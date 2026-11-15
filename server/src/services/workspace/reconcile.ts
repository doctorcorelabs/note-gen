// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace reconciliation service (V3-05, wave 3B overlap).
//
// Compares the on-disk workspace tree against the files index and
// reports the drift, following desain-workspace-api.md section 4.3.
// Reconciliation repairs the index only; it never writes, moves, or
// deletes a file on disk. The one exception in the design (cleaning
// stale `.notegen-tmp-*` files) is not implemented in this slice.
//
// Index seam (read this before wiring): the real index lands in
// V3-06. This module consumes the index through the
// ReconcileIndexPort interface below, a READ port over the same
// `files` table the V3-04b write path upserts
// (services/workspace/write-index-pg.ts). The V3-04b
// WorkspaceIndexPort (write-ports.ts) has no list operation, so
// this module defines its own read port instead of reusing that
// interface; V3-06 implements ReconcileIndexPort over Postgres and
// may merge the two ports by amendment. This module must never
// import the Postgres adapter directly: tests run against a fake
// index, and production wiring is the integrator's step.
//
// Row vocabulary: path, contentHash (hex SHA-256 of the content
// bytes alone, files.content_hash), sizeBytes, and version, copied
// from the `files` table. The table has no mtime column, so the
// size-plus-mtime fast path in desain 4.3 step 3 cannot run
// against this schema: every disk file is hashed. A fast path
// needs a schema amendment that adds a stored mtime first.
//
// Drift categories (desain 4.3 step 4):
// - orphanDisk: on disk, no active index row.
// - phantomIndex: active index row, nothing on disk at that path.
// - hashMismatch: present in both, content hash differs.
// - metadataMismatch: hash matches but the stored sizeBytes
//   differs from disk. Version alone is never drift: version is an
//   index-internal counter with no disk counterpart. An index row
//   whose path names a disk directory is not drift either: directory
//   rows are not owned by this slice, and the write path never
//   creates them.
//
// Repairs: the optional ReconcileRepairPort applies the diff to
// the index. When no repair port is injected, or when dryRun is
// true, no repair is attempted and the report honestly records
// driftRepaired 0 with driftRemaining equal to driftFound. This
// slice never claims a repair it did not perform. The repair port
// is the V3-06 seam for index mutation plus event publication
// (desain 4.3 step 5); lock-aware skipping (skippedLocked) belongs
// to that implementation, and this slice always reports 0 because
// it takes no per-path locks itself.
//
// Job records live in the in-memory ReconcileJobRegistry. That is
// acceptable for MVP per the V3-05 brief: persistence is NOT
// required and is NOT implemented. A restart loses the running and
// last-run state, and a job in flight at restart simply never
// completes. No job queue schema is invented here: a run is one
// async function call guarded by the single-flight registry.

import { constants as fsConstants, lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApiError } from '../../plugins/envelope.js';
import { contentHash } from '../../lib/revision.js';

export const RECONCILE_JOB_ID_PREFIX = 'rec-';
export const DRIFT_PATHS_LIMIT = 100;

export type DriftCategory = 'orphanDisk' | 'phantomIndex' | 'hashMismatch' | 'metadataMismatch';

// One active row of the files index, as the reconcile read port
// returns it. Only the fields the diff needs; the row id and
// mimeType are not consulted.
export interface ReconcileIndexRow {
  path: string;
  contentHash: string;
  sizeBytes: number;
  version: number;
}

// Read port over the files index. V3-06 implements this over
// Postgres (all active rows for one workspace, deletedAt null).
// The workspace id comes from the session, never from the client.
export interface ReconcileIndexPort {
  listActiveRows(workspaceId: string): Promise<readonly ReconcileIndexRow[]>;
}

// One file found on disk during the tree walk: the same snapshot
// feeds both the hash and the size, so the two can never describe
// different moments of a file that changed mid-scan.
export interface DiskFileEntry {
  path: string;
  sizeBytes: number;
  contentHash: string;
}

export interface DriftEntry {
  path: string;
  category: DriftCategory;
  disk: DiskFileEntry | null;
  index: ReconcileIndexRow | null;
}

// Repair port: applies a computed diff to the index. The return
// value is the number of drift entries actually repaired; the
// caller clamps it to the range 0 to drift.length. Event
// publication and per-path locking are the implementation's job
// (desain 4.3 steps 5 and 7). Absent until V3-06 wires it.
export interface ReconcileRepairPort {
  applyRepairs(workspaceId: string, drift: readonly DriftEntry[]): Promise<{ repaired: number }>;
}

