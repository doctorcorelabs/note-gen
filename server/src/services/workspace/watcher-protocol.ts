// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Watcher/event wire protocol (V3-08 part 1, v3b-08a): the message
// contract for WS /api/workspace/events, desain-workspace-api.md
// section 9 and kontrak-api-kanonis.md (events row, 86 routes: 85
// HTTP + 1 WebSocket). This module is transport-neutral and pure: no
// route, no socket, no timer, no filesystem watcher, no database
// access, no migration. The route, handshake, fan-out, chokidar
// watcher, and timers belong to the V3-08 part 2 worker (08b).
//
// What lives here:
// - Wire message types and builders for every server-to-client and
//   client-to-server message in desain 9.3.
// - A strict validator for server-to-client JSON (wire conformance)
//   and a parser for client JSON that separates malformed input from
//   unknown message types (desain 9.2 treats them differently).
// - The resync ring buffer (desain 9.4), batch chunking (max 500),
//   the malformed-message close policy (5 in 1 minute, close 1008),
//   close-code meanings (desain 9.2), and the protocol constants
//   (debounce, heartbeat, backoff, polling intervals).
// - The filesystem watcher raw-event translation table and the
//   API/write dedupe marks (desain 9.6), as pure functions. The
//   timed debounce loop itself is 08b work.
// - Mapping helpers from the three narrow producer shapes that
//   already exist to wire drafts. The three shapes are DIFFERENT and
//   must not be mixed:
//   (a) WorkspaceWriteEvent (frozen write-ports.ts): kind
//       created|changed, path, revision, version, actorId. No
//       modifiedAt, no isDirectory, no seq. The caller supplies
//       modifiedAt from the disk state at publish time.
//   (b) TrashEvent (V3-05 part 3, branch web-workspace-trash-v3b05c,
//       not in this tree): kind deleted|created, path, trashId,
//       actorId. No revision, no isDirectory, no seq. trashId has
//       NO wire field and is dropped by the mapping; it belongs to
//       the index seam only. The caller supplies isDirectory from
//       the trash entry kind, and revision/modifiedAt from the
//       restore result for created events.
//   (c) WorkspaceDeleteEvent (V3-07 part 2, branch
//       web-workspace-media-delete-v3b07b, not in this tree): kind
//       deleted, path, previousPath null, revision null, modifiedAt
//       null, isDirectory. Wire-shaped except seq, actor,
//       workspaceRoot, and originConnectionId, which the caller
//       supplies. The mapping functions below take structural
//       parameters, so the named types on their branches are
//       assignable without importing unmerged code.
// - The index seam (V3-06) is DOCUMENTED, not implemented: index
//   rows and file_events rows are written by WorkspaceIndexPort in
//   the same transaction as the disk write (desain 3.7 step 8),
//   before publication. This module never writes the index. A
//   `rescan` event only tells the client to reload a folder; the
//   server-side rescan/reconcile scan belongs to V3-06. There is no
//   indexHook consumer for watcher events in the V3-06 branches
//   (verified by grep on 06a/06b/06c, 15 Nov 2026); the index is
//   updated on the write path, not from wire events.
// - The API-path coalescing sink in write-queue.ts already exists
//   and is untouched by this module.
//
// Assumptions, recorded explicitly because desain 9 does not define
// them (each is marked A-Wn where it is applied):
// - A-W1: originConnectionId is null for system/watcher events.
//   Desain 9.3 shows a string in its example and does not define the
//   system case; null is the explicit choice, never a missing field.
// - A-W2: the error code for an unknown client message type is
//   `unknown_message_type`. Desain names only `malformed_message`.
//   Unknown-type messages do NOT count toward the 5-malformed close:
//   desain 9.2 says they are answered with `error` and ignored.
// - A-W3: created/changed DIRECTORY events carry null revision and
//   modifiedAt. Desain is explicit only for moved folders and
//   rescan; folders have no content bytes, and the V3-07 folder
//   plan carries null revision.
// - A-W4: the server-message validator tolerates unknown extra
//   fields (forward compatibility, following the 9.3 tolerance for
//   unknown protocol versions) but is strict on every known field
//   and on the null rules.
// - A-W5: lastSeq 0 means no event was ever published. The ring
//   buffer is seeded with the starting seq at boot; once the
//   Postgres sequence lands, 08b seeds it from the sequence last
//   value so a restart never replays an empty buffer as up to date.
// - A-W6: actor precedence is system, then agent, then self, then
//   other. Desain defines the labels and says the server decides
//   from session/connection identity; it does not order them.
// - A-W7: a resync sinceSeq that falls on a Postgres sequence gap
//   replays the events above it; gap detection stays client-side
//   (desain 9.4 tolerates rollback gaps as resync triggers).
// - A-W8: an empty batch is never emitted. Chunking zero events
//   yields zero batches, and the validator rejects an empty batch.
//
// Sequence allocation seam (desain 9.4): production seq values come
// from the Postgres sequence `workspace_event_seq`, which does NOT
// exist in this tree (no such sequence in the M1-M8 schema; creating
// it is a migration, out of scope here). SeqAllocator is the seam
// interface; InMemorySeqAllocator is the single-process,
// non-persistent implementation for tests and for local runs. It
// must not be presented as restart-safe: after a restart it starts
// over, and clients with an old sinceSeq correctly receive
// resync-required only when the ring buffer is seeded honestly.

