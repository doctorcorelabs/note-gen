// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wire conformance spec for the watcher/event protocol (V3-08 part
// 1, v3b-08a): desain-workspace-api.md section 9 + kontrak events
// row. Every assertion pins a documented wire rule; assumptions
// A-W1 to A-W8 from watcher-protocol.ts are pinned where they
// apply and named in the test titles. No route, socket, timer, or
// database is involved: the protocol module is pure.

import { describe, expect, it } from 'vitest';
import {
  BATCH_MAX_EVENTS,
  CLIENT_IDLE_TIMEOUT_MS,
  DEDUPE_MARK_TTL_MS,
  DEDUPE_SUPPRESS_WINDOW_MS,
  ERROR_CODE_MALFORMED_MESSAGE,
  ERROR_CODE_UNKNOWN_MESSAGE_TYPE,
  EventRingBuffer,
  HEARTBEAT_INTERVAL_MS,
  InMemorySeqAllocator,
  MALFORMED_LIMIT,
  MALFORMED_WINDOW_MS,
  MalformedTracker,
  POLL_INTERVAL_HIDDEN_MS,
  POLL_INTERVAL_VISIBLE_MS,
  POLL_MAX_BACKOFF_MS,
  POLL_MIN_INTERVAL_MS,
  RING_BUFFER_CAPACITY,
  WATCHER_CLOSE_CODES,
  WATCHER_DEBOUNCE_MS,
  WATCHER_PROTOCOL_VERSION,
  WATCHER_WORKSPACE_ROOT_DEFAULT,
  WATCHER_REINSTALL_BACKOFF_MS,
  WRITE_STABILITY_MS,
  buildBatch,
  buildError,
  buildHello,
  buildPong,
  buildResyncOk,
  buildResyncRequired,
  buildWorkspaceFileChanged,
  chunkEvents,
  closeCodeClientAction,
  DedupeMarks,
  mapDeleteNoticeToWireDraft,
  mapTrashNoticeToWireDraft,
  mapWriteEventToWireDraft,
  parseClientMessage,
  parseServerMessage,
  reconnectBackoffCapMs,
  resolveActor,
  translateWatcherRawEvent,
  validateServerMessage,
  watcherReinstallDelayMs,
} from '../src/services/workspace/watcher-protocol.js';
import type {
  WatcherEventKind,
  WireEventInput,
  WorkspaceFileChangedMessage,
} from '../src/services/workspace/watcher-protocol.js';
import type { WorkspaceWriteEvent } from '../src/services/workspace/write-ports.js';

const MODIFIED_AT = '2026-11-14T13:00:00.000Z';
const REVISION = 'sha256:0123456789abcdef';

function fileInput(overrides: Partial<WireEventInput> = {}): WireEventInput {
  return {
    seq: 1234,
    kind: 'created',
    path: 'sub/folder/materi-baru.md',
    previousPath: null,
    workspaceRoot: 'default',
    revision: REVISION,
    modifiedAt: MODIFIED_AT,
    isDirectory: false,
    actor: 'other',
    originConnectionId: 'conn-01k',
    ...overrides,
  };
}

function eventAt(seq: number, path = `note-${seq}.md`): WorkspaceFileChangedMessage {
  return buildWorkspaceFileChanged(fileInput({ seq, path, kind: 'changed' }));
}