export interface DriftCategories {
  orphanDisk: number;
  phantomIndex: number;
  hashMismatch: number;
  metadataMismatch: number;
}

export interface ReconcileDiff {
  entries: DriftEntry[];
  categories: DriftCategories;
  filesScanned: number;
  indexRowsChecked: number;
}

// Last-run report shape, mirroring the `lastRun` object of
// GET /api/workspace/reconcile in desain 4.5. The GET route is a
// separate V3-05 part and reads this report from the shared
// registry; this module only produces and stores it.
export interface ReconcileReport {
  jobId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  filesScanned: number;
  indexRowsChecked: number;
  driftFound: number;
  driftRepaired: number;
  driftRemaining: number;
  skippedLocked: number;
  categories: DriftCategories;
  dryRun: boolean;
  driftPaths: string[];
  driftPathsTruncated: boolean;
  status: 'completed';
}

export function createReconcileJobId(): string {
  return `${RECONCILE_JOB_ID_PREFIX}${randomUUID()}`;
}

// Code-unit comparison, case sensitive, no locale (same ordering
// rule as the read service).
function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

// Pure diff: disk entries and index rows in, classified drift out.
// Directory paths on disk suppress phantomIndex for index rows
// that name them (see the module comment).
export function computeReconcileDiff(
  diskFiles: readonly DiskFileEntry[],
  indexRows: readonly ReconcileIndexRow[],
  diskDirectories: ReadonlySet<string>,
): ReconcileDiff {
  const indexByPath = new Map<string, ReconcileIndexRow>();
  for (const row of indexRows) {
    // The unique partial index on (workspace_id, path) forbids two
    // active rows for one path; last wins defensively so a corrupt
    // port result degrades to one comparison instead of a crash.
    indexByPath.set(row.path, row);
  }
  const diskByPath = new Map<string, DiskFileEntry>();
  for (const file of diskFiles) {
    diskByPath.set(file.path, file);
  }
  const entries: DriftEntry[] = [];
  for (const file of diskFiles) {
    const row = indexByPath.get(file.path);
    if (row === undefined) {
      entries.push({ path: file.path, category: 'orphanDisk', disk: file, index: null });
    } else if (row.contentHash !== file.contentHash) {
      entries.push({ path: file.path, category: 'hashMismatch', disk: file, index: row });
    } else if (row.sizeBytes !== file.sizeBytes) {
      entries.push({ path: file.path, category: 'metadataMismatch', disk: file, index: row });
    }
  }
  for (const row of indexRows) {
    if (!diskByPath.has(row.path) && !diskDirectories.has(row.path)) {
      entries.push({ path: row.path, category: 'phantomIndex', disk: null, index: row });
    }
  }
  entries.sort((a, b) => compareStrings(a.path, b.path));
  const categories: DriftCategories = {
    orphanDisk: 0,
    phantomIndex: 0,
    hashMismatch: 0,
    metadataMismatch: 0,
  };
  for (const entry of entries) {
    categories[entry.category] += 1;
  }
  return {
    entries,
    categories,
    filesScanned: diskFiles.length,
    indexRowsChecked: indexRows.length,
  };
}

