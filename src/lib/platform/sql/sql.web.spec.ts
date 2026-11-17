// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Behavior specs for the web SqlAdapter (sql.web.ts, V3-14 part 1).
//
// The adapter is tested against a fake port implementing `SqlDbPort`:
// no fetch, no server, no database. The fake records every call, so
// dispatch, validation-before-execution, chunking, and error
// surfacing are all observable. A fake port error class mirrors the
// 14c `SqlDbClientError` fields (wire code, status, retryable,
// details, operation identity) so the wire-to-adapter mapping is
// tested through the same structural shape the real port throws.
//
// Run: `pnpm vitest run --project unit src/lib/platform/sql/sql.web.spec.ts`
// from the repo root. The file uses vitest (the `unit` project in
// vitest.config.ts), following the reconciled-forms spec precedent.

import { describe, expect, it } from "vitest";
import {
  SQL_OP_METADATA,
  SQL_READ_OP_KINDS,
  SQL_WRITE_OP_KINDS,
  type DbReadOperation,
  type DbWriteOperation,
  type SqlMarkRow,
  type SqlTagRow,
  type SqlWikiCommitResult,
} from "./ops-catalog";
import { SqlAdapterError, type SqlAdapter, type SqlErrorCode } from "./interface";
import type { SqlDbClient } from "./db-client";
import {
  SQL_WEB_FORBIDDEN_OPERATION_FIELDS,
  SQL_WEB_MAX_OPERATIONS_PER_REQUEST,
  createWebSqlAdapter,
  isSqlDbPortError,
  sqlErrorCodeFromWireCode,
  type SqlBatchResult,
  type SqlDbPort,
  type SqlTransactionResult,
} from "./sql.web";

// Wiring proof: the db-client satisfies the adapter port
// structurally, so wiring may pass a SqlDbClient where the adapter
// asks for a SqlDbPort. A mismatch fails typecheck here.
type AssertTrue<T extends true> = T;
export type SqlDbClientPortConformance = AssertTrue<
  SqlDbClient extends SqlDbPort ? true : false
>;

// ---------------------------------------------------------------------------
// Fakes and helpers
// ---------------------------------------------------------------------------

interface FakePortErrorOptions {
  code: string | null;
  status: number | null;
  retryable: boolean;
  requestId?: string | null;
  details?: Record<string, unknown>;
  operationIndex?: number | null;
  kind?: string | null;
}

/**
 * Fake port failure mirroring the 14c `SqlDbClientError` fields.
 * Operation identity is extracted from `details` exactly like the
 * real class does, unless overridden explicitly.
 */
class FakePortError extends Error {
  readonly code: string | null;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly operationIndex: number | null;
  readonly kind: string | null;

  constructor(options: FakePortErrorOptions) {
    super("fake port failure");
    this.name = "SqlDbClientError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.requestId = options.requestId ?? null;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    const detailIndex = this.details["operationIndex"];
    this.operationIndex =
      options.operationIndex !== undefined
        ? options.operationIndex
        : typeof detailIndex === "number" && Number.isInteger(detailIndex)
          ? detailIndex
          : null;
    const detailKind = this.details["kind"];
    this.kind =
      options.kind !== undefined
        ? options.kind
        : typeof detailKind === "string"
          ? detailKind
          : null;
  }
}

interface PortCall {
  method: "batch" | "transaction";
  operations: readonly unknown[];
  idempotencyKey?: string | null;
}

interface FakePortBehavior {
  batch?: (operations: readonly DbReadOperation[], callIndex: number) => unknown;
  transaction?: (
    operations: readonly DbWriteOperation[],
    options: { idempotencyKey?: string | null } | undefined,
    callIndex: number,
  ) => unknown;
}

/**
 * Fake port with an echo default: batch calls answer empty rows per
 * operation, transaction calls answer `affected: 1` per operation
 * (plus `committed: true` for `wiki.commitRevision`, which the
 * adapter requires). Tests override behavior per call through the
 * callbacks, which may return malformed results or throw.
 */
class FakePort implements SqlDbPort {
  readonly calls: PortCall[] = [];
  private batchCallCount = 0;
  private transactionCallCount = 0;

  constructor(private readonly behavior: FakePortBehavior = {}) {}

  async executeBatch(operations: readonly DbReadOperation[]): Promise<SqlBatchResult> {
    const callIndex = this.batchCallCount;
    this.batchCallCount += 1;
    this.calls.push({ method: "batch", operations: [...operations] });
    if (this.behavior.batch !== undefined) {
      return this.behavior.batch(operations, callIndex) as SqlBatchResult;
    }
    return {
      results: operations.map((operation) => ({ kind: operation.kind, rows: [] })),
    };
  }