describe('protocol constants (desain 9)', () => {
  it('pins every numeric constant to its documented value', () => {
    expect(WATCHER_PROTOCOL_VERSION).toBe(1);
    expect(WATCHER_WORKSPACE_ROOT_DEFAULT).toBe('default');
    expect(RING_BUFFER_CAPACITY).toBe(1000);
    expect(BATCH_MAX_EVENTS).toBe(500);
    expect(WATCHER_DEBOUNCE_MS).toBe(300);
    expect(WRITE_STABILITY_MS).toBe(100);
    expect(DEDUPE_MARK_TTL_MS).toBe(1000);
    expect(DEDUPE_SUPPRESS_WINDOW_MS).toBe(500);
    expect(HEARTBEAT_INTERVAL_MS).toBe(30000);
    expect(CLIENT_IDLE_TIMEOUT_MS).toBe(60000);
    expect(MALFORMED_LIMIT).toBe(5);
    expect(MALFORMED_WINDOW_MS).toBe(60000);
    expect(POLL_INTERVAL_VISIBLE_MS).toBe(10000);
    expect(POLL_INTERVAL_HIDDEN_MS).toBe(30000);
    expect(POLL_MAX_BACKOFF_MS).toBe(60000);
    expect(POLL_MIN_INTERVAL_MS).toBe(5000);
    expect([...WATCHER_REINSTALL_BACKOFF_MS]).toEqual([5000, 15000, 60000]);
  });

  it('pins the close codes of desain 9.2', () => {
    expect(WATCHER_CLOSE_CODES).toEqual({
      NORMAL: 1000,
      GOING_AWAY: 1001,
      POLICY_VIOLATION: 1008,
      INTERNAL_ERROR: 1011,
      SESSION_EXPIRED: 4401,
      FORBIDDEN: 4403,
    });
  });
});