import type { WorkspaceWriteEvent } from './write-ports.js';

// ------------------------------------------------------------------
// Constants (desain section 9; every value cites its subsection)
// ------------------------------------------------------------------

/** Wire protocol version, desain 9.3. Only 1 is sent in MVP. */
export const WATCHER_PROTOCOL_VERSION = 1;

/** Logical workspace identity carried on the wire, desain 9.3. This
 * is an identity label, never a filesystem path. */
export const WATCHER_WORKSPACE_ROOT_DEFAULT = 'default';

/** Ring buffer capacity in events, desain 9.4. */
export const RING_BUFFER_CAPACITY = 1000;

/** Maximum events per `batch` message, desain 9.3. */
export const BATCH_MAX_EVENTS = 500;

/** Filesystem watcher debounce per path, desain 9.6. */
export const WATCHER_DEBOUNCE_MS = 300;

/** Write-stability threshold added by the watcher library, desain
 * 9.6. Worst-case latency for out-of-API writes is about 400 ms. */
export const WRITE_STABILITY_MS = 100;

/** How long an API-write dedupe mark is kept, desain 9.6. */
export const DEDUPE_MARK_TTL_MS = 1000;

/** Window after an API-write mark in which a watcher event for the
 * same path and revision is suppressed, desain 9.6. */
export const DEDUPE_SUPPRESS_WINDOW_MS = 500;

/** Server heartbeat interval, desain 9.3 (ping frame, or JSON
 * ping/pong when the library has no frame control). */
export const HEARTBEAT_INTERVAL_MS = 30000;

/** Client idle timeout: no message of any kind for this long means
 * the connection is dead, desain 9.3. */
export const CLIENT_IDLE_TIMEOUT_MS = 60000;

/** Malformed-message close policy, desain 9.2: this many malformed
 * messages inside the window closes the connection with 1008. */
export const MALFORMED_LIMIT = 5;
export const MALFORMED_WINDOW_MS = 60000;

/** Polling fallback intervals, desain 9.7 (client-owned, V3-09). */
export const POLL_INTERVAL_VISIBLE_MS = 10000;
export const POLL_INTERVAL_HIDDEN_MS = 30000;
export const POLL_MAX_BACKOFF_MS = 60000;
export const POLL_MIN_INTERVAL_MS = 5000;

/** Watcher reinstall backoff steps, desain 9.6: 5s, 15s, then 60s
 * capped, unbounded attempts. */
export const WATCHER_REINSTALL_BACKOFF_MS = [5000, 15000, 60000] as const;

/** Close codes the server uses, desain 9.2. */
export const WATCHER_CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
  INTERNAL_ERROR: 1011,
  SESSION_EXPIRED: 4401,
  FORBIDDEN: 4403,
} as const;

/** Error code for malformed client JSON, desain 9.3 example. */
export const ERROR_CODE_MALFORMED_MESSAGE = 'malformed_message';

/** Error code for an unknown client message type. Assumption A-W2:
 * desain names no code for this case. */
export const ERROR_CODE_UNKNOWN_MESSAGE_TYPE = 'unknown_message_type';

// ------------------------------------------------------------------
// Wire message types (desain 9.3)
// ------------------------------------------------------------------

export type WatcherEventKind = 'created' | 'changed' | 'deleted' | 'moved' | 'rescan';

export type WatcherActor = 'self' | 'other' | 'agent' | 'system';

export const WATCHER_EVENT_KINDS: readonly WatcherEventKind[] = [
  'created',
  'changed',
  'deleted',
  'moved',
  'rescan',
];

export const WATCHER_ACTORS: readonly WatcherActor[] = ['self', 'other', 'agent', 'system'];

export interface WorkspaceFileChangedMessage {
  type: 'workspace-file-changed';
  seq: number;
  kind: WatcherEventKind;
  path: string;
  previousPath: string | null;
  workspaceRoot: string;
  revision: string | null;
  modifiedAt: string | null;
  isDirectory: boolean;
  actor: WatcherActor;
  /** Null for system/watcher events (assumption A-W1). */
  originConnectionId: string | null;
}

