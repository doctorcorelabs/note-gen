// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Files-index scanner (V3-06 part 1, wave 3B overlap, AD-57).
//
// Walks one workspace tree on disk and produces the facts the files
// index needs: per-file metadata, content hash, and revision. It
// implements the full-scan walk of desain-workspace-api.md section
// 4.3 steps 1 to 3 (walk, skip rules, fast-path comparison) and the
// drift classification of step 4, without touching disk contents and
// without touching Postgres. Reconciliation repair (step 5: writing
// the index, emitting events, per-path repair, scheduling) belongs to
// V3-06 part 2 and is not in this module.
//
// Rules, all taken from the frozen design and frozen shared modules,
// never re-decided here:
// - Hidden: any path segment starting with "." is skipped, including
//   dot directories, dotfiles, and the ".notegen-tmp-*" temp files
//   (desain section 8.4). The check reuses isHiddenWorkspacePath
//   from server/src/lib/paths.ts. The RAG exclusion list
//   (node_modules, skills) does NOT apply: desain section 8.4 keeps
//   those visible to the workspace API, so the scanner indexes them.
// - Symlinks: never followed, never reported as entries, never an
//   error (desain section 8.5). Every entry is classified with lstat,
//   files are opened with O_NOFOLLOW, and a symlink swapped in
//   between lstat and open is rejected by the open, not followed.
// - Other non-file kinds (sockets, FIFOs, devices) are skipped
//   silently, like symlinks: they never appear in workspace
//   responses (desain section 1.4).
// - Path limits: relative paths over 1024 UTF-8 bytes or 50
//   segments are skipped and counted (desain section 1.7, limits
//   from paths.ts). The scanner never throws for one bad path.
// - Revision: buildRevision from server/src/lib/revision.ts, sha256
//   over workspaceKey + NUL + path + NUL + raw bytes. Content hash:
//   contentHash from the same module, sha256 over the bytes alone,
//   matching files.content_hash. This module computes no hash of its
//   own and must never grow a competing revision helper.
// - Fast path (desain section 4.3 step 3): when the caller supplies
//   a known snapshot and a file's size and mtime match it, the
//   stored hash and revision are reused without reading the file.
//   Any difference, or a missing known entry, means the bytes are
//   read and hashed. The fast path is an optimization only: a wrong
//   known entry can delay detection by one scan at most, because
//   size and mtime are the design's own screening signal.
// - Directories are traversed but never emitted: the files table
//   holds file rows only (write-index-pg.ts writes file rows; the
//   read side reports folder size and revision as null). Empty
//   directories therefore produce no entries and no error.
// - mtime is a comparison signal only. The frozen files table
//   (migration 0000, schema m4-canvas-files.ts) has no mtime column,
//   so modifiedAt is carried on scanned entries for callers and for
//   the fast path, but is not part of any upsert. No migration is
//   needed for this task and none is written.
//
// Store seam: the Postgres store interface is NOT defined here as an
// implementation. FilesIndexStore below is the minimal port this
// scanner needs (list active rows, apply one batch). Its Postgres
// implementation belongs to V3-06 part 2, which must apply each
// batch in one transaction with the version + 1 and soft-delete
// semantics of write-index-pg.ts, write file_events rows per desain
// section 4.3 step 5, and page listActive internally at 1000 rows
// per batch (desain section 4.3 step 2). The upsert shape reuses
// IndexWriteInput field names and types exactly (Pick from
// write-ports.ts) so the part 2 store can map upserts onto the
// existing index port without translation. Until part 2 lands, the
// seam is exercised with a fake store in test/index-scanner.spec.ts.
//
// Placement note: write-index-pg.ts anticipates V3-06 living in
// services/workspace/index.ts and reconcile.ts. The 3B brief for
// this task assigns server/src/services/index/scanner.ts instead;
// this file follows the brief. The part 2 worker owns reconciling
// the two placements and must not duplicate this scanner.

import { constants as fsConstants, lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_WORKSPACE_PATH_BYTES,
  MAX_WORKSPACE_PATH_SEGMENTS,
  WorkspaceRootUnavailableError,
  isHiddenWorkspacePath,
} from '../../lib/paths.js';
import { buildRevision, contentHash } from '../../lib/revision.js';
import type { IndexWriteInput } from '../workspace/write-ports.js';

// Batch size for index sync batches, matching the 1000-row internal
// pagination of desain section 4.3 step 2.
export const INDEX_BATCH_SIZE = 1000;