describe('buildWorkspaceFileChanged (desain 9.3)', () => {
  it('builds the documented 9.3 example shape verbatim', () => {
    const message = buildWorkspaceFileChanged(fileInput());
    expect(message).toEqual({
      type: 'workspace-file-changed',
      seq: 1234,
      kind: 'created',
      path: 'sub/folder/materi-baru.md',
      previousPath: null,
      workspaceRoot: 'default',
      revision: REVISION,
      modifiedAt: MODIFIED_AT,
      isDirectory: false,
      actor: 'other',
      originConnectionId: 'conn-01k',
    });
  });

  it('accepts every kind with its legal null combination', () => {
    const kinds: Array<{ kind: WatcherEventKind; input: Partial<WireEventInput> }> = [
      { kind: 'created', input: {} },
      { kind: 'changed', input: { kind: 'changed' } },
      {
        kind: 'deleted',
        input: { kind: 'deleted', revision: null, modifiedAt: null },
      },
      {
        kind: 'moved',
        input: { kind: 'moved', previousPath: 'sub/folder/lama.md' },
      },
      {
        kind: 'moved',
        input: {
          kind: 'moved',
          previousPath: 'folder-lama',
          isDirectory: true,
          revision: null,
          modifiedAt: null,
        },
      },
      {
        kind: 'rescan',
        input: { kind: 'rescan', path: '', revision: null, modifiedAt: null },
      },
      {
        kind: 'rescan',
        input: { kind: 'rescan', path: 'sub/folder', revision: null, modifiedAt: null },
      },
      {
        kind: 'created',
        input: { kind: 'created', isDirectory: true, revision: null, modifiedAt: null },
      },
    ];
    for (const { kind, input } of kinds) {
      expect(buildWorkspaceFileChanged(fileInput(input)).kind).toBe(kind);
    }
  });

  it('rejects previousPath on non-moved events', () => {
    expect(() => buildWorkspaceFileChanged(fileInput({ previousPath: 'lama.md' }))).toThrow(
      /previousPath must be null/,
    );
  });

  it('rejects moved events without previousPath', () => {
    expect(() => buildWorkspaceFileChanged(fileInput({ kind: 'moved' }))).toThrow(
      /previousPath is required/,
    );
  });

  it('rejects revision/modifiedAt on deleted, rescan, and moved-folder events', () => {
    expect(() =>
      buildWorkspaceFileChanged(fileInput({ kind: 'deleted' })),
    ).toThrow(/revision must be null/);
    expect(() =>
      buildWorkspaceFileChanged(fileInput({ kind: 'rescan', path: 'folder' })),
    ).toThrow(/revision must be null/);
    expect(() =>
      buildWorkspaceFileChanged(
        fileInput({ kind: 'moved', previousPath: 'a', isDirectory: true }),
      ),
    ).toThrow(/revision must be null/);
  });

  it('rejects file created/changed/moved events without revision or modifiedAt', () => {
    expect(() => buildWorkspaceFileChanged(fileInput({ revision: null }))).toThrow(
      /revision is required/,
    );
    expect(() => buildWorkspaceFileChanged(fileInput({ modifiedAt: null }))).toThrow(
      /modifiedAt must be a valid date string/,
    );
    expect(() =>
      buildWorkspaceFileChanged(fileInput({ modifiedAt: 'bukan-tanggal' })),
    ).toThrow(/modifiedAt must be a valid date string/);
  });

  it('rejects directory created/changed events with revision (A-W3)', () => {
    expect(() => buildWorkspaceFileChanged(fileInput({ isDirectory: true }))).toThrow(
      /revision must be null/,
    );
  });

  it('rejects dot-leading segments, absolute paths, and empty paths', () => {
    expect(() => buildWorkspaceFileChanged(fileInput({ path: '.hidden/note.md' }))).toThrow(
      /dot-leading/,
    );
    expect(() => buildWorkspaceFileChanged(fileInput({ path: 'sub/.tmp-x/note.md' }))).toThrow(
      /dot-leading/,
    );
    expect(() => buildWorkspaceFileChanged(fileInput({ path: '/abs/note.md' }))).toThrow(
      /relative/,
    );
    expect(() => buildWorkspaceFileChanged(fileInput({ path: '' }))).toThrow(/must not be empty/);
    expect(() => buildWorkspaceFileChanged(fileInput({ path: 'a//b.md' }))).toThrow(
      /empty segment/,
    );
    expect(() => buildWorkspaceFileChanged(fileInput({ path: 'a\\b.md' }))).toThrow(/POSIX/);
  });

  it('rejects bad seq, kind, actor, and originConnectionId values', () => {
    expect(() => buildWorkspaceFileChanged(fileInput({ seq: 0 }))).toThrow(/seq must be/);
    expect(() => buildWorkspaceFileChanged(fileInput({ seq: 1.5 }))).toThrow(/seq must be/);
    expect(() =>
      buildWorkspaceFileChanged(fileInput({ kind: 'renamed' as WatcherEventKind })),
    ).toThrow(/kind must be/);
    expect(() =>
      buildWorkspaceFileChanged(fileInput({ actor: 'nobody' as 'other' })),
    ).toThrow(/actor must be/);
    expect(() => buildWorkspaceFileChanged(fileInput({ originConnectionId: '' }))).toThrow(
      /originConnectionId/,
    );
    expect(() => buildWorkspaceFileChanged(fileInput({ workspaceRoot: '' }))).toThrow(
      /workspaceRoot/,
    );
  });

  it('accepts a null originConnectionId for system events (A-W1)', () => {
    const message = buildWorkspaceFileChanged(
      fileInput({ actor: 'system', originConnectionId: null }),
    );
    expect(message.originConnectionId).toBeNull();
  });
});

describe('control message builders (desain 9.3)', () => {
  it('builds hello with protocolVersion 1 as the first server message', () => {
    expect(
      buildHello({
        workspaceRoot: 'default',
        serverTime: MODIFIED_AT,
        lastSeq: 1234,
        connectionId: 'conn-01k',
      }),
    ).toEqual({
      type: 'hello',
      protocolVersion: 1,
      workspaceRoot: 'default',
      serverTime: MODIFIED_AT,
      lastSeq: 1234,
      connectionId: 'conn-01k',
    });
    expect(() =>
      buildHello({ workspaceRoot: 'default', serverTime: 'xx', lastSeq: 0, connectionId: 'c' }),
    ).toThrow(/serverTime/);
    expect(() =>
      buildHello({ workspaceRoot: 'default', serverTime: MODIFIED_AT, lastSeq: -1, connectionId: 'c' }),
    ).toThrow(/lastSeq/);
  });

  it('builds resync-required, resync-ok, pong, and error messages', () => {
    expect(buildResyncRequired(1234)).toEqual({ type: 'resync-required', lastSeq: 1234 });
    expect(buildResyncOk(1234)).toEqual({ type: 'resync-ok', lastSeq: 1234 });
    expect(buildPong(MODIFIED_AT)).toEqual({ type: 'pong', serverTime: MODIFIED_AT });
    expect(buildError(ERROR_CODE_MALFORMED_MESSAGE, 'bad json')).toEqual({
      type: 'error',
      code: 'malformed_message',
      message: 'bad json',
    });
    expect(buildError(ERROR_CODE_UNKNOWN_MESSAGE_TYPE, 'nope').code).toBe('unknown_message_type');
    expect(() => buildResyncRequired(-1)).toThrow(/lastSeq/);
    expect(() => buildPong('xx')).toThrow(/serverTime/);
    expect(() => buildError('', 'x')).toThrow(/code/);
  });
});