export interface HelloMessage {
  type: 'hello';
  protocolVersion: 1;
  workspaceRoot: string;
  serverTime: string;
  lastSeq: number;
  connectionId: string;
}

export interface ResyncRequiredMessage {
  type: 'resync-required';
  lastSeq: number;
}

export interface BatchMessage {
  type: 'batch';
  events: WorkspaceFileChangedMessage[];
}

export interface WatcherErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
  serverTime: string;
}

export interface ResyncOkMessage {
  type: 'resync-ok';
  lastSeq: number;
}

export type ServerMessage =
  | WorkspaceFileChangedMessage
  | HelloMessage
  | ResyncRequiredMessage
  | BatchMessage
  | WatcherErrorMessage
  | PongMessage
  | ResyncOkMessage;

export type ClientMessage = { type: 'ping' } | { type: 'resync'; sinceSeq: number };

/** Input accepted by buildWorkspaceFileChanged: the full wire shape
 * minus the `type` discriminator, which the builder sets. */
export interface WireEventInput {
  seq: number;
  kind: WatcherEventKind;
  path: string;
  previousPath: string | null;
  workspaceRoot: string;
  revision: string | null;
  modifiedAt: string | null;
  isDirectory: boolean;
  actor: WatcherActor;
  originConnectionId: string | null;
}

/** A wire event before seq allocation: what the mapping helpers
 * produce and what the publisher completes with a seq. */
export type WireEventDraft = Omit<WireEventInput, 'seq'>;

/** Context every producer must supply: the logical workspace label,
 * the actor label, and the originating connection id (null for
 * system/watcher events, A-W1). */
export interface WireEventContext {
  workspaceRoot: string;
  actor: WatcherActor;
  originConnectionId: string | null;
}

// ------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------

export class WatcherProtocolError extends Error {
  override readonly name = 'WatcherProtocolError';