// One file found by the walk. Directories are never returned.
export interface ScannedFile {
  // Normalized workspace-relative POSIX path, no leading slash.
  path: string;
  // Last path segment.
  name: string;
  sizeBytes: number;
  // Disk mtime. Comparison signal only; not persisted (see header).
  modifiedAt: Date;
  // Disk birthtime, or null when the filesystem does not provide
  // one (same rule as the read side: non-finite or <= 0 means null).
  createdAt: Date | null;
  // Hex SHA-256 over the content bytes alone (files.content_hash).
  contentHash: string;
  // Opaque revision, sha256 over workspaceKey + path + bytes.
  revision: string;
  // text/markdown for .md, text/plain for .txt, null otherwise
  // (same mapping as the write path; see mimeTypeForScannedPath).
  mimeType: string | null;
}

// A previously known index-side fact for one path, used only for the
// fast path. The caller builds this from a prior scan result; the
// files table itself carries no mtime, so index rows alone cannot
// supply modifiedAtMs.
export interface KnownIndexEntry {
  path: string;
  sizeBytes: number;
  modifiedAtMs: number;
  contentHash: string;
  revision: string;
}

export interface ScanStats {
  files: number;
  directoriesVisited: number;
  skippedHidden: number;
  skippedSymlinks: number;
  skippedOtherKinds: number;
  skippedOverLimit: number;
  skippedUnreadable: number;
  skippedVanished: number;
  hashesComputed: number;
  hashesReused: number;
}

export interface ScanResult {
  // Sorted lexicographically by path (code-unit order, as the read
  // side sorts scan results).
  entries: ScannedFile[];
  stats: ScanStats;
}

export interface ScanOptions {
  workspaceRoot: string;
  // Stable server-side workspace key, the same value the revision
  // port uses for this workspace. Never sent to clients.
  workspaceKey: string;
  known?: readonly KnownIndexEntry[];
}

// Mime type for an index row, matching the write path exactly
// (textMimeType in services/workspace/write-file.ts): case-sensitive
// .md and .txt suffixes, null for everything else. The scanner does
// no magic-byte detection; media mime types come from the media
// validation owned by the write path, and the reconcile worker
// decides whether a scanned null overwrites a stored media mime.
export function mimeTypeForScannedPath(path: string): string | null {
  if (path.endsWith('.md')) {
    return 'text/markdown';
  }
  if (path.endsWith('.txt')) {
    return 'text/plain';
  }
  return null;
}

function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function createdAtOrNull(birthtime: Date): Date | null {
  const ms = birthtime.getTime();
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  return birthtime;
}

function isOverLimit(relativePath: string): boolean {
  return (
    Buffer.byteLength(relativePath, 'utf8') > MAX_WORKSPACE_PATH_BYTES ||
    relativePath.split('/').length > MAX_WORKSPACE_PATH_SEGMENTS
  );
}