describe('batch chunking (desain 9.3, max 500)', () => {
  it('chunks 501 and 1200 events into ordered batches of at most 500', () => {
    const events = Array.from({ length: 1200 }, (_, i) => eventAt(i + 1));
    const batches = chunkEvents(events);
    expect(batches).toHaveLength(3);
    expect(batches[0]?.events).toHaveLength(500);
    expect(batches[1]?.events).toHaveLength(500);
    expect(batches[2]?.events).toHaveLength(200);
    expect(batches.flatMap((batch) => batch.events.map((event) => event.seq))).toEqual(
      events.map((event) => event.seq),
    );
  });

  it('yields zero batches for zero events (A-W8) and rejects empty/oversized batches', () => {
    expect(chunkEvents([])).toEqual([]);
    expect(() => buildBatch([])).toThrow(/at least one event/);
    const oversized = Array.from({ length: 501 }, (_, i) => eventAt(i + 1));
    expect(() => buildBatch(oversized)).toThrow(/exceeds the 500 cap/);
    expect(buildBatch([eventAt(1)]).events).toHaveLength(1);
  });
});

describe('validateServerMessage / parseServerMessage (wire conformance)', () => {
  it('accepts every documented server message type from raw JSON text', () => {
    const texts = [
      JSON.stringify(buildWorkspaceFileChanged(fileInput())),
      JSON.stringify(
        buildHello({
          workspaceRoot: 'default',
          serverTime: MODIFIED_AT,
          lastSeq: 1234,
          connectionId: 'conn-01k',
        }),
      ),
      '{"type":"resync-required","lastSeq":1234}',
      JSON.stringify(buildBatch([eventAt(1), eventAt(2)])),
      '{"type":"error","code":"malformed_message","message":"bad"}',
      '{"type":"pong","serverTime":"2026-11-14T13:00:00.000Z"}',
      '{"type":"resync-ok","lastSeq":1234}',
    ];
    for (const text of texts) {
      const result = parseServerMessage(text);
      expect(result.ok).toBe(true);
    }
  });

  it('rejects invalid JSON, non-objects, and unknown types', () => {
    expect(parseServerMessage('{bukan json')).toEqual({
      ok: false,
      errors: ['message is not valid JSON'],
    });
    expect(validateServerMessage([1, 2])).toEqual({
      ok: false,
      errors: ['message must be a JSON object'],
    });
    const unknown = validateServerMessage({ type: 'subscribe', folder: 'x' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.errors[0]).toMatch(/unknown server message type/);
    }
  });

  it('rejects a hello with the wrong protocol version or bad fields', () => {
    const wrong = validateServerMessage({
      type: 'hello',
      protocolVersion: 2,
      workspaceRoot: 'default',
      serverTime: MODIFIED_AT,
      lastSeq: 0,
      connectionId: 'c',
    });
    expect(wrong.ok).toBe(false);
    const badSeq = validateServerMessage({ type: 'resync-ok', lastSeq: -1 });
    expect(badSeq.ok).toBe(false);
  });

  it('rejects batches that are empty, oversized, or hold a bad event', () => {
    expect(validateServerMessage({ type: 'batch', events: [] }).ok).toBe(false);
    const oversized = {
      type: 'batch',
      events: Array.from({ length: 501 }, (_, i) => eventAt(i + 1)),
    };
    expect(validateServerMessage(oversized).ok).toBe(false);
    const badEvent = validateServerMessage({
      type: 'batch',
      events: [{ ...eventAt(1), kind: 'renamed' }],
    });
    expect(badEvent.ok).toBe(false);
    if (!badEvent.ok) {
      expect(badEvent.errors[0]).toMatch(/events\[0\]/);
    }
  });

  it('rejects event shapes that violate the null rules', () => {
    const deleted = validateServerMessage({
      ...buildWorkspaceFileChanged(
        fileInput({ kind: 'deleted', revision: null, modifiedAt: null }),
      ),
      revision: REVISION,
    });
    expect(deleted.ok).toBe(false);
  });

  it('tolerates unknown extra fields (A-W4)', () => {
    const result = validateServerMessage({
      ...buildWorkspaceFileChanged(fileInput()),
      futureField: 'ignored',
    });
    expect(result.ok).toBe(true);
  });
});

