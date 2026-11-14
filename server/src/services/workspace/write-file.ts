// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace write service (V3-04b, wave 3A): PUT file, append,
// patch, and media upload over one atomic write path.
//
// Order of operations per write (desain-workspace-api.md section
// 3.7): validate the path and the body, take the per-path queue
// slot, re-read current state from disk, evaluate the guard against
// the freshly read revision, write to a temp file in the same
// directory, fsync, rename atomically over the target, fsync the
// parent directory (best effort), then update the index and the
// file_events journal in one transaction. Disk first, index second,
// exactly as specified: when the index transaction fails after the
// rename, the answer is 500 index_update_failed with
// details.diskWritten true and the new revision, and the rename is
// never rolled back. Event publication is coalesced and best effort
// (see write-queue.ts) and never fails a write.
//
// Guards use the amended K-03 rule (see write-guards.ts): 412 for
// PUT file/media, 409 for append/patch, with the same conflict
// payload shape in error.details. A stale guard never overwrites
// silently: the conflicting write is rejected and the disk bytes
// are untouched.
//
// This service never calls the path or revision logic directly: it
// goes through the injected ports (write-ports.ts), which V3-04a
// implements. It never builds SQL strings: index writes go through
// the injected index port (Postgres implementation in
// write-index-pg.ts). It never logs content, secrets, or absolute
// paths.

import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SessionPrincipal } from '../../middleware/auth-hook.js';
import { ApiError } from '../../plugins/envelope.js';
import {
  applyLinePatch,
  buildPreview,
  decodeUtf8Strict,
  isValidUtf8,
  revisionConflictError,
  validatePatchRange,
  type BodyGuard,
  type ConflictState,
  type HeaderGuard,
} from './write-guards.js';
import {
  hashBytes,
  hashIdempotencyRequest,
  IDEMPOTENCY_SCOPE,
  stableStringify,
} from './write-idempotency.js';
import { mediaUrlFor, validateMedia } from './write-media.js';
import type {
  ResolvedWorkspacePath,
  StoredIdempotentResponse,
  WorkspaceIdentity,
  WorkspaceIdentityResolver,
  WorkspaceWritePorts,
} from './write-ports.js';
import { CoalescingEventSink, WriteQueue } from './write-queue.js';

export const TEXT_LIMIT_BYTES = 2 * 1024 * 1024;
export const MEDIA_LIMIT_BYTES = 20 * 1024 * 1024;

export interface WriteServiceDeps {
  ports: WorkspaceWritePorts;
  resolveIdentity?: WorkspaceIdentityResolver;
  queue?: WriteQueue;
  eventSink?: CoalescingEventSink;
  textLimitBytes?: number;
  mediaLimitBytes?: number;
}

export interface FileWriteData {
  path: string;
  revision: string;
  version: number | null;
  size: number;
  modifiedAt: string;
  created: boolean;
}

export interface AppendWriteData extends FileWriteData {
  appendedBytes: number;
}

export interface PatchWriteData extends FileWriteData {
  patchedLines: number;
}

export interface MediaWriteData {
  path: string;
  revision: string;
  version: number | null;
  size: number;
  mimeType: string;
  detectedType: string;
  disposition: 'inline' | 'attachment';
  mediaUrl: string;
  modifiedAt: string;
}

export interface ResponseHeaders {
  etag: string;
  revision: string;
  lastModified: string;
  version: string | undefined;
}

export interface WriteOutcome<TData> {
  status: 200 | 201;
  data: TData;
  headers: ResponseHeaders;
  forced: boolean;
  oldRevision: string | null;
  replayed: boolean;
}

interface CurrentState {
  exists: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  content: Buffer | null;
  size: number;
  modifiedAt: Date | null;
}

function contentHashOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function headersFor(revision: string, version: number | null, modifiedAt: Date): ResponseHeaders {
  return {
    etag: `"${revision}"`,
    revision,
    lastModified: modifiedAt.toUTCString(),
    version: version === null ? undefined : String(version),
  };
}