  async executeTransaction(
    operations: readonly DbWriteOperation[],
    options?: { idempotencyKey?: string | null },
  ): Promise<SqlTransactionResult> {
    const callIndex = this.transactionCallCount;
    this.transactionCallCount += 1;
    this.calls.push({
      method: "transaction",
      operations: [...operations],
      idempotencyKey: options?.idempotencyKey,
    });
    if (this.behavior.transaction !== undefined) {
      return this.behavior.transaction(operations, options, callIndex) as SqlTransactionResult;
    }
    return {
      transactionIds: ["tx-fake-1"],
      results: operations.map((operation) => ({
        kind: operation.kind,
        affected: 1,
        ...(operation.kind === "wiki.commitRevision" ? { committed: true } : {}),
      })),
    };
  }
}

function markRow(id: number): SqlMarkRow {
  return {
    id,
    tagId: 1,
    tagIds: [1],
    tagUpdatedAt: 100,
    type: "text",
    url: "",
    deleted: false,
    createdAt: 100,
    updatedAt: 100,
    version: 1,
  };
}

function tagRow(id: number): SqlTagRow {
  return { id, name: `tag-${id}`, isLocked: false, isPin: false, sortOrder: id };
}

function asRead(operation: unknown): DbReadOperation {
  return operation as unknown as DbReadOperation;
}