describe('parseClientMessage (desain 9.2/9.3)', () => {
  it('accepts ping and resync, the only two MVP client messages', () => {
    expect(parseClientMessage('{"type":"ping"}')).toEqual({
      outcome: 'ok',
      message: { type: 'ping' },
    });
    expect(parseClientMessage('{"type":"resync","sinceSeq":1200}')).toEqual({
      outcome: 'ok',
      message: { type: 'resync', sinceSeq: 1200 },
    });
    expect(parseClientMessage('{"type":"resync","sinceSeq":0}').outcome).toBe('ok');
  });

  it('reports invalid JSON, non-objects, and bad sinceSeq as malformed', () => {
    expect(parseClientMessage('bukan json').outcome).toBe('malformed');
    expect(parseClientMessage('[1]').outcome).toBe('malformed');
    expect(parseClientMessage('{"type":"resync"}').outcome).toBe('malformed');
    expect(parseClientMessage('{"type":"resync","sinceSeq":-1}').outcome).toBe('malformed');
    expect(parseClientMessage('{"type":"resync","sinceSeq":1.5}').outcome).toBe('malformed');
    expect(parseClientMessage('{"type":"resync","sinceSeq":"1200"}').outcome).toBe('malformed');
  });

  it('reports unknown types distinctly from malformed input (A-W2)', () => {
    const result = parseClientMessage('{"type":"subscribe","folder":"x"}');
    expect(result).toEqual({
      outcome: 'unknown-type',
      type: 'subscribe',
      errors: ['unknown client message type: subscribe'],
    });
  });
});

describe('InMemorySeqAllocator (desain 9.4 seam)', () => {
  it('allocates strictly increasing seq values starting above its start', async () => {
    const allocator = new InMemorySeqAllocator(10);
    await expect(allocator.next()).resolves.toBe(11);
    await expect(allocator.next()).resolves.toBe(12);
    expect(allocator.lastAllocated()).toBe(12);
    const fresh = new InMemorySeqAllocator();
    await expect(fresh.next()).resolves.toBe(1);
    expect(() => new InMemorySeqAllocator(-1)).toThrow(/start must be/);
  });
});