function isNotDirError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOTDIR'
  );
}

function textMimeType(normalizedPath: string): string | null {
  if (normalizedPath.endsWith('.md')) {
    return 'text/markdown';
  }
  if (normalizedPath.endsWith('.txt')) {
    return 'text/plain';
  }
  return null;
}

export class WorkspaceWriteService {
  private readonly ports: WorkspaceWritePorts;
  private readonly resolveIdentity: WorkspaceIdentityResolver | undefined;
  private readonly queue: WriteQueue;
  private readonly eventSink: CoalescingEventSink;
  private readonly textLimitBytes: number;
  private readonly mediaLimitBytes: number;

  constructor(deps: WriteServiceDeps) {
    this.ports = deps.ports;
    this.resolveIdentity = deps.resolveIdentity;
    this.queue = deps.queue ?? new WriteQueue();
    this.eventSink =
      deps.eventSink ?? new CoalescingEventSink(deps.ports.events);
    this.textLimitBytes = deps.textLimitBytes ?? TEXT_LIMIT_BYTES;
    this.mediaLimitBytes = deps.mediaLimitBytes ?? MEDIA_LIMIT_BYTES;
  }

  // Flushes coalesced events immediately. Used by tests and by
  // graceful shutdown; production request handling never waits for
  // it.
  async flushEvents(): Promise<void> {
    await this.eventSink.flush();
  }

  async putFile(input: {
    rawPath: unknown;
    guard: HeaderGuard;
    body: Buffer;
    idempotencyKey: string | undefined;
    principal: SessionPrincipal | undefined;
  }): Promise<WriteOutcome<FileWriteData>> {
    if (input.guard.kind === 'none') {
      throw ApiError.preconditionRequired();
    }
    if (input.body.length > this.textLimitBytes) {
      throw ApiError.textTooLarge();
    }
    if (!isValidUtf8(input.body)) {
      throw new ApiError(422, 'invalid_text_encoding', 'The content is not valid UTF-8 text.');
    }
    const preResolved = await this.ports.paths.resolveWritePath(input.rawPath);
    return this.queue.run(preResolved.normalized, async () => {
      const resolved = await this.ports.paths.resolveWritePath(input.rawPath);
      const identity = await this.identityForPg(input.principal);
      const replay = await this.checkIdempotency<FileWriteData>(identity, input.idempotencyKey, {
        method: 'PUT',
        path: resolved.normalized,
        guard: JSON.stringify(input.guard),
        bodyHash: hashBytes(input.body),
      });
      if (replay !== null) {
        return replay;
      }
      const current = await this.readCurrent(resolved);
      if (current.isDirectory) {
        throw ApiError.invalidPath();
      }
      if (current.isSymlink) {
        throw new ApiError(400, 'symlink_not_allowed', 'Symlinks are not allowed.');
      }
      const currentRevision =
        current.exists && current.content !== null
          ? this.ports.revisions.compute(resolved.normalized, current.content)
          : null;
      const { created, forced } = await this.evaluateHeaderGuard({
        guard: input.guard,
        resolved,
        current,
        currentRevision,
        identity,
        status: 412,
        isText: true,
      });
      const written = await this.commitWrite({
        resolved,
        content: input.body,
        identity,
        created,
        mimeType: textMimeType(resolved.normalized),
        eventType: created ? 'created' : 'changed',
      });
      const data: FileWriteData = {
        path: resolved.normalized,
        revision: written.revision,
        version: written.version,
        size: input.body.length,
        modifiedAt: written.modifiedAt.toISOString(),
        created,
      };
      const outcome: WriteOutcome<FileWriteData> = {
        status: created ? 201 : 200,
        data,
        headers: headersFor(written.revision, written.version, written.modifiedAt),
        forced,
        oldRevision: currentRevision,
        replayed: false,
      };
      await this.storeIdempotency(identity, input.idempotencyKey, {
        method: 'PUT',
        path: resolved.normalized,
        guard: JSON.stringify(input.guard),
        bodyHash: hashBytes(input.body),
      }, outcome);
      this.eventSink.note({
        kind: created ? 'created' : 'changed',
        path: resolved.normalized,
        revision: written.revision,
        version: written.version,
        actorId: identity?.actorId,
      });
      return outcome;
    });
  }

