// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Behavior specs for the Tauri SqlAdapter (sql.tauri.ts, V3-14 3E
// fold).
//
// The adapter is tested against a fake executor implementing
// `SqlLocalKindExecutor`: no local database, no plugin, no Tauri
// runtime. The fake records every call, so validation-before-
// execution, wave/exposure rejection, and error surfacing are all
// observable. Operation literals below use casts where the test
// exercises kind-level validation only: per-kind field shapes are
// the executor's job, not the adapter's (see the module header),
// and fully typed literals are used on the success paths that pin
// the kind-indexed surface.
//
// Run: `pnpm vitest run --project unit src/lib/platform/sql/sql.tauri.spec.ts`
// from the repo root. The file uses vitest (the `unit` project in
// vitest.config.ts), following the sql.web spec precedent, and is
// listed in VITEST_SPECS in scripts/run-adapter-tests.mjs.

import { describe, expect, it } from "vitest";
import {
  SQL_OP_METADATA,
  type DbReadOperation,
  type DbWriteOperation,
  type SqlOpKind,
} from "./ops-catalog";
import { SqlAdapterError, type SqlAdapter, type WriteResult } from "./interface";
import type {
  ReconciledKindMetadataLookup,
  SqlLocalKindExecutor,
  SqlTauriAdapterDeps,
} from "./reconciled-forms";
import {
  SQL_TAURI_FORBIDDEN_OPERATION_FIELDS,
  SQL_TAURI_MAX_OPERATIONS_PER_REQUEST,
  catalogSqlMetadataLookup,
  createTauriSqlAdapter,
} from "./sql.tauri";

// ---------------------------------------------------------------------------
// Fakes and helpers
// ---------------------------------------------------------------------------

/** Cast helper for kind-level tests: field shapes are not adapter-checked. */
function asRead(op: unknown): DbReadOperation {
  return op as DbReadOperation;
}

function asWrite(op: unknown): DbWriteOperation {
  return op as DbWriteOperation;
}

function errorDetails(error: SqlAdapterError): Record<string, unknown> {
  expect(typeof error.details).toBe("object");
  return error.details as Record<string, unknown>;
}

class FakeExecutor implements SqlLocalKindExecutor {
  readCalls: DbReadOperation[] = [];
  writeCalls: DbWriteOperation[][] = [];
  closeCalls = 0;
  readRows: (op: DbReadOperation) => readonly unknown[] = () => [];
  writeResults: (ops: readonly DbWriteOperation[]) => WriteResult[] = (ops) =>
    ops.map(() => ({ affected: 1 }));
  failReadWith: unknown = undefined;
  failWriteWith: unknown = undefined;
  failCloseWith: unknown = undefined;

  async executeRead(op: DbReadOperation): Promise<readonly unknown[]> {
    this.readCalls.push(op);
    if (this.failReadWith !== undefined) {
      throw this.failReadWith;
    }
    return this.readRows(op);
  }

  async executeWrite(
    ops: readonly DbWriteOperation[],
  ): Promise<WriteResult[]> {
    this.writeCalls.push([...ops]);
    if (this.failWriteWith !== undefined) {
      throw this.failWriteWith;
    }
    return this.writeResults(ops);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.failCloseWith !== undefined) {
      throw this.failCloseWith;
    }
  }
}

function makeAdapter(executor: FakeExecutor) {
  const deps: SqlTauriAdapterDeps = {
    executor,
    metadata: catalogSqlMetadataLookup,
  };
  return createTauriSqlAdapter(deps);
}

async function expectAdapterError(
  promise: Promise<unknown>,
): Promise<SqlAdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SqlAdapterError);
    return error as SqlAdapterError;
  }
  throw new Error("expected the call to throw SqlAdapterError");
}

// ---------------------------------------------------------------------------
// Construction and surface
// ---------------------------------------------------------------------------

