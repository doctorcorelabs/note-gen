// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Readiness checks for the Fase 0 health endpoints.
//
// Contract (desain-health-endpoint.md sections 2 and 3):
// - Every check runs exactly once per request. No retry loop inside a
//   handler; retrying is the caller's job, so latency and failure stay
//   honest.
// - Per-check timeout 2000 ms, overall handler bound 5000 ms (both
//   configurable, see config.ts). A check that exceeds its bound fails
//   with its timeout code; the handler never hangs without a bound.
// - Responses carry only the fixed vocabulary of detail phrases and
//   machine error codes. Raw driver messages, DSN fragments, hosts,
//   users, passwords, and absolute paths are never interpolated.
// - Check order in the response is fixed: db, workspace, migrations,
//   pgvector, worker.
// - Fase 0 blocking rule: ready is true only when db and workspace are
//   ok and migrations is not failed. A pgvector failure is reported
//   honestly but does not block readiness in Fase 0 (it becomes hard in
//   Fase 2). Skipped migrations/worker do not block.

import { randomBytes } from 'node:crypto';
import {
  access as fsAccess,
  constants as fsConstants,
  open as fsOpen,
  opendir as fsOpendir,
  stat as fsStat,
  unlink as fsUnlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  assessMigrationDrift,
  readMigrationManifest,
  type MigrationManifest,
} from '../db/migrate.js';
import type { HealthDbPool } from '../db/pool.js';

export type CheckStatus = 'ok' | 'fail' | 'skipped';

export interface CheckResult {
  status: CheckStatus;
  latencyMs: number | null;
  detail: string | null;
  error: string | null;
}

export type ReadyChecks = {
  db: CheckResult;
  workspace: CheckResult;
  migrations: CheckResult;
  pgvector: CheckResult;
  worker: CheckResult;
};

export class CheckTimeoutError extends Error {
  constructor() {
    super('check timed out');
    this.name = 'CheckTimeoutError';
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    throw new CheckTimeoutError();
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new CheckTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function errorCodeOf(err: unknown): unknown {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code?: unknown }).code;
  }
  return undefined;
}

function mapDbError(err: unknown): { detail: string; error: string } {
  if (err instanceof CheckTimeoutError) {
    return { detail: 'check_timed_out', error: 'DB_TIMEOUT' };
  }
  const code = errorCodeOf(err);
  if (code === '28P01' || code === '28000') {
    return { detail: 'authentication_failed', error: 'DB_AUTH_FAILED' };
  }
  if (code === '3D000') {
    return { detail: 'database_not_found', error: 'DB_NOT_FOUND' };
  }
  if (code === '57014') {
    return { detail: 'check_timed_out', error: 'DB_TIMEOUT' };
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTDOWN' ||
    code === 'ENETDOWN' ||
    code === 'EAI_AGAIN' ||
    code === 'EPERM' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE'
  ) {
    // Connect-level failures: the database endpoint cannot be reached
    // from here. EPERM is included because sandboxed environments
    // refuse the connect() call itself for non-routable addresses
    // (proven by T12: connect EPERM in 6 ms for a blackhole DSN).
    // EPERM anywhere else in the check path has no other plausible
    // meaning: the check only connects and runs SELECT 1.
    return { detail: 'connection_failed', error: 'DB_UNREACHABLE' };
  }
  return { detail: 'unexpected_result', error: 'DB_QUERY_FAILED' };
}

