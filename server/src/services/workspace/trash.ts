// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace trash service (owner V3-05, part 3; AD-57 overlap).
//
// Implements the trash side of kontrak 3.1 over disk: move to trash
// (shared engine for DELETE file/folder and POST /api/workspace/trash),
// list, restore, purge one entry, and empty all. All seven trash
// routes live in routes/workspace-trash.ts and reuse moveToTrash
// from here, so there is exactly one trash engine (kontrak section
// 5, V1-17 2.4).
//
// Location (AD-17, desain-workspace-api.md 5.1): trash lives OUTSIDE
// the workspace root, as a sibling directory. The canonical name is
// `.notegen-trash-<workspace-id>`; no workspace UUID exists yet (the
// session-to-workspace mapping is future work), so the default name
// derives a stable 12-hex suffix from the SHA-256 of the resolved
// root path. An explicit trashRoot dep overrides the default (the
// TRASH_ROOT deployment knob); it is rejected when it equals the
// root or sits inside it. Trash stays on the same filesystem as the
// root when possible so moves are renames; a cross-filesystem move
// falls back to copy plus verify plus remove, and a failed verify
// leaves the source in place.
//
// Metadata: desain 5.1 stores trash metadata in Postgres
// (trash_entries), but no trash schema exists at this base (schema
// ownership is the storage worker's, assumption A11). This slice
// stores one versioned JSON sidecar per entry on disk, next to its
// blob, with exactly the metadata fields desain 5.1 requires. The
// wire contract is unaffected: when the Postgres table lands, only
// this module's metadata read/write changes. Layout per entry:
//
//   <trash-root>/<uuid>/meta.json   versioned metadata (see below)
//   <trash-root>/<uuid>/blob        file bytes, or the folder subtree
//
// Metadata is written BEFORE the blob move, so a crash between the
// two never loses the file: the worst case is a metadata entry whose
// blob is missing, which restore and purge report honestly as 500
// trash_blob_missing. A failed move removes the entry directory, so
// no phantom entry survives a failed request. The metadata file is
// written atomically (temp file plus rename).
//
// Entry ids are UUIDs in a namespace separate from workspace paths
// (lib/paths.ts). An id that is not a UUID answers 404 not_found and
// is never joined into a filesystem path, so traversal through the
// id parameter is impossible.
//
// Restore never overwrites: an occupied target answers 409
// target_exists with details.suggestedTarget (the desain 3.4 copy
// suggestion algorithm) and details.existingKind. For files the
// restore uses link plus unlink on one filesystem, so a target that
// appears between the check and the move cannot be clobbered; the
// cross-filesystem copy path creates the target with O_EXCL. For
// folders the final check plus rename leaves only the empty
// directory race (rename can replace a concurrently created empty
// directory); replacing a file or a non-empty directory with a
// folder fails at the rename itself.
//
// Pagination mirrors the read service: opaque base64url JSON cursors
// { v: 1, kind: 'trash', afterDeletedAt, afterId }, entries sorted
// by deletedAt descending with id ascending as the tie-break, limit
// default 50 and max 200 (kontrak 3.1), totals over all entries.
//
// Events and index: the files index (V3-06) and the WebSocket fan-out
// (V3-08) do not exist at this base. Trash moves are visible to the
// disk-backed list/scan immediately because the blob leaves the root.
// An optional onEvent callback receives deleted/created notices
// (best effort, never fails an operation) as the seam V3-08 wires.
// Idempotency-Key replay for restore (kontrak: recommended, not
// required) is not implemented: a repeated restore answers 404
// not_found because the entry is gone. That gap is recorded in the
// worker report, not hidden behind a fake replay.

import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  constants as fsConstants,
  cp,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { ApiError } from '../../plugins/envelope.js';
import {
  InvalidWorkspacePathError,
  WorkspaceRootUnavailableError,
  WorkspaceSymlinkError,
  assertNoSymlinkComponents,
  validateWorkspacePath,
  type ValidatedWorkspacePath,
} from '../../lib/paths.js';
import { buildRevision, contentHash } from '../../lib/revision.js';
import { parseLimit } from './read.js';

export const DEFAULT_TRASH_LIMIT = 50;
export const MAX_TRASH_LIMIT = 200;
export const DEFAULT_MAX_BATCH_PATHS = 100;

