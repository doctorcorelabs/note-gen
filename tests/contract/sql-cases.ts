// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// SQL contract cases (parameterized over implementations).
//
// Case IDs: CT-K, CT-T, CT-H, CT-X, CT-I, CT-S5, CT-S6 from
// fase1/desain-sql-adapter.md section 6, plus the C-SQ IDs from
// fase1/desain-pengujian.md section 2.4 where the same behavior is
// named there. Only the adapter-level subset runs here: cases that
// need a real Postgres catalog, HTTP auth, migration files, or a
// production bundle (CT-M1 to CT-M6, CT-T6, CT-K5, CT-S1 to CT-S4,
// CT-I3, CT-P1 to CT-P3, C-SQ-02, C-SQ-09, and the 1 MB body half of
// CT-X5) are recorded as deferred in tests/contract/README.md and
// must run against the Postgres-backed implementation, never the fake.
// This follows the R2 reconciliation in desain-pengujian.md: the fake
// proves the cases are runnable and can detect violations; it does
// not replace the Postgres contract.
//
// Concurrency cases (CT-H4, CT-X2) run sequentially against the fake:
// single-threaded in-memory code cannot race itself. What the fake
// proves is the guard itself (the second writer loses); true
// concurrent execution is a Postgres-level property.
//
// Chunk contents are never observable through read operations by
// design (CT-S6), so C-SQ-06 atomicity is asserted through the
// observable surfaces: knowledge status and vector summaries.

import { expect, it } from "vitest";
import { ContractError, isContractError } from "./contract-errors";
import type { ContractErrorCode } from "./contract-errors";
import { TAG_GUARD_CONFLICT_MESSAGE } from "./contract-types";
import type {
  MarkRow,
  SqlAdapter,
  TagRow,
} from "./contract-types";

async function expectCode(
  promise: Promise<unknown>,
  code: ContractErrorCode,
): Promise<ContractError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ContractError);
  expect(isContractError(thrown, code)).toBe(true);
  return thrown as ContractError;
}

async function makeTag(sql: SqlAdapter, name: string): Promise<number> {
  const result = await sql.execute({ kind: "tags.create", name });
  return result.id as number;
}

async function makeMark(
  sql: SqlAdapter,
  tagId: number,
  tagIds: number[],
  extra: { sourceId?: string | null; content?: string } = {},
): Promise<number> {
  const result = await sql.execute({
    kind: "marks.create",
    mark: {
      tagId,
      type: "text",
      content: extra.content ?? "body",
      sourceId: extra.sourceId,
    },
    tagIds,
  });
  return result.id as number;
}

async function getMark(sql: SqlAdapter, id: number): Promise<MarkRow> {
  const row = await sql.queryOne<MarkRow>({ kind: "marks.get", id });
  if (row === null) {
    throw new Error(`Expected mark ${id} to exist`);
  }
  return row;
}

async function assertPrimaryInvariant(sql: SqlAdapter): Promise<void> {
  const marks = await sql.query<MarkRow>({
    kind: "marks.list",
    includeDeleted: true,
    limit: 200,
  });
  for (const mark of marks) {
    expect(mark.tagIds).toContain(mark.tagId);
  }
}

