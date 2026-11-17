// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Postgres column factory for the SQL contract suite (F6).
 *
 * `postgresSqlFactory` is present only when the
 * `SQL_CONTRACT_DATABASE_URL` environment variable is set; when it
 * is unset the factory is `null` and the suite runs without the
 * Postgres column (absent, never silently skipped). When it is set
 * but the database is unreachable, factory creation fails loudly.
 * Point it at a SCRATCH database: every case inserts a fresh user
 * plus workspace, and cases write real rows.
 *
 * The shim implements `SqlAdapter` over the server's own dispatch
 * (`runTransactionRequest` / `runBatchRequest`) with the generated
 * handler registry, so the cases exercise the real handlers, the
 * real Drizzle runner, and the real schema. It mirrors the route
 * contract exactly: `validateDbOperations` runs first on every
 * chunk (the dispatch preflight rejects unknown kinds with a 500
 * when route validation is bypassed, so the shim must never skip
 * it), read batches over 50 operations are chunked like the web
 * adapter chunks them, write transactions over 50 operations are
 * rejected instead of split (the adapter-level bound, mirroring
 * `WebSqlAdapter.transaction`), and empty operation lists answer
 * `[]` directly (route validation rejects empty arrays).
 *
 * Per-case isolation: each `create()` inserts a fresh user (UUID),
 * a workspace owned by that user, and a workspace_members row, so
 * `resolveDefaultWorkspaceId` resolves that case's workspace and
 * no case sees another case's rows. Tag ids are database-global
 * sequences; no case assumes the first tag has id 1. Migrations
 * run once per process (module-level promise) before the first
 * case; a migration failure fails factory creation loudly.
 * Idempotency passes through to the server's idempotency store:
 * the key the caller supplies (or null when absent) plus
 * `hashDbRequestBody` over the validated operations. `ApiError`
 * values translate to `SqlAdapterError` through the same
 * `sqlErrorCodeFromWireCode` mapping the web adapter uses, with
 * `operationIndex` remapped by the chunk offset and the wire code
 * preserved in `details.wireCode`.
 *
 * LIVE STATUS: this leg is registered but has never run against a
 * live database in this workspace (no local Postgres server). Its
 * first live run belongs to CI or the merge gate; see
 * tests/contract/README.md.
 */

import { randomUUID } from "node:crypto";
import {
  createDb,
  users,
  workspaceMembers,
  workspaces,
} from "../../../server/src/db/index.js";
import { runMigrations } from "../../../server/src/db/migrate.js";
import { ApiError } from "../../../server/src/plugins/envelope.js";
import {
  closeDbRouteDeps,
  createDefaultDbRouteDeps,
  type DbRouteDeps,
} from "../../../server/src/services/db/deps.js";
import {
  runBatchRequest,
  runTransactionRequest,
} from "../../../server/src/services/db/dispatch.js";
import { registerDbHandlers } from "../../../server/src/services/db/handlers.generated.js";
import type { DbOperationInput } from "../../../server/src/services/db/registry.js";
import {
  hashDbRequestBody,
  validateDbOperations,
} from "../../../server/src/services/db/validation.js";
import { sqlErrorCodeFromWireCode } from "../../../src/lib/platform/sql/sql.web";
import type { ContractFactory } from "../contract-harness";
import { SqlAdapterError } from "../contract-types";
import type {
  DbReadOperation,
  DbWriteOperation,
  SqlAdapter,
  SqlHealth,
  SqlReadOpKind,
  SqlReadOperationByKind,
  SqlReadRow,
  SqlTransactionOptions,
  SqlWriteOpKind,
  SqlWriteOperationByKind,
  SqlWriteResult,
  SqlWriteResultFor,
} from "../contract-types";

const MAX_OPERATIONS_PER_REQUEST = 50;

function databaseUrl(): string | null {
  const value = process.env.SQL_CONTRACT_DATABASE_URL;
  return value !== undefined && value.trim() !== "" ? value : null;
}

let migrationPromise: Promise<void> | null = null;

function ensureMigrated(url: string): Promise<void> {
  if (migrationPromise === null) {
    migrationPromise = (async () => {
      await runMigrations({ databaseUrl: url });
    })();
  }
  return migrationPromise;
}

function translateError(error: unknown, chunkOffset: number): SqlAdapterError {
  if (error instanceof ApiError) {
    const details: Record<string, unknown> = {
      ...error.details,
      wireCode: error.code,
    };
    if (typeof details.operationIndex === "number") {
      details.operationIndex = details.operationIndex + chunkOffset;
    }
    return new SqlAdapterError(
      sqlErrorCodeFromWireCode(error.code, error.statusCode),
      error.message,
      { details },
    );
  }
  if (error instanceof SqlAdapterError) {
    return error;
  }
  return new SqlAdapterError(
    "UNKNOWN",
    error instanceof Error ? error.message : "Unknown Postgres error",
  );
}

class PostgresContractSqlAdapter implements SqlAdapter {
  readonly mode = "web" as const;
  private closed = false;

