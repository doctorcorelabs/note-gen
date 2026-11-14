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

// Migrations check. Fase 0 has no migration registry, so the check is
// skipped when the database is reachable. When the database is down, the
// check fails with DB_UNAVAILABLE even in Fase 0, because migration status
// cannot be determined at all without the database. The real drift check
// plugs in here in Fase 1; the contract (drift means 503) is already
// locked by the design document.
export function checkMigrations(dbOk: boolean): CheckResult {
  if (!dbOk) {
    return { status: 'fail', latencyMs: null, detail: 'db_unavailable', error: 'DB_UNAVAILABLE' };
  }
  return { status: 'skipped', latencyMs: null, detail: 'no_migration_registry_in_fase_0', error: null };
}

// Worker check. Fase 0 has no worker and no heartbeat table, so the check
// is always skipped, regardless of database state. Skipped means "not
// applicable", not "worker healthy".
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
  const migrations = checkMigrations(dbOk);
  const worker = checkWorker();
  const checks: ReadyChecks = { db, workspace, migrations, pgvector, worker };
  const ok = db.status === 'ok' && workspace.status === 'ok' && migrations.status !== 'fail';
  return { checks, ok };
}