  async appendFile(input: {
    rawPath: unknown;
    guard: BodyGuard;
    content: string;
    idempotencyKey: string | undefined;
    principal: SessionPrincipal | undefined;
  }): Promise<WriteOutcome<AppendWriteData>> {
    const contentBytes = Buffer.from(input.content, 'utf8');
    const preResolved = await this.ports.paths.resolveWritePath(input.rawPath);
    return this.queue.run(preResolved.normalized, async () => {
      const resolved = await this.ports.paths.resolveWritePath(input.rawPath);
      const identity = await this.identityForPg(input.principal);
      const replay = await this.checkIdempotency<AppendWriteData>(identity, input.idempotencyKey, {
        method: 'POST',
        path: resolved.normalized,
        guard: JSON.stringify(input.guard),
        bodyHash: hashBytes(contentBytes),
      });
      if (replay !== null) {
        return replay;
      }
      const current = await this.readCurrent(resolved);
      if (!current.exists || current.isDirectory || current.content === null) {
        throw ApiError.notFound();
      }
      if (current.isSymlink) {
        throw new ApiError(400, 'symlink_not_allowed', 'Symlinks are not allowed.');
      }
      const currentRevision = this.ports.revisions.compute(resolved.normalized, current.content);
      const forced = await this.evaluateBodyGuard({
        guard: input.guard,
        resolved,
        current,
        currentRevision,
        identity,
        failedOperation: 'append',
      });
      if (!isValidUtf8(current.content)) {
        throw new ApiError(422, 'invalid_text_encoding', 'The content is not valid UTF-8 text.');
      }
      if (contentBytes.length === 0) {
        // Empty append is a no-op: no disk write, no version bump,
        // no event. The current revision is returned unchanged.
        const version =
          identity !== null && this.ports.index !== undefined
            ? await this.ports.index.currentVersion(identity.workspaceId, resolved.normalized)
            : null;
        const modifiedAt = current.modifiedAt ?? new Date(0);
        const data: AppendWriteData = {
          path: resolved.normalized,
          revision: currentRevision,
          version,
          size: current.size,
          modifiedAt: modifiedAt.toISOString(),
          created: false,
          appendedBytes: 0,
        };
        const outcome: WriteOutcome<AppendWriteData> = {
          status: 200,
          data,
          headers: headersFor(currentRevision, version, modifiedAt),
          forced,
          oldRevision: currentRevision,
          replayed: false,
        };
        await this.storeIdempotency(identity, input.idempotencyKey, {
          method: 'POST',
          path: resolved.normalized,
          guard: JSON.stringify(input.guard),
          bodyHash: hashBytes(contentBytes),
        }, outcome);
        return outcome;
      }
      const next = Buffer.concat([current.content, contentBytes]);
      if (next.length > this.textLimitBytes) {
        throw ApiError.textTooLarge();
      }
      const written = await this.commitWrite({
        resolved,
        content: next,
        identity,
        created: false,
        mimeType: textMimeType(resolved.normalized),
        eventType: 'changed',
      });
      const data: AppendWriteData = {
        path: resolved.normalized,
        revision: written.revision,
        version: written.version,
        size: next.length,
        modifiedAt: written.modifiedAt.toISOString(),
        created: false,
        appendedBytes: contentBytes.length,
      };
      const outcome: WriteOutcome<AppendWriteData> = {
        status: 200,
        data,
        headers: headersFor(written.revision, written.version, written.modifiedAt),
        forced,
        oldRevision: currentRevision,
        replayed: false,
      };
      await this.storeIdempotency(identity, input.idempotencyKey, {
        method: 'POST',
        path: resolved.normalized,
        guard: JSON.stringify(input.guard),
        bodyHash: hashBytes(contentBytes),
      }, outcome);
      this.eventSink.note({
        kind: 'changed',
        path: resolved.normalized,
        revision: written.revision,
        version: written.version,
        actorId: identity?.actorId,
      });
      return outcome;
    });
  }