// Postgres check: one connection from the application pool, the trivial
// read-only query SELECT 1 AS ok, result verified to be exactly one row
// with value 1, connection returned to the pool in a finally block.
export async function checkDb(pool: HealthDbPool | null, timeoutMs: number): Promise<CheckResult> {
  if (pool === null) {
    return { status: 'fail', latencyMs: null, detail: 'not_configured', error: 'DB_NOT_CONFIGURED' };
  }
  const start = Date.now();
  const elapsed = (): number => Date.now() - start;
  let timedOut = false;
  let client: Awaited<ReturnType<HealthDbPool['connect']>> | undefined;
  try {
    client = await withTimeout(pool.connect(), timeoutMs);
    const remaining = Math.max(0, timeoutMs - elapsed());
    const result = await withTimeout(client.query('SELECT 1 AS ok'), remaining);
    const value = result.rows[0]?.['ok'];
    if (result.rows.length !== 1 || value !== 1) {
      return { status: 'fail', latencyMs: elapsed(), detail: 'unexpected_result', error: 'DB_QUERY_FAILED' };
    }
    return { status: 'ok', latencyMs: elapsed(), detail: 'select_1_ok', error: null };
  } catch (err) {
    if (err instanceof CheckTimeoutError) {
      timedOut = true;
    }
    const mapped = mapDbError(err);
    return { status: 'fail', latencyMs: elapsed(), detail: mapped.detail, error: mapped.error };
  } finally {
    // A timed-out client may still be busy; releasing it with an error
    // destroys it instead of returning a busy client to the pool.
    if (client !== undefined) {
      client.release(timedOut ? new Error('health check timeout') : undefined);
    }
  }
}

// pgvector check: reports honestly whether the vector extension exists in
// the application database. When the database check failed, this check is
// not run and reports DB_UNAVAILABLE, because it cannot be verified
// without the database.
export async function checkPgvector(
  pool: HealthDbPool | null,
  dbOk: boolean,
  timeoutMs: number,
): Promise<CheckResult> {
  if (!dbOk || pool === null) {
    return { status: 'fail', latencyMs: null, detail: 'db_unavailable', error: 'DB_UNAVAILABLE' };
  }
  const start = Date.now();
  const elapsed = (): number => Date.now() - start;
  let timedOut = false;
  let client: Awaited<ReturnType<HealthDbPool['connect']>> | undefined;
  try {
    client = await withTimeout(pool.connect(), timeoutMs);
    const remaining = Math.max(0, timeoutMs - elapsed());
    const result = await withTimeout(
      client.query('SELECT 1 AS present FROM pg_extension WHERE extname = $1', ['vector']),
      remaining,
    );
    if (result.rows.length >= 1) {
      return { status: 'ok', latencyMs: elapsed(), detail: 'extension_present', error: null };
    }
    return { status: 'fail', latencyMs: elapsed(), detail: 'extension_missing', error: 'PGVECTOR_MISSING' };
  } catch (err) {
    if (err instanceof CheckTimeoutError) {
      timedOut = true;
      return { status: 'fail', latencyMs: elapsed(), detail: 'check_timed_out', error: 'PGVECTOR_CHECK_TIMEOUT' };
    }
    return { status: 'fail', latencyMs: elapsed(), detail: 'check_failed', error: 'PGVECTOR_CHECK_FAILED' };
  } finally {
    if (client !== undefined) {
      client.release(timedOut ? new Error('health check timeout') : undefined);
    }
  }
}

// Dependencies for the real migrations check (V3-15, wave 3B). The
// pool is the same application pool the db check uses, never a second
// DSN. The manifest is injectable so the comparison is testable with
// a fake DB handle; by default it is read from the migrations folder
// on disk through readMigrationManifest. The applied-hash reader is
// injectable too: by default it is the journal query through the
// pool, and a test may inject a runner that returns the applied
// digests directly, in which case the pool is not connected for the
// journal read. The check is opt-in: only a caller that passes these
// deps gets the real drift comparison.
export interface MigrationCheckDeps {
  pool: HealthDbPool | null;
  timeoutMs: number;
  manifest?: MigrationManifest;
  readManifest?: () => Promise<MigrationManifest>;
  readAppliedHashes?: () => Promise<string[]>;
}