function asWrite(operation: unknown): DbWriteOperation {
  return operation as unknown as DbWriteOperation;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

async function expectSqlError(promise: Promise<unknown>, code: SqlErrorCode): Promise<SqlAdapterError> {
  const caught = await captureError(promise);
  expect(caught).toBeInstanceOf(SqlAdapterError);
  const error = caught as SqlAdapterError;
  expect(error.code).toBe(code);
  return error;
}

function errorDetails(error: SqlAdapterError): Record<string, unknown> {
  expect(typeof error.details).toBe("object");
  return error.details as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Construction and surface
// ---------------------------------------------------------------------------

describe("WebSqlAdapter construction", () => {
  it("reports mode web, satisfies SqlAdapter, and carries no stub marker", () => {
    const adapter = createWebSqlAdapter({ port: new FakePort() });
    expect(adapter.mode).toBe("web");
    // Assignability to the real SqlAdapter surface (W23/3E fold;
    // see D-6 in sql.web.ts). The AD-26 stub marker must never
    // return: its presence would mean the stub type came back.
    const asAdapter: SqlAdapter = adapter;
    expect(asAdapter.mode).toBe("web");
    expect("__sqlAdapterStub" in adapter).toBe(false);
  });

  it("rejects construction without a conforming port", () => {
    expect(() => createWebSqlAdapter({ port: undefined as unknown as SqlDbPort })).toThrow(TypeError);
    expect(() =>
      createWebSqlAdapter({ port: {} as unknown as SqlDbPort }),
    ).toThrow(TypeError);
  });

  it("close resolves without touching the port", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    await expect(adapter.close()).resolves.toBeUndefined();
    expect(port.calls).toHaveLength(0);
  });

  it("pins the request limit and the forbidden field mirror", () => {
    expect(SQL_WEB_MAX_OPERATIONS_PER_REQUEST).toBe(50);
    expect([...SQL_WEB_FORBIDDEN_OPERATION_FIELDS]).toEqual([
      "sql",
      "query",
      "statement",
      "table",
      "columns",
      "raw",
      "workspaceId",
      "workspace_id",
      "operations",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("WebSqlAdapter reads", () => {
  it("query dispatches one read operation to the batch port and returns rows", async () => {
    const port = new FakePort({
      batch: (operations) => ({
        results: operations.map((operation) => ({
          kind: operation.kind,
          rows: [markRow(7)],
        })),
      }),
    });
    const adapter = createWebSqlAdapter({ port });
    const rows = await adapter.query({ kind: "marks.get", id: 7 });
    expect(rows).toEqual([markRow(7)]);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].method).toBe("batch");
    expect(port.calls[0].operations).toEqual([{ kind: "marks.get", id: 7 }]);
  });

  it("queryOne returns the first row", async () => {
    const port = new FakePort({
      batch: (operations) => ({
        results: operations.map((operation) => ({
          kind: operation.kind,
          rows: [tagRow(3), tagRow(4)],
        })),
      }),
    });
    const adapter = createWebSqlAdapter({ port });
    await expect(adapter.queryOne({ kind: "tags.get", id: 3 })).resolves.toEqual(tagRow(3));
  });

  it("queryOne returns null over an empty set without throwing", async () => {
    const adapter = createWebSqlAdapter({ port: new FakePort() });
    await expect(adapter.queryOne({ kind: "marks.get", id: 99 })).resolves.toBeNull();
  });

  it("queryMany returns one row array per operation in request order", async () => {
    const port = new FakePort({
      batch: (operations) => ({
        results: operations.map((operation) => {
          if (operation.kind === "tags.list") {
            return { kind: operation.kind, rows: [tagRow(1), tagRow(2)] };
          }
          if (operation.kind === "marks.get") {
            return { kind: operation.kind, rows: [markRow(5)] };
          }
          return { kind: operation.kind, rows: [] };
        }),
      }),
    });
    const adapter = createWebSqlAdapter({ port });
    const results = await adapter.queryMany([
      { kind: "tags.list" },
      { kind: "marks.get", id: 5 },
      { kind: "tags.get", id: 9 },
    ]);
    expect(results).toEqual([[tagRow(1), tagRow(2)], [markRow(5)], []]);
    expect(port.calls).toHaveLength(1);
  });

  it("queryMany with no operations sends one empty batch call and returns []", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    await expect(adapter.queryMany([])).resolves.toEqual([]);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].operations).toEqual([]);
  });

  it("queryMany chunks 51 operations into 50 plus 1 through the port, preserving order", async () => {
    const port = new FakePort({
      batch: (operations) => ({
        results: operations.map((operation) => ({
          kind: operation.kind,
          rows: operation.kind === "tags.get" ? [tagRow(operation.id)] : [],
        })),
      }),
    });
    const adapter = createWebSqlAdapter({ port });
    const ops: DbReadOperation[] = Array.from({ length: 51 }, (_, index) => ({
      kind: "tags.get",
      id: index + 1,
    }));
    const results = await adapter.queryMany(ops);
    expect(port.calls).toHaveLength(2);
    expect(port.calls[0].operations).toHaveLength(50);
    expect(port.calls[1].operations).toHaveLength(1);
    expect(results).toHaveLength(51);
    expect(results.map((rows) => (rows[0] as SqlTagRow).id)).toEqual(
      Array.from({ length: 51 }, (_, index) => index + 1),
    );
  });

  it("queryMany chunks 100 operations into two full port calls", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    const ops: DbReadOperation[] = Array.from({ length: 100 }, () => ({ kind: "tags.list" }));
    await adapter.queryMany(ops);
    expect(port.calls).toHaveLength(2);
    expect(port.calls[0].operations).toHaveLength(50);
    expect(port.calls[1].operations).toHaveLength(50);
  });

  it("query rejects a write kind with VALIDATION before any port call", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    const error = await expectSqlError(
      adapter.query(asRead({ kind: "marks.create", mark: { tagId: 1, type: "text", url: "" } })),
      "VALIDATION",
    );
    expect(errorDetails(error)["wireCode"]).toBe("invalid_operation");
    expect(port.calls).toHaveLength(0);
  });

  it("query rejects an unknown kind with VALIDATION before any port call", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    const error = await expectSqlError(
      adapter.query(asRead({ kind: "marks.nope", id: 1 })),
      "VALIDATION",
    );
    const details = errorDetails(error);
    expect(details["wireCode"]).toBe("invalid_operation");
    expect(details["operationIndex"]).toBe(0);
    expect(details["kind"]).toBe("marks.nope");
    expect(port.calls).toHaveLength(0);
  });

  it("query rejects contract-mirror ghost kinds with VALIDATION", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    for (const kind of ["knowledge.registerSource", "knowledge.claimSource", "vector.insertChunk"]) {
      const error = await expectSqlError(
        adapter.query(asRead({ kind, sourceType: "record", sourceId: "1" })),
        "VALIDATION",
      );
      expect(errorDetails(error)["wireCode"]).toBe("invalid_operation");
    }
    expect(port.calls).toHaveLength(0);
  });

  it("query rejects forbidden top-level fields with VALIDATION", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    for (const field of ["sql", "query", "statement", "table", "columns", "raw", "workspaceId", "workspace_id", "operations"]) {
      const error = await expectSqlError(
        adapter.query(asRead({ kind: "marks.get", id: 1, [field]: "x" })),
        "VALIDATION",
      );
      expect(errorDetails(error)["wireCode"]).toBe("validation_failed");
    }
    expect(port.calls).toHaveLength(0);
  });

  it("query rejects the server-only kind as wrong-group VALIDATION, not UNAVAILABLE", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    const error = await expectSqlError(
      adapter.query(
        asRead({ kind: "vector.replaceChunks", sourceType: "record", sourceId: "1", chunks: [] }),
      ),
      "VALIDATION",
    );
    expect(errorDetails(error)["wireCode"]).toBe("invalid_operation");
    expect(port.calls).toHaveLength(0);
  });

  it("query rejects non-object operations and missing kinds with VALIDATION", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    await expectSqlError(adapter.query(asRead(null)), "VALIDATION");
    await expectSqlError(adapter.query(asRead("marks.get")), "VALIDATION");
    await expectSqlError(adapter.query(asRead({ id: 1 })), "VALIDATION");
    await expectSqlError(adapter.query(asRead({ kind: "" })), "VALIDATION");
    expect(port.calls).toHaveLength(0);
  });

  it("queryMany validates the whole batch before any port call", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    await expectSqlError(
      adapter.queryMany([{ kind: "tags.list" }, asRead({ kind: "nope" })]),
      "VALIDATION",
    );
    await expectSqlError(
      adapter.queryMany([asRead({ kind: "nope" }), { kind: "tags.list" }]),
      "VALIDATION",
    );
    expect(port.calls).toHaveLength(0);
  });

  it("queryMany rejects a non-array argument with VALIDATION", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    await expectSqlError(
      adapter.queryMany("tags.list" as unknown as readonly DbReadOperation[]),
      "VALIDATION",
    );
    expect(port.calls).toHaveLength(0);
  });

  it("messages.get follows the catalog: rejected until the AD-44 amendment lands, admitted after", async () => {
    const catalogHasMessagesGet = (SQL_READ_OP_KINDS as readonly string[]).includes("messages.get");
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    const op = asRead({ kind: "messages.get", id: 1 });
    if (catalogHasMessagesGet) {
      await expect(adapter.queryOne(op)).resolves.toBeNull();
      expect(port.calls).toHaveLength(1);
    } else {
      const error = await expectSqlError(adapter.queryOne(op), "VALIDATION");
      expect(errorDetails(error)["wireCode"]).toBe("invalid_operation");
      expect(port.calls).toHaveLength(0);
    }
  });

  it("accepts injection-looking strings carried as nested data", async () => {
    // Only top-level operation keys are checked. A string that looks
    // like SQL inside a payload is data; handlers bind it as a
    // parameter and never execute it.
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    const result = await adapter.execute(
      asWrite({
        kind: "marks.create",
        mark: { tagId: 1, type: "text", url: "", content: "SELECT * FROM marks; DROP TABLE marks;" },
      }),
    );
    expect(result.affected).toBe(1);
    expect(port.calls).toHaveLength(1);
  });

  it("does not reject unknown non-forbidden fields: per-kind shapes are the server's job", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    await expect(
      adapter.query(asRead({ kind: "marks.get", id: 1, bogusField: 1 })),
    ).resolves.toEqual([]);
    expect(port.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

describe("WebSqlAdapter writes", () => {
  it("execute dispatches one write operation to the transaction port", async () => {
    const port = new FakePort({
      transaction: (operations) => ({
        transactionIds: ["tx-1"],
        results: operations.map((operation) => ({
          kind: operation.kind,
          affected: 1,
          id: 42,
          version: 2,
        })),
      }),
    });
    const adapter = createWebSqlAdapter({ port });
    const result = await adapter.execute({ kind: "tags.create", name: "alpha" });
    expect(result).toEqual({ affected: 1, id: 42, version: 2 });
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].method).toBe("transaction");
    expect(port.calls[0].operations).toEqual([{ kind: "tags.create", name: "alpha" }]);
    expect(port.calls[0].idempotencyKey).toBeUndefined();
  });

  it("execute preserves the committed flag for wiki.commitRevision", async () => {
    const port = new FakePort({
      transaction: (operations) => ({
        transactionIds: ["tx-1"],
        results: operations.map((operation) => ({
          kind: operation.kind,
          affected: 0,
          committed: false,
        })),
      }),
    });
    const adapter = createWebSqlAdapter({ port });
    const op = asWrite({ kind: "wiki.commitRevision", revision: {}, pages: [] });
    const result = await adapter.execute(op);
    expect((result as SqlWikiCommitResult).committed).toBe(false);
    expect(result.affected).toBe(0);
  });

  it("transaction strips the committed flag from every entry", async () => {
    const port = new FakePort({
      transaction: (operations) => ({
        transactionIds: ["tx-1"],
        results: operations.map((operation) => ({
          kind: operation.kind,
          affected: 1,
          committed: true,
        })),
      }),
    });
    const adapter = createWebSqlAdapter({ port });
    const results = await adapter.transaction([
      asWrite({ kind: "wiki.commitRevision", revision: {}, pages: [] }),
    ]);
    expect(results).toEqual([{ affected: 1 }]);
    expect("committed" in results[0]).toBe(false);
  });

  it("transaction passes the idempotency key through to the port", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    await adapter.transaction([{ kind: "tags.create", name: "beta" }], {
      idempotencyKey: "key-123",
    });
    expect(port.calls[0].idempotencyKey).toBe("key-123");
  });

  it("transaction without a key passes undefined so the port generates one", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    await adapter.transaction([{ kind: "tags.create", name: "gamma" }]);
    expect(port.calls[0].idempotencyKey).toBeUndefined();
  });

  it("execute rejects a read kind with VALIDATION before any port call", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    await expectSqlError(adapter.execute(asWrite({ kind: "tags.list" })), "VALIDATION");
    expect(port.calls).toHaveLength(0);
  });

  it("transaction rejects a read kind with VALIDATION before any port call", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    const error = await expectSqlError(
      adapter.transaction([{ kind: "tags.create", name: "x" }, asWrite({ kind: "tags.list" })]),
      "VALIDATION",
    );
    expect(errorDetails(error)["operationIndex"]).toBe(1);
    expect(port.calls).toHaveLength(0);
  });

  it("transaction rejects the server-only kind locally with UNAVAILABLE naming capability and phase", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    const error = await expectSqlError(
      adapter.transaction([
        asWrite({ kind: "vector.replaceChunks", sourceType: "record", sourceId: "1", chunks: [] }),
      ]),
      "UNAVAILABLE",
    );
    expect(error.message).toContain("vector.replaceChunks");
    expect(error.message).toContain("Fase 2");
    expect(error.retryable).toBe(false);
    const details = errorDetails(error);
    expect(details["wireCode"]).toBe("capability_unavailable");
    expect(details["capability"]).toBe("vector.replaceChunks");
    expect(details["phase"]).toBe("Fase 2");
    expect(details["operationIndex"]).toBe(0);
    expect(details["kind"]).toBe("vector.replaceChunks");
    expect(port.calls).toHaveLength(0);
  });

  it("transaction over 50 operations is rejected locally to protect atomicity", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    const ops: DbWriteOperation[] = Array.from({ length: 51 }, () => ({
      kind: "tags.create",
      name: "x",
    }));
    const error = await expectSqlError(adapter.transaction(ops), "VALIDATION");
    const details = errorDetails(error);
    expect(details["limit"]).toBe(50);
    expect(details["received"]).toBe(51);
    expect(port.calls).toHaveLength(0);
  });

  it("transaction of exactly 50 operations sends one port call", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    const ops: DbWriteOperation[] = Array.from({ length: 50 }, () => ({
      kind: "tags.create",
      name: "x",
    }));
    const results = await adapter.transaction(ops);
    expect(results).toHaveLength(50);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].operations).toHaveLength(50);
  });

  it("transaction with no operations sends one empty call and returns []", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    await expect(adapter.transaction([])).resolves.toEqual([]);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].operations).toEqual([]);
  });

  it("W2 kinds other than the server-only kind are sent: the server answers 410", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    const result = await adapter.execute(
      asWrite({ kind: "memories.create", input: { content: "hello" } }),
    );
    expect(result.affected).toBe(1);
    expect(port.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Catalog coverage (derived, amendment-proof)
// ---------------------------------------------------------------------------

describe("WebSqlAdapter catalog coverage", () => {
  it("accepts every catalog read kind through queryMany", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    for (const kind of SQL_READ_OP_KINDS) {
      const op = { kind } as unknown as DbReadOperation;
      const results = await adapter.queryMany([op]);
      expect(results).toEqual([[]]);
    }
    expect(port.calls.length).toBe(SQL_READ_OP_KINDS.length);
  });

  it("accepts every catalog write kind through transaction except the server-only kind", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    let sent = 0;
    for (const kind of SQL_WRITE_OP_KINDS) {
      const op = { kind } as unknown as DbWriteOperation;
      const metadata = SQL_OP_METADATA[kind];
      if (metadata.exposure === "server-only") {
        await expectSqlError(adapter.transaction([op]), "UNAVAILABLE");
      } else {
        const results = await adapter.transaction([op]);
        expect(results).toHaveLength(1);
        sent += 1;
      }
    }
    expect(port.calls.length).toBe(sent);
    expect(sent).toBe(SQL_WRITE_OP_KINDS.length - 1);
  });
});