describe('EventRingBuffer (desain 9.4)', () => {
  it('starts at lastSeq 0 and answers ok with no events when up to date', () => {
    const buffer = new EventRingBuffer();
    expect(buffer.lastSeq).toBe(0);
    expect(buffer.replay(0)).toEqual({ outcome: 'ok', events: [] });
    expect(buffer.replay(99)).toEqual({ outcome: 'ok', events: [] });
  });

  it('replays exactly the events above sinceSeq, in order', () => {
    const buffer = new EventRingBuffer();
    buffer.append(eventAt(1));
    buffer.append(eventAt(2));
    buffer.append(eventAt(3));
    expect(buffer.replay(1)).toEqual({ outcome: 'ok', events: [eventAt(2), eventAt(3)] });
    expect(buffer.replay(3)).toEqual({ outcome: 'ok', events: [] });
    expect(buffer.lastSeq).toBe(3);
  });

  it('requires resync when the buffer rotated past sinceSeq', () => {
    const buffer = new EventRingBuffer({ capacity: 3 });
    for (let seq = 1; seq <= 5; seq += 1) {
      buffer.append(eventAt(seq));
    }
    expect(buffer.size).toBe(3);
    expect(buffer.replay(2)).toEqual({ outcome: 'ok', events: [eventAt(3), eventAt(4), eventAt(5)] });
    expect(buffer.replay(1)).toEqual({ outcome: 'resync-required', lastSeq: 5 });
    expect(buffer.replay(0)).toEqual({ outcome: 'resync-required', lastSeq: 5 });
  });

  it('evicts the oldest event once the 1000-event capacity is exceeded', () => {
    const buffer = new EventRingBuffer();
    for (let seq = 1; seq <= 1001; seq += 1) {
      buffer.append(eventAt(seq));
    }
    expect(buffer.size).toBe(1000);
    expect(buffer.replay(0).outcome).toBe('resync-required');
    const replayed = buffer.replay(1);
    expect(replayed.outcome).toBe('ok');
    if (replayed.outcome === 'ok') {
      expect(replayed.events[0]?.seq).toBe(2);
      expect(replayed.events).toHaveLength(1000);
    }
  });

  it('requires resync from an empty buffer seeded past sinceSeq (A-W5)', () => {
    const buffer = new EventRingBuffer({ startingSeq: 500 });
    expect(buffer.lastSeq).toBe(500);
    expect(buffer.replay(100)).toEqual({ outcome: 'resync-required', lastSeq: 500 });
    expect(buffer.replay(500)).toEqual({ outcome: 'ok', events: [] });
  });

  it('tolerates sequence gaps by replaying what exists above sinceSeq (A-W7)', () => {
    const buffer = new EventRingBuffer();
    buffer.append(eventAt(10));
    buffer.append(eventAt(12));
    expect(buffer.replay(9)).toEqual({ outcome: 'ok', events: [eventAt(10), eventAt(12)] });
    expect(buffer.replay(11)).toEqual({ outcome: 'ok', events: [eventAt(12)] });
  });

  it('rejects non-increasing seq and bad replay arguments', () => {
    const buffer = new EventRingBuffer();
    buffer.append(eventAt(5));
    expect(() => buffer.append(eventAt(5))).toThrow(/monotonically/);
    expect(() => buffer.append(eventAt(4))).toThrow(/monotonically/);
    expect(() => buffer.replay(-1)).toThrow(/sinceSeq/);
    expect(() => new EventRingBuffer({ capacity: 0 })).toThrow(/capacity/);
  });
});

describe('MalformedTracker (desain 9.2: 5 malformed in 1 minute closes with 1008)', () => {
  it('closes only on the fifth malformed message inside the window', () => {
    const tracker = new MalformedTracker();
    expect(tracker.record(0)).toBe(false);
    expect(tracker.record(1000)).toBe(false);
    expect(tracker.record(2000)).toBe(false);
    expect(tracker.record(3000)).toBe(false);
    expect(tracker.record(4000)).toBe(true);
    expect(tracker.count(4000)).toBe(5);
  });

  it('forgets malformed messages older than the window', () => {
    const tracker = new MalformedTracker();
    for (let i = 0; i < 4; i += 1) {
      tracker.record(i * 1000);
    }
    expect(tracker.record(60001)).toBe(false);
    expect(tracker.count(60001)).toBe(4);
    expect(tracker.record(60002)).toBe(true);
  });
});