// Migrations check. Reads the applied journal digests through the
// passed-in pool, compares them against the expected manifest with
// assessMigrationDrift (both directions: missing tags and unexpected
// digests), and fails with MIGRATION_DRIFT on any difference, which
// blocks readiness through the unchanged rule in runReadyChecks. The
// detail names the drift direction in the fixed vocabulary only:
// migrations_missing when expected tags are absent, migrations_unexpected
// when stored digests match no expected file, migration_drift when
// both directions differ at once. The tags and digests themselves
// never enter the result: the fixed vocabulary above keeps them out
// of the HTTP response, and the exact values stay available to the
// operator through assessMigrationDrift via checkMigrationDrift,
// which reports the same comparison outside the health response.
//
// States:
// - Database down: fail with DB_UNAVAILABLE, as in Fase 0.
// - No deps passed: skipped with check_not_configured. Server wiring
//   passes the deps (V3-15 full wiring, waiting on trunk state); until
//   then the check honestly reports that it is not wired, and skipped
//   still does not block readiness.
// - Journal table or schema missing: treated as zero applied, so a
//   fresh database fails with MIGRATION_DRIFT, never skipped.
// - Any other failure (query error, timeout, unreadable manifest):
//   fail with a fixed machine code. This function never throws.
export async function checkMigrations(
  dbOk: boolean,
  deps?: MigrationCheckDeps,
): Promise<CheckResult> {
  if (!dbOk) {
    return { status: 'fail', latencyMs: null, detail: 'db_unavailable', error: 'DB_UNAVAILABLE' };
  }
  if (deps === undefined) {
    return { status: 'skipped', latencyMs: null, detail: 'check_not_configured', error: null };
  }
  if (deps.pool === null) {
    return { status: 'fail', latencyMs: null, detail: 'db_unavailable', error: 'DB_UNAVAILABLE' };
  }
  const start = Date.now();
  const elapsed = (): number => Date.now() - start;
  let manifest: MigrationManifest;
  try {
    manifest = deps.manifest ?? (await (deps.readManifest ?? readMigrationManifest)());
  } catch {
    return { status: 'fail', latencyMs: elapsed(), detail: 'manifest_unavailable', error: 'MIGRATION_MANIFEST_UNAVAILABLE' };
  }
  let timedOut = false;
  let client: Awaited<ReturnType<HealthDbPool['connect']>> | undefined;
  try {
    let appliedHashes: string[];
    if (deps.readAppliedHashes !== undefined) {
      // Injected runner: the caller supplies the applied digests
      // directly, so no pool connection is opened for the journal
      // read. A missing journal table or schema reported by the
      // runner means zero applied, exactly as in the pool path.
      try {
        appliedHashes = await withTimeout(deps.readAppliedHashes(), deps.timeoutMs);
      } catch (err) {
        const code = errorCodeOf(err);
        if (code === '42P01' || code === '3F000') {
          appliedHashes = [];
        } else {
          throw err;
        }
      }
    } else {
      client = await withTimeout(deps.pool.connect(), deps.timeoutMs);
      const remaining = Math.max(0, deps.timeoutMs - elapsed());
      let rows: Array<Record<string, unknown>>;
      try {
        const result = await withTimeout(
          client.query(
            'SELECT "hash" FROM "drizzle"."__drizzle_migrations" ORDER BY "created_at" ASC, "hash" ASC',
          ),
          remaining,
        );
        rows = result.rows;
      } catch (err) {
        const code = errorCodeOf(err);
        if (code === '42P01' || code === '3F000') {
          rows = [];
        } else {
          throw err;
        }
      }
      appliedHashes = rows
        .map((row) => row['hash'])
        .filter((hash): hash is string => typeof hash === 'string');
    }
    const drift = assessMigrationDrift(manifest, appliedHashes);
    if (drift.current) {
      return { status: 'ok', latencyMs: elapsed(), detail: 'migrations_current', error: null };
    }
    const detail =
      drift.missingTags.length > 0 && drift.unexpectedHashes.length > 0
        ? 'migration_drift'
        : drift.missingTags.length > 0
          ? 'migrations_missing'
          : 'migrations_unexpected';
    return { status: 'fail', latencyMs: elapsed(), detail, error: 'MIGRATION_DRIFT' };
  } catch (err) {
    if (err instanceof CheckTimeoutError) {
      timedOut = true;
      return { status: 'fail', latencyMs: elapsed(), detail: 'check_timed_out', error: 'MIGRATION_CHECK_TIMEOUT' };
    }
    return { status: 'fail', latencyMs: elapsed(), detail: 'check_failed', error: 'MIGRATION_CHECK_FAILED' };
  } finally {
    if (client !== undefined) {
      client.release(timedOut ? new Error('health check timeout') : undefined);
    }
  }
}