  constructor(message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------
// Shared shape checks (used by the builder and the validator)
// ------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value));
}

/** Path rules for wire events, desain 9.5: the server never
 * publishes an event for a path with a dot-leading segment. An
 * empty path is legal ONLY for `rescan`, where it means the root. */
function checkEventPath(kind: WatcherEventKind, path: unknown, field: string): string[] {
  if (typeof path !== 'string') {
    return [`${field} must be a string`];
  }
  if (path === '') {
    return kind === 'rescan' && field === 'path' ? [] : [`${field} must not be empty`];
  }
  if (path.startsWith('/')) {
    return [`${field} must be relative, got an absolute path`];
  }
  if (path.includes('\\')) {
    return [`${field} must use POSIX separators`];
  }
  for (const segment of path.split('/')) {
    if (segment === '') {
      return [`${field} must not contain an empty segment`];
    }
    if (segment.startsWith('.')) {
      return [`${field} must not contain a dot-leading segment`];
    }
  }
  return [];
}

/** Null rules for revision/modifiedAt/previousPath, desain 9.3 plus
 * assumption A-W3 for directory created/changed events. */
function checkNullRules(input: {
  kind: WatcherEventKind;
  previousPath: unknown;
  revision: unknown;
  modifiedAt: unknown;
  isDirectory: unknown;
}): string[] {
  const errors: string[] = [];
  const { kind, previousPath, revision, modifiedAt, isDirectory } = input;
  if (kind === 'moved') {
    if (previousPath === null || previousPath === undefined) {
      errors.push('previousPath is required for moved events');
    }
  } else if (previousPath !== null) {
    errors.push(`previousPath must be null for ${kind} events`);
  }
  const needsRevision =
    (kind === 'created' || kind === 'changed' || kind === 'moved') && isDirectory !== true;
  if (needsRevision) {
    if (typeof revision !== 'string' || revision === '') {
      errors.push(`revision is required for ${kind} file events`);
    }
    if (!isValidDateString(modifiedAt)) {
      errors.push(`modifiedAt must be a valid date string for ${kind} file events`);
    }
  } else {
    if (revision !== null) {
      errors.push(`revision must be null for ${kind}${isDirectory === true ? ' directory' : ''} events`);
    }
    if (modifiedAt !== null) {
      errors.push(`modifiedAt must be null for ${kind}${isDirectory === true ? ' directory' : ''} events`);
    }
  }
  return errors;
}

function checkEventFields(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (value['type'] !== 'workspace-file-changed') {
    errors.push('type must be workspace-file-changed');
  }
  if (!Number.isSafeInteger(value['seq']) || (value['seq'] as number) < 1) {
    errors.push('seq must be a safe integer >= 1');
  }
  const kind = value['kind'];
  if (typeof kind !== 'string' || !(WATCHER_EVENT_KINDS as readonly string[]).includes(kind)) {
    errors.push('kind must be created, changed, deleted, moved, or rescan');
    return errors;
  }
  errors.push(...checkEventPath(kind as WatcherEventKind, value['path'], 'path'));
  if (kind === 'moved') {
    errors.push(...checkEventPath(kind, value['previousPath'], 'previousPath'));
  } else if (value['previousPath'] !== null && value['previousPath'] !== undefined) {
    errors.push('previousPath must be null for non-moved events');
  }
  if (typeof value['workspaceRoot'] !== 'string' || value['workspaceRoot'] === '') {
    errors.push('workspaceRoot must be a non-empty string');
  }
  if (typeof value['isDirectory'] !== 'boolean') {
    errors.push('isDirectory must be a boolean');
  }
  if (
    typeof value['actor'] !== 'string' ||
    !(WATCHER_ACTORS as readonly string[]).includes(value['actor'])
  ) {
    errors.push('actor must be self, other, agent, or system');
  }
  if (
    value['originConnectionId'] !== null &&
    (typeof value['originConnectionId'] !== 'string' || value['originConnectionId'] === '')
  ) {
    errors.push('originConnectionId must be a non-empty string or null');
  }
  errors.push(
    ...checkNullRules({
      kind: kind as WatcherEventKind,
      previousPath: value['previousPath'],
      revision: value['revision'],
      modifiedAt: value['modifiedAt'],
      isDirectory: value['isDirectory'],
    }),
  );
  return errors;
}

// ------------------------------------------------------------------
// Builders (fail fast; the publisher must never emit a bad shape)
// ------------------------------------------------------------------

export function buildWorkspaceFileChanged(input: WireEventInput): WorkspaceFileChangedMessage {
  const errors = checkEventFields({ ...input, type: 'workspace-file-changed' });
  if (errors.length > 0) {
    throw new WatcherProtocolError(`Invalid workspace event: ${errors.join('; ')}`);
  }
  return { type: 'workspace-file-changed', ...input };
}

export function buildHello(input: {
  workspaceRoot: string;
  serverTime: string;
  lastSeq: number;
  connectionId: string;
}): HelloMessage {
  if (input.workspaceRoot === '') {
    throw new WatcherProtocolError('Invalid hello: workspaceRoot must not be empty');
  }
  if (!isValidDateString(input.serverTime)) {
    throw new WatcherProtocolError('Invalid hello: serverTime must be a valid date string');
  }
  if (!Number.isSafeInteger(input.lastSeq) || input.lastSeq < 0) {
    throw new WatcherProtocolError('Invalid hello: lastSeq must be a safe integer >= 0');
  }
  if (input.connectionId === '') {
    throw new WatcherProtocolError('Invalid hello: connectionId must not be empty');
  }
  return {
    type: 'hello',
    protocolVersion: WATCHER_PROTOCOL_VERSION,
    workspaceRoot: input.workspaceRoot,
    serverTime: input.serverTime,
    lastSeq: input.lastSeq,
    connectionId: input.connectionId,
  };
}

export function buildResyncRequired(lastSeq: number): ResyncRequiredMessage {
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) {
    throw new WatcherProtocolError('Invalid resync-required: lastSeq must be a safe integer >= 0');
  }
  return { type: 'resync-required', lastSeq };
}

export function buildResyncOk(lastSeq: number): ResyncOkMessage {
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) {
    throw new WatcherProtocolError('Invalid resync-ok: lastSeq must be a safe integer >= 0');
  }
  return { type: 'resync-ok', lastSeq };
}

export function buildPong(serverTime: string): PongMessage {
  if (!isValidDateString(serverTime)) {
    throw new WatcherProtocolError('Invalid pong: serverTime must be a valid date string');
  }
  return { type: 'pong', serverTime };
}

export function buildError(code: string, message: string): WatcherErrorMessage {
  if (code === '') {
    throw new WatcherProtocolError('Invalid error message: code must not be empty');
  }
  return { type: 'error', code, message };
}

/** One batch message. Throws when empty or over the 500 cap (A-W8);
 * use chunkEvents to split a long replay. */
export function buildBatch(events: readonly WorkspaceFileChangedMessage[]): BatchMessage {
  if (events.length === 0) {
    throw new WatcherProtocolError('Invalid batch: a batch must contain at least one event');
  }
  if (events.length > BATCH_MAX_EVENTS) {
    throw new WatcherProtocolError(
      `Invalid batch: ${events.length} events exceeds the ${BATCH_MAX_EVENTS} cap; split it first`,
    );
  }
  return { type: 'batch', events: [...events] };
}

/** Split events into batches of at most 500, preserving order
 * (desain 9.3). Zero events yield zero batches (A-W8). */