// Read a file without following symlinks. Returns null when the
// entry vanished or turned into a symlink between lstat and open;
// other errors propagate so the caller can count them unreadable.
async function readFileNoFollow(fsPath: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(fsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// Walk the workspace tree and hash what the fast path cannot reuse.
// Throws WorkspaceRootUnavailableError when the root itself is
// missing, unreadable, or not a directory; every problem below the
// root only skips entries and is counted in stats, so one unreadable
// directory never fails the whole scan.
export async function scanWorkspaceTree(options: ScanOptions): Promise<ScanResult> {
  const { workspaceRoot, workspaceKey } = options;
  let rootReal: string;
  try {
    rootReal = await realpath(workspaceRoot);
  } catch {
    throw new WorkspaceRootUnavailableError();
  }
  let rootStats;
  try {
    rootStats = await lstat(rootReal);
  } catch {
    throw new WorkspaceRootUnavailableError();
  }
  if (!rootStats.isDirectory()) {
    throw new WorkspaceRootUnavailableError();
  }

  const knownByPath = new Map<string, KnownIndexEntry>();
  for (const entry of options.known ?? []) {
    knownByPath.set(entry.path, entry);
  }

  const stats: ScanStats = {
    files: 0,
    directoriesVisited: 0,
    skippedHidden: 0,
    skippedSymlinks: 0,
    skippedOtherKinds: 0,
    skippedOverLimit: 0,
    skippedUnreadable: 0,
    skippedVanished: 0,
    hashesComputed: 0,
    hashesReused: 0,
  };
  const entries: ScannedFile[] = [];
  const stack: string[] = [''];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    const currentFs = current === '' ? rootReal : join(rootReal, ...current.split('/'));
    let dirents;
    try {
      dirents = await readdir(currentFs, { withFileTypes: true });
    } catch (error) {
      if (current === '') {
        throw new WorkspaceRootUnavailableError();
      }
      stats.skippedUnreadable += 1;
      void error;
      continue;
    }
    stats.directoriesVisited += 1;
    dirents.sort((a, b) => compareStrings(a.name, b.name));
    // Push directories in reverse so traversal pops them in sorted
    // order; entries are sorted again at the end regardless.
    const childDirs: string[] = [];
    for (const dirent of dirents) {
      const childPath = current === '' ? dirent.name : `${current}/${dirent.name}`;
      if (isHiddenWorkspacePath(childPath)) {
        stats.skippedHidden += 1;
        continue;
      }
      if (isOverLimit(childPath)) {
        stats.skippedOverLimit += 1;
        continue;
      }
      const childFs = join(currentFs, dirent.name);
      let childStats;
      try {
        childStats = await lstat(childFs);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          stats.skippedVanished += 1;
        } else {
          stats.skippedUnreadable += 1;
        }
        continue;
      }
      if (childStats.isSymbolicLink()) {
        stats.skippedSymlinks += 1;
        continue;
      }
      if (childStats.isDirectory()) {
        childDirs.push(childPath);
        continue;
      }
      if (!childStats.isFile()) {
        stats.skippedOtherKinds += 1;
        continue;
      }
      const known = knownByPath.get(childPath);
      if (
        known !== undefined &&
        known.sizeBytes === childStats.size &&
        known.modifiedAtMs === childStats.mtimeMs
      ) {
        stats.hashesReused += 1;
        stats.files += 1;
        entries.push({
          path: childPath,
          name: dirent.name,
          sizeBytes: childStats.size,
          modifiedAt: childStats.mtime,
          createdAt: createdAtOrNull(childStats.birthtime),
          contentHash: known.contentHash,
          revision: known.revision,
          mimeType: mimeTypeForScannedPath(childPath),
        });
        continue;
      }
      let bytes: Buffer | null;
      try {
        bytes = await readFileNoFollow(childFs);
      } catch {
        stats.skippedUnreadable += 1;
        continue;
      }
      if (bytes === null) {
        stats.skippedVanished += 1;
        continue;
      }
      stats.hashesComputed += 1;
      stats.files += 1;
      entries.push({
        path: childPath,
        name: dirent.name,
        sizeBytes: childStats.size,
        modifiedAt: childStats.mtime,
        createdAt: createdAtOrNull(childStats.birthtime),
        contentHash: contentHash(bytes),
        revision: buildRevision(workspaceKey, childPath, bytes),
        mimeType: mimeTypeForScannedPath(childPath),
      });
    }
    for (let i = childDirs.length - 1; i >= 0; i -= 1) {
      stack.push(childDirs[i] as string);
    }
  }

  entries.sort((a, b) => compareStrings(a.path, b.path));
  return { entries, stats };
}

// One active files row, as the diff needs it. Field names follow the
// Drizzle schema (m4-canvas-files.ts); version is a number, matching
// the bigint mode used by the write index port.
export interface IndexRowSnapshot {
  path: string;
  contentHash: string;
  sizeBytes: number;
  version: number;
  mimeType: string | null;
}

// One row to upsert. The persisted fields reuse IndexWriteInput
// names and types exactly (Pick enforces this at compile time);
// revision and modifiedAt ride along for the store and for event
// payloads but are not files columns.
export interface IndexUpsert
  extends Pick<IndexWriteInput, 'path' | 'contentHash' | 'sizeBytes' | 'mimeType'> {
  revision: string;
  modifiedAt: Date;
}

export interface IndexSyncBatch {
  upserts: IndexUpsert[];
  // Paths whose active index row must be soft-deleted (deleted_at).
  deletes: string[];
}

// Drift classification per desain section 4.3 step 4.
// metadataMismatch is always 0 against the current schema: it means
// "same hash, different size/mtime/version", but size follows from
// the hashed bytes, mime follows from the path, and the files table
// stores no mtime, so no observable difference survives a hash
// match. The field stays so the summary keeps the design vocabulary
// if a future migration adds a persisted mtime column.
export interface DiffSummary {
  orphanDisk: number;
  phantomIndex: number;
  hashMismatch: number;
  metadataMismatch: number;
}

export interface IndexSyncPlan {
  batches: IndexSyncBatch[];
  summary: DiffSummary;
}