// Worker check: contract set in wave 3A (V3-39c).
//
// Honest skipped result. No worker is deployed in the MVP and no
// heartbeat table exists in the M1-M7 schema, so there is no heartbeat
// source this check could read. The check therefore stays skipped with
// the locked Fase 0 detail, performs no I/O (no pool, no disk), and
// returns the same value in every database state. Skipped means "not
// applicable", never "worker healthy": this task makes no claim of a
// real worker check.
//
// Blocking rule: a skipped worker never blocks readiness. The ok rule
// in runReadyChecks is unchanged (db ok, workspace ok, migrations not
// failed); pgvector and worker results do not decide it. This function
// must keep returning skipped until the promotion below lands;
// changing the status without a real heartbeat source would be a false
// report either way (ok would claim a healthy worker, fail would block
// deploys that have no worker by design).
//
// Promotion contract (future work, wave 5 / T16, NOT this task): when
// a worker is deployed together with a heartbeat table and writer, this
// check reads the newest heartbeat using the database clock, fresh
// means ok, older than 300000 ms means fail with WORKER_STALE, no
// heartbeat row at all means fail with WORKER_NO_HEARTBEAT, and a dead
// database means fail with DB_UNAVAILABLE; the check then becomes hard.
// The promotion changes this signature and both call sites
// (runReadyChecks and the emergency envelope), and it needs the
// heartbeat schema plus a contract amendment if the ReadyChecks shape
// changes. Sequencing: V3-15 (wave 3B) adds the real checkMigrations
// above this contract and must not change checkWorker.
export function checkWorker(): CheckResult {
  return { status: 'skipped', latencyMs: null, detail: 'no_worker_in_fase_0', error: null };
}

// Filesystem surface used by the workspace check. Injectable so the
// failure modes (unreadable, unwritable, cleanup failure) can be tested
// with mocks instead of relying on permission bits, which root ignores.
export interface WorkspaceFs {
  stat: (path: string) => Promise<{ isDirectory: () => boolean }>;
  access: (path: string, mode?: number) => Promise<void>;
  opendir: (path: string) => Promise<{ close: () => Promise<void> }>;
  open: (path: string, flags: string) => Promise<{ writeFile: (data: string) => Promise<void>; close: () => Promise<void> }>;
  unlink: (path: string) => Promise<void>;
  R_OK: number;
}

export const realWorkspaceFs: WorkspaceFs = {
  stat: (path) => fsStat(path),
  access: (path, mode) => fsAccess(path, mode),
  opendir: (path) => fsOpendir(path),
  open: (path, flags) => fsOpen(path, flags),
  unlink: (path) => fsUnlink(path),
  R_OK: fsConstants.R_OK,
};

interface ProbeState {
  probePath: string | undefined;
}