export type TrashKind = 'file' | 'folder';

export interface TrashEntry {
  id: string;
  originalPath: string;
  name: string;
  kind: TrashKind;
  size: number;
  entryCount: number;
  revision: string | null;
  deletedAt: string;
}

export interface MoveToTrashResult {
  path: string;
  trashId: string;
  kind: TrashKind;
  entryCount: number;
  size: number;
  deletedAt: string;
}

export interface BatchMoveResult {
  moved: string[];
  notFound: string[];
  rejected: Array<{ path: string; reason: string }>;
}

export interface ListTrashResult {
  entries: TrashEntry[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
  totalSize: number;
}

export interface RestoreResult {
  id: string;
  originalPath: string;
  restoredPath: string;
  kind: TrashKind;
  revision: string | null;
  size: number;
  restoredAt: string;
}

export interface PurgeResult {
  id: string;
  purged: true;
  purgedAt: string;
}

export type PurgeFailureCode = 'trash_blob_missing' | 'internal_error';

export interface PurgeAllResult {
  purged: number;
  failed: number;
  failures: Array<{ id: string; code: PurgeFailureCode }>;
  purgedAt: string;
}

// Narrow change notice for the realtime layer (V3-08 seam). The
// WebSocket message contract belongs to V3-08, which maps from
// these fields.
export interface TrashEvent {
  kind: 'deleted' | 'created';
  path: string;
  trashId: string;
  actorId: string | undefined;
}

export interface WorkspaceTrashDeps {
  workspaceRoot: string | undefined;
  // Explicit trash root override (TRASH_ROOT deployment knob). When
  // omitted, the sibling default derived from the resolved root is
  // used. Must never equal the root or sit inside it.
  trashRoot?: string;
  // Stable server-side workspace key for the revision formula. When
  // omitted, the resolved workspace root path is used, the same
  // default as the read service.
  workspaceKey?: string;
  // Maximum paths per POST /api/workspace/trash request. Default
  // 100 (kontrak 3.1; the final value is server configuration).
  maxBatchPaths?: number;
  // Best-effort event callback, wired by V3-08. Absent means no
  // events are published. A throwing callback never fails the
  // operation that emitted the event.
  onEvent?: (event: TrashEvent) => void;
  // DA-6 F4: warn sink for per-item move failures that the batch
  // endpoint reports as rejected move_failed inside a 200. Without
  // it those failures were visible only as a client toast and the
  // server log stayed clean. Receives the path and the cause
  // message, never file content. A throwing sink never fails the
  // operation.
  onWarn?: (message: string, details: { path: string; cause: string }) => void;
}

export interface MoveToTrashOptions {
  // When set (DELETE file/folder routes), a kind mismatch answers
  // 409 wrong_kind. Unset for the batch endpoint, which accepts
  // either kind per item.
  expectedKind?: TrashKind;
  actorId?: string;
}

export interface RestoreOptions {
  // Restore target. Undefined means the original path.
  target?: string;
  actorId?: string;
}

interface TrashMetadata {
  v: 1;
  id: string;
  originalPath: string;
  name: string;
  kind: TrashKind;
  size: number;
  entryCount: number;
  revision: string | null;
  deletedAt: string;
  deletedBy: string | null;
}

interface TrashCursor {
  v: 1;
  kind: 'trash';
  afterDeletedAt: string;
  afterId: string;
}

const META_FILE = 'meta.json';
const BLOB_NAME = 'blob';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVE_LETTER_PATTERN = /^[A-Za-z]:/;

// Internal signal: the restore target became occupied between the
// check and the move. The restore handler converts it to 409
// target_exists with a fresh suggestion.
class TargetOccupiedError extends Error {
  constructor() {
    super('The restore target is occupied.');
    this.name = 'TargetOccupiedError';
  }
}

function invalidCursor(): ApiError {
  return new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
}

function symlinkNotAllowed(): ApiError {
  return new ApiError(400, 'symlink_not_allowed', 'Symlinks are not allowed in the workspace.');
}

function trashBlobMissing(id: string, originalPath: string): ApiError {
  return new ApiError(500, 'trash_blob_missing', 'The trash entry data is missing.', {
    details: { id, originalPath },
  });
}

// Map path-layer errors to write-side HTTP errors: hidden and
// symlink paths are 400 here (reads answer 404 for both).
function mapWritePathError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof InvalidWorkspacePathError) {
    return ApiError.invalidPath();
  }
  if (error instanceof WorkspaceSymlinkError) {
    return symlinkNotAllowed();
  }
  if (error instanceof WorkspaceRootUnavailableError) {
    return ApiError.serviceUnavailable();
  }
  throw error;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isExdev(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EXDEV'
  );
}