  async patchFile(input: {
    rawPath: unknown;
    guard: BodyGuard;
    startLine: number;
    endLine: number;
    replacement: string;
    idempotencyKey: string | undefined;
    principal: SessionPrincipal | undefined;
  }): Promise<WriteOutcome<PatchWriteData>> {
    const preResolved = await this.ports.paths.resolveWritePath(input.rawPath);
    return this.queue.run(preResolved.normalized, async () => {
      const resolved = await this.ports.paths.resolveWritePath(input.rawPath);
      const identity = await this.identityForPg(input.principal);
      const bodyHash = hashBytes(
        Buffer.from(
          stableStringify({
            startLine: input.startLine,
            endLine: input.endLine,
            replacement: input.replacement,
          }),
          'utf8',
        ),
      );
      const replay = await this.checkIdempotency<PatchWriteData>(identity, input.idempotencyKey, {
        method: 'POST',
        path: resolved.normalized,
        guard: JSON.stringify(input.guard),
        bodyHash,
      });
      if (replay !== null) {
        return replay;
      }
      const current = await this.readCurrent(resolved);
      if (!current.exists || current.isDirectory || current.content === null) {
        throw ApiError.notFound();
      }
      if (current.isSymlink) {
        throw new ApiError(400, 'symlink_not_allowed', 'Symlinks are not allowed.');
      }
      const currentRevision = this.ports.revisions.compute(resolved.normalized, current.content);
      const forced = await this.evaluateBodyGuard({
        guard: input.guard,
        resolved,
        current,
        currentRevision,
        identity,
        failedOperation: 'patch',
      });
      let text: string;
      try {
        text = decodeUtf8Strict(current.content);
      } catch {
        throw new ApiError(422, 'invalid_text_encoding', 'The content is not valid UTF-8 text.');
      }
      validatePatchRange(text, input.startLine, input.endLine);
      const nextText = applyLinePatch(text, input.startLine, input.endLine, input.replacement);
      const next = Buffer.from(nextText, 'utf8');
      if (next.length > this.textLimitBytes) {
        throw ApiError.textTooLarge();
      }
      const written = await this.commitWrite({
        resolved,
        content: next,
        identity,
        created: false,
        mimeType: textMimeType(resolved.normalized),
        eventType: 'changed',
      });
      const data: PatchWriteData = {
        path: resolved.normalized,
        revision: written.revision,
        version: written.version,
        size: next.length,
        modifiedAt: written.modifiedAt.toISOString(),
        created: false,
        patchedLines: input.endLine - input.startLine,
      };
      const outcome: WriteOutcome<PatchWriteData> = {
        status: 200,
        data,
        headers: headersFor(written.revision, written.version, written.modifiedAt),
        forced,
        oldRevision: currentRevision,
        replayed: false,
      };
      await this.storeIdempotency(identity, input.idempotencyKey, {
        method: 'POST',
        path: resolved.normalized,
        guard: JSON.stringify(input.guard),
        bodyHash,
      }, outcome);
      this.eventSink.note({
        kind: 'changed',
        path: resolved.normalized,
        revision: written.revision,
        version: written.version,
        actorId: identity?.actorId,
      });
      return outcome;
    });
  }

