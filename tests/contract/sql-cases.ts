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
//
// F6 REMAP (wave 4): the cases run against the canonical SqlAdapter
// surface (ops-catalog.ts, 74 kinds), not the folded 30-kind
// mirror. The six ghost kinds are gone: the knowledge status
// machine runs on knowledge.upsertSource / knowledge.updateStatus /
// knowledge.removeSource, and chunk work on vector.replaceChunks.
// Changes from the scaffold cases, each with its reason:
// - CT-K4 DELETED: vector.insertChunk is a ghost kind with no
//   canonical operation; duplicate-chunk-key behavior has no
//   observable canonical form (replaceChunks replaces whole sets).
// - CT-K2: the `duplicate` flag assertion is dropped (canonical
//   SqlWriteResult has no such field; first-write-wins is observed
//   as affected 0 plus the existing id), the null-sourceId leg
//   omits sourceId instead (the server mints UUIDs), and the
//   update-sourceId tail is dropped (SqlMarkPatch has no sourceId;
//   the field is immutable after create).
// - CT-K3: a duplicate tag name returns the existing tag with
//   affected 0 (the server handler's ON CONFLICT DO NOTHING
//   behavior), it does not throw.
// - CT-X6: the pinned upstream message is NOT asserted here. The
//   web adapter rebuilds error messages from wire codes, so the
//   message text is not adapter-observable; the case asserts the
//   CONFLICT code plus the guard details, and the message itself
//   stays pinned by server/test/db-handlers-records-tags.spec.ts.
// - CT-P2-shape: exact key-set equality is replaced by
//   required-plus-allowed key assertions, because canonical rows
//   omit null content/desc and tag rows carry no timestamps and no
//   total on tags.get.
// - CT-X1: the middle valid mark creation is dropped. Tag ids are
//   database-global sequences, so no case may assume the first tag
//   in a fresh workspace has id 1; atomicity is proven with one
//   successful op plus one failing op.
// - CT-H3/CT-H4: the ghost claim/fail/retry verbs are replaced by
//   guarded updateStatus transitions. Pending-to-pending is a legal
//   self-transition, so the old "retry from pending conflicts"
//   leg is replaced by ready-to-indexing and failed-to-ready legs.
// - Fake-only cases (they run only when factory.name is "fake"):
//   C-SQ-06b, CT-H5, CT-S6 (they seed chunks through
//   vector.replaceChunks, which the server answers 410 in Fase 1),
//   and CT-X4 (wiki.commitRevision is a 410 stub in Fase 1).
//   CT-X5 runs on every leg: the web adapter rejects oversized
//   transactions locally instead of splitting them, and the
//   Postgres shim mirrors that adapter-level bound. See
//   tests/contract/EXCEPTIONS.md E13-E14.

import { expect, it } from "vitest";
import { DEFAULT_CANVAS_DOCUMENT } from "../../src/types/canvas";
import type { ContractFactory } from "./contract-harness";
import { SqlAdapterError } from "./contract-types";
import type {
  KnowledgeIndexStatus,
  KnowledgeSource,
  KnowledgeSourceType,
  SqlAdapter,
  SqlErrorCode,
  SqlMarkRow,
  SqlTagRow,
  WikiPage,
  WikiSourceRevision,
  WikiSourceState,
} from "./contract-types";

async function expectCode(
  promise: Promise<unknown>,
  code: SqlErrorCode,
): Promise<SqlAdapterError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(SqlAdapterError);
  expect((thrown as SqlAdapterError).code).toBe(code);
  return thrown as SqlAdapterError;
}

async function makeTag(sql: SqlAdapter, name: string): Promise<number> {
  const result = await sql.execute({ kind: "tags.create", name });
  return result.id as number;
}

async function makeMark(
  sql: SqlAdapter,
  tagId: number,
  tagIds: number[],
  extra: { sourceId?: string; content?: string } = {},
): Promise<number> {
  const result = await sql.execute({
    kind: "marks.create",
    mark: {
      tagId,
      type: "text",
      content: extra.content ?? "body",
      url: "",
      ...(extra.sourceId === undefined
        ? {}
        : { sourceId: extra.sourceId }),
    },
    tagIds,
  });
  return result.id as number;
}