// ---------------------------------------------------------------------------
// Error mapping and failure surfacing
// ---------------------------------------------------------------------------

describe("sqlErrorCodeFromWireCode", () => {
  const cases: Array<[string | null, number | null, SqlErrorCode]> = [
    ["capability_unavailable", 410, "UNAVAILABLE"],
    ["capability_unavailable", null, "UNAVAILABLE"],
    ["revision_conflict", 409, "CONFLICT"],
    ["revision_conflict", 412, "CONFLICT"],
    ["record_tags_changed", 409, "CONFLICT"],
    ["tag_in_use", 409, "CONFLICT"],
    ["idempotency_key_reused", 409, "CONFLICT"],
    ["not_found", 404, "NOT_FOUND"],
    ["validation_failed", 400, "VALIDATION"],
    ["invalid_operation", 400, "VALIDATION"],
    ["payload_too_large", 413, "VALIDATION"],
    ["unauthenticated", 401, "UNAUTHORIZED"],
    ["invalid_credentials", 401, "UNAUTHORIZED"],
    ["forbidden", 403, "FORBIDDEN"],
    ["csrf_invalid", 403, "FORBIDDEN"],
    ["origin_rejected", 403, "FORBIDDEN"],
    ["step_up_required", 403, "FORBIDDEN"],
    ["rate_limited", 429, "UNAVAILABLE"],
    ["service_unavailable", 503, "UNAVAILABLE"],
    ["write_queue_timeout", 503, "UNAVAILABLE"],
    ["internal_error", 500, "UNKNOWN"],
    ["index_update_failed", 500, "UNKNOWN"],
    ["some_future_code", 500, "UNKNOWN"],
    ["some_future_code", 409, "CONFLICT"],
    ["some_future_code", 404, "NOT_FOUND"],
    ["some_future_code", 401, "UNAUTHORIZED"],
    ["some_future_code", 403, "FORBIDDEN"],
    ["some_future_code", 410, "UNAVAILABLE"],
    ["some_future_code", 429, "UNAVAILABLE"],
    [null, 500, "UNKNOWN"],
    [null, null, "UNKNOWN"],
    [null, 400, "VALIDATION"],
    [null, 422, "VALIDATION"],
  ];
  for (const [wireCode, status, expected] of cases) {
    it(`maps wire ${String(wireCode)} / status ${String(status)} to ${expected}`, () => {
      expect(sqlErrorCodeFromWireCode(wireCode, status)).toBe(expected);
    });
  }
});