export function chunkEvents(events: readonly WorkspaceFileChangedMessage[]): BatchMessage[] {
  const batches: BatchMessage[] = [];
  for (let start = 0; start < events.length; start += BATCH_MAX_EVENTS) {
    batches.push(buildBatch(events.slice(start, start + BATCH_MAX_EVENTS)));
  }
  return batches;
}

// ------------------------------------------------------------------
// Wire conformance validation (server-to-client JSON)
// ------------------------------------------------------------------

export type ValidationResult<T> = { ok: true; message: T } | { ok: false; errors: string[] };

function checkLastSeq(value: unknown): string[] {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? []
    : ['lastSeq must be a safe integer >= 0'];
}

/** Validate any server-to-client message. Unknown extra fields are
 * tolerated (A-W4); every known field is checked. */
export function validateServerMessage(value: unknown): ValidationResult<ServerMessage> {
  if (!isRecord(value)) {
    return { ok: false, errors: ['message must be a JSON object'] };
  }
  switch (value['type']) {
    case 'workspace-file-changed': {
      const errors = checkEventFields(value);
      return errors.length === 0
        ? { ok: true, message: value as unknown as WorkspaceFileChangedMessage }
        : { ok: false, errors };
    }
    case 'hello': {
      const errors: string[] = [];
      if (value['protocolVersion'] !== WATCHER_PROTOCOL_VERSION) {
        errors.push(`protocolVersion must be ${WATCHER_PROTOCOL_VERSION}`);
      }
      if (typeof value['workspaceRoot'] !== 'string' || value['workspaceRoot'] === '') {
        errors.push('workspaceRoot must be a non-empty string');
      }
      if (!isValidDateString(value['serverTime'])) {
        errors.push('serverTime must be a valid date string');
      }
      errors.push(...checkLastSeq(value['lastSeq']));
      if (typeof value['connectionId'] !== 'string' || value['connectionId'] === '') {
        errors.push('connectionId must be a non-empty string');
      }
      return errors.length === 0
        ? { ok: true, message: value as unknown as HelloMessage }
        : { ok: false, errors };
    }
    case 'resync-required':
    case 'resync-ok': {
      const errors = checkLastSeq(value['lastSeq']);
      return errors.length === 0
        ? { ok: true, message: value as unknown as ResyncRequiredMessage | ResyncOkMessage }
        : { ok: false, errors };
    }
    case 'batch': {
      const errors: string[] = [];
      const events = value['events'];
      if (!Array.isArray(events)) {
        return { ok: false, errors: ['events must be an array'] };
      }
      if (events.length === 0) {
        errors.push('events must contain at least one event');
      }
      if (events.length > BATCH_MAX_EVENTS) {
        errors.push(`events must contain at most ${BATCH_MAX_EVENTS} events`);
      }
      events.forEach((event, index) => {
        if (!isRecord(event)) {
          errors.push(`events[${index}] must be a JSON object`);
          return;
        }
        for (const error of checkEventFields(event)) {
          errors.push(`events[${index}]: ${error}`);
        }
      });
      return errors.length === 0
        ? { ok: true, message: value as unknown as BatchMessage }
        : { ok: false, errors };
    }
    case 'error': {
      const errors: string[] = [];
      if (typeof value['code'] !== 'string' || value['code'] === '') {
        errors.push('code must be a non-empty string');
      }
      if (typeof value['message'] !== 'string') {
        errors.push('message must be a string');
      }
      return errors.length === 0
        ? { ok: true, message: value as unknown as WatcherErrorMessage }
        : { ok: false, errors };
    }
    case 'pong': {
      const errors = isValidDateString(value['serverTime'])
        ? []
        : ['serverTime must be a valid date string'];
      return errors.length === 0
        ? { ok: true, message: value as unknown as PongMessage }
        : { ok: false, errors };
    }
    default:
      return { ok: false, errors: [`unknown server message type: ${String(value['type'])}`] };
  }
}

/** Parse and validate one raw server-to-client JSON text. Used by
 * conformance tests on both sides of the wire. */
export function parseServerMessage(raw: string): ValidationResult<ServerMessage> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, errors: ['message is not valid JSON'] };
  }
  return validateServerMessage(parsed);
}

// ------------------------------------------------------------------
// Client message parsing (desain 9.2/9.3)
// ------------------------------------------------------------------

export type ClientMessageParseResult =
  | { outcome: 'ok'; message: ClientMessage }
  | { outcome: 'malformed'; errors: string[] }
  | { outcome: 'unknown-type'; type: string; errors: string[] };

/** Parse one raw client JSON text. Only `ping` and `resync` exist
 * in MVP. Malformed input counts toward the 1008 close policy;
 * unknown types are answered with `error` and ignored (A-W2). */