describe('translateWatcherRawEvent (desain 9.6)', () => {
  it('maps add/addDir/change/unlink/unlinkDir and never invents moved', () => {
    expect(translateWatcherRawEvent({ event: 'add', path: 'a.md' })).toEqual({
      kind: 'created',
      path: 'a.md',
      isDirectory: false,
    });
    expect(translateWatcherRawEvent({ event: 'addDir', path: 'folder' })).toEqual({
      kind: 'created',
      path: 'folder',
      isDirectory: true,
    });
    expect(translateWatcherRawEvent({ event: 'change', path: 'a.md' })).toEqual({
      kind: 'changed',
      path: 'a.md',
      isDirectory: false,
    });
    expect(translateWatcherRawEvent({ event: 'unlink', path: 'a.md' })).toEqual({
      kind: 'deleted',
      path: 'a.md',
      isDirectory: false,
    });
    expect(translateWatcherRawEvent({ event: 'unlinkDir', path: 'folder' })).toEqual({
      kind: 'deleted',
      path: 'folder',
      isDirectory: true,
    });
  });

  it('filters dot-leading paths to null', () => {
    expect(translateWatcherRawEvent({ event: 'add', path: '.notegen-tmp-x/note.md' })).toBeNull();
    expect(translateWatcherRawEvent({ event: 'change', path: '' })).toBeNull();
  });
});

describe('DedupeMarks (desain 9.6)', () => {
  it('suppresses same path+revision watcher events inside 500 ms', () => {
    const marks = new DedupeMarks();
    marks.mark('a.md', REVISION, 1000);
    expect(marks.shouldSuppress('a.md', REVISION, 1200)).toBe(true);
    expect(marks.shouldSuppress('a.md', REVISION, 1500)).toBe(true);
    expect(marks.shouldSuppress('a.md', REVISION, 1501)).toBe(false);
    expect(marks.shouldSuppress('a.md', 'sha256:other', 1200)).toBe(false);
    expect(marks.shouldSuppress('b.md', REVISION, 1200)).toBe(false);
  });

  it('expires marks after 1000 ms', () => {
    const marks = new DedupeMarks();
    marks.mark('a.md', REVISION, 1000);
    expect(marks.shouldSuppress('a.md', REVISION, 2000)).toBe(false);
    expect(marks.shouldSuppress('a.md', REVISION, 2001)).toBe(false);
  });
});

describe('actor resolution, close actions, and backoff tables', () => {
  it('resolves actor labels with system, agent, self, other precedence (A-W6)', () => {
    const base = { originConnectionId: 'conn-1', connectionId: 'conn-1' };
    expect(resolveActor({ ...base, isSystem: true, isProgrammatic: true })).toBe('system');
    expect(resolveActor({ ...base, isSystem: false, isProgrammatic: true })).toBe('agent');
    expect(resolveActor({ ...base, isSystem: false, isProgrammatic: false })).toBe('self');
    expect(
      resolveActor({
        originConnectionId: 'conn-2',
        connectionId: 'conn-1',
        isSystem: false,
        isProgrammatic: false,
      }),
    ).toBe('other');
    expect(
      resolveActor({
        originConnectionId: null,
        connectionId: 'conn-1',
        isSystem: false,
        isProgrammatic: false,
      }),
    ).toBe('other');
  });

  it('maps every close code to its desain 9.2 client action', () => {
    expect(closeCodeClientAction(1000)).toBe('none');
    expect(closeCodeClientAction(1001)).toBe('reconnect-resync');
    expect(closeCodeClientAction(1008)).toBe('reconnect-once-then-poll');
    expect(closeCodeClientAction(1011)).toBe('reconnect-resync');
    expect(closeCodeClientAction(4401)).toBe('relogin');
    expect(closeCodeClientAction(4403)).toBe('show-error');
    expect(closeCodeClientAction(9999)).toBe('show-error');
  });

  it('computes reconnect backoff caps 1s, 2s, 4s, 8s, then 15s capped', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(reconnectBackoffCapMs)).toEqual([
      1000, 2000, 4000, 8000, 15000, 15000, 15000,
    ]);
    expect(() => reconnectBackoffCapMs(-1)).toThrow(/attempt/);
  });

  it('computes watcher reinstall delays 5s, 15s, then 60s capped', () => {
    expect([0, 1, 2, 3, 9].map(watcherReinstallDelayMs)).toEqual([5000, 15000, 60000, 60000, 60000]);
    expect(() => watcherReinstallDelayMs(-1)).toThrow(/attempt/);
  });
});