  async writeMedia(input: {
    rawPath: unknown;
    guard: HeaderGuard;
    body: Buffer;
    idempotencyKey: string | undefined;
    principal: SessionPrincipal | undefined;
  }): Promise<WriteOutcome<MediaWriteData>> {
    if (input.guard.kind === 'none') {
      throw ApiError.preconditionRequired();
    }
    if (input.body.length > this.mediaLimitBytes) {
      throw ApiError.mediaTooLarge();
    }
    const preResolved = await this.ports.paths.resolveWritePath(input.rawPath);
    const validation = validateMedia(preResolved.normalized, input.body);
    return this.queue.run(preResolved.normalized, async () => {
      const resolved = await this.ports.paths.resolveWritePath(input.rawPath);
      const identity = await this.identityForPg(input.principal);
      const replay = await this.checkIdempotency<MediaWriteData>(identity, input.idempotencyKey, {
        method: 'MEDIA',
        path: resolved.normalized,
        guard: JSON.stringify(input.guard),
        bodyHash: hashBytes(input.body),
      });
      if (replay !== null) {
        return replay;
      }
      const current = await this.readCurrent(resolved);
      if (current.isDirectory) {
        throw ApiError.invalidPath();
      }
      if (current.isSymlink) {
        throw new ApiError(400, 'symlink_not_allowed', 'Symlinks are not allowed.');
      }
      const currentRevision =
        current.exists && current.content !== null
          ? this.ports.revisions.compute(resolved.normalized, current.content)
          : null;
      const { created, forced } = await this.evaluateHeaderGuard({
        guard: input.guard,
        resolved,
        current,
        currentRevision,
        identity,
        status: 412,
        isText: false,
      });
      const written = await this.commitWrite({
        resolved,
        content: input.body,
        identity,
        created,
        mimeType: validation.mimeType,
        eventType: created ? 'created' : 'changed',
      });
      const data: MediaWriteData = {
        path: resolved.normalized,
        revision: written.revision,
        version: written.version,
        size: input.body.length,
        mimeType: validation.mimeType,
        detectedType: validation.detectedType,
        disposition: validation.disposition,
        mediaUrl: mediaUrlFor(resolved.normalized),
        modifiedAt: written.modifiedAt.toISOString(),
      };
      const outcome: WriteOutcome<MediaWriteData> = {
        status: created ? 201 : 200,
        data,
        headers: headersFor(written.revision, written.version, written.modifiedAt),
        forced,
        oldRevision: currentRevision,
        replayed: false,
      };
      await this.storeIdempotency(identity, input.idempotencyKey, {
        method: 'MEDIA',
        path: resolved.normalized,
        guard: JSON.stringify(input.guard),
        bodyHash: hashBytes(input.body),
      }, outcome);
      this.eventSink.note({
        kind: created ? 'created' : 'changed',
        path: resolved.normalized,
        revision: written.revision,
        version: written.version,
        actorId: identity?.actorId,
      });
      return outcome;
    });
  }

  // Resolves the identity needed by Postgres-backed ports, or null
  // when no such port is wired. Fails closed (503) when a Postgres
  // port is wired but no identity can be attributed: writing without
  // attribution would corrupt the index and the idempotency store.
  private async identityForPg(principal: SessionPrincipal | undefined): Promise<WorkspaceIdentity | null> {
    const needsPg = this.ports.index !== undefined || this.ports.idempotency !== undefined;
    if (!needsPg) {
      return null;
    }
    if (principal === undefined || this.resolveIdentity === undefined) {
      throw ApiError.serviceUnavailable();
    }
    const identity = await this.resolveIdentity(principal);
    if (identity === null) {
      throw ApiError.serviceUnavailable();
    }
    return identity;
  }