export function parseClientMessage(raw: string): ClientMessageParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { outcome: 'malformed', errors: ['message is not valid JSON'] };
  }
  if (!isRecord(parsed)) {
    return { outcome: 'malformed', errors: ['message must be a JSON object'] };
  }
  switch (parsed['type']) {
    case 'ping':
      return { outcome: 'ok', message: { type: 'ping' } };
    case 'resync': {
      const sinceSeq = parsed['sinceSeq'];
      if (!Number.isSafeInteger(sinceSeq) || (sinceSeq as number) < 0) {
        return { outcome: 'malformed', errors: ['sinceSeq must be a safe integer >= 0'] };
      }
      return { outcome: 'ok', message: { type: 'resync', sinceSeq: sinceSeq as number } };
    }
    default:
      return {
        outcome: 'unknown-type',
        type: String(parsed['type']),
        errors: [`unknown client message type: ${String(parsed['type'])}`],
      };
  }
}

// ------------------------------------------------------------------
// Sequence allocation seam (desain 9.4)
// ------------------------------------------------------------------

/** Allocates strictly increasing seq values. The production
 * implementation reads Postgres `workspace_event_seq`; that
 * sequence and its migration belong to a later worker. */
export interface SeqAllocator {
  next(): Promise<number>;
}

/** Single-process, non-persistent allocator for tests and local
 * runs. NOT restart-safe: it restarts from its start value, so the
 * ring buffer must be seeded honestly at boot (A-W5). */
export class InMemorySeqAllocator implements SeqAllocator {
  private current: number;

  constructor(start = 0) {
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new WatcherProtocolError('InMemorySeqAllocator start must be a safe integer >= 0');
    }
    this.current = start;
  }

  async next(): Promise<number> {
    this.current += 1;
    return this.current;
  }

  lastAllocated(): number {
    return this.current;
  }
}

// ------------------------------------------------------------------
// Resync ring buffer (desain 9.4)
// ------------------------------------------------------------------

export type ReplayResult =
  | { outcome: 'ok'; events: WorkspaceFileChangedMessage[] }
  | { outcome: 'resync-required'; lastSeq: number };

/** The last 1000 published events, in seq order, per process.
 * `startingSeq` is the last seq known at boot (0 when no event was
 * ever published). Seeding it from the Postgres sequence last value
 * is what makes an empty post-restart buffer answer resync-required
 * instead of a false up-to-date (A-W5). */
export class EventRingBuffer {
  private readonly capacity: number;
  private readonly events: WorkspaceFileChangedMessage[] = [];
  private readonly startingSeq: number;

  constructor(options: { capacity?: number; startingSeq?: number } = {}) {
    const capacity = options.capacity ?? RING_BUFFER_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new WatcherProtocolError('EventRingBuffer capacity must be a safe integer >= 1');
    }
    const startingSeq = options.startingSeq ?? 0;
    if (!Number.isSafeInteger(startingSeq) || startingSeq < 0) {
      throw new WatcherProtocolError('EventRingBuffer startingSeq must be a safe integer >= 0');
    }
    this.capacity = capacity;
    this.startingSeq = startingSeq;
  }

  append(event: WorkspaceFileChangedMessage): void {
    if (event.seq <= this.lastSeq) {
      throw new WatcherProtocolError(
        `seq must increase monotonically: ${event.seq} <= ${this.lastSeq}`,
      );
    }
    this.events.push(event);
    while (this.events.length > this.capacity) {
      this.events.shift();
    }
  }

  get lastSeq(): number {
    const last = this.events[this.events.length - 1];
    return last === undefined ? this.startingSeq : last.seq;
  }

  get size(): number {
    return this.events.length;
  }

  /** Replay the events above sinceSeq, or require a snapshot resync
   * when the buffer has rotated past it (desain 9.4). A sinceSeq on
   * a sequence gap replays what exists above it (A-W7). */
  replay(sinceSeq: number): ReplayResult {
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) {
      throw new WatcherProtocolError('replay sinceSeq must be a safe integer >= 0');
    }
    if (sinceSeq >= this.lastSeq) {
      return { outcome: 'ok', events: [] };
    }
    const oldest = this.events[0];
    if (oldest === undefined) {
      return { outcome: 'resync-required', lastSeq: this.lastSeq };
    }
    if (sinceSeq < oldest.seq - 1) {
      return { outcome: 'resync-required', lastSeq: this.lastSeq };
    }
    return { outcome: 'ok', events: this.events.filter((event) => event.seq > sinceSeq) };
  }
}

// ------------------------------------------------------------------
// Malformed-message close policy (desain 9.2)
// ------------------------------------------------------------------