// Pure diff: compare scanned disk facts with active index rows and
// emit upsert/delete batches. Never touches disk or the store.
// - orphanDisk (on disk, no index row): upsert.
// - hashMismatch (both sides, different hash): upsert.
// - phantomIndex (index row, not on disk): delete.
// - Same hash on both sides: no batch entry, no version bump.
// Upserts and deletes are each sorted by path; batches pack
// operations in that order up to INDEX_BATCH_SIZE operations each.
// An empty plan (no differences) yields zero batches, never an
// empty batch.
export function planIndexSync(
  scanned: readonly ScannedFile[],
  indexRows: readonly IndexRowSnapshot[],
): IndexSyncPlan {
  const scannedByPath = new Map<string, ScannedFile>();
  for (const entry of scanned) {
    scannedByPath.set(entry.path, entry);
  }
  const indexByPath = new Map<string, IndexRowSnapshot>();
  for (const row of indexRows) {
    indexByPath.set(row.path, row);
  }

  const upserts: IndexUpsert[] = [];
  const deletes: string[] = [];
  const summary: DiffSummary = {
    orphanDisk: 0,
    phantomIndex: 0,
    hashMismatch: 0,
    metadataMismatch: 0,
  };

  const scannedPaths = [...scannedByPath.keys()].sort(compareStrings);
  for (const path of scannedPaths) {
    const entry = scannedByPath.get(path) as ScannedFile;
    const row = indexByPath.get(path);
    if (row === undefined) {
      summary.orphanDisk += 1;
      upserts.push({
        path: entry.path,
        contentHash: entry.contentHash,
        sizeBytes: entry.sizeBytes,
        mimeType: entry.mimeType,
        revision: entry.revision,
        modifiedAt: entry.modifiedAt,
      });
    } else if (row.contentHash !== entry.contentHash) {
      summary.hashMismatch += 1;
      upserts.push({
        path: entry.path,
        contentHash: entry.contentHash,
        sizeBytes: entry.sizeBytes,
        mimeType: entry.mimeType,
        revision: entry.revision,
        modifiedAt: entry.modifiedAt,
      });
    }
  }

  const indexPaths = [...indexByPath.keys()].sort(compareStrings);
  for (const path of indexPaths) {
    if (!scannedByPath.has(path)) {
      summary.phantomIndex += 1;
      deletes.push(path);
    }
  }

  const batches: IndexSyncBatch[] = [];
  let current: IndexSyncBatch = { upserts: [], deletes: [] };
  let currentOps = 0;
  const flushIfFull = (): void => {
    if (currentOps >= INDEX_BATCH_SIZE) {
      batches.push(current);
      current = { upserts: [], deletes: [] };
      currentOps = 0;
    }
  };
  for (const upsert of upserts) {
    flushIfFull();
    current.upserts.push(upsert);
    currentOps += 1;
  }
  for (const path of deletes) {
    flushIfFull();
    current.deletes.push(path);
    currentOps += 1;
  }
  if (currentOps > 0) {
    batches.push(current);
  }
  return { batches, summary };
}

// Minimal port the scanner needs from the index store. The Postgres
// implementation belongs to V3-06 part 2 (see header): listActive
// returns active rows only (deleted_at IS NULL), applyBatch applies
// one batch in a single transaction. The scanner never assumes the
// store keeps mtime or revision columns.
export interface FilesIndexStore {
  listActive(workspaceId: string): Promise<IndexRowSnapshot[]>;
  applyBatch(workspaceId: string, batch: IndexSyncBatch): Promise<void>;
}

export interface IndexSyncOptions {
  workspaceId: string;
  workspaceRoot: string;
  workspaceKey: string;
  known?: readonly KnownIndexEntry[];
}

export interface IndexSyncReport {
  scanned: number;
  stats: ScanStats;
  batchesApplied: number;
  upsertsApplied: number;
  deletesApplied: number;
  summary: DiffSummary;
}

// Scan, diff, and apply: the single entry point a reconcile job or a
// startup scan calls. Batches apply sequentially in plan order; a
// store failure aborts the remaining batches and propagates, so the
// caller can report a partial sync honestly instead of claiming a
// clean scan. This function never writes disk and never emits
// events; both are the store and reconcile owners' jobs.
export async function syncIndexFromScan(
  store: FilesIndexStore,
  options: IndexSyncOptions,
): Promise<IndexSyncReport> {
  const { entries, stats } = await scanWorkspaceTree({
    workspaceRoot: options.workspaceRoot,
    workspaceKey: options.workspaceKey,
    known: options.known,
  });
  const indexRows = await store.listActive(options.workspaceId);
  const plan = planIndexSync(entries, indexRows);
  let upsertsApplied = 0;
  let deletesApplied = 0;
  for (const batch of plan.batches) {
    await store.applyBatch(options.workspaceId, batch);
    upsertsApplied += batch.upserts.length;
    deletesApplied += batch.deletes.length;
  }
  return {
    scanned: entries.length,
    stats,
    batchesApplied: plan.batches.length,
    upsertsApplied,
    deletesApplied,
    summary: plan.summary,
  };
}