  private async checkIdempotency<TData>(
    identity: WorkspaceIdentity | null,
    key: string | undefined,
    request: { method: string; path: string; guard: string; bodyHash: string },
  ): Promise<WriteOutcome<TData> | null> {
    if (this.ports.idempotency === undefined || key === undefined || identity === null) {
      return null;
    }
    const requestHash = hashIdempotencyRequest(request);
    const result = await this.ports.idempotency.lookup({
      userId: identity.userId,
      scope: IDEMPOTENCY_SCOPE,
      key,
      requestHash,
    });
    if (result.outcome === 'miss') {
      return null;
    }
    if (result.outcome === 'reused') {
      throw new ApiError(409, 'idempotency_key_reused', 'The idempotency key was already used with a different request.');
    }
    const stored: StoredIdempotentResponse = result.response;
    return {
      status: stored.status === 201 ? 201 : 200,
      data: stored.data as unknown as TData,
      headers: stored.headers,
      forced: false,
      oldRevision: null,
      replayed: true,
    };
  }

  private async storeIdempotency<TData>(
    identity: WorkspaceIdentity | null,
    key: string | undefined,
    request: { method: string; path: string; guard: string; bodyHash: string },
    outcome: WriteOutcome<TData>,
  ): Promise<void> {
    if (this.ports.idempotency === undefined || key === undefined || identity === null) {
      return;
    }
    try {
      await this.ports.idempotency.store({
        userId: identity.userId,
        scope: IDEMPOTENCY_SCOPE,
        key,
        requestHash: hashIdempotencyRequest(request),
        response: {
          status: outcome.status,
          data: outcome.data as unknown as Record<string, unknown>,
          headers: outcome.headers,
        },
      });
    } catch {
      // Best effort: the write already succeeded, and failing the
      // response now would lie about it. A missing key record only
      // means a later retry re-runs the guard, which stays safe.
    }
  }

  private async evaluateHeaderGuard(input: {
    guard: HeaderGuard;
    resolved: ResolvedWorkspacePath;
    current: CurrentState;
    currentRevision: string | null;
    identity: WorkspaceIdentity | null;
    status: 409 | 412;
    isText: boolean;
  }): Promise<{ created: boolean; forced: boolean }> {
    const { guard, current, currentRevision } = input;
    if (guard.kind === 'none') {
      throw ApiError.preconditionRequired();
    }
    if (guard.kind === 'create-only') {
      if (current.exists) {
        throw ApiError.alreadyExists();
      }
      return { created: true, forced: false };
    }
    if (guard.kind === 'force') {
      return { created: !current.exists, forced: true };
    }
    if (!current.exists || currentRevision === null) {
      throw ApiError.notFound();
    }
    if (guard.revision !== currentRevision) {
      throw revisionConflictError(
        input.status,
        await this.conflictState(input.resolved, current, currentRevision, input.identity, input.isText),
      );
    }
    return { created: false, forced: false };
  }

  private async evaluateBodyGuard(input: {
    guard: BodyGuard;
    resolved: ResolvedWorkspacePath;
    current: CurrentState;
    currentRevision: string;
    identity: WorkspaceIdentity | null;
    failedOperation: 'append' | 'patch';
  }): Promise<boolean> {
    if (input.guard.kind === 'force') {
      return true;
    }
    if (input.guard.revision !== input.currentRevision) {
      throw revisionConflictError(
        409,
        await this.conflictState(input.resolved, input.current, input.currentRevision, input.identity, true),
        input.failedOperation,
      );
    }
    return false;
  }

  private async conflictState(
    resolved: ResolvedWorkspacePath,
    current: CurrentState,
    currentRevision: string,
    identity: WorkspaceIdentity | null,
    isText: boolean,
  ): Promise<ConflictState> {
    const version =
      identity !== null && this.ports.index !== undefined
        ? await this.ports.index.currentVersion(identity.workspaceId, resolved.normalized)
        : null;
    const preview = buildPreview(current.content ?? Buffer.alloc(0), isText);
    return {
      path: resolved.normalized,
      serverRevision: currentRevision,
      serverVersion: version,
      serverModifiedAt: (current.modifiedAt ?? new Date(0)).toISOString(),
      serverSize: current.size,
      currentPreview: preview.currentPreview,
      previewTruncated: preview.previewTruncated,
      suggestedCopyPath: await this.suggestCopyPath(resolved),
    };
  }