/** Counts malformed client messages in a sliding 60-second window.
 * record() returns true when the connection must close with 1008.
 * The clock is injected so the policy is testable without timers. */
export class MalformedTracker {
  private readonly timestamps: number[] = [];

  record(nowMs: number): boolean {
    const floor = nowMs - MALFORMED_WINDOW_MS;
    while (this.timestamps.length > 0 && (this.timestamps[0] as number) <= floor) {
      this.timestamps.shift();
    }
    this.timestamps.push(nowMs);
    return this.timestamps.length >= MALFORMED_LIMIT;
  }

  count(nowMs: number): number {
    const floor = nowMs - MALFORMED_WINDOW_MS;
    return this.timestamps.filter((stamp) => stamp > floor).length;
  }
}

// ------------------------------------------------------------------
// Filesystem watcher translation + API dedupe (desain 9.6)
// ------------------------------------------------------------------

export type WatcherRawEventKind = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

export interface TranslatedWatcherEvent {
  kind: WatcherEventKind;
  path: string;
  isDirectory: boolean;
}

/** Translate one raw filesystem watcher event to a wire kind.
 * Returns null for paths the server never publishes (dot-leading
 * segments, desain 9.5). A filesystem rename (unlink + add pair)
 * is NEVER translated to `moved`; only the API path produces
 * reliable `moved` events (desain 9.6). */
export function translateWatcherRawEvent(raw: {
  event: WatcherRawEventKind;
  path: string;
}): TranslatedWatcherEvent | null {
  if (checkEventPath('changed', raw.path, 'path').length > 0) {
    return null;
  }
  switch (raw.event) {
    case 'add':
      return { kind: 'created', path: raw.path, isDirectory: false };
    case 'addDir':
      return { kind: 'created', path: raw.path, isDirectory: true };
    case 'change':
      return { kind: 'changed', path: raw.path, isDirectory: false };
    case 'unlink':
      return { kind: 'deleted', path: raw.path, isDirectory: false };
    case 'unlinkDir':
      return { kind: 'deleted', path: raw.path, isDirectory: true };
  }
}

/** API-write dedupe marks (desain 9.6): an API write marks
 * (path, revision) for 1000 ms; a watcher event for the same path
 * and revision within 500 ms of the mark is suppressed. The clock
 * is injected; the timed watcher loop is 08b work. */
export class DedupeMarks {
  private readonly marks = new Map<string, number>();

  mark(path: string, revision: string, nowMs: number): void {
    this.prune(nowMs);
    this.marks.set(`${path}\0${revision}`, nowMs);
  }

  shouldSuppress(path: string, revision: string, nowMs: number): boolean {
    this.prune(nowMs);
    const markedAt = this.marks.get(`${path}\0${revision}`);
    if (markedAt === undefined) {
      return false;
    }
    return nowMs - markedAt <= DEDUPE_SUPPRESS_WINDOW_MS;
  }

  private prune(nowMs: number): void {
    const floor = nowMs - DEDUPE_MARK_TTL_MS;
    for (const [key, markedAt] of this.marks) {
      if (markedAt <= floor) {
        this.marks.delete(key);
      }
    }
  }
}

// ------------------------------------------------------------------
// Actor resolution + close-code + backoff tables (desain 9.2/9.3/9.4)
// ------------------------------------------------------------------

/** Resolve the actor label. Precedence is system, agent, self,
 * other (A-W6). Watcher/filesystem events are always `system`. */
export function resolveActor(input: {
  isSystem: boolean;
  isProgrammatic: boolean;
  originConnectionId: string | null;
  connectionId: string;
}): WatcherActor {
  if (input.isSystem) {
    return 'system';
  }
  if (input.isProgrammatic) {
    return 'agent';
  }
  if (input.originConnectionId !== null && input.originConnectionId === input.connectionId) {
    return 'self';
  }
  return 'other';
}

export type CloseCodeClientAction =
  | 'none'
  | 'reconnect-resync'
  | 'reconnect-once-then-poll'
  | 'relogin'
  | 'show-error';

/** Client action per close code, desain 9.2 table. The behavior
 * itself is V3-09 work; this pins the table in one place. */
export function closeCodeClientAction(code: number): CloseCodeClientAction {
  switch (code) {
    case WATCHER_CLOSE_CODES.NORMAL:
      return 'none';
    case WATCHER_CLOSE_CODES.GOING_AWAY:
    case WATCHER_CLOSE_CODES.INTERNAL_ERROR:
      return 'reconnect-resync';
    case WATCHER_CLOSE_CODES.POLICY_VIOLATION:
      return 'reconnect-once-then-poll';
    case WATCHER_CLOSE_CODES.SESSION_EXPIRED:
      return 'relogin';
    case WATCHER_CLOSE_CODES.FORBIDDEN:
      return 'show-error';
    default:
      return 'show-error';
  }
}

