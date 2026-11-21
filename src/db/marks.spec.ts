// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Behavior specs for the marks migration (src/db/marks.ts, wave 5,
// D-DEMO-3): the ControlText save path and the completion reads run
// through typed catalog kinds over a fake SqlAdapter. No test sends
// real HTTP and no test touches a database. The fake mirrors the
// server kind handlers closely enough to prove the client-side
// logic: first-write-wins sourceId, the version and tag-set guards,
// primary-always-present tag sets, 404 on missing rows, and the 200
// row page cap with cursor pagination. Subtree tag matching by tag
// name is server-side and is NOT mirrored; the fake matches on tag
// set membership, and the specs never rely on name descent. Live
// verification against the real kind handlers runs in the demo
// rerun after this slot merges.
//
// Run: `pnpm vitest run --project unit src/db/marks.spec.ts` from
// the repo root. The file uses vitest (the `unit` project in
// vitest.config.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlatformCapabilityError,
  __resetPlatformForTests,
  registerPlatformAdapter,
  type FsAdapter,
  type SqlAdapter,
  type StoreAdapter,
} from "../lib/platform";
import type {
  DbReadOperation,
  DbWriteOperation,
  SqlMarkRow,
  SqlTagRow,
} from "../lib/platform/sql/ops-catalog";
import {
  attachMarkTagIds,
  clearTrash,
  deleteAllMarks,
  deleteMarks,
  delMark,
  delMarkForever,
  getActiveMarkPage,
  getAllMarks,
  getMarkById,
  getMarkPreviews,
  getMarks,
  getTrashMarkPreviews,
  initMarksDb,
  insertExternalMark,
  insertMark,
  insertMarks,
  restoreMark,
  restoreMarks,
  saveMarkTagIds,
  updateMark,
  updateMarks,
  updateMarkTag,
  updatePluginTextRecord,
  updateRecordTags,
  type Mark,
} from "./marks";

const mocks = vi.hoisted(() => ({
  enqueueAutoDataSync: vi.fn((..._args: unknown[]) => { void _args; }),
  enqueueKnowledgeSourceIndex: vi.fn((..._args: unknown[]) => { void _args; }),
  removeKnowledgeSourceIndex: vi.fn(async (..._args: unknown[]) => { void _args; }),
  reconcileStructuredKnowledgeSources: vi.fn(async (..._args: unknown[]) => { void _args; }),
  getRecordImageThumbnailPath: vi.fn(async (..._args: unknown[]) => { void _args; return null; }),
}));

vi.mock("@/lib/sync/auto-data-sync-queue", () => ({
  enqueueAutoDataSync: (...args: unknown[]) => mocks.enqueueAutoDataSync(...args),
  setAutoDataSyncApplyingRemote: vi.fn(),
}));

vi.mock("@/lib/knowledge-index", () => ({
  enqueueKnowledgeSourceIndex: (...args: unknown[]) =>
    mocks.enqueueKnowledgeSourceIndex(...args),
  removeKnowledgeSourceIndex: (...args: unknown[]) =>
    mocks.removeKnowledgeSourceIndex(...args),
  reconcileStructuredKnowledgeSources: (...args: unknown[]) =>
    mocks.reconcileStructuredKnowledgeSources(...args),
}));

vi.mock("@/lib/record-image-thumbnail", () => ({
  getRecordImageThumbnailPath: (...args: unknown[]) =>
    mocks.getRecordImageThumbnailPath(...args),
}));

function kindFailure(code: string, message: string): Error {
  const error = new Error(`${code} ${message}`);
  error.name = "SqlAdapterError";
  const status = Number(code);
  const localCode =
    status === 409 ? "CONFLICT" : status === 404 ? "NOT_FOUND" : status === 400 ? "VALIDATION" : "UNKNOWN";
  Object.assign(error, {
    code: localCode,
    retryable: false,
    details: { wireCode: message, status },
  });
  return error;
}