async function readFileNoFollow(fsPath: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(fsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
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

export interface WorkspaceTreeSnapshot {
  files: DiskFileEntry[];
  directories: Set<string>;
}

// Walk the workspace tree (desain 4.3 step 1): recursive from the
// root, skipping dot-segment entries, symlinks (never followed,
// never reported as drift), and non-file non-directory entries.
// Temporary `.notegen-tmp-*` files start with a dot, so the dot
// rule skips them too. Trash lives outside the root and is never
// walked. Files that vanish mid-scan are absent from the snapshot,
// not drift. A missing or unreadable root answers 503
// service_unavailable, the same mapping the read service uses.
export async function scanWorkspaceTree(workspaceRoot: string): Promise<WorkspaceTreeSnapshot> {
  let rootReal: string;
  try {
    rootReal = await realpath(workspaceRoot);
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
  const files: DiskFileEntry[] = [];
  const directories = new Set<string>();
  const stack: string[] = [''];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const currentFs = current === '' ? rootReal : join(rootReal, ...current.split('/'));
    const dirents = await readdir(currentFs, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) {
        continue;
      }
      const childPath = current === '' ? dirent.name : `${current}/${dirent.name}`;
      const childFs = join(currentFs, dirent.name);
      let childStats;
      try {
        childStats = await lstat(childFs);
      } catch {
        continue;
      }
      if (childStats.isSymbolicLink()) {
        continue;
      }
      if (childStats.isDirectory()) {
        directories.add(childPath);
        stack.push(childPath);
      } else if (childStats.isFile()) {
        const bytes = await readFileNoFollow(childFs);
        if (bytes === null) {
          continue;
        }
        files.push({ path: childPath, sizeBytes: bytes.length, contentHash: contentHash(bytes) });
      }
    }
  }
  files.sort((a, b) => compareStrings(a.path, b.path));
  return { files, directories };
}

export interface ReconcileScanInput {
  jobId: string;
  workspaceId: string;
  workspaceRoot: string;
  index: ReconcileIndexPort;
  repairs?: ReconcileRepairPort;
  dryRun: boolean;
  startedAt: Date;
}

// One full scan: walk disk, read the index, diff, and (unless this
// is a dry run or no repair port is wired) apply repairs through
// the port. Throws when the walk or the index read fails; the
// caller records the failure on the job. Never touches disk
// contents: the only mutation path is the repair port, which
// writes the index, never files.
export async function runReconcileScan(input: ReconcileScanInput): Promise<ReconcileReport> {
  const snapshot = await scanWorkspaceTree(input.workspaceRoot);
  const rows = await input.index.listActiveRows(input.workspaceId);
  const diff = computeReconcileDiff(snapshot.files, rows, snapshot.directories);
  let repaired = 0;
  if (!input.dryRun && input.repairs !== undefined && diff.entries.length > 0) {
    const result = await input.repairs.applyRepairs(input.workspaceId, diff.entries);
    repaired = Math.max(0, Math.min(diff.entries.length, result.repaired));
  }
  const finishedAt = new Date();
  const driftPaths = diff.entries.slice(0, DRIFT_PATHS_LIMIT).map((entry) => entry.path);
  return {
    jobId: input.jobId,
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - input.startedAt.getTime(),
    filesScanned: diff.filesScanned,
    indexRowsChecked: diff.indexRowsChecked,
    driftFound: diff.entries.length,
    driftRepaired: repaired,
    driftRemaining: diff.entries.length - repaired,
    skippedLocked: 0,
    categories: diff.categories,
    dryRun: input.dryRun,
    driftPaths,
    driftPathsTruncated: diff.entries.length > DRIFT_PATHS_LIMIT,
    status: 'completed',
  };
}

export type ReconcileJobStatus = 'running' | 'completed' | 'failed';

export interface ReconcileJobRecord {
  jobId: string;
  status: ReconcileJobStatus;
  full: boolean;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  report: ReconcileReport | null;
}

// In-memory, single-flight job registry. At most one job runs at a
// time per registry instance: tryStart is synchronous
// check-and-set, so a second POST while a run is in flight is
// rejected 409 without ever queueing (kontrak 3.1, desain 4.5).
// The registry is process memory only: nothing here survives a
// restart, by design for MVP (see the module comment). The
// integrator MUST share one registry instance between the POST
// route in this slice and the future GET status route, or the GET
// route will see an empty registry.
export class ReconcileJobRegistry {
  private runningJob: ReconcileJobRecord | null = null;
  private lastFinished: ReconcileJobRecord | null = null;
  private idleWaiters: Array<() => void> = [];

  tryStart(jobId: string, full: boolean, dryRun: boolean, startedAt: Date): ReconcileJobRecord | null {
    if (this.runningJob !== null) {
      return null;
    }
    const record: ReconcileJobRecord = {
      jobId,
      status: 'running',
      full,
      dryRun,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      report: null,
    };
    this.runningJob = record;
    return record;
  }

  complete(jobId: string, report: ReconcileReport): void {
    if (this.runningJob === null || this.runningJob.jobId !== jobId) {
      return;
    }
    this.runningJob.status = 'completed';
    this.runningJob.finishedAt = report.finishedAt;
    this.runningJob.report = report;
    this.lastFinished = this.runningJob;
    this.runningJob = null;
    this.notifyIdle();
  }

  fail(jobId: string, finishedAt: Date): void {
    if (this.runningJob === null || this.runningJob.jobId !== jobId) {
      return;
    }
    this.runningJob.status = 'failed';
    this.runningJob.finishedAt = finishedAt.toISOString();
    this.lastFinished = this.runningJob;
    this.runningJob = null;
    this.notifyIdle();
  }

  running(): ReconcileJobRecord | null {
    return this.runningJob;
  }

  lastRecord(): ReconcileJobRecord | null {
    return this.lastFinished;
  }

  lastReport(): ReconcileReport | null {
    return this.lastFinished?.report ?? null;
  }

  waitForIdle(): Promise<void> {
    if (this.runningJob === null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private notifyIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