describe("WebSqlAdapter error mapping", () => {
  it("recognizes port errors structurally", () => {
    expect(
      isSqlDbPortError(
        new FakePortError({ code: "validation_failed", status: 400, retryable: false, details: {} }),
      ),
    ).toBe(true);
    expect(isSqlDbPortError(new Error("plain"))).toBe(false);
    expect(isSqlDbPortError(null)).toBe(false);
    expect(isSqlDbPortError({ code: "x", status: 400, retryable: false })).toBe(false);
  });

  it("maps port failures end to end, preserving retryable and correlation details", async () => {
    const cases: Array<{
      wireCode: string | null;
      status: number | null;
      retryable: boolean;
      expected: SqlErrorCode;
    }> = [
      { wireCode: "revision_conflict", status: 409, retryable: false, expected: "CONFLICT" },
      { wireCode: "validation_failed", status: 400, retryable: false, expected: "VALIDATION" },
      { wireCode: "not_found", status: 404, retryable: false, expected: "NOT_FOUND" },
      { wireCode: "unauthenticated", status: 401, retryable: false, expected: "UNAUTHORIZED" },
      { wireCode: "forbidden", status: 403, retryable: false, expected: "FORBIDDEN" },
      { wireCode: "capability_unavailable", status: 410, retryable: false, expected: "UNAVAILABLE" },
      { wireCode: "rate_limited", status: 429, retryable: true, expected: "UNAVAILABLE" },
      { wireCode: "service_unavailable", status: 503, retryable: true, expected: "UNAVAILABLE" },
      { wireCode: "internal_error", status: 500, retryable: false, expected: "UNKNOWN" },
      { wireCode: null, status: null, retryable: true, expected: "UNKNOWN" },
    ];
    for (const entry of cases) {
      const port = new FakePort({
        batch: () => {
          throw new FakePortError({
            code: entry.wireCode,
            status: entry.status,
            retryable: entry.retryable,
            requestId: "req-1",
            details: { operationIndex: 0, kind: "marks.get" },
          });
        },
      });
      const adapter = createWebSqlAdapter({ port });
      const error = await expectSqlError(adapter.query({ kind: "marks.get", id: 1 }), entry.expected);
      expect(error.retryable).toBe(entry.retryable);
      const details = errorDetails(error);
      expect(details["wireCode"]).toBe(entry.wireCode ?? undefined);
      expect(details["operationIndex"]).toBe(0);
      expect(details["kind"]).toBe("marks.get");
      expect(details["requestId"]).toBe("req-1");
    }
  });

  it("maps a server 410 for a W2 kind to UNAVAILABLE with capability and phase", async () => {
    const port = new FakePort({
      transaction: () => {
        throw new FakePortError({
          code: "capability_unavailable",
          status: 410,
          retryable: false,
          details: {
            capability: "memories.create",
            phase: "Fase 2",
            operationIndex: 0,
            kind: "memories.create",
          },
        });
      },
    });
    const adapter = createWebSqlAdapter({ port });
    const error = await expectSqlError(
      adapter.execute(asWrite({ kind: "memories.create", input: { content: "x" } })),
      "UNAVAILABLE",
    );
    const details = errorDetails(error);
    expect(details["capability"]).toBe("memories.create");
    expect(details["phase"]).toBe("Fase 2");
  });

  it("surfaces transaction failure all-or-nothing: the failing index and kind, no partial results", async () => {
    const port = new FakePort({
      transaction: () => {
        throw new FakePortError({
          code: "revision_conflict",
          status: 409,
          retryable: false,
          details: { operationIndex: 1, kind: "tags.delete", currentVersion: 3 },
        });
      },
    });
    const adapter = createWebSqlAdapter({ port });
    const caught = await captureError(
      adapter.transaction([
        { kind: "tags.create", name: "a" },
        { kind: "tags.delete", id: 9 },
      ]),
    );
    expect(caught).toBeInstanceOf(SqlAdapterError);
    const error = caught as SqlAdapterError;
    expect(error.code).toBe("CONFLICT");
    const details = errorDetails(error);
    expect(details["operationIndex"]).toBe(1);
    expect(details["kind"]).toBe("tags.delete");
    expect(details["currentVersion"]).toBe(3);
  });

  it("remaps a chunk-local failure index to the global index in a chunked batch", async () => {
    const port = new FakePort({
      batch: (_operations, callIndex) => {
        if (callIndex === 1) {
          throw new FakePortError({
            code: "validation_failed",
            status: 400,
            retryable: false,
            details: { operationIndex: 0, kind: "tags.get" },
          });
        }
        return {
          results: _operations.map((operation) => ({ kind: operation.kind, rows: [] })),
        };
      },
    });
    const adapter = createWebSqlAdapter({ port });
    const ops: DbReadOperation[] = Array.from({ length: 51 }, (_, index) => ({
      kind: "tags.get",
      id: index + 1,
    }));
    const error = await expectSqlError(adapter.queryMany(ops), "VALIDATION");
    const details = errorDetails(error);
    expect(details["operationIndex"]).toBe(50);
    expect(details["failedChunkIndex"]).toBe(1);
    expect(details["completedOperations"]).toBe(50);
  });

  it("treats malformed port results as UNKNOWN shape mismatches", async () => {
    const mismatches: Array<{ name: string; batch?: () => unknown; transaction?: () => unknown }> = [
      {
        name: "batch length mismatch",
        batch: () => ({ results: [] }),
      },
      {
        name: "batch kind mismatch",
        batch: () => ({ results: [{ kind: "tags.list", rows: [] }] }),
      },
      {
        name: "batch rows not an array",
        batch: () => ({ results: [{ kind: "marks.get", rows: {} }] }),
      },
      {
        name: "batch result not an object",
        batch: () => "garbage",
      },
      {
        name: "transaction affected negative",
        transaction: () => ({
          transactionIds: ["tx-1"],
          results: [{ kind: "tags.create", affected: -1 }],
        }),
      },
    ];
    for (const mismatch of mismatches) {
      const port = new FakePort({
        batch: mismatch.batch as FakePortBehavior["batch"],
        transaction: mismatch.transaction as FakePortBehavior["transaction"],
      });
      const adapter = createWebSqlAdapter({ port });
      if (mismatch.batch !== undefined) {
        const error = await expectSqlError(adapter.query({ kind: "marks.get", id: 1 }), "UNKNOWN");
        expect(errorDetails(error)["mismatch"]).toBeDefined();
      } else {
        const error = await expectSqlError(
          adapter.execute(asWrite({ kind: "tags.create", name: "x" })),
          "UNKNOWN",
        );
        expect(errorDetails(error)["mismatch"]).toBeDefined();
      }
    }
    // The commitRevision case needs its own operation kind.
    const port = new FakePort({
      transaction: () => ({
        transactionIds: ["tx-1"],
        results: [{ kind: "wiki.commitRevision", affected: 1 }],
      }),
    });
    const adapter = createWebSqlAdapter({ port });
    const error = await expectSqlError(
      adapter.execute(asWrite({ kind: "wiki.commitRevision", revision: {}, pages: [] })),
      "UNKNOWN",
    );
    expect(String(errorDetails(error)["mismatch"])).toContain("committed");
  });

  it("wraps non-port errors as UNKNOWN without carrying their message text", async () => {
    const port = new FakePort({
      batch: () => {
        throw new Error("SENTINEL_SECRET_TEXT must never surface");
      },
    });
    const adapter = createWebSqlAdapter({ port });
    const error = await expectSqlError(adapter.query({ kind: "marks.get", id: 1 }), "UNKNOWN");
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain("SENTINEL_SECRET_TEXT");
    expect(errorDetails(error)["errorName"]).toBe("Error");
  });

  it("passes an adapter-shaped error from the port through unchanged", async () => {
    const thrown = new SqlAdapterError("CONFLICT", "already shaped", { details: { x: 1 } });
    const port = new FakePort({
      batch: () => {
        throw thrown;
      },
    });
    const adapter = createWebSqlAdapter({ port });
    const caught = await captureError(adapter.query({ kind: "marks.get", id: 1 }));
    expect(caught).toBe(thrown);
  });
});

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

