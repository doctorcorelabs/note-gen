// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for the knowledge catalog migration
// (src/db/knowledge.ts, BUG-02): every read and write runs
// through typed `knowledge.*` catalog kinds over a fake
// SqlAdapter. No test sends real HTTP and no test touches a
// database. The specs prove the client-side mapping: kind
// names, payload shapes, the stats single-row unwrap, and the
// zero-filled stats fallback. Live verification against the
// real handlers runs in the RAG settings rerun after this fix
// lands.
//
// Run: `pnpm vitest run --project unit src/db/knowledge.spec.ts`
// from the repo root.

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetPlatformForTests,
  registerPlatformAdapter,
  type SqlAdapter,
} from "../lib/platform";
import type {
  DbReadOperation,
  DbWriteOperation,
} from "../lib/platform/sql/ops-catalog";
import type { KnowledgeSource } from "@/types/knowledge";
import {
  deleteKnowledgeSource,
  getKnowledgeIndexStats,
  getKnowledgeSource,
  getKnowledgeSources,
  updateKnowledgeSourceIndexState,
  upsertKnowledgeSource,
} from "./knowledge";

const SOURCE: KnowledgeSource = {
  sourceKey: "record:7",
  sourceType: "record",
  sourceId: "7",
  title: "Record 7",
  contentHash: "hash-1",
  indexedHash: null,
  updatedAt: 1794660000000,
  locator: { markId: 7 },
  status: "pending",
  error: null,
};

class FakeSqlAdapter {
  readonly mode = "web" as const;
  readonly ops: unknown[] = [];
  statsRow: unknown = {
    article: { pending: 1, indexing: 0, ready: 2, failed: 0 },
    record: { pending: 0, indexing: 0, ready: 3, failed: 1 },
    canvas: { pending: 0, indexing: 0, ready: 0, failed: 0 },
  };

  async ready() {
    return { ok: true, mode: "web" as const, migrationsCurrent: true };
  }

  async query(op: DbReadOperation): Promise<unknown[]> {
    this.ops.push(op);
    switch (op.kind) {
      case "knowledge.getSource":
        return op.sourceKey === SOURCE.sourceKey ? [SOURCE] : [];
      case "knowledge.listSources":
        return [SOURCE];
      case "knowledge.stats":
        return this.statsRow === null ? [] : [this.statsRow];
      default:
        throw new Error(`fake query kind not implemented: ${op.kind}`);
    }
  }

  async queryOne(op: DbReadOperation): Promise<unknown | null> {
    const rows = await this.query(op);
    return rows[0] ?? null;
  }

  async queryMany(ops: readonly DbReadOperation[]): Promise<unknown[][]> {
    const out: unknown[][] = [];
    for (const op of ops) out.push(await this.query(op));
    return out;
  }

  async execute(op: DbWriteOperation): Promise<{ affected: number; id?: number | string; version?: number }> {
    this.ops.push(op);
    return { affected: 1 };
  }

  async transaction(ops: readonly DbWriteOperation[]) {
    const out = [];
    for (const op of ops) out.push(await this.execute(op));
    return out;
  }
}

let fakeSql: FakeSqlAdapter;

beforeEach(() => {
  __resetPlatformForTests();
  fakeSql = new FakeSqlAdapter();
  registerPlatformAdapter("sql", fakeSql as unknown as SqlAdapter, ["web"]);
});

describe("knowledge catalog migration (BUG-02)", () => {
  it("upsertKnowledgeSource executes knowledge.upsertSource with the source payload", async () => {
    await upsertKnowledgeSource(SOURCE);
    expect(fakeSql.ops).toEqual([{ kind: "knowledge.upsertSource", source: SOURCE }]);
  });

  it("getKnowledgeSource reads through knowledge.getSource and maps missing to null", async () => {
    expect(await getKnowledgeSource("record:7")).toEqual(SOURCE);
    expect(await getKnowledgeSource("record:404")).toBeNull();
  });

  it("getKnowledgeSources passes only non-empty filters to knowledge.listSources", async () => {
    expect(await getKnowledgeSources()).toEqual([SOURCE]);
    expect(fakeSql.ops[0]).toEqual({ kind: "knowledge.listSources" });
    await getKnowledgeSources({ statuses: ["failed"], sourceTypes: ["record"] });
    expect(fakeSql.ops[1]).toEqual({
      kind: "knowledge.listSources",
      sourceTypes: ["record"],
      statuses: ["failed"],
    });
  });

  it("updateKnowledgeSourceIndexState executes knowledge.updateStatus with null-filled fields", async () => {
    await updateKnowledgeSourceIndexState("record:7", { status: "ready", indexedHash: "hash-1" });
    expect(fakeSql.ops).toEqual([
      {
        kind: "knowledge.updateStatus",
        sourceKey: "record:7",
        update: { status: "ready", indexedHash: "hash-1", error: null },
      },
    ]);
  });

  it("deleteKnowledgeSource executes knowledge.removeSource", async () => {
    await deleteKnowledgeSource("record:7");
    expect(fakeSql.ops).toEqual([{ kind: "knowledge.removeSource", sourceKey: "record:7" }]);
  });

  it("getKnowledgeIndexStats unwraps the single stats row", async () => {
    const stats = await getKnowledgeIndexStats();
    expect(stats.article.ready).toBe(2);
    expect(stats.record.failed).toBe(1);
    expect(fakeSql.ops).toEqual([{ kind: "knowledge.stats" }]);
  });

  it("getKnowledgeIndexStats falls back to zero-filled cells on an empty result", async () => {
    fakeSql.statsRow = null;
    const stats = await getKnowledgeIndexStats();
    expect(stats).toEqual({
      article: { pending: 0, indexing: 0, ready: 0, failed: 0 },
      record: { pending: 0, indexing: 0, ready: 0, failed: 0 },
      canvas: { pending: 0, indexing: 0, ready: 0, failed: 0 },
    });
  });
});