describe("TauriSqlAdapter construction", () => {
  it("reports mode tauri, satisfies SqlAdapter, and carries no stub marker", () => {
    const adapter = makeAdapter(new FakeExecutor());
    expect(adapter.mode).toBe("tauri");
    const asAdapter: SqlAdapter = adapter;
    expect(asAdapter.mode).toBe("tauri");
    expect("__sqlAdapterStub" in adapter).toBe(false);
  });

  it("rejects construction without a conforming executor or lookup", () => {
    const executor = new FakeExecutor();
    expect(() =>
      createTauriSqlAdapter(undefined as unknown as SqlTauriAdapterDeps),
    ).toThrow(TypeError);
    expect(() =>
      createTauriSqlAdapter({
        executor: {} as unknown as SqlLocalKindExecutor,
        metadata: catalogSqlMetadataLookup,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createTauriSqlAdapter({
        executor,
        metadata: {} as unknown as ReconciledKindMetadataLookup,
      }),
    ).toThrow(TypeError);
  });

  it("pins the request limit and the forbidden-field list", () => {
    expect(SQL_TAURI_MAX_OPERATIONS_PER_REQUEST).toBe(50);
    expect([...SQL_TAURI_FORBIDDEN_OPERATION_FIELDS]).toEqual([
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
// ready()
// ---------------------------------------------------------------------------

describe("TauriSqlAdapter ready", () => {
  it("probes with tags.list and reports migrations current on success", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    await expect(adapter.ready()).resolves.toEqual({
      ok: true,
      mode: "tauri",
      migrationsCurrent: true,
    });
    expect(executor.readCalls).toEqual([{ kind: "tags.list" }]);
  });

  it("never throws: a failed probe answers not-ok", async () => {
    const executor = new FakeExecutor();
    executor.failReadWith = new Error("local database unavailable");
    const adapter = makeAdapter(executor);
    await expect(adapter.ready()).resolves.toEqual({
      ok: false,
      mode: "tauri",
      migrationsCurrent: false,
    });
  });

  it("never throws: a SqlAdapterError probe failure answers not-ok", async () => {
    const executor = new FakeExecutor();
    executor.failReadWith = new SqlAdapterError("UNAVAILABLE", "down");
    const adapter = makeAdapter(executor);
    await expect(adapter.ready()).resolves.toEqual({
      ok: false,
      mode: "tauri",
      migrationsCurrent: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("TauriSqlAdapter reads", () => {
  it("query returns executor rows for a typed read", async () => {
    const executor = new FakeExecutor();
    executor.readRows = () => [{ id: 1, name: "Idea" }];
    const adapter = makeAdapter(executor);
    const rows = await adapter.query({ kind: "tags.list" });
    expect(rows).toEqual([{ id: 1, name: "Idea" }]);
    expect(executor.readCalls).toEqual([{ kind: "tags.list" }]);
  });

  it("queryOne returns the first row, or null over an empty set", async () => {
    const executor = new FakeExecutor();
    executor.readRows = (op) =>
      op.kind === "messages.get" ? [{ id: 7 }] : [];
    const adapter = makeAdapter(executor);
    await expect(adapter.queryOne({ kind: "messages.get", id: 7 })).resolves.toEqual({ id: 7 });
    await expect(adapter.queryOne({ kind: "marks.get", id: 99 })).resolves.toBeNull();
  });

  it("queryMany runs reads in request order, one executor call each", async () => {
    const executor = new FakeExecutor();
    executor.readRows = (op) => [{ kind: op.kind }];
    const adapter = makeAdapter(executor);
    const results = await adapter.queryMany([
      { kind: "tags.list" },
      { kind: "marks.get", id: 1 },
      { kind: "messages.get", id: 2 },
    ]);
    expect(results).toEqual([
      [{ kind: "tags.list" }],
      [{ kind: "marks.get" }],
      [{ kind: "messages.get" }],
    ]);
    expect(executor.readCalls.map((op) => op.kind)).toEqual([
      "tags.list",
      "marks.get",
      "messages.get",
    ]);
  });

  it("queryMany with an empty batch touches no executor", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    await expect(adapter.queryMany([])).resolves.toEqual([]);
    expect(executor.readCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

describe("TauriSqlAdapter writes", () => {
  it("execute runs one write as its own transaction", async () => {
    const executor = new FakeExecutor();
    executor.writeResults = () => [{ affected: 1, id: 9, version: 3 }];
    const adapter = makeAdapter(executor);
    const result = await adapter.execute(
      asWrite({ kind: "tags.create", name: "New" }),
    );
    expect(result).toEqual({ affected: 1, id: 9, version: 3 });
    expect(executor.writeCalls).toEqual([[{ kind: "tags.create", name: "New" }]]);
  });

  it("transaction runs all writes in one executor call", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    const ops = [
      asWrite({ kind: "tags.create", name: "A" }),
      asWrite({ kind: "tags.create", name: "B" }),
    ];
    const results = await adapter.transaction(ops);
    expect(results).toEqual([{ affected: 1 }, { affected: 1 }]);
    expect(executor.writeCalls).toEqual([ops]);
  });

  it("transaction accepts an idempotency key and ignores it locally", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    const results = await adapter.transaction(
      [asWrite({ kind: "tags.create", name: "A" })],
      { idempotencyKey: "key-1" },
    );
    expect(results).toEqual([{ affected: 1 }]);
    expect(executor.writeCalls).toHaveLength(1);
  });

  it("transaction over 50 operations is rejected before any executor call", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    const ops = Array.from({ length: 51 }, (_, i) =>
      asWrite({ kind: "tags.create", name: `T${i}` }),
    );
    const error = await expectAdapterError(adapter.transaction(ops));
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toContain("51 operations");
    expect(executor.writeCalls).toEqual([]);
  });

  it("empty transaction calls the executor once with no operations", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    await expect(adapter.transaction([])).resolves.toEqual([]);
    expect(executor.writeCalls).toEqual([[]]);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("TauriSqlAdapter validation", () => {
  it("rejects an unknown kind before any executor call", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    const error = await expectAdapterError(
      adapter.query(asRead({ kind: "marks.nope" })),
    );
    expect(error.code).toBe("VALIDATION");
    expect(errorDetails(error)["wireCode"]).toBe("invalid_operation");
    expect(executor.readCalls).toEqual([]);
  });

  it("rejects a wrong-group kind before any executor call", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    const readError = await expectAdapterError(
      adapter.query(asRead({ kind: "tags.create", name: "X" })),
    );
    expect(readError.code).toBe("VALIDATION");
    const writeError = await expectAdapterError(
      adapter.execute(asWrite({ kind: "tags.list" })),
    );
    expect(writeError.code).toBe("VALIDATION");
    expect(executor.readCalls).toEqual([]);
    expect(executor.writeCalls).toEqual([]);
  });

  it("rejects every forbidden field before any executor call", async () => {
    for (const field of SQL_TAURI_FORBIDDEN_OPERATION_FIELDS) {
      const executor = new FakeExecutor();
      const adapter = makeAdapter(executor);
      const error = await expectAdapterError(
        adapter.query(asRead({ kind: "tags.list", [field]: "x" })),
      );
      expect(error.code).toBe("VALIDATION");
      expect(executor.readCalls).toEqual([]);
    }
  });

  it("rejects a non-object operation and a missing kind", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    const nonObject = await expectAdapterError(
      adapter.query(asRead("tags.list")),
    );
    expect(nonObject.code).toBe("VALIDATION");
    const noKind = await expectAdapterError(adapter.query(asRead({})));
    expect(noKind.code).toBe("VALIDATION");
    expect(executor.readCalls).toEqual([]);
  });

  it("rejects a batch with one invalid operation before any executor call", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    const error = await expectAdapterError(
      adapter.queryMany([
        { kind: "tags.list" },
        asRead({ kind: "marks.nope" }),
      ]),
    );
    expect(error.code).toBe("VALIDATION");
    expect(executor.readCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wave and exposure
// ---------------------------------------------------------------------------

describe("TauriSqlAdapter wave and exposure", () => {
  it.each(["memories.create", "memories.update", "policy.put", "wiki.upsertSource"])(
    "rejects W2 kind %s locally with UNAVAILABLE naming the phase",
    async (kind) => {
      const executor = new FakeExecutor();
      const adapter = makeAdapter(executor);
      const error = await expectAdapterError(
        adapter.execute(asWrite({ kind })),
      );
      expect(error.code).toBe("UNAVAILABLE");
      expect(error.retryable).toBe(false);
      expect(error.message).toContain(kind);
      expect(error.message).toContain("Fase 2");
      const details = errorDetails(error);
      expect(details["wireCode"]).toBe("capability_unavailable");
      expect(details["capability"]).toBe(kind);
      expect(details["phase"]).toBe("Fase 2");
      expect(executor.writeCalls).toEqual([]);
    },
  );

  it("rejects a W2 kind inside a transaction before any executor call", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    const error = await expectAdapterError(
      adapter.transaction([
        asWrite({ kind: "tags.create", name: "A" }),
        asWrite({ kind: "memories.create" }),
      ]),
    );
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toContain("Fase 2");
    expect(executor.writeCalls).toEqual([]);
  });

  it("rejects the server-only kind locally before any executor call", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    const error = await expectAdapterError(
      adapter.execute(asWrite({ kind: "vector.replaceChunks" })),
    );
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toContain("server-only");
    expect(error.message).toContain("Fase 2");
    const details = errorDetails(error);
    expect(details["wireCode"]).toBe("capability_unavailable");
    expect(details["phase"]).toBe("Fase 2");
    expect(executor.writeCalls).toEqual([]);
  });

  it("answers the server-only kind in a read batch as wrong-group VALIDATION", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    const error = await expectAdapterError(
      adapter.query(asRead({ kind: "vector.replaceChunks" })),
    );
    expect(error.code).toBe("VALIDATION");
    expect(executor.readCalls).toEqual([]);
  });

  it("admits messages.get, kind 74, through the catalog", async () => {
    const executor = new FakeExecutor();
    executor.readRows = () => [{ id: 3 }];
    const adapter = makeAdapter(executor);
    await expect(adapter.queryOne({ kind: "messages.get", id: 3 })).resolves.toEqual({ id: 3 });
    expect(SQL_OP_METADATA["messages.get" as SqlOpKind].wave).toBe("W1");
  });
});

// ---------------------------------------------------------------------------
// Executor failures and result shapes
// ---------------------------------------------------------------------------

describe("TauriSqlAdapter executor failures", () => {
  it("wraps an unknown executor failure as UNKNOWN without its message", async () => {
    const executor = new FakeExecutor();
    executor.failReadWith = new Error("marker-must-not-leak-12345 exploded");
    const adapter = makeAdapter(executor);
    const error = await expectAdapterError(adapter.query({ kind: "tags.list" }));
    expect(error.code).toBe("UNKNOWN");
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain("marker-must-not-leak-12345");
  });

  it("passes a SqlAdapterError from the executor through unchanged", async () => {
    const executor = new FakeExecutor();
    const thrown = new SqlAdapterError("CONFLICT", "guard miss", {
      details: { wireCode: "revision_conflict" },
    });
    executor.failWriteWith = thrown;
    const adapter = makeAdapter(executor);
    const error = await expectAdapterError(
      adapter.execute(asWrite({ kind: "tags.create", name: "X" })),
    );
    expect(error).toBe(thrown);
  });

  it("rejects a non-array read result as a shape mismatch", async () => {
    const executor = new FakeExecutor();
    executor.readRows = () => "not-an-array" as unknown as readonly unknown[];
    const adapter = makeAdapter(executor);
    const error = await expectAdapterError(adapter.query({ kind: "tags.list" }));
    expect(error.code).toBe("UNKNOWN");
    expect(error.message).toContain("mismatch");
  });

  it("rejects a write result of the wrong length as a shape mismatch", async () => {
    const executor = new FakeExecutor();
    executor.writeResults = () => [{ affected: 1 }, { affected: 1 }];
    const adapter = makeAdapter(executor);
    const error = await expectAdapterError(
      adapter.execute(asWrite({ kind: "tags.create", name: "X" })),
    );
    expect(error.code).toBe("UNKNOWN");
    expect(error.message).toContain("mismatch");
  });

  it("rejects a negative affected count as a shape mismatch", async () => {
    const executor = new FakeExecutor();
    executor.writeResults = () => [{ affected: -1 }];
    const adapter = makeAdapter(executor);
    const error = await expectAdapterError(
      adapter.execute(asWrite({ kind: "tags.create", name: "X" })),
    );
    expect(error.code).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// Metadata lookup and close
// ---------------------------------------------------------------------------

describe("catalogSqlMetadataLookup", () => {
  it("reads wave and exposure from the catalog without restating kinds", () => {
    expect(catalogSqlMetadataLookup.metadata("marks.list")).toEqual(
      SQL_OP_METADATA["marks.list"],
    );
    expect(catalogSqlMetadataLookup.metadata("memories.create").wave).toBe("W2");
    expect(catalogSqlMetadataLookup.metadata("vector.replaceChunks").exposure).toBe(
      "server-only",
    );
    expect(catalogSqlMetadataLookup.metadata("messages.get").wave).toBe("W1");
    expect(catalogSqlMetadataLookup.metadata("messages.get").exposure).toBe("client");
  });
});

describe("TauriSqlAdapter close", () => {
  it("delegates close to the executor", async () => {
    const executor = new FakeExecutor();
    const adapter = makeAdapter(executor);
    await adapter.close();
    expect(executor.closeCalls).toBe(1);
  });

  it("wraps a close failure as UNKNOWN", async () => {
    const executor = new FakeExecutor();
    executor.failCloseWith = new Error("close blew up");
    const adapter = makeAdapter(executor);
    const error = await expectAdapterError(adapter.close());
    expect(error.code).toBe("UNKNOWN");
  });
});