function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

// DeletedAt descending, id ascending as the tie-break (desain 1.6). ISO UTC
// timestamps from Date.toISOString share one fixed shape, so string
// comparison orders them chronologically.
function compareTrashEntries(a: TrashEntry, b: TrashEntry): number {
  const byDeleted = compareStrings(b.deletedAt, a.deletedAt);
  if (byDeleted !== 0) {
    return byDeleted;
  }
  return compareStrings(a.id, b.id);
}

function encodeCursor(cursor: TrashCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeTrashCursor(raw: unknown): TrashCursor | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor();
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(',') !== 'afterDeletedAt,afterId,kind,v' ||
    record['v'] !== 1 ||
    record['kind'] !== 'trash' ||
    typeof record['afterDeletedAt'] !== 'string' ||
    typeof record['afterId'] !== 'string' ||
    Number.isNaN(Date.parse(record['afterDeletedAt'] as string)) ||
    !UUID_PATTERN.test(record['afterId'] as string)
  ) {
    throw invalidCursor();
  }
  return record as unknown as TrashCursor;
}

function parseMetadata(raw: string, expectedId: string): TrashMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    record['v'] !== 1 ||
    record['id'] !== expectedId ||
    typeof record['originalPath'] !== 'string' ||
    record['originalPath'] === '' ||
    typeof record['name'] !== 'string' ||
    record['name'] === '' ||
    (record['kind'] !== 'file' && record['kind'] !== 'folder') ||
    typeof record['size'] !== 'number' ||
    !Number.isInteger(record['size']) ||
    (record['size'] as number) < 0 ||
    typeof record['entryCount'] !== 'number' ||
    !Number.isInteger(record['entryCount']) ||
    (record['entryCount'] as number) < 1 ||
    (record['revision'] !== null && typeof record['revision'] !== 'string') ||
    typeof record['deletedAt'] !== 'string' ||
    Number.isNaN(Date.parse(record['deletedAt'] as string)) ||
    (record['deletedBy'] !== null && typeof record['deletedBy'] !== 'string')
  ) {
    return null;
  }
  try {
    validateWorkspacePath(record['originalPath'] as string);
  } catch {
    return null;
  }
  const segments = (record['originalPath'] as string).split('/');
  if (segments[segments.length - 1] !== record['name']) {
    return null;
  }
  return record as unknown as TrashMetadata;
}

async function readFileNoFollow(fsPath: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(fsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        return null;
      }
    }
    throw error;
  }
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// Subtree stats without following symlinks: size is the total bytes
// of regular files, entryCount counts files, folders, and symlinks,
// including the subtree root itself (desain 2.8).
async function walkStats(fsPath: string): Promise<{ size: number; entryCount: number }> {
  let size = 0;
  let entryCount = 0;
  const stack: string[] = [fsPath];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let stats;
    try {
      stats = await lstat(current);
    } catch {
      continue;
    }
    entryCount += 1;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      if (stats.isFile()) {
        size += stats.size;
      }
      continue;
    }
    const dirents = await readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      stack.push(join(current, dirent.name));
    }
  }
  return { size, entryCount };
}

// Cross-filesystem copy verification: byte equality for files
// (content hash, never a revision), subtree stats equality for
// folders.
async function verifyCopy(source: string, dest: string, kind: TrashKind): Promise<boolean> {
  if (kind === 'file') {
    const [sourceBytes, destBytes] = await Promise.all([readFile(source), readFile(dest)]);
    return sourceBytes.length === destBytes.length && contentHash(sourceBytes) === contentHash(destBytes);
  }
  const [sourceStats, destStats] = await Promise.all([walkStats(source), walkStats(dest)]);
  return sourceStats.size === destStats.size && sourceStats.entryCount === destStats.entryCount;
}