function sortedUnique(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

const MARK_TYPES = [
  "scan",
  "text",
  "image",
  "link",
  "file",
  "recording",
  "todo",
] as const;

class FakeSqlAdapter {
  readonly mode = "web" as const;
  readonly ops: unknown[] = [];
  readonly marks = new Map<number, SqlMarkRow>();
  readonly tags = new Map<number, SqlTagRow>();
  private nextMarkId = 1;
  private nextTagId = 1;
  private clock = 1_700_000_000_000;

  seedTag(partial: Partial<SqlTagRow> & { name: string }): SqlTagRow {
    const id = partial.id ?? this.nextTagId++;
    this.nextTagId = Math.max(this.nextTagId, id + 1);
    const row: SqlTagRow = {
      id,
      name: partial.name,
      isLocked: partial.isLocked ?? false,
      isPin: partial.isPin ?? false,
      sortOrder: partial.sortOrder ?? 0,
    };
    this.tags.set(id, row);
    return row;
  }

  seedMark(partial: Partial<SqlMarkRow> & { tagId: number }): SqlMarkRow {
    const id = partial.id ?? this.nextMarkId++;
    this.nextMarkId = Math.max(this.nextMarkId, id + 1);
    const createdAt = partial.createdAt ?? (this.clock += 1000);
    const row: SqlMarkRow = {
      id,
      tagId: partial.tagId,
      tagIds: partial.tagIds ?? [partial.tagId],
      tagUpdatedAt: partial.tagUpdatedAt ?? 0,
      type: partial.type ?? "text",
      content: partial.content,
      desc: partial.desc,
      url: partial.url ?? "",
      deleted: partial.deleted ?? false,
      createdAt,
      updatedAt: partial.updatedAt ?? createdAt,
      version: partial.version ?? 1,
      sourceId: partial.sourceId ?? null,
    };
    this.marks.set(id, row);
    return row;
  }

  get executes(): Array<Record<string, unknown>> {
    return this.ops.filter(
      (op): op is Record<string, unknown> =>
        typeof op === "object" && op !== null && !this.isReadKind((op as { kind: string }).kind),
    );
  }

  private isReadKind(kind: string): boolean {
    return (
      kind === "marks.list" ||
      kind === "marks.get" ||
      kind === "marks.listByTag" ||
      kind === "tags.list"
    );
  }

  async ready() {
    return { ok: true, mode: "web" as const, migrationsCurrent: true };
  }

  async query(op: DbReadOperation): Promise<unknown[]> {
    this.ops.push(op);
    switch (op.kind) {
      case "marks.list":
        return this.listMarks(op.deleted ?? "active", undefined, op.cursor, op.limit);
      case "marks.listByTag":
        return this.listMarks(op.deleted ?? "active", op.tagId, op.cursor, op.limit);
      case "marks.get": {
        const row = this.marks.get(op.id);
        return row === undefined ? [] : [row];
      }
      case "tags.list":
        return [...this.tags.values()].sort((a, b) => a.id - b.id);
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
    switch (op.kind) {
      case "marks.create":
        return this.createMark(op);
      case "marks.update":
        return this.updateMark(op);
      case "marks.updateTags":
        return this.updateTags(op);
      case "marks.saveTagIds":
        return this.saveTagIds(op);
      case "marks.softDelete":
        return this.softDelete(op.id, true);
      case "marks.restore":
        return this.softDelete(op.id, false);
      case "marks.emptyTrash": {
        let purged = 0;
        for (const [id, row] of [...this.marks.entries()]) {
          if (row.deleted) {
            this.marks.delete(id);
            purged += 1;
          }
        }
        return { affected: purged };
      }
      case "marks.deletePermanent": {
        if (!this.marks.has(op.id)) throw kindFailure("404", "not_found");
        this.marks.delete(op.id);
        return { affected: 1, id: op.id };
      }
      case "knowledge.updateStatus":
        return { affected: 1, id: op.sourceKey };
      default:
        throw new Error(`fake execute kind not implemented: ${op.kind}`);
    }
  }

  async transaction(ops: readonly DbWriteOperation[]) {
    const out: Array<{ affected: number; id?: number | string; version?: number }> = [];
    for (const op of ops) out.push(await this.execute(op));
    return out;
  }

  async close() {}

  private listMarks(
    deleted: "active" | "deleted" | "all",
    tagId: number | undefined,
    cursor: string | undefined,
    limit: number | undefined,
  ): SqlMarkRow[] {
    const effectiveLimit = Math.min(200, Math.max(1, Math.floor(limit ?? 50)));
    let rows = [...this.marks.values()].filter((row) => {
      if (deleted === "active" && row.deleted) return false;
      if (deleted === "deleted" && !row.deleted) return false;
      if (tagId !== undefined && !row.tagIds.includes(tagId)) return false;
      return true;
    });
    rows.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    if (cursor !== undefined) {
      const [createdAtText, idText] = cursor.split(":");
      const cursorCreatedAt = Number(createdAtText);
      const cursorId = Number(idText);
      rows = rows.filter(
        (row) => row.createdAt < cursorCreatedAt || (row.createdAt === cursorCreatedAt && row.id < cursorId),
      );
    }
    return rows.slice(0, effectiveLimit);
  }

  private createMark(op: Extract<DbWriteOperation, { kind: "marks.create" }>) {
    const mark = op.mark;
    if (!Number.isInteger(mark.tagId) || mark.tagId <= 0) {
      throw kindFailure("400", "mark.tagId must be a positive integer");
    }
    if (!(MARK_TYPES as readonly string[]).includes(mark.type)) {
      throw kindFailure("400", "mark.type must be a known mark type");
    }
    if (typeof mark.url !== "string") {
      throw kindFailure("400", "mark.url must be a string");
    }
    const effectiveTagIds = sortedUnique([mark.tagId, ...(op.tagIds ?? [])]);
    for (const tagId of effectiveTagIds) {
      if (!this.tags.has(tagId)) throw kindFailure("400", "tag_not_found");
    }
    if (mark.sourceId !== undefined) {
      for (const row of this.marks.values()) {
        if (row.sourceId === mark.sourceId) {
          return { affected: 0, id: row.id, version: row.version };
        }
      }
    }
    const createdAt = (this.clock += 1000);
    const row = this.seedMark({
      tagId: mark.tagId,
      tagIds: effectiveTagIds,
      tagUpdatedAt: createdAt,
      type: mark.type,
      content: mark.content,
      desc: mark.desc,
      url: mark.url,
      createdAt,
      updatedAt: createdAt,
      sourceId: mark.sourceId ?? `minted-${this.nextMarkId}`,
    });
    return { affected: 1, id: row.id, version: row.version };
  }

  private updateMark(op: Extract<DbWriteOperation, { kind: "marks.update" }>) {
    const row = this.marks.get(op.id);
    if (row === undefined || row.deleted) throw kindFailure("404", "not_found");
    if (op.expected !== undefined && op.expected.version !== row.version) {
      throw kindFailure("409", "revision_conflict");
    }
    const patch = op.patch;
    const fieldCount = Object.keys(patch).length;
    if (fieldCount === 0) return { affected: 0, id: row.id, version: row.version };
    if (patch.tagId !== undefined) {
      if (!this.tags.has(patch.tagId)) throw kindFailure("400", "tag_not_found");
      row.tagId = patch.tagId;
      row.tagIds = sortedUnique([...row.tagIds, patch.tagId]);
      row.tagUpdatedAt = (this.clock += 1000);
    }
    if (patch.content !== undefined) row.content = patch.content ?? undefined;
    if (patch.desc !== undefined) row.desc = patch.desc ?? undefined;
    if (patch.url !== undefined) row.url = patch.url;
    row.version += 1;
    row.updatedAt = (this.clock += 1000);
    return { affected: 1, id: row.id, version: row.version };
  }

  private updateTags(op: Extract<DbWriteOperation, { kind: "marks.updateTags" }>) {
    const row = this.marks.get(op.id);
    if (row === undefined || row.deleted) throw kindFailure("404", "not_found");
    if (op.expected !== undefined) {
      const expectedSet = sortedUnique(op.expected.tagIds);
      const currentSet = sortedUnique(row.tagIds);
      if (
        JSON.stringify(expectedSet) !== JSON.stringify(currentSet) ||
        op.expected.primaryTagId !== row.tagId
      ) {
        throw kindFailure("409", "record_tags_changed");
      }
    }
    const createdIds: number[] = [];
    for (const name of op.newNames ?? []) {
      const created = this.seedTag({ name });
      createdIds.push(created.id);
    }
    const next = sortedUnique([
      row.tagId,
      ...op.tagIds.filter((tagId) => this.tags.has(tagId)),
      ...createdIds,
    ]);
    if (next.length === 0) throw kindFailure("400", "a mark without a tag is not valid");
    row.tagIds = next;
    row.version += 1;
    row.tagUpdatedAt = (this.clock += 1000);
    return { affected: 1, id: row.id, version: row.version };
  }

  private saveTagIds(op: Extract<DbWriteOperation, { kind: "marks.saveTagIds" }>) {
    const row = this.marks.get(op.id);
    if (row === undefined) throw kindFailure("404", "not_found");
    if (op.tagIds === undefined) return { affected: 0, id: row.id, version: row.version };
    const next = sortedUnique([op.tagId, ...op.tagIds]);
    for (const tagId of next) {
      if (!this.tags.has(tagId)) throw kindFailure("400", "tag_not_found");
    }
    row.tagId = op.tagId;
    row.tagIds = next;
    row.tagUpdatedAt = (this.clock += 1000);
    return { affected: 1, id: row.id, version: row.version };
  }

  private softDelete(id: number, deleted: boolean) {
    const row = this.marks.get(id);
    if (row === undefined) throw kindFailure("404", "not_found");
    if (row.deleted === deleted) return { affected: 0, id: row.id, version: row.version };
    row.deleted = deleted;
    row.version += 1;
    row.updatedAt = (this.clock += 1000);
    return { affected: 1, id: row.id, version: row.version };
  }
}

function createMemoryStore() {
  const docs = new Map<string, Map<string, unknown>>();
  const handleFor = (path: string) => {
    let doc = docs.get(path);
    if (doc === undefined) {
      doc = new Map();
      docs.set(path, doc);
    }
    const docRef = doc;
    return {
      path,
      get: async <T,>(key: string): Promise<T | undefined> =>
        docRef.get(key) as T | undefined,
      set: async (key: string, value: unknown): Promise<void> => {
        docRef.set(key, value);
      },
      save: async (): Promise<void> => {},
      delete: async (key: string): Promise<boolean> => docRef.delete(key),
    };
  };
  return {
    docs,
    adapter: {
      load: async (path: string) => handleFor(path),
      getStore: async (path: string) => handleFor(path),
      closeAll: async () => {},
    } as unknown as StoreAdapter,
  };
}

function createMemoryFs(initialFiles: string[] = []) {
  const files = new Set(initialFiles);
  const removed: string[] = [];
  const mkdirs: string[] = [];
  return {
    files,
    removed,
    mkdirs,
    adapter: {
      exists: async (path: string | URL): Promise<boolean> => files.has(String(path)),
      mkdir: async (path: string | URL): Promise<void> => {
        mkdirs.push(String(path));
      },
      remove: async (path: string | URL): Promise<void> => {
        files.delete(String(path));
        removed.push(String(path));
      },
    } as unknown as FsAdapter,
  };
}

let fakeSql: FakeSqlAdapter;
let memoryStore: ReturnType<typeof createMemoryStore>;
let memoryFs: ReturnType<typeof createMemoryFs>;

beforeEach(() => {
  fakeSql = new FakeSqlAdapter();
  fakeSql.seedTag({ id: 1, name: "Idea", isLocked: true });
  fakeSql.seedTag({ id: 2, name: "inbox" });
  fakeSql.seedTag({ id: 3, name: "inbox/sub" });
  memoryStore = createMemoryStore();
  memoryFs = createMemoryFs();
  mocks.enqueueAutoDataSync.mockClear();
  mocks.enqueueKnowledgeSourceIndex.mockClear();
  mocks.removeKnowledgeSourceIndex.mockClear();
  mocks.reconcileStructuredKnowledgeSources.mockClear();
  mocks.getRecordImageThumbnailPath.mockClear();
  __resetPlatformForTests();
  registerPlatformAdapter("sql", fakeSql as unknown as SqlAdapter, ["web"]);
  registerPlatformAdapter("store", memoryStore.adapter, ["web"]);
  registerPlatformAdapter("fs", memoryFs.adapter, ["web"]);
});

function opKinds(): string[] {
  // Wiki reads flow through the adapter since the wiki migration
  // (UTANG-UJI-09), so index cleanup on delete/restore records
  // wiki.* reads alongside the marks writes. This spec asserts the
  // marks write ordering only, so wiki reads are filtered out here.
  return fakeSql.ops
    .map((op) => (op as { kind: string }).kind)
    .filter((kind) => !kind.startsWith("wiki."));
}

describe("insertMark (ControlText save path)", () => {
  it("saves a text capture exactly as ControlText calls it, readable back afterwards", async () => {
    const result = await insertMark({
      tagId: 2,
      type: "text",
      desc: "hello quokka",
      content: "hello quokka",
    });
    expect(result.rowsAffected).toBe(1);
    expect(result.lastInsertId).toBe(1);
    const saved = await getMarkById(result.lastInsertId);
    expect(saved).toMatchObject({
      tagId: 2,
      tagIds: [2],
      type: "text",
      desc: "hello quokka",
      content: "hello quokka",
      url: "",
      deleted: 0,
    });
    expect(saved?.sourceId).toBeTruthy();
  });

  it("sends one marks.create with url defaulted to empty and no activity argument", async () => {
    await insertMark({ tagId: 2, type: "text", desc: "d", content: "c" });
    const creates = fakeSql.executes.filter((op) => op.kind === "marks.create");
    expect(creates).toHaveLength(1);
    const op = creates[0];
    expect(op.mark).toMatchObject({ tagId: 2, type: "text", desc: "d", content: "c", url: "" });
    expect(op.mark).not.toHaveProperty("sourceId");
    expect(op).not.toHaveProperty("activity");
    expect(op).not.toHaveProperty("tagIds");
    expect(fakeSql.executes).toHaveLength(1);
  });

  it("awaits beforeWrite before any kind call is sent", async () => {
    let opsAtBeforeWrite = -1;
    await insertMark({ tagId: 2, type: "text", content: "c" }, async () => {
      opsAtBeforeWrite = fakeSql.ops.length;
    });
    expect(opsAtBeforeWrite).toBe(0);
    expect(opKinds()).toEqual(["marks.create"]);
  });

  it("normalizes tagIds through the primary set and passes a supplied sourceId", async () => {
    await insertMark({
      tagId: 2,
      tagIds: [3, 2, 3, 0, -1],
      type: "text",
      content: "c",
      sourceId: "src-1",
    });
    const op = fakeSql.executes.find((entry) => entry.kind === "marks.create");
    expect(op?.tagIds).toEqual([2, 3]);
    expect((op?.mark as { sourceId?: string }).sourceId).toBe("src-1");
  });

  it("treats a duplicate sourceId as first-write-wins without a second row", async () => {
    const first = await insertMark({ tagId: 2, type: "text", content: "one", sourceId: "dup-1" });
    const second = await insertMark({ tagId: 3, type: "text", content: "two", sourceId: "dup-1" });
    expect(first.rowsAffected).toBe(1);
    expect(second.rowsAffected).toBe(0);
    expect(second.lastInsertId).toBe(first.lastInsertId);
    expect(fakeSql.marks.size).toBe(1);
    expect(fakeSql.marks.get(first.lastInsertId)?.content).toBe("one");
  });

  it("fails fast with no kind call when tagId or type is missing", async () => {
    await expect(insertMark({ type: "text", content: "c" })).rejects.toThrow(
      "insertMark requires tagId and type",
    );
    await expect(insertMark({ tagId: 2, content: "c" })).rejects.toThrow(
      "insertMark requires tagId and type",
    );
    expect(fakeSql.ops).toHaveLength(0);
  });

  it("generates a thumbnail for a local image mark and skips it for text", async () => {
    await insertMark({ tagId: 2, type: "image", url: "image/pic.png", content: "" });
    expect(mocks.getRecordImageThumbnailPath).toHaveBeenCalledWith("image/pic.png", 96);
    mocks.getRecordImageThumbnailPath.mockClear();
    await insertMark({ tagId: 2, type: "text", content: "c" });
    expect(mocks.getRecordImageThumbnailPath).not.toHaveBeenCalled();
  });

  it("enqueues the records sync and the knowledge index for the new id", async () => {
    const result = await insertMark({ tagId: 2, type: "text", content: "c" });
    expect(mocks.enqueueAutoDataSync).toHaveBeenCalledWith("records", "mark:insert");
    // The knowledge enqueue runs through a fire-and-forget dynamic
    // import, so wait for the chain instead of asserting inline.
    await vi.waitFor(() => {
      expect(mocks.enqueueKnowledgeSourceIndex).toHaveBeenCalledWith(
        `record:${result.lastInsertId}`,
      );
    });
  });
});

describe("insertExternalMark", () => {
  it("inserts a new external record and reports duplicate false", async () => {
    const outcome = await insertExternalMark({
      tagId: 2,
      type: "text",
      content: "ext",
      sourceId: "ext-1",
    });
    expect(outcome.duplicate).toBe(false);
    expect(outcome.mark.content).toBe("ext");
    expect(outcome.mark.sourceId).toBe("ext-1");
  });

  it("returns the existing row with duplicate true for a known sourceId", async () => {
    const first = await insertExternalMark({
      tagId: 2,
      type: "text",
      content: "ext",
      sourceId: "ext-1",
    });
    const second = await insertExternalMark({
      tagId: 3,
      type: "text",
      content: "changed",
      sourceId: "ext-1",
    });
    expect(second.duplicate).toBe(true);
    expect(second.mark.id).toBe(first.mark.id);
    expect(second.mark.content).toBe("ext");
    expect(fakeSql.marks.size).toBe(1);
  });
});

describe("reads", () => {
  it("getMarks returns deleted rows too, mapped to 0 | 1, newest first", async () => {
    fakeSql.seedMark({ tagId: 2, content: "old", createdAt: 100 });
    fakeSql.seedMark({ tagId: 2, content: "gone", deleted: true, createdAt: 200 });
    fakeSql.seedMark({ tagId: 2, content: "new", createdAt: 300 });
    const marks = await getMarks(2);
    expect(marks.map((mark) => mark.content)).toEqual(["new", "gone", "old"]);
    expect(marks.map((mark) => mark.deleted)).toEqual([0, 1, 0]);
    expect(marks[0].tagIds).toEqual([2]);
    const listOp = fakeSql.ops.find(
      (op) => (op as { kind: string }).kind === "marks.listByTag",
    ) as { deleted?: string } | undefined;
    expect(listOp?.deleted).toBe("all");
  });

  it("getMarks pages past the 200 row cap with a cursor", async () => {
    for (let index = 0; index < 250; index += 1) {
      fakeSql.seedMark({ tagId: 2, content: `row-${index}`, createdAt: 1000 + index });
    }
    const marks = await getMarks(2);
    expect(marks).toHaveLength(250);
    const listOps = fakeSql.ops.filter(
      (op) => (op as { kind: string }).kind === "marks.listByTag",
    ) as Array<{ cursor?: string; limit?: number }>;
    expect(listOps).toHaveLength(2);
    expect(listOps[0].cursor).toBeUndefined();
    expect(listOps[0].limit).toBe(200);
    expect(listOps[1].cursor ?? "").toMatch(/^\d+:\d+$/);
    expect(listOps[1].limit).toBe(200);
  });

  it("getMarkById returns undefined for a missing row and reads deleted rows", async () => {
    const kept = fakeSql.seedMark({ tagId: 2, content: "kept" });
    fakeSql.seedMark({ tagId: 2, content: "gone", deleted: true });
    expect(await getMarkById(999)).toBeUndefined();
    expect(await getMarkById(kept.id)).toMatchObject({ content: "kept", deleted: 0 });
    const gone = await getMarkById(kept.id + 1);
    expect(gone?.deleted).toBe(1);
  });

  it("getMarkPreviews truncates to 500 code points and reads active rows only", async () => {
    const long = `${"x".repeat(499)}\u{1F600}${"y".repeat(50)}`;
    fakeSql.seedMark({ tagId: 2, content: long, desc: long });
    fakeSql.seedMark({ tagId: 2, content: "gone", deleted: true });
    const previews = await getMarkPreviews();
    expect(previews).toHaveLength(1);
    expect(Array.from(previews[0].content ?? "")).toHaveLength(500);
    expect(previews[0].content?.endsWith("\u{1F600}")).toBe(true);
    expect(Array.from(previews[0].desc ?? "")).toHaveLength(500);
    const listOp = fakeSql.ops.find(
      (op) => (op as { kind: string }).kind === "marks.list",
    ) as { deleted?: string } | undefined;
    expect(listOp?.deleted).toBe("active");
  });

  it("getMarkPreviews with a tag id filters through listByTag", async () => {
    fakeSql.seedMark({ tagId: 2, content: "in-inbox" });
    fakeSql.seedMark({ tagId: 3, tagIds: [3], content: "in-sub" });
    const previews = await getMarkPreviews(2);
    expect(previews.map((mark) => mark.content)).toEqual(["in-inbox"]);
  });

  it("getTrashMarkPreviews returns deleted rows only", async () => {
    fakeSql.seedMark({ tagId: 2, content: "kept" });
    fakeSql.seedMark({ tagId: 2, content: "gone", deleted: true });
    const previews = await getTrashMarkPreviews();
    expect(previews.map((mark) => mark.content)).toEqual(["gone"]);
  });

  it("getAllMarks returns every row including deleted ones", async () => {
    fakeSql.seedMark({ tagId: 2, content: "kept" });
    fakeSql.seedMark({ tagId: 3, tagIds: [3], content: "gone", deleted: true });
    const marks = await getAllMarks();
    expect(marks).toHaveLength(2);
  });
});

describe("updates and deletes", () => {
  function seedTextMark(overrides: Partial<SqlMarkRow> = {}): Mark {
    const row = fakeSql.seedMark({ tagId: 2, content: "body", desc: "title", ...overrides });
    return {
      id: row.id,
      tagId: row.tagId,
      tagIds: [...row.tagIds],
      tagUpdatedAt: row.tagUpdatedAt,
      version: row.version,
      type: row.type,
      content: row.content,
      desc: row.desc,
      url: row.url,
      deleted: row.deleted ? 1 : 0,
      createdAt: row.createdAt,
      sourceId: row.sourceId,
    };
  }

  it("updateMark patches without createdAt and invalidates the knowledge index", async () => {
    const mark = seedTextMark();
    const result = await updateMark({ ...mark, content: "edited", createdAt: 424242 });
    expect(result.rowsAffected).toBe(1);
    const update = fakeSql.executes.find((op) => op.kind === "marks.update");
    expect(update?.patch).toEqual({
      tagId: 2,
      url: "",
      desc: "title",
      content: "edited",
    });
    expect(update?.patch).not.toHaveProperty("createdAt");
    expect(fakeSql.marks.get(mark.id)?.createdAt).toBe(mark.createdAt);
    const invalidation = fakeSql.executes.find((op) => op.kind === "knowledge.updateStatus");
    expect(invalidation).toMatchObject({
      sourceKey: `record:${mark.id}`,
      update: { status: "pending", indexedHash: null, error: null },
    });
  });

  it("updateMark queues remote deletion when the local asset path changes", async () => {
    const mark = seedTextMark({ type: "image", url: "image/old.png", content: "" });
    await updateMark({ ...mark, url: "image/new.png" });
    const store = memoryStore.docs.get("store.json");
    const pending = store?.get("pendingRecordAssetRemoteDeletions") as string[] | undefined;
    expect(pending).toHaveLength(1);
    expect(pending?.[0] ?? "").toContain("old.png");
  });

  it("updateMarkTag moves the primary tag through marks.update", async () => {
    const mark = seedTextMark();
    await updateMarkTag(mark.id, 3, mark.version);
    const update = fakeSql.executes.find((op) => op.kind === "marks.update");
    expect(update).toMatchObject({ id: mark.id, patch: { tagId: 3 }, expected: { version: mark.version } });
    expect(fakeSql.marks.get(mark.id)?.tagId).toBe(3);
  });

  it("updateMark sends the loaded version and rejects a stale guard", async () => {
    const mark = seedTextMark();
    await updateMark({ ...mark, content: "edited" });
    const update = fakeSql.executes.find((op) => op.kind === "marks.update");
    expect(update).toMatchObject({ expected: { version: mark.version } });
    await expect(
      updateMark({ ...mark, content: "stale" }),
    ).rejects.toThrow("409 revision_conflict");
  });

  it("updatePluginTextRecord sends the loaded version and returns true", async () => {
    const mark = seedTextMark();
    const ok = await updatePluginTextRecord(mark, { ...mark, content: "plugin-edited", desc: "plugin title" }, async () => {});
    expect(ok).toBe(true);
    const update = fakeSql.executes.find((op) => op.kind === "marks.update");
    expect(update).toMatchObject({ id: mark.id, expected: { version: mark.version } });
    expect(update?.patch).toMatchObject({ content: "plugin-edited", desc: "plugin title" });
    expect(fakeSql.marks.get(mark.id)?.content).toBe("plugin-edited");
    expect(fakeSql.marks.get(mark.id)?.version).toBe((mark.version ?? 0) + 1);
  });

  it("updatePluginTextRecord returns false on a stale version without writing", async () => {
    const mark = seedTextMark();
    await updateMark({ ...mark, content: "concurrent" });
    const ok = await updatePluginTextRecord(mark, { ...mark, content: "plugin-stale" }, async () => {});
    expect(ok).toBe(false);
    expect(fakeSql.marks.get(mark.id)?.content).toBe("concurrent");
  });

  it("updatePluginTextRecord fails closed without a version", async () => {
    const mark = seedTextMark();
    const unversioned: Mark = { ...mark };
    delete unversioned.version;
    await expect(
      updatePluginTextRecord(unversioned, { ...unversioned, content: "x" }, async () => {}),
    ).rejects.toThrow(/mark\.version/);
    expect(fakeSql.executes.filter((op) => op.kind === "marks.update")).toHaveLength(0);
  });

  it("updatePluginTextRecord runs beforeWrite before the kind call", async () => {
    const mark = seedTextMark();
    await expect(
      updatePluginTextRecord(mark, { ...mark, content: "x" }, async () => { throw new Error("permission revoked"); }),
    ).rejects.toThrow("permission revoked");
    expect(fakeSql.executes.filter((op) => op.kind === "marks.update")).toHaveLength(0);
    expect(fakeSql.marks.get(mark.id)?.content).toBe("body");
  });

  it("getActiveMarkPage pages active marks with a lookahead hasMore", async () => {
    for (let index = 0; index < 5; index += 1) {
      fakeSql.seedMark({ tagId: 2, content: `page-${index}`, createdAt: 1000 + index });
    }
    fakeSql.seedMark({ tagId: 2, content: "trashed", deleted: true, createdAt: 2000 });
    const firstPage = await getActiveMarkPage({ tagId: 2, offset: 0, limit: 2 });
    expect(firstPage.marks.map((mark) => mark.content)).toEqual(["page-4", "page-3"]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.marks[0].version).toBe(1);
    const lastPage = await getActiveMarkPage({ tagId: 2, offset: 4, limit: 2 });
    expect(lastPage.marks.map((mark) => mark.content)).toEqual(["page-0"]);
    expect(lastPage.hasMore).toBe(false);
  });

  it("updateMark, updateMarkTag, and updateMarks fail closed without a version", async () => {
    const mark = seedTextMark();
    const unversioned: Mark = { ...mark };
    delete unversioned.version;
    await expect(updateMark({ ...unversioned, content: "x" })).rejects.toThrow(
      /mark\.version/,
    );
    await expect(updateMarkTag(mark.id, 3)).rejects.toThrow(/mark\.version/);
    await expect(
      updateMarks([{ ...unversioned, content: "x" }]),
    ).rejects.toThrow(/mark\.version/);
    expect(fakeSql.executes.filter((op) => op.kind === "marks.update")).toHaveLength(0);
  });

  it("delMark and restoreMark run the matching kinds", async () => {
    const mark = seedTextMark();
    await delMark(mark.id);
    expect(fakeSql.marks.get(mark.id)?.deleted).toBe(true);
    await restoreMark(mark.id);
    expect(fakeSql.marks.get(mark.id)?.deleted).toBe(false);
    expect(opKinds()).toEqual([
      "marks.softDelete",
      "marks.restore",
    ]);
  });

  it("delMarkForever removes the row, the local asset, and queues the remote deletion", async () => {
    memoryFs.files.add("image/pic.png");
    const mark = seedTextMark({ type: "image", url: "image/pic.png", content: "" });
    const result = await delMarkForever(mark.id);
    expect(result.rowsAffected).toBe(1);
    expect(fakeSql.marks.has(mark.id)).toBe(false);
    expect(memoryFs.files.has("image/pic.png")).toBe(false);
    expect(memoryFs.removed).toEqual(["image/pic.png"]);
    const store = memoryStore.docs.get("store.json");
    const pending = store?.get("pendingRecordAssetRemoteDeletions") as string[] | undefined;
    expect(pending?.[0] ?? "").toContain("pic.png");
    expect(mocks.removeKnowledgeSourceIndex).toHaveBeenCalledWith(`record:${mark.id}`);
  });

  it("delMarkForever on a missing row reports zero rows with no kind call", async () => {
    const result = await delMarkForever(999);
    expect(result).toEqual({ rowsAffected: 0, lastInsertId: 999 });
    expect(fakeSql.executes).toHaveLength(0);
  });

  it("bulk update, delete, and restore loop one kind call per row in order", async () => {
    const first = seedTextMark({ content: "one" });
    const second = seedTextMark({ content: "two" });
    await updateMarks([
      { ...first, content: "one-edited" },
      { ...second, content: "two-edited" },
    ]);
    await deleteMarks([first.id, second.id]);
    await restoreMarks([first.id, second.id]);
    expect(opKinds()).toEqual([
      "marks.update",
      "marks.update",
      "knowledge.updateStatus",
      "knowledge.updateStatus",
      "marks.softDelete",
      "marks.softDelete",
      "marks.restore",
      "marks.restore",
    ]);
    expect(fakeSql.marks.get(first.id)?.content).toBe("one-edited");
    expect(fakeSql.marks.get(second.id)?.deleted).toBe(false);
  }, 30000);

  it("initMarksDb creates the three asset directories", async () => {
    await initMarksDb();
    expect(memoryFs.mkdirs).toEqual(["screenshot", "image", "recordings"]);
  });
});

describe("tag sets", () => {
  it("updateRecordTags guards on the current set and primary", async () => {
    const row = fakeSql.seedMark({ tagId: 2, tagIds: [2] });
    await updateRecordTags(row.id, [2, 3]);
    const op = fakeSql.executes.find((entry) => entry.kind === "marks.updateTags");
    expect(op).toMatchObject({
      id: row.id,
      tagIds: [2, 3],
      expected: { tagIds: [2], primaryTagId: 2 },
    });
    expect(fakeSql.marks.get(row.id)?.tagIds).toEqual([2, 3]);
  });

  it("updateRecordTags filters unknown tag ids and creates new names", async () => {
    const row = fakeSql.seedMark({ tagId: 2, tagIds: [2] });
    await updateRecordTags(row.id, [2, 999], undefined, [" fresh "]);
    const op = fakeSql.executes.find((entry) => entry.kind === "marks.updateTags");
    expect(op?.tagIds).toEqual([2]);
    expect(op?.newNames).toEqual(["fresh"]);
    expect(fakeSql.marks.get(row.id)?.tagIds).toContain(4);
  });

  it("updateRecordTags rejects a stale expected set", async () => {
    const row = fakeSql.seedMark({ tagId: 2, tagIds: [2] });
    await expect(updateRecordTags(row.id, [2, 3], [3])).rejects.toThrow(
      "record_tags_changed",
    );
  });

  it("updateRecordTags throws Record not found for a missing or deleted mark", async () => {
    await expect(updateRecordTags(999, [2])).rejects.toThrow("Record not found");
    const gone = fakeSql.seedMark({ tagId: 2, deleted: true });
    await expect(updateRecordTags(gone.id, [2])).rejects.toThrow("Record not found");
  });

  it("saveMarkTagIds writes the normalized set and preserves on a missing set", async () => {
    const row = fakeSql.seedMark({ tagId: 2, tagIds: [2] });
    await saveMarkTagIds(row.id, 2, [3, 2, 3]);
    const op = fakeSql.executes.find((entry) => entry.kind === "marks.saveTagIds");
    expect(op).toMatchObject({ id: row.id, tagId: 2, tagIds: [2, 3] });
    expect(op).not.toHaveProperty("updatedAt");
    expect(fakeSql.marks.get(row.id)?.tagIds).toEqual([2, 3]);
    const before = fakeSql.executes.length;
    await saveMarkTagIds(row.id, 2, undefined, 12345);
    expect(fakeSql.executes.length).toBe(before);
  });

  it("attachMarkTagIds maps tag sets without any kind call", async () => {
    const marks: Mark[] = [
      { id: 1, tagId: 2, type: "text", url: "", deleted: 0, createdAt: 1 },
      { id: 2, tagId: 2, tagIds: [3, 2], tagUpdatedAt: 77, type: "text", url: "", deleted: 0, createdAt: 2 },
    ];
    const attached = await attachMarkTagIds(marks);
    expect(attached[0].tagIds).toEqual([2]);
    expect(attached[0].tagUpdatedAt).toBe(0);
    expect(attached[1].tagIds).toEqual([2, 3]);
    expect(attached[1].tagUpdatedAt).toBe(77);
    expect(fakeSql.ops).toHaveLength(0);
  });
});

describe("unmigrated functions still fail loudly", () => {
  it("insertMarks and deleteAllMarks reject through getDb", async () => {
    await expect(insertMarks([{ tagId: 2, type: "text" }])).rejects.toBeInstanceOf(
      PlatformCapabilityError,
    );
    await expect(deleteAllMarks()).rejects.toBeInstanceOf(PlatformCapabilityError);
  });

  it("clearTrash purges only trashed marks through marks.emptyTrash (BUG-01)", async () => {
    fakeSql.seedMark({ tagId: 2, content: "keep", deleted: false });
    fakeSql.seedMark({ tagId: 2, content: "gone-1", deleted: true });
    fakeSql.seedMark({ tagId: 2, content: "gone-2", deleted: true });
    const result = await clearTrash();
    expect(result.rowsAffected).toBe(2);
    expect(fakeSql.marks.size).toBe(1);
    const empties = fakeSql.executes.filter((op) => op.kind === "marks.emptyTrash");
    expect(empties).toHaveLength(1);
  });
});