describe("WebSqlAdapter ready", () => {
  it("reports health probe values when a probe is wired", async () => {
    const adapter = createWebSqlAdapter({
      port: new FakePort(),
      health: async () => ({ ok: true, migrationsCurrent: true }),
    });
    await expect(adapter.ready()).resolves.toEqual({ ok: true, mode: "web", migrationsCurrent: true });
    const notReady = createWebSqlAdapter({
      port: new FakePort(),
      health: async () => ({ ok: false, migrationsCurrent: false }),
    });
    await expect(notReady.ready()).resolves.toEqual({
      ok: false,
      mode: "web",
      migrationsCurrent: false,
    });
  });

  it("answers not-ok instead of throwing when the probe fails", async () => {
    const adapter = createWebSqlAdapter({
      port: new FakePort(),
      health: async () => {
        throw new Error("health endpoint down");
      },
    });
    await expect(adapter.ready()).resolves.toEqual({
      ok: false,
      mode: "web",
      migrationsCurrent: false,
    });
  });

  it("answers not-ok when the probe returns garbage", async () => {
    const adapter = createWebSqlAdapter({
      port: new FakePort(),
      health: async () => null as unknown as { ok: boolean; migrationsCurrent: boolean },
    });
    await expect(adapter.ready()).resolves.toEqual({
      ok: false,
      mode: "web",
      migrationsCurrent: false,
    });
  });

  it("without a probe, probes liveness with an empty batch and reports migrations unverified", async () => {
    const port = new FakePort();
    const adapter = createWebSqlAdapter({ port });
    await expect(adapter.ready()).resolves.toEqual({
      ok: true,
      mode: "web",
      migrationsCurrent: false,
    });
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].operations).toEqual([]);
  });

  it("without a probe, a failed batch probe answers not-ok without throwing", async () => {
    const port = new FakePort({
      batch: () => {
        throw new FakePortError({ code: null, status: null, retryable: true, details: {} });
      },
    });
    const adapter = createWebSqlAdapter({ port });
    await expect(adapter.ready()).resolves.toEqual({
      ok: false,
      mode: "web",
      migrationsCurrent: false,
    });
  });
});