async function runWorkspaceProbe(
  root: string,
  fsDeps: WorkspaceFs,
  start: number,
  state: ProbeState,
): Promise<CheckResult> {
  const elapsed = (): number => Date.now() - start;
  let stats: { isDirectory: () => boolean };
  try {
    stats = await fsDeps.stat(root);
  } catch (err) {
    if (errorCodeOf(err) === 'ENOENT') {
      return { status: 'fail', latencyMs: elapsed(), detail: 'directory_missing', error: 'WORKSPACE_MISSING' };
    }
    return { status: 'fail', latencyMs: elapsed(), detail: 'stat_failed', error: 'WORKSPACE_UNREACHABLE' };
  }
  if (!stats.isDirectory()) {
    return { status: 'fail', latencyMs: elapsed(), detail: 'not_a_directory', error: 'WORKSPACE_NOT_DIRECTORY' };
  }
  try {
    await fsDeps.access(root, fsDeps.R_OK);
    const dir = await fsDeps.opendir(root);
    await dir.close();
  } catch {
    return { status: 'fail', latencyMs: elapsed(), detail: 'not_readable', error: 'WORKSPACE_NOT_READABLE' };
  }
  // Writability is proven with a real write probe, never with permission
  // bits alone: bits can pass while a read-only mount or a full disk
  // makes a real write fail. The probe file is created exclusively with
  // a unique name, written, closed, and removed in all paths.
  const probeName = `.health-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
  const probePath = join(root, probeName);
  state.probePath = probePath;
  try {
    const handle = await fsDeps.open(probePath, 'wx');
    try {
      await handle.writeFile('ok');
    } finally {
      await handle.close();
    }
  } catch {
    state.probePath = undefined;
    return { status: 'fail', latencyMs: elapsed(), detail: 'write_probe_failed', error: 'WORKSPACE_NOT_WRITABLE' };
  }
  try {
    await fsDeps.unlink(probePath);
  } catch {
    return { status: 'fail', latencyMs: elapsed(), detail: 'probe_cleanup_failed', error: 'WORKSPACE_CLEANUP_FAILED' };
  }
  state.probePath = undefined;
  return { status: 'ok', latencyMs: elapsed(), detail: 'readable_and_writable', error: null };
}

// Workspace root check: the directory from WORKSPACE_ROOT must exist, be
// a directory, be readable, and pass a real write probe. No silent
// default (cwd, /tmp, or any other path) is ever substituted when the
// variable is missing, and no path other than WORKSPACE_ROOT is tested.
export async function checkWorkspace(
  root: string | undefined,
  timeoutMs: number,
  fsDeps: WorkspaceFs = realWorkspaceFs,
): Promise<CheckResult> {
  if (root === undefined || root.trim() === '') {
    return { status: 'fail', latencyMs: null, detail: 'not_configured', error: 'WORKSPACE_NOT_CONFIGURED' };
  }
  if (!isAbsolute(root) || root === '/') {
    return { status: 'fail', latencyMs: null, detail: 'invalid_path', error: 'WORKSPACE_INVALID_PATH' };
  }
  const start = Date.now();
  const state: ProbeState = { probePath: undefined };
  try {
    return await withTimeout(runWorkspaceProbe(root, fsDeps, start, state), timeoutMs);
  } catch (err) {
    if (err instanceof CheckTimeoutError) {
      // Best effort cleanup of a probe file that a timed-out probe may
      // have left behind. Cleanup failure here does not change the
      // timeout result; the next probe uses a fresh unique name.
      if (state.probePath !== undefined) {
        try {
          await fsDeps.unlink(state.probePath);
        } catch {
          // Ignore: the timeout result below is the honest outcome.
        }
      }
      return { status: 'fail', latencyMs: Date.now() - start, detail: 'check_timed_out', error: 'WORKSPACE_TIMEOUT' };
    }
    throw err;
  }
}

export interface ReadyCheckDeps {
  pool: HealthDbPool | null;
  workspaceRoot: string | undefined;
  checkTimeoutMs: number;
  overallTimeoutMs: number;
  workspaceFs?: WorkspaceFs;
  // Optional until server wiring passes it (V3-15 full wiring). When
  // absent, the migrations check reports skipped and readiness is
  // decided exactly as before; when present, drift blocks readiness.
  migrationCheck?: MigrationCheckDeps;
}

// Runs the readiness checks. db and workspace run in parallel; the
// database-dependent checks run after db is known, so a dead database
// yields DB_UNAVAILABLE for migrations and pgvector without wasted
// queries. Each phase is bounded by the remaining overall budget, so the
// whole collection stays inside the overall timeout.
export async function runReadyChecks(deps: ReadyCheckDeps): Promise<{ checks: ReadyChecks; ok: boolean }> {
  const deadline = Date.now() + deps.overallTimeoutMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const [db, workspace] = await Promise.all([
    checkDb(deps.pool, Math.min(deps.checkTimeoutMs, remaining())),
    checkWorkspace(deps.workspaceRoot, Math.min(deps.checkTimeoutMs, remaining()), deps.workspaceFs),
  ]);
  const dbOk = db.status === 'ok';
  const pgvector = await checkPgvector(deps.pool, dbOk, Math.min(deps.checkTimeoutMs, remaining()));
  const migrations = await checkMigrations(dbOk, deps.migrationCheck);
  const worker = checkWorker();
  const checks: ReadyChecks = { db, workspace, migrations, pgvector, worker };
  const ok = db.status === 'ok' && workspace.status === 'ok' && migrations.status !== 'fail';
  return { checks, ok };
}