  constructor(
    private readonly deps: DbRouteDeps,
    private readonly userId: string,
  ) {}

  async ready(): Promise<SqlHealth> {
    return { ok: true, mode: "web", migrationsCurrent: true };
  }

  async query<K extends SqlReadOpKind>(
    op: SqlReadOperationByKind<K>,
  ): Promise<SqlReadRow<K>[]> {
    const batches = await this.queryMany([op]);
    return batches[0] as SqlReadRow<K>[];
  }

  async queryOne<K extends SqlReadOpKind>(
    op: SqlReadOperationByKind<K>,
  ): Promise<SqlReadRow<K> | null> {
    const rows = await this.query(op);
    return rows.length > 0 ? rows[0] : null;
  }

  async queryMany(ops: readonly DbReadOperation[]): Promise<unknown[][]> {
    this.assertOpen();
    if (ops.length === 0) {
      return [];
    }
    const out: unknown[][] = [];
    for (
      let offset = 0;
      offset < ops.length;
      offset += MAX_OPERATIONS_PER_REQUEST
    ) {
      const chunk = ops.slice(offset, offset + MAX_OPERATIONS_PER_REQUEST);
      const validated = this.validateChunk(chunk, "read");
      try {
        const data = await runBatchRequest(this.deps, {
          userId: this.userId,
          requestId: randomUUID(),
          operations: validated,
        });
        for (const entry of data.results) {
          out.push([...entry.rows]);
        }
      } catch (error) {
        throw translateError(error, offset);
      }
    }
    return out;
  }

  async execute<K extends SqlWriteOpKind>(
    op: SqlWriteOperationByKind<K>,
  ): Promise<SqlWriteResultFor<K>> {
    const results = await this.transaction([op]);
    return results[0] as SqlWriteResultFor<K>;
  }

  async transaction(
    ops: readonly DbWriteOperation[],
    opts?: SqlTransactionOptions,
  ): Promise<SqlWriteResult[]> {
    this.assertOpen();
    if (ops.length === 0) {
      return [];
    }
    if (ops.length > MAX_OPERATIONS_PER_REQUEST) {
      throw new SqlAdapterError(
        "VALIDATION",
        `SqlAdapter request failed: VALIDATION (transaction holds ${ops.length} operations, at most ${MAX_OPERATIONS_PER_REQUEST} per request; transactions are never split)`,
        {
          details: {
            wireCode: "validation_failed",
            limit: MAX_OPERATIONS_PER_REQUEST,
            received: ops.length,
          },
        },
      );
    }
    const validated = this.validateChunk(ops, "write");
    const key = opts?.idempotencyKey;
    try {
      const data = await runTransactionRequest(this.deps, {
        userId: this.userId,
        requestId: randomUUID(),
        operations: validated,
        idempotencyKey: key === undefined || key === "" ? null : key,
        requestHash: hashDbRequestBody(validated),
      });
      return data.results.map((entry) => ({
        affected: entry.affected,
        ...(entry.id === undefined ? {} : { id: entry.id }),
        ...(entry.version === undefined ? {} : { version: entry.version }),
        ...(entry.committed === undefined
          ? {}
          : { committed: entry.committed }),
      }));
    } catch (error) {
      throw translateError(error, 0);
    }
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await closeDbRouteDeps(this.deps);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SqlAdapterError("UNAVAILABLE", "Postgres contract adapter is closed");
    }
  }

  private validateChunk(
    chunk: readonly DbReadOperation[] | readonly DbWriteOperation[],
    group: "read" | "write",
  ): DbOperationInput[] {
    try {
      return validateDbOperations({ operations: [...chunk] }, group);
    } catch (error) {
      throw translateError(error, 0);
    }
  }
}

async function createPostgresSqlAdapter(): Promise<SqlAdapter> {
  const url = databaseUrl();
  if (url === null) {
    throw new Error(
      "postgresSqlFactory requires SQL_CONTRACT_DATABASE_URL to be set",
    );
  }
  await ensureMigrated(url);
  const userId = randomUUID();
  const setup = createDb(url, { max: 1 });
  try {
    await setup.db.insert(users).values({
      id: userId,
      email: `contract-${userId}@example.invalid`,
      passwordHash: "contract-dummy-hash",
    });
    const [workspace] = await setup.db
      .insert(workspaces)
      .values({ ownerUserId: userId, name: "contract" })
      .returning({ id: workspaces.id });
    await setup.db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId,
      role: "owner",
    });
  } finally {
    await setup.close();
  }
  const deps = createDefaultDbRouteDeps({ databaseUrl: url });
  registerDbHandlers(deps.registry);
  return new PostgresContractSqlAdapter(deps, userId);
}

/**
 * The Postgres factory, or null when SQL_CONTRACT_DATABASE_URL is
 * unset. The suite registers it only when present.
 */
export const postgresSqlFactory: ContractFactory<SqlAdapter> | null =
  databaseUrl() === null
    ? null
    : {
        name: "postgres",
        create: () => createPostgresSqlAdapter(),
        teardown: async (impl) => {
          await impl.close();
        },
      };
