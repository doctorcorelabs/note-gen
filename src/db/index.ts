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
 *   plus session, through `ready()`), then runs the 13 table
 *   verifications of desain-sql-adapter section 5.4 (F5, wave 4):
 *   one cheap read per retained table, batched through
 *   `queryMany`, writing nothing and creating no schema.
 *   `initAllDatabases()` keeps its name and memoized shape
 *   for existing callers and delegates to it.
 *
 * Re-homed outside boot init (F5): `initializeWikiPreferences`
 * runs through the StoreAdapter, lazily from `getWikiSettings`
 * (it is not a boot step); `bootstrapStructuredKnowledgeRegistry`
 * runs through the SqlAdapter (`knowledge.upsertSource`, status
 * pending, no indexing) plus the StoreAdapter consent key, from
 * its owner in `src/lib/knowledge-index.ts` (it is not a boot
 * step either). The two init functions for deleted tables
 * (`initConversationSyncStateDb`, `initSelfHostedSyncDb`) were
 * removed with F5: they had no callers and must never run.
 *
 * The legacy surface below (`getDb`, the `db` facade,
 * `executeRecordTransaction`, `RecordStatement`) is kept ONLY so
 * unmigrated callers keep typechecking while the codemod rewrites
 * them call-site by call-site (reconciliation classes A-J). Every
 * legacy entry point fails loudly at runtime with a
 * `PlatformCapabilityError` naming the migration; nothing fails
 * silently and nothing executes. The per-module init functions
 * are NOT called from here anymore: the sync-state and
 * self-hosted init functions target deleted tables and were
 * removed, the rest are replaced by the readiness check plus the
 * section 5.4 verifications, and the conversation-sync
 * initialized flag is never written (the sync protocol is
 * deleted).
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
 * The section 5.4 verification batch: 13 verification rows, 14
 * cheap reads (the memories row needs two: the list plus the
 * policy default). Each read proves one retained table is
 * reachable through the adapter; no read writes anything and no
 * read creates schema. Probe ids are arbitrary: the list handlers
 * answer an empty array for an unknown conversation or tag,
 * never an error, and the cache read answers a miss for a random
 * key, so the batch succeeds on an empty database and fails only
 * when a table cannot be reached at all (stale migrations, a
 * broken session, or a down backend). Row order follows the
 * section 5.4 table (rows 4 and 15, the deleted tables, are
 * absent by disposition).
 */
type VerificationBatch = Parameters<SqlAdapter["queryMany"]>[0];

function buildVerificationBatch(): VerificationBatch {
  return [
    { kind: "messages.listByConversation", conversationId: 1, limit: 1 },
    { kind: "conversations.list", limit: 1 },
    { kind: "compactions.listByConversation", conversationId: 1, limit: 1 },
    {
      kind: "imageCache.get",
      cacheKey: `__verify__${Math.random().toString(36).slice(2)}`,
    },
    { kind: "marks.list", limit: 1 },
    { kind: "notes.latestByTag", tagId: 1 },
    { kind: "tags.list" },
    { kind: "vector.summaries" },
    { kind: "memories.list", limit: 1 },
    { kind: "policy.get" },
    { kind: "canvases.list", limit: 1 },
    { kind: "activity.list", limit: 1 },
    { kind: "knowledge.listSources", limit: 1 },
    {
      kind: "wiki.getSourceState",
      contextId: "__verify__",
      stableId: "__verify__",
    },
  ];
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check SqlAdapter readiness, then verify every retained table is
 * reachable. No DDL runs, no schema is created, and no per-module
 * init runs: the server migrator owns the schema, and readiness
 * comes from the health endpoint through `ready()`. A failed
 * verification throws a capability error naming migrations, so
 * boot stops at step 4 with a diagnosable cause instead of
 * proceeding against an unreadable database. The bootstrap tag
 * `Idea` is verified present for the active workspace and only
 * warned about when absent: boot never writes data, so a missing
 * seed tag is a warning, not a failure and not a creation.
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
  const batch = buildVerificationBatch();
  let results: unknown[][];
  try {
    results = await adapter.queryMany(batch);
  } catch {
    throw capabilityError(
      "unavailable",
      "sql",
      "verify",
      getPlatformMode(),
      "table verification failed; verify migrations are current and the session is valid",
    );
  }
  const tagsIndex = batch.findIndex((op) => op.kind === "tags.list");
  const tagRows = results[tagsIndex];
  if (
    Array.isArray(tagRows) &&
    !tagRows.some((row) => isRecordValue(row) && row.name === "Idea")
  ) {
    console.warn(
      "initSqlAdapter: bootstrap tag 'Idea' was not found for the active workspace; " +
        "boot continues without creating it.",
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