export function defineSqlCases(getImpl: () => SqlAdapter): void {
  it("C-SQ-01: ready() is idempotent and preserves data", async () => {
    const sql = getImpl();
    await expect(sql.ready()).resolves.toMatchObject({ ok: true });
    const tagId = await makeTag(sql, "Ready");
    await makeMark(sql, tagId, [tagId]);
    await expect(sql.ready()).resolves.toMatchObject({ ok: true });
    await expect(sql.ready()).resolves.toMatchObject({ ok: true });
    const marks = await sql.query<MarkRow>({ kind: "marks.list" });
    expect(marks).toHaveLength(1);
  });

  it("C-SQ-03: creating a mark writes its mark_tags rows together", async () => {
    const sql = getImpl();
    const a = await makeTag(sql, "A");
    const b = await makeTag(sql, "B");
    const id = await makeMark(sql, a, [a, b]);
    const row = await getMark(sql, id);
    expect(row.tagIds).toEqual([a, b]);
    const byTag = await sql.query<MarkRow>({
      kind: "marks.listByTag",
      tagId: b,
    });
    expect(byTag.map((mark) => mark.id)).toContain(id);
  });

  it("CT-K1: a mark referencing a nonexistent tag is rejected", async () => {
    const sql = getImpl();
    await expectCode(
      sql.execute({
        kind: "marks.create",
        mark: { tagId: 999, type: "text" },
        tagIds: [999],
      }),
      "VALIDATION",
    );
    const tagId = await makeTag(sql, "Real");
    await expectCode(
      sql.execute({
        kind: "marks.create",
        mark: { tagId, type: "text" },
        tagIds: [tagId, 999],
      }),
      "VALIDATION",
    );
    await expect(sql.query({ kind: "marks.list" })).resolves.toHaveLength(0);
  });

  it("CT-K2/C-SQ-05: duplicate sourceId returns the existing row; null sourceIds stay independent", async () => {
    const sql = getImpl();
    const tagId = await makeTag(sql, "Dup");
    const first = await sql.execute({
      kind: "marks.create",
      mark: { tagId, type: "text", sourceId: "src-1" },
      tagIds: [tagId],
    });
    const second = await sql.execute({
      kind: "marks.create",
      mark: { tagId, type: "text", content: "other", sourceId: "src-1" },
      tagIds: [tagId],
    });
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.affected).toBe(0);
    const marks = await sql.query<MarkRow>({ kind: "marks.list" });
    expect(marks).toHaveLength(1);
    expect(marks[0].content).toBe("body");

    await makeMark(sql, tagId, [tagId], { sourceId: null });
    await makeMark(sql, tagId, [tagId], { sourceId: null });
    await expect(sql.query({ kind: "marks.list" })).resolves.toHaveLength(3);

    const other = await makeMark(sql, tagId, [tagId], {
      sourceId: "src-2",
    });
    await expectCode(
      sql.execute({
        kind: "marks.update",
        id: other,
        patch: { sourceId: "src-1" },
      }),
      "CONFLICT",
    );
  });

  it("CT-K3: tag names are unique and case-sensitive", async () => {
    const sql = getImpl();
    await makeTag(sql, "Work");
    await expectCode(sql.execute({ kind: "tags.create", name: "Work" }), "CONFLICT");
    await makeTag(sql, "work");
    const tags = await sql.query<TagRow>({ kind: "tags.list" });
    expect(tags.map((tag) => tag.name).sort()).toEqual(["Work", "work"]);
  });

  it("CT-K4/C-SQ-06a: a duplicate vector chunk key is rejected", async () => {
    const sql = getImpl();
    const chunk = { chunkId: 0, content: "c0", embedding: [0.1] };
    await sql.execute({
      kind: "vector.insertChunk",
      sourceType: "article",
      sourceId: "a1",
      chunk,
    });
    await expectCode(
      sql.execute({
        kind: "vector.insertChunk",
        sourceType: "article",
        sourceId: "a1",
        chunk,
      }),
      "CONFLICT",
    );
    await sql.execute({
      kind: "vector.insertChunk",
      sourceType: "article",
      sourceId: "a1",
      chunk: { chunkId: 1, content: "c1", embedding: [0.2] },
    });
    await sql.execute({
      kind: "vector.insertChunk",
      sourceType: "article",
      sourceId: "a2",
      chunk,
    });
    const summaries = await sql.query({ kind: "vector.summaries" });
    expect(summaries).toHaveLength(2);
  });

  it("C-SQ-06b: replaceChunks is all-or-nothing when one chunk is invalid", async () => {
    const sql = getImpl();
    await sql.execute({
      kind: "knowledge.registerSource",
      sourceType: "article",
      sourceId: "doc",
      contentHash: "h1",
    });
    await sql.execute({
      kind: "knowledge.claimSource",
      sourceType: "article",
      sourceId: "doc",
    });
    await sql.execute({
      kind: "knowledge.completeSource",
      sourceType: "article",
      sourceId: "doc",
      chunks: [{ chunkId: 0, content: "old", embedding: [0.1] }],
    });
    await expectCode(
      sql.execute({
        kind: "vector.replaceChunks",
        sourceType: "article",
        sourceId: "doc",
        chunks: [
          { chunkId: 0, content: "new", embedding: [0.2] },
          { chunkId: -1, content: "bad", embedding: [0.3] },
        ],
      }),
      "VALIDATION",
    );
    const summaries = await sql.query({ kind: "vector.summaries" });
    expect(summaries).toHaveLength(1);
    const source = await sql.queryOne({
      kind: "knowledge.getSource",
      sourceType: "article",
      sourceId: "doc",
    });
    expect(source).toMatchObject({ status: "ready", indexedHash: "h1" });
  });

  it("CT-T1/C-SQ-04a: moving the primary tag keeps extra tags", async () => {
    const sql = getImpl();
    const a = await makeTag(sql, "A");
    const b = await makeTag(sql, "B");
    const c = await makeTag(sql, "C");
    const id = await makeMark(sql, a, [a, b, c]);
    const before = await getMark(sql, id);
    await sql.execute({
      kind: "marks.update",
      id,
      patch: { tagId: b },
    });
    const after = await getMark(sql, id);
    expect(after.tagId).toBe(b);
    expect(after.tagIds).toEqual([a, b, c]);
    expect(after.tagUpdatedAt).toBeGreaterThan(before.tagUpdatedAt);
    await assertPrimaryInvariant(sql);
  });

  it("CT-T2/C-SQ-04b: permanent delete cascades; soft delete keeps tags and restore returns them", async () => {
    const sql = getImpl();
    const a = await makeTag(sql, "A");
    const b = await makeTag(sql, "B");
    const id = await makeMark(sql, a, [a, b]);

    await sql.execute({ kind: "marks.softDelete", id });
    await expect(sql.query({ kind: "marks.list" })).resolves.toHaveLength(0);
    const deleted = await getMark(sql, id);
    expect(deleted.deleted).toBe(true);
    expect(deleted.tagIds).toEqual([a, b]);

    await sql.execute({ kind: "marks.restore", id });
    const restored = await getMark(sql, id);
    expect(restored.deleted).toBe(false);
    expect(restored.tagIds).toEqual([a, b]);

    await sql.execute({ kind: "marks.deletePermanent", id });
    await expect(
      sql.queryOne({ kind: "marks.get", id }),
    ).resolves.toBeNull();
    await expect(
      sql.query({ kind: "marks.list", includeDeleted: true }),
    ).resolves.toHaveLength(0);
    await expect(
      sql.query({ kind: "marks.listByTag", tagId: a }),
    ).resolves.toHaveLength(0);
  });

  it("CT-T3: deleting a used tag fails without reassignTo and never discards records", async () => {
    const sql = getImpl();
    const a = await makeTag(sql, "A");
    const b = await makeTag(sql, "B");
    const m1 = await makeMark(sql, a, [a]);
    const m2 = await makeMark(sql, b, [a, b]);

    await expectCode(sql.execute({ kind: "tags.delete", id: a }), "CONFLICT");
    expect((await getMark(sql, m1)).tagId).toBe(a);
    expect((await getMark(sql, m2)).tagIds).toEqual([a, b]);

    await sql.execute({ kind: "tags.delete", id: a, reassignTo: b });
    const after1 = await getMark(sql, m1);
    expect(after1.tagId).toBe(b);
    expect(after1.tagIds).toEqual([b]);
    expect(after1.deleted).toBe(false);
    const after2 = await getMark(sql, m2);
    expect(after2.tagIds).toEqual([b]);
    expect(after2.deleted).toBe(false);
    const tags = await sql.query<TagRow>({ kind: "tags.list" });
    expect(tags.map((tag) => tag.name)).toEqual(["B"]);
  });

  it("CT-T4: updateTags replaces the set, creates new tags, and enforces the guard", async () => {
    const sql = getImpl();
    const a = await makeTag(sql, "A");
    const b = await makeTag(sql, "B");
    const id = await makeMark(sql, a, [a, b]);
    const before = await getMark(sql, id);

    const result = await sql.execute({
      kind: "marks.updateTags",
      id,
      tagIds: [b],
      newNames: ["C"],
    });
    expect(result.version).toBe(before.version + 1);
    const after = await getMark(sql, id);
    expect(after.tagId).toBe(a);
    expect(after.tagIds).toHaveLength(3);
    expect(after.tagUpdatedAt).toBeGreaterThan(before.tagUpdatedAt);
    await assertPrimaryInvariant(sql);

    await expectCode(
      sql.execute({
        kind: "marks.updateTags",
        id,
        tagIds: [a],
        expected: { tagIds: [a, b], primaryTagId: a },
      }),
      "CONFLICT",
    );
    const unchanged = await getMark(sql, id);
    expect(unchanged.tagIds).toEqual(after.tagIds);
    expect(unchanged.version).toBe(after.version);
  });

  it("CT-T5: the primary invariant holds after a mixed scenario", async () => {
    const sql = getImpl();
    const a = await makeTag(sql, "A");
    const b = await makeTag(sql, "B");
    const m1 = await makeMark(sql, a, [a, b]);
    const m2 = await makeMark(sql, b, [b]);
    await sql.execute({
      kind: "marks.updateTags",
      id: m1,
      tagIds: [b],
      newNames: ["C"],
    });
    await sql.execute({ kind: "marks.update", id: m2, patch: { tagId: a } });
    await sql.execute({ kind: "marks.saveTagIds", id: m2, tagIds: [] });
    await sql.execute({ kind: "marks.softDelete", id: m1 });
    await sql.execute({ kind: "marks.restore", id: m1 });
    await assertPrimaryInvariant(sql);
  });

  it("CT-H1: register, claim, complete drives pending to ready with matching hashes", async () => {
    const sql = getImpl();
    await sql.execute({
      kind: "knowledge.registerSource",
      sourceType: "record",
      sourceId: "r1",
      contentHash: "h1",
      title: "R1",
    });
    let source = await sql.queryOne({
      kind: "knowledge.getSource",
      sourceType: "record",
      sourceId: "r1",
    });
    expect(source).toMatchObject({
      status: "pending",
      indexedHash: null,
      contentHash: "h1",
    });
    await sql.execute({
      kind: "knowledge.claimSource",
      sourceType: "record",
      sourceId: "r1",
    });
    source = await sql.queryOne({
      kind: "knowledge.getSource",
      sourceType: "record",
      sourceId: "r1",
    });
    expect(source).toMatchObject({ status: "indexing" });
    await sql.execute({
      kind: "knowledge.completeSource",
      sourceType: "record",
      sourceId: "r1",
      chunks: [{ chunkId: 0, content: "c", embedding: [0.1, 0.2] }],
    });
    source = await sql.queryOne({
      kind: "knowledge.getSource",
      sourceType: "record",
      sourceId: "r1",
    });
    expect(source).toMatchObject({
      status: "ready",
      indexedHash: "h1",
      contentHash: "h1",
    });
    const stats = await sql.query({
      kind: "knowledge.stats",
    });
    expect(stats).toContainEqual({
      sourceType: "record",
      status: "ready",
      count: 1,
    });
  });

  it("CT-H2: new content returns a ready source to pending, keeping the old indexedHash", async () => {
    const sql = getImpl();
    await sql.execute({
      kind: "knowledge.registerSource",
      sourceType: "article",
      sourceId: "doc",
      contentHash: "h1",
    });
    await sql.execute({
      kind: "knowledge.claimSource",
      sourceType: "article",
      sourceId: "doc",
    });
    await sql.execute({
      kind: "knowledge.completeSource",
      sourceType: "article",
      sourceId: "doc",
      chunks: [{ chunkId: 0, content: "c", embedding: [0.1] }],
    });
    await sql.execute({
      kind: "knowledge.registerSource",
      sourceType: "article",
      sourceId: "doc",
      contentHash: "h2",
    });
    const source = await sql.queryOne({
      kind: "knowledge.getSource",
      sourceType: "article",
      sourceId: "doc",
    });
    expect(source).toMatchObject({
      status: "pending",
      contentHash: "h2",
      indexedHash: "h1",
    });
  });

  it("CT-H3: illegal status transitions are rejected", async () => {
    const sql = getImpl();
    await sql.execute({
      kind: "knowledge.registerSource",
      sourceType: "canvas",
      sourceId: "c1",
      contentHash: "h1",
    });
    await expectCode(
      sql.execute({
        kind: "knowledge.completeSource",
        sourceType: "canvas",
        sourceId: "c1",
        chunks: [],
      }),
      "CONFLICT",
    );
    await expectCode(
      sql.execute({
        kind: "knowledge.failSource",
        sourceType: "canvas",
        sourceId: "c1",
        error: "boom",
      }),
      "CONFLICT",
    );
    await expectCode(
      sql.execute({
        kind: "knowledge.retrySource",
        sourceType: "canvas",
        sourceId: "c1",
      }),
      "CONFLICT",
    );
    await sql.execute({
      kind: "knowledge.claimSource",
      sourceType: "canvas",
      sourceId: "c1",
    });
    await sql.execute({
      kind: "knowledge.completeSource",
      sourceType: "canvas",
      sourceId: "c1",
      chunks: [],
    });
    await expectCode(
      sql.execute({
        kind: "knowledge.claimSource",
        sourceType: "canvas",
        sourceId: "c1",
      }),
      "CONFLICT",
    );
  });

  it("CT-H4: two claims over one pending source, exactly one wins", async () => {
    const sql = getImpl();
    await sql.execute({
      kind: "knowledge.registerSource",
      sourceType: "article",
      sourceId: "doc",
      contentHash: "h1",
    });
    await sql.execute({
      kind: "knowledge.claimSource",
      sourceType: "article",
      sourceId: "doc",
    });
    await expectCode(
      sql.execute({
        kind: "knowledge.claimSource",
        sourceType: "article",
        sourceId: "doc",
      }),
      "CONFLICT",
    );
  });

  it("CT-H5: a failed chunk write cancels the status change", async () => {
    const sql = getImpl();
    await sql.execute({
      kind: "knowledge.registerSource",
      sourceType: "article",
      sourceId: "doc",
      contentHash: "h1",
    });
    await sql.execute({
      kind: "knowledge.claimSource",
      sourceType: "article",
      sourceId: "doc",
    });
    await expectCode(
      sql.execute({
        kind: "knowledge.completeSource",
        sourceType: "article",
        sourceId: "doc",
        chunks: [{ chunkId: 0, content: "", embedding: [0.1] }],
      }),
      "VALIDATION",
    );
    const source = await sql.queryOne({
      kind: "knowledge.getSource",
      sourceType: "article",
      sourceId: "doc",
    });
    expect(source).toMatchObject({ status: "indexing", indexedHash: null });
    await expect(sql.query({ kind: "vector.summaries" })).resolves.toHaveLength(0);
    await sql.execute({
      kind: "knowledge.completeSource",
      sourceType: "article",
      sourceId: "doc",
      chunks: [{ chunkId: 0, content: "ok", embedding: [0.1] }],
    });
    const ready = await sql.queryOne({
      kind: "knowledge.getSource",
      sourceType: "article",
      sourceId: "doc",
    });
    expect(ready).toMatchObject({ status: "ready" });
  });

  it("CT-H6: a failed source retries to pending with the error cleared", async () => {
    const sql = getImpl();
    await sql.execute({
      kind: "knowledge.registerSource",
      sourceType: "article",
      sourceId: "doc",
      contentHash: "h1",
    });
    await sql.execute({
      kind: "knowledge.claimSource",
      sourceType: "article",
      sourceId: "doc",
    });
    await sql.execute({
      kind: "knowledge.failSource",
      sourceType: "article",
      sourceId: "doc",
      error: "worker died",
    });
    let source = await sql.queryOne({
      kind: "knowledge.getSource",
      sourceType: "article",
      sourceId: "doc",
    });
    expect(source).toMatchObject({ status: "failed", error: "worker died" });
    await sql.execute({
      kind: "knowledge.retrySource",
      sourceType: "article",
      sourceId: "doc",
    });
    source = await sql.queryOne({
      kind: "knowledge.getSource",
      sourceType: "article",
      sourceId: "doc",
    });
    expect(source).toMatchObject({ status: "pending", error: null });
  });

  it("CT-X1: a transaction with a failing operation leaves nothing behind", async () => {
    const sql = getImpl();
    await expectCode(
      sql.transaction([
        { kind: "tags.create", name: "T1" },
        {
          kind: "marks.create",
          mark: { tagId: 1, type: "text" },
          tagIds: [1],
        },
        {
          kind: "marks.create",
          mark: { tagId: 999, type: "text" },
          tagIds: [999],
        },
      ]),
      "VALIDATION",
    );
    await expect(sql.query({ kind: "tags.list" })).resolves.toHaveLength(0);
    await expect(sql.query({ kind: "marks.list" })).resolves.toHaveLength(0);
    await assertPrimaryInvariant(sql);
  });

  it("CT-X2/C-SQ-10: two guarded writers, one wins; retry with fresh state succeeds", async () => {
    const sql = getImpl();
    const a = await makeTag(sql, "A");
    const b = await makeTag(sql, "B");
    const id = await makeMark(sql, a, [a, b]);
    const guard = { tagIds: [a, b], primaryTagId: a };
    await sql.execute({
      kind: "marks.updateTags",
      id,
      tagIds: [a],
      expected: guard,
    });
    await expectCode(
      sql.execute({
        kind: "marks.updateTags",
        id,
        tagIds: [b],
        expected: guard,
      }),
      "CONFLICT",
    );
    const fresh = await getMark(sql, id);
    await sql.execute({
      kind: "marks.updateTags",
      id,
      tagIds: [b],
      expected: { tagIds: fresh.tagIds, primaryTagId: fresh.tagId },
    });
    const after = await getMark(sql, id);
    expect(after.tagIds).toEqual([a, b]);
  });

  it("CT-X3: canvas save with a stale version conflicts; force succeeds", async () => {
    const sql = getImpl();
    const created = await sql.execute({
      kind: "canvases.save",
      title: "Board",
      content: { nodes: [] },
    });
    const id = created.id as string;
    const error = await expectCode(
      sql.execute({
        kind: "canvases.save",
        id,
        title: "Stale",
        content: {},
        expectedVersion: 99,
      }),
      "CONFLICT",
    );
    expect(error.details).toMatchObject({ currentVersion: 1 });
    const second = await sql.execute({
      kind: "canvases.save",
      id,
      title: "V2",
      content: { nodes: [1] },
      expectedVersion: 1,
    });
    expect(second.version).toBe(2);
    const forced = await sql.execute({
      kind: "canvases.save",
      id,
      title: "Forced",
      content: {},
      expectedVersion: 1,
      force: true,
    });
    expect(forced.version).toBe(3);
  });

  it("CT-X4: wiki commit with a stale version does not commit; the correct version commits", async () => {
    const sql = getImpl();
    const stale = await sql.execute({
      kind: "wiki.commitRevision",
      contextId: "ctx",
      sourceId: "s1",
      expectedVersion: 1,
      contentHash: "h1",
    });
    expect(stale.committed).toBe(false);
    expect(stale.version).toBe(0);
    const committed = await sql.execute({
      kind: "wiki.commitRevision",
      contextId: "ctx",
      sourceId: "s1",
      expectedVersion: 0,
      contentHash: "h1",
    });
    expect(committed.committed).toBe(true);
    expect(committed.version).toBe(1);
    const state = await sql.queryOne({
      kind: "wiki.getSourceState",
      contextId: "ctx",
      sourceId: "s1",
    });
    expect(state).toMatchObject({ version: 1, dirty: true, contentHash: "h1" });
    const staleAgain = await sql.execute({
      kind: "wiki.commitRevision",
      contextId: "ctx",
      sourceId: "s1",
      expectedVersion: 0,
      contentHash: "h2",
    });
    expect(staleAgain.committed).toBe(false);
    const unchanged = await sql.queryOne({
      kind: "wiki.getSourceState",
      contextId: "ctx",
      sourceId: "s1",
    });
    expect(unchanged).toMatchObject({ version: 1, contentHash: "h1" });
  });

  it("CT-X5: a transaction over the operation limit is rejected", async () => {
    const sql = getImpl();
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      kind: "tags.create" as const,
      name: `T${i}`,
    }));
    await expectCode(sql.transaction(tooMany), "VALIDATION");
    await expect(sql.query({ kind: "tags.list" })).resolves.toHaveLength(0);
    const atLimit = Array.from({ length: 50 }, (_, i) => ({
      kind: "tags.create" as const,
      name: `U${i}`,
    }));
    const results = await sql.transaction(atLimit);
    expect(results).toHaveLength(50);
  });

  it("CT-X6: the tag guard conflict uses the pinned upstream message", async () => {
    const sql = getImpl();
    const a = await makeTag(sql, "A");
    const id = await makeMark(sql, a, [a]);
    const error = await expectCode(
      sql.execute({
        kind: "marks.updateTags",
        id,
        tagIds: [a],
        expected: { tagIds: [999], primaryTagId: a },
      }),
      "CONFLICT",
    );
    expect(error.message).toBe(TAG_GUARD_CONFLICT_MESSAGE);
  });

  it("CT-S5/C-SQ-08: injection strings are data; unknown kinds and removed tables are rejected; no raw SQL path", async () => {
    const sql = getImpl();
    const injectionTag = "' OR '1'='1";
    const tagId = await makeTag(sql, injectionTag);
    await makeMark(sql, tagId, [tagId], {
      content: "; DROP TABLE marks; --",
    });
    const tags = await sql.query<TagRow>({ kind: "tags.list" });
    expect(tags.map((tag) => tag.name)).toContain(injectionTag);
    const marks = await sql.query<MarkRow>({ kind: "marks.list" });
    expect(marks).toHaveLength(1);
    expect(marks[0].content).toBe("; DROP TABLE marks; --");

    await expectCode(
      sql.query({ kind: "self_hosted.list" } as never),
      "VALIDATION",
    );
    await expectCode(
      sql.execute({ kind: "raw.query", sql: "SELECT 1" } as never),
      "VALIDATION",
    );
    const surface = sql as unknown as Record<string, unknown>;
    expect(surface.executeRaw).toBeUndefined();
    expect(surface.queryRaw).toBeUndefined();
    expect(surface.raw).toBeUndefined();
    expect(surface.sql).toBeUndefined();
  });

  it("CT-S6: responses never carry embeddings", async () => {
    const sql = getImpl();
    await sql.execute({
      kind: "knowledge.registerSource",
      sourceType: "article",
      sourceId: "doc",
      contentHash: "h1",
    });
    await sql.execute({
      kind: "knowledge.claimSource",
      sourceType: "article",
      sourceId: "doc",
    });
    const completed = await sql.execute({
      kind: "knowledge.completeSource",
      sourceType: "article",
      sourceId: "doc",
      chunks: [{ chunkId: 0, content: "c", embedding: [0.5, 0.25] }],
    });
    const batch = await sql.queryMany([
      { kind: "knowledge.listSources" },
      { kind: "vector.summaries" },
      { kind: "knowledge.stats" },
    ]);
    const serialized = JSON.stringify({ completed, batch });
    expect(serialized).not.toContain("embedding");
    expect(serialized).not.toContain("0.5");
  });

  it("CT-I1/CT-I2: an idempotency key replays identical results and rejects a different body", async () => {
    const sql = getImpl();
    const ops = [{ kind: "tags.create" as const, name: "Idem" }];
    const first = await sql.transaction(ops, { idempotencyKey: "key-1" });
    const replay = await sql.transaction(ops, { idempotencyKey: "key-1" });
    expect(replay).toEqual(first);
    const tags = await sql.query<TagRow>({ kind: "tags.list" });
    expect(tags.filter((tag) => tag.name === "Idem")).toHaveLength(1);
    await expectCode(
      sql.transaction([{ kind: "tags.create", name: "Other" }], {
        idempotencyKey: "key-1",
      }),
      "CONFLICT",
    );
  });

  it("CT-P2-shape: query results use stable fields and epoch millisecond timestamps", async () => {
    const sql = getImpl();
    const tagId = await makeTag(sql, "Shape");
    const id = await makeMark(sql, tagId, [tagId]);
    const mark = await getMark(sql, id);
    expect(Object.keys(mark).sort()).toEqual(
      [
        "content",
        "createdAt",
        "deleted",
        "desc",
        "id",
        "sourceId",
        "tagId",
        "tagIds",
        "tagUpdatedAt",
        "type",
        "updatedAt",
        "url",
        "version",
      ].sort(),
    );
    expect(typeof mark.createdAt).toBe("number");
    expect(mark.createdAt).toBeGreaterThan(0);
    expect(typeof mark.updatedAt).toBe("number");
    const tags = await sql.query<TagRow>({ kind: "tags.list" });
    expect(Object.keys(tags[0]).sort()).toEqual(
      [
        "createdAt",
        "id",
        "isLocked",
        "isPin",
        "name",
        "sortOrder",
        "updatedAt",
      ].sort(),
    );
  });

  it("queryMany: batch reads keep order and fail as a batch on an unknown kind; queryOne returns null when empty", async () => {
    const sql = getImpl();
    const tagId = await makeTag(sql, "Batch");
    await makeMark(sql, tagId, [tagId]);
    const [tags, marks] = await sql.queryMany([
      { kind: "tags.list" },
      { kind: "marks.list" },
    ]);
    expect(tags).toHaveLength(1);
    expect(marks).toHaveLength(1);
    await expectCode(
      sql.queryMany([
        { kind: "tags.list" },
        { kind: "nope.list" } as never,
      ]),
      "VALIDATION",
    );
    await expect(
      sql.queryOne({ kind: "marks.get", id: 999 }),
    ).resolves.toBeNull();
  });
}