describe('producer mappings (three narrow shapes, never mixed)', () => {
  const context = {
    workspaceRoot: 'default',
    actor: 'other' as const,
    originConnectionId: 'conn-01k',
  };

  it('maps WorkspaceWriteEvent (frozen write-ports shape) with caller-supplied facts', () => {
    const writeEvent: WorkspaceWriteEvent = {
      kind: 'changed',
      path: 'a.md',
      revision: REVISION,
      version: 3,
      actorId: 'user-1',
    };
    const draft = mapWriteEventToWireDraft(writeEvent, { ...context, modifiedAt: MODIFIED_AT });
    expect(draft).toEqual({
      kind: 'changed',
      path: 'a.md',
      previousPath: null,
      workspaceRoot: 'default',
      revision: REVISION,
      modifiedAt: MODIFIED_AT,
      isDirectory: false,
      actor: 'other',
      originConnectionId: 'conn-01k',
    });
    const built = buildWorkspaceFileChanged({ ...draft, seq: 7 });
    expect(validateServerMessage(built).ok).toBe(true);
  });

  it('maps a trash deleted notice, drops trashId, and forces null revision (05c seam)', () => {
    // Typed as the TrashEvent shape on the V3-05 branch to prove the
    // mapping accepts it structurally; trashId is dropped by design.
    const notice: {
      kind: 'deleted';
      path: string;
      trashId: string;
      actorId: string | undefined;
    } = { kind: 'deleted', path: 'a.md', trashId: 'trash-1', actorId: 'user-1' };
    const draft = mapTrashNoticeToWireDraft(notice, { ...context, isDirectory: false });
    expect(draft).toEqual({
      kind: 'deleted',
      path: 'a.md',
      previousPath: null,
      workspaceRoot: 'default',
      revision: null,
      modifiedAt: null,
      isDirectory: false,
      actor: 'other',
      originConnectionId: 'conn-01k',
    });
    expect('trashId' in draft).toBe(false);
    expect(() =>
      mapTrashNoticeToWireDraft(
        { kind: 'deleted', path: 'a.md' },
        { ...context, isDirectory: false, revision: REVISION },
      ),
    ).toThrow(/must not carry/);
  });

  it('maps a trash restore notice only with caller-supplied revision facts (05c seam)', () => {
    const draft = mapTrashNoticeToWireDraft(
      { kind: 'created', path: 'a.md' },
      { ...context, isDirectory: false, revision: REVISION, modifiedAt: MODIFIED_AT },
    );
    expect(draft.kind).toBe('created');
    expect(draft.revision).toBe(REVISION);
    expect(() =>
      mapTrashNoticeToWireDraft(
        { kind: 'created', path: 'a.md' },
        { ...context, isDirectory: false },
      ),
    ).toThrow(/require revision/);
  });

  it('maps a delete notice identically except for the wire context (07b seam)', () => {
    const draft = mapDeleteNoticeToWireDraft(
      {
        kind: 'deleted',
        path: 'media/pic.png',
        previousPath: null,
        revision: null,
        modifiedAt: null,
        isDirectory: false,
      },
      context,
    );
    expect(draft).toEqual({
      kind: 'deleted',
      path: 'media/pic.png',
      previousPath: null,
      workspaceRoot: 'default',
      revision: null,
      modifiedAt: null,
      isDirectory: false,
      actor: 'other',
      originConnectionId: 'conn-01k',
    });
    const built = buildWorkspaceFileChanged({ ...draft, seq: 9 });
    expect(validateServerMessage(built).ok).toBe(true);
  });
});