  // Suggests a copy path that does not exist yet: "name (salinan).md",
  // then "name (salinan 2).md", and so on, up to 100 attempts
  // (desain section 3.4). A suggestion, not a reservation: the copy
  // PUT still guards with If-None-Match.
  private async suggestCopyPath(resolved: ResolvedWorkspacePath): Promise<string | null> {
    const base = basename(resolved.absolute);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    const dir = dirname(resolved.absolute);
    const normalizedDir = dirname(resolved.normalized);
    for (let i = 0; i < 100; i += 1) {
      const label = i === 0 ? ' (salinan)' : ` (salinan ${i + 1})`;
      const candidate = `${stem}${label}${ext}`;
      try {
        await access(join(dir, candidate));
      } catch {
        return normalizedDir === '.' ? candidate : `${normalizedDir}/${candidate}`;
      }
    }
    return null;
  }

  private async readCurrent(resolved: ResolvedWorkspacePath): Promise<CurrentState> {
    let info;
    try {
      info = await lstat(resolved.absolute);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') {
        return { exists: false, isDirectory: false, isSymlink: false, content: null, size: 0, modifiedAt: null };
      }
      if (isNotDirError(error)) {
        throw ApiError.invalidPath();
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      return {
        exists: true,
        isDirectory: false,
        isSymlink: true,
        content: null,
        size: 0,
        modifiedAt: info.mtime,
      };
    }
    if (info.isDirectory()) {
      return {
        exists: true,
        isDirectory: true,
        isSymlink: false,
        content: null,
        size: 0,
        modifiedAt: info.mtime,
      };
    }
    const content = await readFile(resolved.absolute);
    return {
      exists: true,
      isDirectory: false,
      isSymlink: false,
      content,
      size: content.length,
      modifiedAt: info.mtime,
    };
  }

  // Atomic commit: temp file in the same directory, fsync, rename,
  // directory fsync (best effort), then the index transaction. On
  // index failure the disk write stands and the error carries
  // diskWritten true (desain section 3.7 step 8).
  private async commitWrite(input: {
    resolved: ResolvedWorkspacePath;
    content: Buffer;
    identity: WorkspaceIdentity | null;
    created: boolean;
    mimeType: string | null;
    eventType: 'created' | 'changed';
  }): Promise<{ revision: string; version: number | null; modifiedAt: Date }> {
    const { resolved, content } = input;
    const dir = dirname(resolved.absolute);
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      if (isNotDirError(error)) {
        throw ApiError.invalidPath();
      }
      throw error;
    }
    const tmpPath = join(dir, `.notegen-tmp-${randomUUID()}`);
    try {
      const handle = await open(tmpPath, 'wx');
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, resolved.absolute);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      if (isNotDirError(error)) {
        throw ApiError.invalidPath();
      }
      throw error;
    }
    try {
      const dirHandle = await open(dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // Best effort: not every filesystem supports directory fsync.
    }
    const revision = this.ports.revisions.compute(resolved.normalized, content);
    const after = await stat(resolved.absolute);
    let version: number | null = null;
    if (this.ports.index !== undefined && input.identity !== null) {
      try {
        const recorded = await this.ports.index.recordWrite({
          workspaceId: input.identity.workspaceId,
          actorId: input.identity.actorId,
          path: resolved.normalized,
          contentHash: contentHashOf(content),
          sizeBytes: content.length,
          mimeType: input.mimeType,
          eventType: input.eventType,
          created: input.created,
        });
        version = recorded.version;
      } catch {
        throw new ApiError(500, 'index_update_failed', 'The index update failed after the file was written.', {
          details: { diskWritten: true, revision, path: resolved.normalized },
        });
      }
    }
    return { revision, version, modifiedAt: after.mtime };
  }
}