async function getMark(sql: SqlAdapter, id: number): Promise<SqlMarkRow> {
  const row = await sql.queryOne({ kind: "marks.get", id });
  if (row === null) {
    throw new Error(`Expected mark ${id} to exist`);
  }
  return row;
}

async function assertPrimaryInvariant(sql: SqlAdapter): Promise<void> {
  const marks = await sql.query({
    kind: "marks.list",
    deleted: "all",
    limit: 200,
  });
  for (const mark of marks) {
    expect(mark.tagIds).toContain(mark.tagId);
  }
}

function makeSourceInput(
  sourceKey: string,
  sourceType: KnowledgeSourceType,
  sourceId: string,
  contentHash: string,
  status: KnowledgeIndexStatus = "pending",
): KnowledgeSource {
  return {
    sourceKey,
    sourceType,
    sourceId,
    title: sourceId,
    contentHash,
    indexedHash: null,
    updatedAt: Date.now(),
    locator: {},
    status,
    error: null,
  };
}

async function upsertSource(
  sql: SqlAdapter,
  source: KnowledgeSource,
): Promise<void> {
  await sql.execute({ kind: "knowledge.upsertSource", source });
}

async function getSource(
  sql: SqlAdapter,
  sourceKey: string,
): Promise<KnowledgeSource> {
  const row = await sql.queryOne({ kind: "knowledge.getSource", sourceKey });
  if (row === null) {
    throw new Error(`Expected knowledge source ${sourceKey} to exist`);
  }
  return row;
}

async function setStatus(
  sql: SqlAdapter,
  sourceKey: string,
  status: KnowledgeIndexStatus,
  extra: {
    indexedHash?: string | null;
    error?: string | null;
    expectedStatus?: KnowledgeIndexStatus;
  } = {},
): Promise<void> {
  await sql.execute({
    kind: "knowledge.updateStatus",
    sourceKey,
    update: { status, ...extra },
  });
}

const WIKI_CANVAS_ID = "11111111-1111-4111-8111-111111111111";

function wikiState(contentHash: string, version: number): WikiSourceState {
  return {
    contextId: "ctx",
    stableId: "s1",
    sourceKey: "article:s1",
    sourceType: "article",
    source: {
      sourceKey: "article:s1",
      stableId: "s1",
      sourceType: "article",
      title: "S1",
      contentHash,
      locator: {},
      syncDomain: "library",
    },
    contentHash,
    status: "pending",
    revisionId: null,
    version,
    updatedAt: Date.now(),
    error: null,
  };
}

function wikiRevision(
  id: string,
  sourceHash: string,
  outputHash: string,
): WikiSourceRevision {
  return {
    id,
    contextId: "ctx",
    inputHash: sourceHash,
    outputHash,
    pipelineVersion: "wiki-1",
    generation: 1,
    language: "en",
    source: {
      sourceKey: "article:s1",
      stableId: "s1",
      sourceType: "article",
      title: "S1",
      contentHash: sourceHash,
      locator: {},
      syncDomain: "library",
    },
    summary: "summary",
    contributions: [],
    createdAt: Date.now(),
    modelId: "test-model",
    usage: { inputTokens: 0, outputTokens: 0, estimated: false },
  };
}

function wikiPage(id: string): WikiPage {
  return {
    id,
    contextId: "ctx",
    kind: "source",
    title: "Page",
    aliases: [],
    body: "body",
    sourceRefs: [],
    inputHash: "h1",
    outputHash: "out1",
    updatedAt: Date.now(),
    status: "ready",
    relatedPageIds: [],
  };
}

