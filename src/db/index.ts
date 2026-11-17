// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * SQL funnel (V3-14, 3E fold): the single entry point through
 * which database access used to flow, now routed to the typed
 * SqlAdapter.
 *
 * What changed at V3-14: the local database binding, the inline
 * schema creation, and the trigger setup that used to live here
 * are gone. The AD-90 funnel exception expired with this change:
 * this file no longer imports the former Tauri SQL plugin, and the
 * gate exception that permitted exactly that import was removed
 * with it. Schema and migrations are the server's job (versioned
 * migrations plus the startup migrator); the client never runs
 * DDL, never sees a table name, and never sends SQL.
 *
 * The live surface is small:
 * - `getSqlAdapter()` returns the registered `SqlAdapter` from the
 *   platform registry. All new database access goes through it,
 *   with typed catalog operations only (AD-26). Registration is
 *   owned by wiring (AD-33); until wiring registers the adapter,
 *   resolving it throws the registry's not-registered error.
 * - `initSqlAdapter()` checks adapter readiness (endpoint ready
 *   plus session, through `ready()`) and returns without running
 *   DDL. `initAllDatabases()` keeps its name and memoized shape
 *   for existing callers and delegates to it.
 *
 * The legacy surface below (`getDb`, the `db` facade,
 * `executeRecordTransaction`, `RecordStatement`) is kept ONLY so
 * unmigrated callers keep typechecking while the codemod rewrites
 * them call-site by call-site (reconciliation classes A-J). Every
 * legacy entry point fails loudly at runtime with a
 * `PlatformCapabilityError` naming the migration; nothing fails
 * silently and nothing executes. The per-module init functions
 * are NOT called from here anymore: the sync-state and
 * self-hosted init functions target deleted tables and must never
 * run, the rest are replaced by the readiness check, the wiki
 * preference bootstrap and the structured knowledge registry
 * bootstrap are re-homed outside boot init (follow-up, see the
 * V3-14 report), and the conversation-sync initialized flag is
 * never written (the sync protocol is deleted).
 */

// Relative import (not the @/ alias): vitest does not resolve the
// alias to this directory index, and this module is spec-covered.
import {
  capabilityError,
  getPlatformMode,
  platform,
  type PlatformCapabilityError,
  type SqlAdapter,
} from "../lib/platform";

/**
 * Deprecated statement shape for `executeRecordTransaction`.
 * Kept for type-compatibility with unmigrated callers only: no
 * execution path accepts these statements anymore. Callers migrate
 * to typed catalog operations sent through the adapter's
 * `transaction` method.
 */
export interface RecordStatement {
  sql: string;
  values: (string | number | boolean | null)[];
  expectedRows?: number;
}

/**
 * Shape of a legacy write result, matching the fields unmigrated
 * callers read (`rowsAffected`, `lastInsertId`). Kept for
 * type-compatibility only: no legacy write ever succeeds anymore.
 */
export interface LegacyDbWriteResult {
  rowsAffected: number;
  lastInsertId?: number;
}

/**
 * Structural shape of the legacy database handle, matching the
 * methods unmigrated callers use (`execute`, `select`, `close`).
 * Kept for type-compatibility only: `getDb()` never returns a
 * working handle anymore.
 */
export interface LegacyDatabaseHandle {
  execute(
    query: string,
    bindValues?: unknown[],
  ): Promise<LegacyDbWriteResult>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  close(databaseName?: string): Promise<boolean>;
}

function legacyDbRemovedError(capability: string): PlatformCapabilityError {
  return capabilityError(
    "unsupported",
    "sql",
    capability,
    getPlatformMode(),
    "raw SQL access was removed at V3-14 (AD-90 funnel closed); use getSqlAdapter() with typed catalog operations",
  );
}

/**
 * The registered SqlAdapter, resolved through the platform
 * registry. Throws the registry's not-registered error until
 * wiring registers the adapter (AD-33 follow-up).
 */
export function getSqlAdapter(): SqlAdapter {
  return platform.sql;
}

/**
 * Deprecated: raw SQL access was removed. Always rejects with a
 * `PlatformCapabilityError` naming the migration to
 * `getSqlAdapter()`. Kept so unmigrated callers keep typechecking
 * until the codemod rewrites them; never returns a handle.
 */
export async function getDb(): Promise<LegacyDatabaseHandle> {
  throw legacyDbRemovedError("getDb");
}

/**
 * Deprecated: raw SQL execution was removed. Always rejects with
 * a `PlatformCapabilityError` naming the migration to typed
 * operations through the adapter's `transaction` method. The
 * statements are never read, never sent, and never executed.
 */
export async function executeRecordTransaction(
  statements: RecordStatement[],
): Promise<void> {
  void statements;
  throw legacyDbRemovedError("executeRecordTransaction");
}

/**
 * Deprecated compatibility facade for modules that historically
 * imported `db` directly. `execute` and `select` always reject
 * with the migration error. `close` resolves `false`: no local
 * connection exists anymore, so there is nothing to close, and
 * teardown paths must not throw.
 */
export const db = {
  async execute(
    query: string,
    bindValues?: unknown[],
  ): Promise<LegacyDbWriteResult> {
    void query;
    void bindValues;
    throw legacyDbRemovedError("db.execute");
  },
  async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
    void query;
    void bindValues;
    throw legacyDbRemovedError("db.select");
  },
  async close(): Promise<boolean> {
    return false;
  },
};

/**
 * Check SqlAdapter readiness and return. No DDL runs, no schema is
 * created, and no per-module init runs: the server migrator owns
 * the schema, and readiness comes from the health endpoint through
 * `ready()`. Throws a capability error when the adapter reports
 * not-ok, so boot fails with a diagnosable cause instead of
 * proceeding against an unreadable database.
 */
export async function initSqlAdapter(): Promise<void> {
  const adapter = getSqlAdapter();
  const health = await adapter.ready();
  if (!health.ok) {
    throw capabilityError(
      "unavailable",
      "sql",
      "ready",
      getPlatformMode(),
      "database readiness check failed; verify migrations are current and the session is valid",
    );
  }
}

let sqlAdapterInitialization: Promise<void> | null = null;

/**
 * Initialize database access for boot. Delegates to
 * `initSqlAdapter()` with the historical memoization: one process
 * reuses one initialization task, and a failure clears the memo so
 * the next call retries. Kept under its historical name because
 * boot and several callers import it.
 */
export function initAllDatabases(): Promise<void> {
  if (!sqlAdapterInitialization) {
    sqlAdapterInitialization = initSqlAdapter().catch((error) => {
      sqlAdapterInitialization = null;
      throw error;
    });
  }

  return sqlAdapterInitialization;
}