// Move one entry, preferring rename. On EXDEV, copy plus verify plus
// remove; a failed verify or remove deletes the partial copy and
// leaves the source in place. A vanished source answers not_found.
async function moveEntry(source: string, dest: string, kind: TrashKind): Promise<void> {
  try {
    await rename(source, dest);
    return;
  } catch (error) {
    if (isEnoent(error)) {
      throw ApiError.notFound();
    }
    if (!isExdev(error)) {
      throw error;
    }
  }
  try {
    await cp(source, dest, { recursive: true, dereference: false, errorOnExist: true });
  } catch (error) {
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  let verified = false;
  try {
    verified = await verifyCopy(source, dest, kind);
  } catch {
    verified = false;
  }
  if (!verified) {
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    throw ApiError.internalError();
  }
  try {
    await rm(source, { recursive: true, force: true });
  } catch (error) {
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function createWorkspaceTrash(deps: WorkspaceTrashDeps) {
  const maxBatchPaths = deps.maxBatchPaths ?? DEFAULT_MAX_BATCH_PATHS;

  function emit(event: TrashEvent): void {
    if (deps.onEvent === undefined) {
      return;
    }
    try {
      deps.onEvent(event);
    } catch {
      // Best effort: event publication never fails an operation.
    }
  }

  async function requireRoot(): Promise<string> {
    if (deps.workspaceRoot === undefined || deps.workspaceRoot === '') {
      throw ApiError.serviceUnavailable();
    }
    let rootReal: string;
    try {
      rootReal = await realpath(deps.workspaceRoot);
    } catch {
      throw ApiError.serviceUnavailable();
    }
    let rootStats;
    try {
      rootStats = await stat(rootReal);
    } catch {
      throw ApiError.serviceUnavailable();
    }
    if (!rootStats.isDirectory()) {
      throw ApiError.serviceUnavailable();
    }
    return rootReal;
  }

  function trashRootFor(rootReal: string): string {
    if (deps.trashRoot !== undefined && deps.trashRoot !== '') {
      const resolved = resolve(deps.trashRoot);
      if (resolved === rootReal || resolved.startsWith(rootReal + sep)) {
        throw ApiError.serviceUnavailable();
      }
      return resolved;
    }
    const suffix = createHash('sha256').update(rootReal, 'utf8').digest('hex').slice(0, 12);
    return join(dirname(rootReal), `.notegen-trash-${suffix}`);
  }

  async function readEntryMetadata(entryDir: string, expectedId: string): Promise<TrashMetadata | null> {
    let raw: string;
    try {
      raw = await readFile(join(entryDir, META_FILE), 'utf8');
    } catch {
      return null;
    }
    return parseMetadata(raw, expectedId);
  }

  // All readable entries in the trash root. A missing trash root
  // means an empty trash (a GET must not create directories).
  // Corrupt or foreign entries are skipped here; purge-all reports
  // corrupt UUID-named entries as failures instead of hiding them.
  async function readAllMetadata(trashRoot: string): Promise<TrashMetadata[]> {
    let dirents;
    try {
      dirents = await readdir(trashRoot, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }
    const metas: TrashMetadata[] = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !UUID_PATTERN.test(dirent.name)) {
        continue;
      }
      const meta = await readEntryMetadata(join(trashRoot, dirent.name), dirent.name);
      if (meta !== null) {
        metas.push(meta);
      }
    }
    return metas;
  }

  function entryFromMetadata(meta: TrashMetadata): TrashEntry {
    return {
      id: meta.id,
      originalPath: meta.originalPath,
      name: meta.name,
      kind: meta.kind,
      size: meta.size,
      entryCount: meta.entryCount,
      revision: meta.revision,
      deletedAt: meta.deletedAt,
    };
  }

  async function writeMetadataAtomic(entryDir: string, meta: TrashMetadata): Promise<void> {
    const tmpPath = join(entryDir, `.${META_FILE}.tmp-${randomUUID()}`);
    try {
      await writeFile(tmpPath, JSON.stringify(meta), 'utf8');
      await rename(tmpPath, join(entryDir, META_FILE));
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  // Suggested restore target (desain 3.4 algorithm): insert
  // " (salinan)" before the extension (or at the end when there is
  // none), then " (salinan 2)", " (salinan 3)", up to 100 attempts;
  // null when every candidate is taken. Existence only, no file is
  // created.
  async function suggestRestoreTarget(
    rootReal: string,
    validated: ValidatedWorkspacePath,
  ): Promise<string | null> {
    const dir = validated.segments.slice(0, -1);
    const base = validated.segments[validated.segments.length - 1] as string;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let n = 1; n <= 100; n += 1) {
      const suffix = n === 1 ? ' (salinan)' : ` (salinan ${n})`;
      const candidate = [...dir, `${stem}${suffix}${ext}`].join('/');
      let candidateValidated: ValidatedWorkspacePath;
      try {
        candidateValidated = validateWorkspacePath(candidate);
      } catch {
        continue;
      }
      if (candidateValidated.hidden) {
        continue;
      }
      const fsPath = join(rootReal, ...candidateValidated.segments);
      const existing = await lstat(fsPath).catch(() => null);
      if (existing === null) {
        return candidate;
      }
    }
    return null;
  }

  async function targetExistsError(
    rootReal: string,
    validated: ValidatedWorkspacePath,
    existingKind: TrashKind,
  ): Promise<ApiError> {
    const suggestedTarget = await suggestRestoreTarget(rootReal, validated);
    return new ApiError(409, 'target_exists', 'The restore target already exists.', {
      details: { suggestedTarget, existingKind },
    });
  }

  // Move a trash blob back into the workspace without ever
  // overwriting an occupied target. Files use link plus unlink on
  // one filesystem (link fails EEXIST when the target appears), and
  // an O_EXCL copy on a cross-filesystem move. Folders use a final
  // existence check plus rename, with a copy fallback that also
  // refuses an existing destination.
  async function moveBlobToTarget(
    blobPath: string,
    targetFs: string,
    kind: TrashKind,
  ): Promise<void> {
    if (kind === 'file') {
      try {
        await link(blobPath, targetFs);
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error) {
          const code = (error as { code?: unknown }).code;
          if (code === 'EEXIST') {
            throw new TargetOccupiedError();
          }
          if (code === 'EXDEV' || code === 'EPERM') {
            await copyFileExclusive(blobPath, targetFs);
            await unlink(blobPath).catch(() => undefined);
            return;
          }
        }
        throw error;
      }
      await unlink(blobPath).catch(() => undefined);
      return;
    }
    const existing = await lstat(targetFs).catch(() => null);
    if (existing !== null) {
      throw new TargetOccupiedError();
    }
    try {
      await rename(blobPath, targetFs);
      return;
    } catch (error) {
      if (isEnoent(error)) {
        // The blob or the freshly created parent vanished under a
        // concurrent operation; neither is an occupied target.
        throw ApiError.internalError();
      }
      if (!isExdev(error)) {
        throw error;
      }
    }
    try {
      await cp(blobPath, targetFs, { recursive: true, dereference: false, errorOnExist: true });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code?: unknown }).code;
        if (code === 'EEXIST') {
          throw new TargetOccupiedError();
        }
      }
      await rm(targetFs, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    let verified = false;
    try {
      verified = await verifyCopy(blobPath, targetFs, kind);
    } catch {
      verified = false;
    }
    if (!verified) {
      await rm(targetFs, { recursive: true, force: true }).catch(() => undefined);
      throw ApiError.internalError();
    }
    await rm(blobPath, { recursive: true, force: true });
  }

  async function copyFileExclusive(source: string, dest: string): Promise<void> {
    const bytes = await readFile(source);
    let handle;
    try {
      handle = await open(dest, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o666);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code?: unknown }).code;
        if (code === 'EEXIST') {
          throw new TargetOccupiedError();
        }
      }
      throw error;
    }
    try {
      await handle.writeFile(bytes);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(dest, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();
    const copied = await readFile(dest);
    if (copied.length !== bytes.length || contentHash(copied) !== contentHash(bytes)) {
      await rm(dest, { force: true }).catch(() => undefined);
      throw ApiError.internalError();
    }
  }

  async function moveToTrash(
    rawPath: unknown,
    options: MoveToTrashOptions = {},
  ): Promise<MoveToTrashResult> {
    let validated: ValidatedWorkspacePath;
    try {
      validated = validateWorkspacePath(rawPath);
    } catch (error) {
      throw mapWritePathError(error);
    }
    if (validated.hidden) {
      throw ApiError.invalidPath();
    }
    const rootReal = await requireRoot();
    const workspaceKey = deps.workspaceKey ?? rootReal;
    let fsPath: string;
    try {
      fsPath = await assertNoSymlinkComponents(rootReal, validated);
    } catch (error) {
      throw mapWritePathError(error);
    }
    let stats;
    try {
      stats = await lstat(fsPath);
    } catch (error) {
      if (isEnoent(error)) {
        throw ApiError.notFound();
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw symlinkNotAllowed();
    }
    if (!stats.isFile() && !stats.isDirectory()) {
      throw ApiError.invalidPath();
    }
    const kind: TrashKind = stats.isDirectory() ? 'folder' : 'file';
    if (options.expectedKind !== undefined && kind !== options.expectedKind) {
      throw new ApiError(409, 'wrong_kind', 'The path is not of the expected kind.');
    }
    const { size, entryCount } = await walkStats(fsPath);
    let revision: string | null = null;
    if (kind === 'file') {
      const bytes = await readFileNoFollow(fsPath);
      if (bytes === null) {
        throw ApiError.notFound();
      }
      revision = buildRevision(workspaceKey, validated.path, bytes);
    }
    const trashRoot = trashRootFor(rootReal);
    await mkdir(trashRoot, { recursive: true });
    let entryDir: string | null = null;
    let id = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      id = randomUUID();
      entryDir = join(trashRoot, id);
      try {
        await mkdir(entryDir);
        break;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EEXIST') {
          entryDir = null;
          continue;
        }
        throw error;
      }
    }
    if (entryDir === null) {
      throw ApiError.internalError();
    }
    const deletedAt = new Date().toISOString();
    const meta: TrashMetadata = {
      v: 1,
      id,
      originalPath: validated.path,
      name: validated.segments[validated.segments.length - 1] as string,
      kind,
      size,
      entryCount,
      revision,
      deletedAt,
      deletedBy: options.actorId ?? null,
    };
    try {
      await writeMetadataAtomic(entryDir, meta);
      await moveEntry(fsPath, join(entryDir, BLOB_NAME), kind);
    } catch (error) {
      await rm(entryDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    emit({ kind: 'deleted', path: validated.path, trashId: id, actorId: options.actorId });
    return { path: validated.path, trashId: id, kind, entryCount, size, deletedAt };
  }

  // Reason for a batch rejection. The V1-17 example names
  // path_escapes_workspace for "../keluar.md"; that reason covers
  // absolute paths and ".." segments, while other malformed shapes
  // use invalid_path.
  function escapeReason(input: string): string {
    if (
      input.startsWith('/') ||
      DRIVE_LETTER_PATTERN.test(input) ||
      input.split('/').includes('..')
    ) {
      return 'path_escapes_workspace';
    }
    return 'invalid_path';
  }

  async function moveBatch(
    rawPaths: readonly unknown[],
    options: { actorId?: string } = {},
  ): Promise<BatchMoveResult> {
    // Fail the whole request up front when the workspace is
    // unavailable, instead of reporting every item as rejected.
    const rootReal = await requireRoot();
    const trashRoot = trashRootFor(rootReal);
    const trashedPaths = new Set(
      (await readAllMetadata(trashRoot)).map((meta) => meta.originalPath),
    );
    const moved: string[] = [];
    const notFound: string[] = [];
    const rejected: Array<{ path: string; reason: string }> = [];
    for (const item of rawPaths) {
      if (typeof item !== 'string') {
        rejected.push({ path: String(item), reason: 'invalid_path' });
        continue;
      }
      let validated: ValidatedWorkspacePath;
      try {
        validated = validateWorkspacePath(item);
      } catch {
        rejected.push({ path: item, reason: escapeReason(item) });
        continue;
      }
      if (validated.hidden) {
        rejected.push({ path: item, reason: 'hidden_path' });
        continue;
      }
      try {
        const result = await moveToTrash(item, { actorId: options.actorId });
        moved.push(result.path);
        trashedPaths.add(result.path);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'not_found') {
          // Idempotent per item: a path already in trash is
          // reported moved without creating a duplicate entry.
          if (trashedPaths.has(validated.path)) {
            moved.push(validated.path);
          } else {
            notFound.push(validated.path);
          }
        } else if (error instanceof ApiError && error.code === 'symlink_not_allowed') {
          rejected.push({ path: validated.path, reason: 'symlink_not_allowed' });
        } else if (error instanceof ApiError && error.code === 'invalid_path') {
          rejected.push({ path: validated.path, reason: 'invalid_path' });
        } else if (error instanceof ApiError && error.code === 'service_unavailable') {
          throw error;
        } else {
          // DA-6 F4: log the cause server-side; the wire answer
          // stays the generic move_failed reason.
          try {
            deps.onWarn?.('workspace trash move failed', {
              path: validated.path,
              cause: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // Best effort: logging never fails the operation.
          }
          rejected.push({ path: validated.path, reason: 'move_failed' });
        }
      }
    }
    return { moved, notFound, rejected };
  }

  async function list(query: { cursor?: unknown; limit?: unknown }): Promise<ListTrashResult> {
    const limit = parseLimit(query.limit, DEFAULT_TRASH_LIMIT, MAX_TRASH_LIMIT);
    const cursor = decodeTrashCursor(query.cursor);
    const rootReal = await requireRoot();
    const trashRoot = trashRootFor(rootReal);
    const entries = (await readAllMetadata(trashRoot)).map(entryFromMetadata).sort(compareTrashEntries);
    const totalCount = entries.length;
    const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
    let start = 0;
    if (cursor !== null) {
      const anchor: TrashEntry = {
        id: cursor.afterId,
        originalPath: '',
        name: '',
        kind: 'file',
        size: 0,
        entryCount: 1,
        revision: null,
        deletedAt: cursor.afterDeletedAt,
      };
      start = entries.findIndex((entry) => compareTrashEntries(entry, anchor) > 0);
      if (start === -1) {
        start = entries.length;
      }
    }
    const page = entries.slice(start, start + limit);
    const hasMore = start + page.length < entries.length;
    const last = page[page.length - 1];
    return {
      entries: page,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ v: 1, kind: 'trash', afterDeletedAt: last.deletedAt, afterId: last.id })
          : null,
      hasMore,
      totalCount,
      totalSize,
    };
  }

  async function restore(
    idInput: unknown,
    options: RestoreOptions = {},
  ): Promise<RestoreResult> {
    if (typeof idInput !== 'string' || !UUID_PATTERN.test(idInput)) {
      throw ApiError.notFound();
    }
    const rootReal = await requireRoot();
    const workspaceKey = deps.workspaceKey ?? rootReal;
    const trashRoot = trashRootFor(rootReal);
    const entryDir = join(trashRoot, idInput);
    const entryStats = await lstat(entryDir).catch(() => null);
    if (entryStats === null || !entryStats.isDirectory()) {
      throw ApiError.notFound();
    }
    const meta = await readEntryMetadata(entryDir, idInput);
    if (meta === null) {
      throw ApiError.internalError();
    }
    const blobPath = join(entryDir, BLOB_NAME);
    const blobStats = await lstat(blobPath).catch(() => null);
    if (blobStats === null) {
      throw trashBlobMissing(idInput, meta.originalPath);
    }
    const targetInput = options.target ?? meta.originalPath;
    let validated: ValidatedWorkspacePath;
    try {
      validated = validateWorkspacePath(targetInput);
    } catch (error) {
      throw mapWritePathError(error);
    }
    if (validated.hidden) {
      throw ApiError.invalidPath();
    }
    const targetFs = join(rootReal, ...validated.segments);
    const existing = await lstat(targetFs).catch(() => null);
    if (existing !== null) {
      throw await targetExistsError(
        rootReal,
        validated,
        existing.isDirectory() ? 'folder' : 'file',
      );
    }
    try {
      await assertNoSymlinkComponents(rootReal, validated);
    } catch (error) {
      throw mapWritePathError(error);
    }
    try {
      await mkdir(dirname(targetFs), { recursive: true });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code?: unknown }).code;
        if (code === 'ENOTDIR' || code === 'EEXIST') {
          throw ApiError.invalidPath();
        }
      }
      throw error;
    }
    try {
      await moveBlobToTarget(blobPath, targetFs, meta.kind);
    } catch (error) {
      if (error instanceof TargetOccupiedError) {
        const current = await lstat(targetFs).catch(() => null);
        throw await targetExistsError(
          rootReal,
          validated,
          current !== null && current.isDirectory() ? 'folder' : 'file',
        );
      }
      throw error;
    }
    await rm(entryDir, { recursive: true, force: true });
    const restoredAt = new Date().toISOString();
    let revision: string | null = null;
    let size = meta.size;
    if (meta.kind === 'file') {
      const bytes = await readFileNoFollow(targetFs);
      if (bytes === null) {
        throw ApiError.internalError();
      }
      // Recomputed at the restored path, so the revision differs
      // from the trashed one exactly when the path changed
      // (desain 5.2, revision formula 3.1).
      revision = buildRevision(workspaceKey, validated.path, bytes);
      size = bytes.length;
    }
    emit({ kind: 'created', path: validated.path, trashId: idInput, actorId: options.actorId });
    return {
      id: idInput,
      originalPath: meta.originalPath,
      restoredPath: validated.path,
      kind: meta.kind,
      revision,
      size,
      restoredAt,
    };
  }

  async function purge(idInput: unknown): Promise<PurgeResult> {
    if (typeof idInput !== 'string' || !UUID_PATTERN.test(idInput)) {
      throw ApiError.notFound();
    }
    const rootReal = await requireRoot();
    const trashRoot = trashRootFor(rootReal);
    const entryDir = join(trashRoot, idInput);
    const entryStats = await lstat(entryDir).catch(() => null);
    if (entryStats === null || !entryStats.isDirectory()) {
      throw ApiError.notFound();
    }
    const meta = await readEntryMetadata(entryDir, idInput);
    if (meta === null) {
      throw ApiError.internalError();
    }
    const blobStats = await lstat(join(entryDir, BLOB_NAME)).catch(() => null);
    if (blobStats === null) {
      // The entry is kept for operator follow-up, the same rule as
      // restore: a missing blob is reported, not silently cleaned.
      throw trashBlobMissing(idInput, meta.originalPath);
    }
    await rm(entryDir, { recursive: true, force: true });
    return { id: idInput, purged: true, purgedAt: new Date().toISOString() };
  }

  async function purgeAll(): Promise<PurgeAllResult> {
    const rootReal = await requireRoot();
    const trashRoot = trashRootFor(rootReal);
    let dirents;
    try {
      dirents = await readdir(trashRoot, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) {
        return { purged: 0, failed: 0, failures: [], purgedAt: new Date().toISOString() };
      }
      throw error;
    }
    const names = dirents
      .filter((dirent) => dirent.isDirectory() && UUID_PATTERN.test(dirent.name))
      .map((dirent) => dirent.name)
      .sort(compareStrings);
    let purged = 0;
    const failures: Array<{ id: string; code: PurgeFailureCode }> = [];
    for (const name of names) {
      const entryDir = join(trashRoot, name);
      const meta = await readEntryMetadata(entryDir, name);
      if (meta === null) {
        failures.push({ id: name, code: 'internal_error' });
        continue;
      }
      const blobStats = await lstat(join(entryDir, BLOB_NAME)).catch(() => null);
      if (blobStats === null) {
        failures.push({ id: name, code: 'trash_blob_missing' });
        continue;
      }
      try {
        await rm(entryDir, { recursive: true, force: true });
        purged += 1;
      } catch {
        failures.push({ id: name, code: 'internal_error' });
      }
    }
    return { purged, failed: failures.length, failures, purgedAt: new Date().toISOString() };
  }


  // DA-6 F4: boot-time writability probe for the trash root. A
  // trash root that cannot be created or written (the live
  // UTANG-UJI-10 root cause) now warns at startup instead of
  // failing the first delete. The probe checks write access on
  // the root, or on the nearest existing ancestor when the root
  // does not exist yet, so listing an empty trash still creates
  // nothing. Never throws.
  async function probeTrashRoot(): Promise<boolean> {
    try {
      const rootReal = await requireRoot();
      let candidate = trashRootFor(rootReal);
      for (;;) {
        try {
          await access(candidate, fsConstants.W_OK);
          return true;
        } catch (cause) {
          if ((cause as { code?: string }).code !== 'ENOENT') return false;
          const parent = dirname(candidate);
          if (parent === candidate) return false;
          candidate = parent;
        }
      }
    } catch {
      return false;
    }
  }

  return { moveToTrash, moveBatch, list, restore, purge, purgeAll, maxBatchPaths, probeTrashRoot };
}

export type WorkspaceTrash = ReturnType<typeof createWorkspaceTrash>;