/** Reconnect backoff cap before full jitter, desain 9.4: 1s, 2s,
 * 4s, 8s, then 15s capped. Attempt is 0-based; the client randomizes
 * the actual delay between 0 and this cap. */
export function reconnectBackoffCapMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new WatcherProtocolError('reconnect attempt must be a safe integer >= 0');
  }
  return Math.min(1000 * 2 ** attempt, 15000);
}

/** Watcher reinstall delay, desain 9.6: 5s, 15s, then 60s capped.
 * Attempt is 0-based. */
export function watcherReinstallDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new WatcherProtocolError('reinstall attempt must be a safe integer >= 0');
  }
  const index = Math.min(attempt, WATCHER_REINSTALL_BACKOFF_MS.length - 1);
  return WATCHER_REINSTALL_BACKOFF_MS[index] as number;
}

// ------------------------------------------------------------------
// Producer mappings (the three narrow shapes stay separate)
// ------------------------------------------------------------------

/** Map a frozen WorkspaceWriteEvent (write-ports.ts) to a wire
 * draft. The write event carries no modifiedAt or isDirectory, so
 * the caller supplies them from the disk state at publish time;
 * file writes are the only producer on this path today, so
 * isDirectory defaults to false. */
export function mapWriteEventToWireDraft(
  event: WorkspaceWriteEvent,
  facts: WireEventContext & { modifiedAt: string; isDirectory?: boolean },
): WireEventDraft {
  return {
    kind: event.kind,
    path: event.path,
    previousPath: null,
    workspaceRoot: facts.workspaceRoot,
    revision: event.revision,
    modifiedAt: facts.modifiedAt,
    isDirectory: facts.isDirectory ?? false,
    actor: facts.actor,
    originConnectionId: facts.originConnectionId,
  };
}

/** Map a trash notice to a wire draft. The parameter shape is
 * structural: TrashEvent on the V3-05 branch (kind, path, trashId,
 * actorId) is assignable, and trashId is intentionally dropped
 * because the wire has no field for it. The caller supplies
 * isDirectory from the trash entry kind. For `deleted`, revision
 * and modifiedAt are forced null (desain 9.3); supplying them is
 * an error. For `created` (restore), the caller supplies
 * revision/modifiedAt from the restored state; omitting them is an
 * error. Purge publishes NO event (desain 5.2, V3-07 constant):
 * callers must not map a purge through this function. */
export function mapTrashNoticeToWireDraft(
  notice: { kind: 'deleted' | 'created'; path: string },
  facts: WireEventContext & {
    isDirectory: boolean;
    revision?: string | null;
    modifiedAt?: string | null;
  },
): WireEventDraft {
  if (notice.kind === 'deleted') {
    if (facts.revision != null || facts.modifiedAt != null) {
      throw new WatcherProtocolError('Trash deleted notices must not carry revision/modifiedAt');
    }
    return {
      kind: 'deleted',
      path: notice.path,
      previousPath: null,
      workspaceRoot: facts.workspaceRoot,
      revision: null,
      modifiedAt: null,
      isDirectory: facts.isDirectory,
      actor: facts.actor,
      originConnectionId: facts.originConnectionId,
    };
  }
  if (facts.revision == null || facts.revision === '' || !isValidDateString(facts.modifiedAt)) {
    throw new WatcherProtocolError('Trash restore notices require revision and modifiedAt');
  }
  return {
    kind: 'created',
    path: notice.path,
    previousPath: null,
    workspaceRoot: facts.workspaceRoot,
    revision: facts.revision,
    modifiedAt: facts.modifiedAt,
    isDirectory: facts.isDirectory,
    actor: facts.actor,
    originConnectionId: facts.originConnectionId,
  };
}

/** Map a delete notice to a wire draft. The parameter shape is
 * structural and matches WorkspaceDeleteEvent on the V3-07 branch
 * exactly (kind deleted, path, previousPath null, revision null,
 * modifiedAt null, isDirectory); only the seq/actor/workspace
 * context is added here. */
export function mapDeleteNoticeToWireDraft(
  notice: {
    kind: 'deleted';
    path: string;
    previousPath: null;
    revision: null;
    modifiedAt: null;
    isDirectory: boolean;
  },
  context: WireEventContext,
): WireEventDraft {
  return {
    kind: notice.kind,
    path: notice.path,
    previousPath: notice.previousPath,
    workspaceRoot: context.workspaceRoot,
    revision: notice.revision,
    modifiedAt: notice.modifiedAt,
    isDirectory: notice.isDirectory,
    actor: context.actor,
    originConnectionId: context.originConnectionId,
  };
}