export function defineSqlCases(
  getImpl: () => SqlAdapter,
  factory: ContractFactory<SqlAdapter>,
): void {
  const isFake = factory.name === "fake";

  it("C-SQ-01: ready() is idempotent and preserves data", async () => {
    const sql = getImpl();
    await expect(sql.ready()).resolves.toMatchObject({ ok: true });
    const tagId = await makeTag(sql, "Ready");
    await makeMark(sql, tagId, [tagId]);
    await expect(sql.ready()).resolves.toMatchObject({ ok: true });
    await expect(sql.ready()).resolves.toMatchObject({ ok: true });
    const marks = await sql.query({ kind: "marks.list" });
    expect(marks).toHaveLength(1);
  });

  it("C-SQ-03: creating a mark writes its mark_tags rows together", async () => {
    const sql = getImpl();
    const a = await makeTag(sql, "A");
    const b = await makeTag(sql, "B");
    const id = await makeMark(sql, a, [a, b]);
    const row = await getMark(sql, id);
    expect(row.tagIds).toEqual([a, b]);
    const byTag = await sql.query({
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
        mark: { tagId: 999, type: "text", url: "" },
        tagIds: [999],
      }),
      "VALIDATION",
    );
    const tagId = await makeTag(sql, "Real");
    await expectCode(
      sql.execute({
        kind: "marks.create",
        mark: { tagId, type: "text", url: "" },
        tagIds: [tagId, 999],
      }),
      "VALIDATION",
    );
    await expect(sql.query({ kind: "marks.list" })).resolves.toHaveLength(0);
  });

  it("CT-K2/C-SQ-05: duplicate sourceId returns the existing row; omitted sourceIds stay independent", async () => {
    const sql = getImpl();
    const tagId = await makeTag(sql, "Dup");
    const first = await sql.execute({
      kind: "marks.create",
      mark: { tagId, type: "text", content: "body", url: "", sourceId: "src-1" },
      tagIds: [tagId],
    });
    const second = await sql.execute({
      kind: "marks.create",
      mark: { tagId, type: "text", content: "other", url: "", sourceId: "src-1" },
      tagIds: [tagId],
    });
    expect(second.affected).toBe(0);
    expect(second.id).toBe(first.id);
    const marks = await sql.query({ kind: "marks.list" });
    expect(marks).toHaveLength(1);
    expect(marks[0].content).toBe("body");

    await makeMark(sql, tagId, [tagId]);
    await makeMark(sql, tagId, [tagId]);
    await expect(sql.query({ kind: "marks.list" })).resolves.toHaveLength(3);
  });

  it("CT-K3: duplicate tag names return the existing tag; names are case-sensitive", async () => {
    const sql = getImpl();
    const first = await sql.execute({ kind: "tags.create", name: "Work" });
    expect(first.affected).toBe(1);
    const duplicate = await sql.execute({ kind: "tags.create", name: "Work" });
    expect(duplicate.affected).toBe(0);
    expect(duplicate.id).toBe(first.id);
    await makeTag(sql, "work");
    const tags = await sql.query({ kind: "tags.list" });
    expect(tags.map((tag) => tag.name).sort()).toEqual(["Work", "work"]);
  });

  if (isFake) {
    it("C-SQ-06b: replaceChunks is all-or-nothing when one chunk is invalid", async () => {
      const sql = getImpl();
      await upsertSource(
        sql,
        makeSourceInput("article:doc", "article", "doc", "h1"),
      );
      await setStatus(sql, "article:doc", "indexing", {
        expectedStatus: "pending",
      });
      await sql.transaction([
        {
          kind: "knowledge.updateStatus",
          sourceKey: "article:doc",
          update: { status: "ready", indexedHash: "h1" },
        },
        {
          kind: "vector.replaceChunks",
          sourceType: "article",
          sourceId: "doc",
          chunks: [{ chunkId: 0, content: "old", embedding: "[0.1]" }],
        },
      ]);
      await expectCode(
        sql.transaction([
          {
            kind: "knowledge.updateStatus",
            sourceKey: "article:doc",
            update: { status: "ready", indexedHash: "h2" },
          },
          {
            kind: "vector.replaceChunks",
            sourceType: "article",
            sourceId: "doc",
            chunks: [
              { chunkId: 0, content: "new", embedding: "[0.2]" },
              { chunkId: -1, content: "bad", embedding: "[0.3]" },
            ],
          },
        ]),
        "VALIDATION",
      );
      const summaries = await sql.query({ kind: "vector.summaries" });
      expect(summaries).toHaveLength(1);
      const source = await getSource(sql, "article:doc");
      expect(source).toMatchObject({ status: "ready", indexedHash: "h1" });
    });
  }

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
      sql.query({ kind: "marks.list", deleted: "all" }),
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
    const tags = await sql.query({ kind: "tags.list" });
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
    await sql.execute({ kind: "marks.saveTagIds", id: m2, tagId: a, tagIds: [] });
    await sql.execute({ kind: "marks.softDelete", id: m1 });
    await sql.execute({ kind: "marks.restore", id: m1 });
    await assertPrimaryInvariant(sql);
  });

  it("CT-H1/C-SQ-07: upsert, claim, complete drives pending to ready with matching hashes", async () => {
    const sql = getImpl();
    await upsertSource(
      sql,
      makeSourceInput("record:r1", "record", "r1", "h1"),
    );
    let source = await getSource(sql, "record:r1");
    expect(source).toMatchObject({
      status: "pending",
      indexedHash: null,
      contentHash: "h1",
    });
    await setStatus(sql, "record:r1", "indexing", {
      expectedStatus: "pending",
    });
    source = await getSource(sql, "record:r1");
    expect(source).toMatchObject({ status: "indexing" });
    await setStatus(sql, "record:r1", "ready", {
      indexedHash: "h1",
      expectedStatus: "indexing",
    });
    source = await getSource(sql, "record:r1");
    expect(source).toMatchObject({
      status: "ready",
      indexedHash: "h1",
      contentHash: "h1",
    });
    const stats = await sql.queryOne({ kind: "knowledge.stats" });
    expect(stats?.record.ready).toBe(1);
    expect(stats?.record.pending).toBe(0);
  });

  it("CT-H2: new content returns a ready source to pending, keeping the old indexedHash", async () => {
    const sql = getImpl();
    await upsertSource(
      sql,
      makeSourceInput("article:doc", "article", "doc", "h1"),
    );
    await setStatus(sql, "article:doc", "indexing", {
      expectedStatus: "pending",
    });
    await setStatus(sql, "article:doc", "ready", {
      indexedHash: "h1",
      expectedStatus: "indexing",
    });
    await upsertSource(
      sql,
      makeSourceInput("article:doc", "article", "doc", "h2"),
    );
    const source = await getSource(sql, "article:doc");
    expect(source).toMatchObject({
      status: "pending",
      contentHash: "h2",
      indexedHash: "h1",
    });
  });

  it("CT-H3: illegal status transitions are rejected", async () => {
    const sql = getImpl();
    await upsertSource(
      sql,
      makeSourceInput("canvas:c1", "canvas", "c1", "h1"),
    );
    await expectCode(
      setStatus(sql, "canvas:c1", "ready"),
      "CONFLICT",
    );
    await expectCode(
      setStatus(sql, "canvas:c1", "failed", { error: "boom" }),
      "CONFLICT",
    );
    await setStatus(sql, "canvas:c1", "indexing", {
      expectedStatus: "pending",
    });
    await setStatus(sql, "canvas:c1", "ready", {
      indexedHash: "h1",
      expectedStatus: "indexing",
    });
    await expectCode(
      setStatus(sql, "canvas:c1", "indexing"),
      "CONFLICT",
    );
    await upsertSource(
      sql,
      makeSourceInput("canvas:c2", "canvas", "c2", "h1"),
    );
    await setStatus(sql, "canvas:c2", "indexing", {
      expectedStatus: "pending",
    });
    await setStatus(sql, "canvas:c2", "failed", { error: "worker died" });
    await expectCode(setStatus(sql, "canvas:c2", "ready"), "CONFLICT");
  });

  it("CT-H4: two guarded claims over one pending source, exactly one wins", async () => {
    const sql = getImpl();
    await upsertSource(
      sql,
      makeSourceInput("article:doc", "article", "doc", "h1"),
    );
    await setStatus(sql, "article:doc", "indexing", {
      expectedStatus: "pending",
    });
    await expectCode(
      setStatus(sql, "article:doc", "indexing", {
        expectedStatus: "pending",
      }),
      "CONFLICT",
    );
    const source = await getSource(sql, "article:doc");
    expect(source.status).toBe("indexing");
  });

  if (isFake) {
    it("CT-H5: a failed chunk write cancels the status change", async () => {
      const sql = getImpl();
      await upsertSource(
        sql,
        makeSourceInput("article:doc", "article", "doc", "h1"),
      );
      await setStatus(sql, "article:doc", "indexing", {
        expectedStatus: "pending",
      });
      await expectCode(
        sql.transaction([
          {
            kind: "knowledge.updateStatus",
            sourceKey: "article:doc",
            update: { status: "ready", indexedHash: "h1" },
          },
          {
            kind: "vector.replaceChunks",
            sourceType: "article",
            sourceId: "doc",
            chunks: [{ chunkId: 0, content: "", embedding: "[0.1]" }],
          },
        ]),
        "VALIDATION",
      );
      const source = await getSource(sql, "article:doc");
      expect(source).toMatchObject({ status: "indexing", indexedHash: null });
      await expect(sql.query({ kind: "vector.summaries" })).resolves.toHaveLength(0);
      await sql.transaction([
        {
          kind: "knowledge.updateStatus",
          sourceKey: "article:doc",
          update: { status: "ready", indexedHash: "h1" },
        },
        {
          kind: "vector.replaceChunks",
          sourceType: "article",
          sourceId: "doc",
          chunks: [{ chunkId: 0, content: "ok", embedding: "[0.1]" }],
        },
      ]);
      const ready = await getSource(sql, "article:doc");
      expect(ready).toMatchObject({ status: "ready" });
    });
  }

  it("CT-H6: a failed source retries to pending with the error cleared", async () => {
    const sql = getImpl();
    await upsertSource(
      sql,
      makeSourceInput("article:doc", "article", "doc", "h1"),
    );
    await setStatus(sql, "article:doc", "indexing", {
      expectedStatus: "pending",
    });
    await setStatus(sql, "article:doc", "failed", { error: "worker died" });
    let source = await getSource(sql, "article:doc");
    expect(source).toMatchObject({ status: "failed", error: "worker died" });
    await setStatus(sql, "article:doc", "pending");
    source = await getSource(sql, "article:doc");
    expect(source).toMatchObject({ status: "pending", error: null });
  });

  it("CT-X1: a transaction with a failing operation leaves nothing behind", async () => {
    const sql = getImpl();
    await expectCode(
      sql.transaction([
        { kind: "tags.create", name: "T1" },
        {
          kind: "marks.create",
          mark: { tagId: 999999, type: "text", url: "" },
          tagIds: [999999],
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
      kind: "canvases.create",
      canvas: {
        id: WIKI_CANVAS_ID,
        title: "Board",
        canvasType: "blank",
        document: structuredClone(DEFAULT_CANVAS_DOCUMENT),
      },
    });
    const id = created.id as string;
    const error = await expectCode(
      sql.execute({
        kind: "canvases.save",
        id,
        patch: { title: "Stale" },
        expected: { version: 99 },
      }),
      "CONFLICT",
    );
    expect(error.details).toMatchObject({ currentVersion: 1 });
    const second = await sql.execute({
      kind: "canvases.save",
      id,
      patch: {
        title: "V2",
        document: structuredClone(DEFAULT_CANVAS_DOCUMENT),
      },
      expected: { version: 1 },
    });
    expect(second.version).toBe(2);
    const forced = await sql.execute({
      kind: "canvases.save",
      id,
      patch: { title: "Forced" },
      expected: { version: 1 },
      force: true,
    });
    expect(forced.version).toBe(3);
  });

  if (isFake) {
    it("CT-X4: wiki commit with a stale version does not commit; the correct version commits", async () => {
      const sql = getImpl();
      const stale = await sql.execute({
        kind: "wiki.commitRevision",
        revision: wikiRevision("rev-0", "h1", "out0"),
        pages: [],
        expectedVersion: 1,
      });
      expect(stale.committed).toBe(false);
      expect(stale.version).toBe(0);
      await sql.execute({
        kind: "wiki.upsertSource",
        state: wikiState("h1", 0),
      });
      const hashMismatch = await sql.execute({
        kind: "wiki.commitRevision",
        revision: wikiRevision("rev-x", "other", "outx"),
        pages: [],
        expectedVersion: 0,
      });
      expect(hashMismatch.committed).toBe(false);
      const committed = await sql.execute({
        kind: "wiki.commitRevision",
        revision: wikiRevision("rev-1", "h1", "out1"),
        pages: [wikiPage("page-1")],
        expectedVersion: 0,
      });
      expect(committed.committed).toBe(true);
      expect(committed.version).toBe(1);
      const state = await sql.queryOne({
        kind: "wiki.getSourceState",
        contextId: "ctx",
        stableId: "s1",
      });
      expect(state).toMatchObject({
        version: 1,
        revisionId: "rev-1",
        contentHash: "out1",
      });
      const staleAgain = await sql.execute({
        kind: "wiki.commitRevision",
        revision: wikiRevision("rev-2", "out1", "out2"),
        pages: [],
        expectedVersion: 0,
      });
      expect(staleAgain.committed).toBe(false);
      const unchanged = await sql.queryOne({
        kind: "wiki.getSourceState",
        contextId: "ctx",
        stableId: "s1",
      });
      expect(unchanged).toMatchObject({ version: 1, contentHash: "out1" });
    });
  }

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

  it("CT-X6: the tag guard conflict reports the current tag set", async () => {
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
    expect(error.details).toMatchObject({
      currentTagIds: [a],
      currentPrimaryTagId: a,
    });
  });

  it("CT-S5/C-SQ-08: injection strings are data; unknown kinds and removed tables are rejected; no raw SQL path", async () => {
    const sql = getImpl();
    const injectionTag = "' OR '1'='1";
    const tagId = await makeTag(sql, injectionTag);
    await makeMark(sql, tagId, [tagId], {
      content: "; DROP TABLE marks; --",
    });
    const tags = await sql.query({ kind: "tags.list" });
    expect(tags.map((tag) => tag.name)).toContain(injectionTag);
    const marks = await sql.query({ kind: "marks.list" });
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

  if (isFake) {
    it("CT-S6: responses never carry embeddings", async () => {
      const sql = getImpl();
      await upsertSource(
        sql,
        makeSourceInput("article:doc", "article", "doc", "h1"),
      );
      await setStatus(sql, "article:doc", "indexing", {
        expectedStatus: "pending",
      });
      const completed = await sql.transaction([
        {
          kind: "knowledge.updateStatus",
          sourceKey: "article:doc",
          update: { status: "ready", indexedHash: "h1" },
        },
        {
          kind: "vector.replaceChunks",
          sourceType: "article",
          sourceId: "doc",
          chunks: [{ chunkId: 0, content: "c", embedding: "[0.5, 0.25]" }],
        },
      ]);
      const batch = await sql.queryMany([
        { kind: "knowledge.listSources" },
        { kind: "vector.summaries" },
        { kind: "knowledge.stats" },
      ]);
      const serialized = JSON.stringify({ completed, batch });
      expect(serialized).not.toContain("embedding");
      expect(serialized).not.toContain("0.5");
    });
  }

  it("CT-I1/CT-I2: an idempotency key replays identical results and rejects a different body", async () => {
    const sql = getImpl();
    const ops = [{ kind: "tags.create" as const, name: "Idem" }];
    const first = await sql.transaction(ops, { idempotencyKey: "key-1" });
    const replay = await sql.transaction(ops, { idempotencyKey: "key-1" });
    expect(replay).toEqual(first);
    const tags = await sql.query({ kind: "tags.list" });
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
    const markKeys = Object.keys(mark).sort();
    const allowedMarkKeys = [
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
    ].sort();
    for (const key of markKeys) {
      expect(allowedMarkKeys).toContain(key);
    }
    for (const key of [
      "id",
      "tagId",
      "tagIds",
      "tagUpdatedAt",
      "type",
      "url",
      "deleted",
      "createdAt",
      "updatedAt",
      "version",
      "sourceId",
      "content",
    ]) {
      expect(markKeys).toContain(key);
    }
    expect(typeof mark.createdAt).toBe("number");
    expect(mark.createdAt).toBeGreaterThan(0);
    expect(typeof mark.updatedAt).toBe("number");
    const tags = await sql.query({ kind: "tags.list" });
    const tagKeys = Object.keys(tags[0]).sort();
    for (const key of tagKeys) {
      expect(["id", "isLocked", "isPin", "name", "sortOrder", "total"]).toContain(key);
    }
    for (const key of ["id", "name", "isLocked", "isPin", "sortOrder"]) {
      expect(tagKeys).toContain(key);
    }
    const single = await sql.queryOne({ kind: "tags.get", id: tagId });
    expect(single).not.toBeNull();
    expect("total" in (single as SqlTagRow)).toBe(false);
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
