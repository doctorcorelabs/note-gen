// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Vitest-style flow specs for the kind-backed inbox records client
// (records-kind-client.ts) against an in-memory fake SqlAdapter. No
// test sends real HTTP and no test touches a database. The fake
// mirrors the server kind handlers closely enough to prove the
// client-side logic: the five create flows, duplicate sourceId,
// optimistic guards, trash/restore, tag moves, sequential
// stop-and-report multi-select, and the honest unavailability of
// tag delete and empty-trash. Handler semantics the fake mirrors
// include first-write-wins sourceId (affected 0), the version and
// tag-set guards with their canonical wire codes, primary-always-
// present tag sets, and tags.create returning the existing id with
// affected 0. Subtree tag counting and descendant renames are NOT
// mirrored; the specs never rely on them. Live verification against
// the real kind handlers runs after integrator wiring (V3-41).
//
// Runs in the Vitest leg of `pnpm test:unit` and is listed in
// VITEST_SPECS in scripts/run-adapter-tests.mjs.

import { describe, expect, it } from "vitest";

import type {
  DbReadOperation,
  DbWriteOperation,
  SqlMarkRow,
  SqlReadOpKind,
  SqlReadOperationByKind,
  SqlReadRow,
  SqlTagRow,
  SqlWriteOpKind,
  SqlWriteOperationByKind,
  SqlWriteResultFor,
} from "../platform/sql/ops-catalog";
import { ApiError } from "./errors";
import {
  buildFileCreateBody,
  buildImageCreateBody,
  buildLinkCreateBody,
  buildTextCreateBody,
  buildTodoCreateBody,
  makeSourceId,
} from "./record-inputs";
import {
  moveRecordsTagsSequential,
  restoreRecordsSequential,
  softDeleteRecordsSequential,
  type UploadedAsset,
} from "./records-client";
import {
  KindRecordsApi,
  translateKindError,
  type KindSqlAdapter,
} from "./records-kind-client";

/** Structural stand-in for a SqlAdapterError from the real adapter. */
function kindFailure(
  wireCode: string,
  status: number,
  details: Record<string, unknown> = {},
): Error {
  const error = new Error(`SqlAdapter request failed (${wireCode})`);
  error.name = "SqlAdapterError";
  (error as Error & Record<string, unknown>).code = "CONFLICT";
  (error as Error & Record<string, unknown>).retryable = false;
  (error as Error & Record<string, unknown>).details = {
    wireCode,
    status,
    requestId: "req-fake",
    ...details,
  };
  return error;
}

interface FakeTagState {
  id: number;
  name: string;
  isLocked: boolean;
  isPin: boolean;
  sortOrder: number;
}

class FakeKindSql implements KindSqlAdapter {
  private tags = new Map<number, FakeTagState>();
  private marks = new Map<number, SqlMarkRow>();
  private nextTagId = 3;
  private nextMarkId = 100;
  private clock = 1_700_000_000_000;

  constructor(withLockedDefault = true) {
    if (withLockedDefault) {
      this.tags.set(1, {
        id: 1,
        name: "Idea",
        isLocked: true,
        isPin: true,
        sortOrder: 0,
      });
    }
    this.tags.set(2, {
      id: 2,
      name: "Research",
      isLocked: false,
      isPin: false,
      sortOrder: 1,
    });
  }

  private tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  private tagRow(state: FakeTagState, withTotal: boolean): SqlTagRow {
    const row: SqlTagRow = {
      id: state.id,
      name: state.name,
      isLocked: state.isLocked,
      isPin: state.isPin,
      sortOrder: state.sortOrder,
    };
    if (withTotal) {
      row.total = [...this.marks.values()].filter(
        (mark) => !mark.deleted && mark.tagIds.includes(state.id),
      ).length;
    }
    return row;
  }

  private parseCursor(cursor: string): { createdAt: number; id: number } {
    const match = /^(\d+):(\d+)$/.exec(cursor);
    if (match === null) {
      throw kindFailure("invalid_cursor", 400, { cursor: "malformed" });
    }
    return { createdAt: Number(match[1]), id: Number(match[2]) };
  }

  private listMarks(
    op: Extract<DbReadOperation, { kind: "marks.list" | "marks.listByTag" }>,
  ): SqlMarkRow[] {
    const deleted = op.deleted ?? "active";
    const limit = op.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1) {
      throw kindFailure("invalid_limit", 400);
    }
    const capped = Math.min(limit, 200);
    let rows = [...this.marks.values()];
    if (deleted === "active") rows = rows.filter((row) => !row.deleted);
    if (deleted === "deleted") rows = rows.filter((row) => row.deleted);
    if (op.kind === "marks.listByTag") {
      rows = rows.filter((row) => row.tagIds.includes(op.tagId));
    }
    rows.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    if (op.cursor !== undefined) {
      const position = this.parseCursor(op.cursor);
      rows = rows.filter(
        (row) =>
          row.createdAt < position.createdAt ||
          (row.createdAt === position.createdAt && row.id < position.id),
      );
    }
    return rows.slice(0, capped).map((row) => ({ ...row, tagIds: [...row.tagIds] }));
  }

  private doQuery(op: DbReadOperation): unknown[] {
    switch (op.kind) {
      case "marks.list":
      case "marks.listByTag":
        return this.listMarks(op);
      case "marks.get": {
        const row = this.marks.get(op.id);
        return row === undefined ? [] : [{ ...row, tagIds: [...row.tagIds] }];
      }
      case "tags.list":
        return [...this.tags.values()]
          .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
          .map((state) => this.tagRow(state, true));
      case "tags.get": {
        const state = this.tags.get(op.id);
        return state === undefined ? [] : [this.tagRow(state, false)];
      }
      default:
        throw new Error(`FakeKindSql does not implement read kind ${op.kind}`);
    }
  }

  private doExecute(op: DbWriteOperation): {
    affected: number;
    id?: number;
    version?: number;
  } {
    switch (op.kind) {
      case "marks.create": {
        const tagIds = op.tagIds ?? [op.mark.tagId];
        for (const tagId of [op.mark.tagId, ...tagIds]) {
          if (!this.tags.has(tagId)) {
            throw kindFailure("tag_not_found", 400, { tagId });
          }
        }
        if (op.mark.sourceId !== undefined) {
          const existing = [...this.marks.values()].find(
            (row) => row.sourceId === op.mark.sourceId,
          );
          if (existing !== undefined) {
            return { affected: 0, id: existing.id, version: existing.version };
          }
        }
        const now = this.tick();
        const id = this.nextMarkId;
        this.nextMarkId += 1;
        const effective = [...new Set([op.mark.tagId, ...tagIds])].sort(
          (a, b) => a - b,
        );
        this.marks.set(id, {
          id,
          tagId: op.mark.tagId,
          tagIds: effective,
          tagUpdatedAt: 0,
          type: op.mark.type,
          ...(op.mark.content === undefined
            ? {}
            : { content: op.mark.content }),
          ...(op.mark.desc === undefined ? {} : { desc: op.mark.desc }),
          url: op.mark.url,
          deleted: false,
          createdAt: now,
          updatedAt: now,
          version: 1,
          sourceId: op.mark.sourceId ?? null,
        });
        return { affected: 1, id, version: 1 };
      }
      case "marks.update": {
        const row = this.marks.get(op.id);
        if (row === undefined) throw kindFailure("not_found", 404);
        if (
          op.expected !== undefined &&
          op.expected.version !== row.version
        ) {
          throw kindFailure("revision_conflict", 409, {
            current: { version: row.version, updatedAt: row.updatedAt },
          });
        }
        if (op.patch.content !== undefined) row.content = op.patch.content ?? undefined;
        if (op.patch.desc !== undefined) row.desc = op.patch.desc ?? undefined;
        if (op.patch.url !== undefined) row.url = op.patch.url;
        row.version += 1;
        row.updatedAt = this.tick();
        return { affected: 1, id: row.id, version: row.version };
      }
      case "marks.softDelete": {
        const row = this.marks.get(op.id);
        if (row === undefined) throw kindFailure("not_found", 404);
        if (row.deleted) return { affected: 0, id: row.id, version: row.version };
        row.deleted = true;
        row.version += 1;
        row.updatedAt = this.tick();
        return { affected: 1, id: row.id, version: row.version };
      }
      case "marks.restore": {
        const row = this.marks.get(op.id);
        if (row === undefined) throw kindFailure("not_found", 404);
        if (!row.deleted) return { affected: 0, id: row.id, version: row.version };
        row.deleted = false;
        row.version += 1;
        row.updatedAt = this.tick();
        return { affected: 1, id: row.id, version: row.version };
      }
      case "marks.deletePermanent": {
        if (!this.marks.has(op.id)) throw kindFailure("not_found", 404);
        this.marks.delete(op.id);
        return { affected: 1, id: op.id };
      }
      case "marks.updateTags": {
        const row = this.marks.get(op.id);
        if (row === undefined || row.deleted) {
          throw kindFailure("not_found", 404);
        }
        if (op.expected !== undefined) {
          const expectedSet = [...op.expected.tagIds].sort((a, b) => a - b);
          const currentSet = [...row.tagIds].sort((a, b) => a - b);
          const setsEqual =
            expectedSet.length === currentSet.length &&
            expectedSet.every((id, index) => id === currentSet[index]);
          if (!setsEqual || op.expected.primaryTagId !== row.tagId) {
            throw kindFailure("record_tags_changed", 409, {
              currentTagIds: [...row.tagIds],
              version: row.version,
            });
          }
        }
        const valid = op.tagIds.filter((tagId) => this.tags.has(tagId));
        if (valid.length === 0) {
          throw kindFailure("validation_failed", 400, {
            fields: [{ field: "tagIds", issue: "no valid tag" }],
          });
        }
        row.tagIds = [...new Set([row.tagId, ...valid])].sort((a, b) => a - b);
        row.tagUpdatedAt = this.tick();
        row.version += 1;
        row.updatedAt = row.tagUpdatedAt;
        return { affected: 1, id: row.id, version: row.version };
      }
      case "tags.create": {
        const name = op.name.trim();
        if (name === "") {
          throw kindFailure("validation_failed", 400, {
            fields: [{ field: "name", issue: "must not be empty" }],
          });
        }
        const existing = [...this.tags.values()].find(
          (tag) => tag.name === name,
        );
        if (existing !== undefined) {
          return { affected: 0, id: existing.id };
        }
        const id = this.nextTagId;
        this.nextTagId += 1;
        this.tags.set(id, {
          id,
          name,
          isLocked: false,
          isPin: false,
          sortOrder: id,
        });
        return { affected: 1, id };
      }
      case "tags.rename": {
        const state = this.tags.get(op.id);
        if (state === undefined) throw kindFailure("not_found", 404);
        const normalized = op.name.trim();
        if (state.isLocked && normalized !== state.name) {
          throw kindFailure("tag_locked", 409);
        }
        const collision = [...this.tags.values()].find(
          (tag) => tag.id !== op.id && tag.name === normalized,
        );
        if (collision !== undefined && normalized !== state.name) {
          throw kindFailure("tag_name_taken", 409);
        }
        state.name = normalized;
        if (op.isPin !== undefined) state.isPin = op.isPin;
        if (op.sortOrder !== undefined) state.sortOrder = op.sortOrder;
        return { affected: 1, id: state.id };
      }
      default:
        throw new Error(`FakeKindSql does not implement write kind ${op.kind}`);
    }
  }

  async query<K extends SqlReadOpKind>(
    op: SqlReadOperationByKind<K>,
  ): Promise<SqlReadRow<K>[]> {
    return this.doQuery(op as DbReadOperation) as SqlReadRow<K>[];
  }

  async queryOne<K extends SqlReadOpKind>(
    op: SqlReadOperationByKind<K>,
  ): Promise<SqlReadRow<K> | null> {
    const rows = await this.query(op);
    return rows.length === 0 ? null : rows[0];
  }

  async execute<K extends SqlWriteOpKind>(
    op: SqlWriteOperationByKind<K>,
  ): Promise<SqlWriteResultFor<K>> {
    return this.doExecute(op as DbWriteOperation) as SqlWriteResultFor<K>;
  }
}

function makeApi(withLockedDefault = true): {
  api: KindRecordsApi;
  uploads: Array<{ file: Blob; fileName: string | undefined }>;
} {
  const uploads: Array<{ file: Blob; fileName: string | undefined }> = [];
  const assets = {
    uploadAsset: async (
      file: Blob,
      fileName?: string,
    ): Promise<UploadedAsset> => {
      uploads.push({ file, fileName });
      return {
        assetKey: `asset-${uploads.length}`,
        fileName: fileName ?? "upload",
        mimeType: "image/png",
        sizeBytes: file.size,
        contentHash: "sha256:fake",
        createdAt: 1_700_000_000_000,
      };
    },
  };
  const api = new KindRecordsApi({
    sql: new FakeKindSql(withLockedDefault),
    assets,
  });
  return { api, uploads };
}

describe("KindRecordsApi behavior gate: five records, two tags", () => {
  it("creates five records with two tags and opens each from the inbox list", async () => {
    const { api } = makeApi();
    const first = await api.createTag("Alpha");
    const second = await api.createTag("Beta");
    const tags = [first.id, second.id];
    const uploaded = await api.uploadAsset(
      new Blob(["fake-image"], { type: "image/png" }),
      "photo.png",
    );
    const created = [
      await api.createRecord(
        buildTextCreateBody("First note", { tagIds: tags }, makeSourceId("paste", "one")),
      ),
      await api.createRecord(
        buildLinkCreateBody("example.com/article", { tagIds: tags }, makeSourceId("paste", "two")),
      ),
      await api.createRecord(
        buildImageCreateBody(uploaded.assetKey, "A photo", { tagIds: tags }, makeSourceId("upload", "three")),
      ),
      await api.createRecord(
        buildFileCreateBody(uploaded.assetKey, "notes.pdf", undefined, { tagIds: tags }, makeSourceId("upload", "four")),
      ),
      await api.createRecord(
        buildTodoCreateBody({ title: "Buy milk" }, { tagIds: tags }, makeSourceId("paste", "five")),
      ),
    ];
    expect(created).toHaveLength(5);
    for (const record of created) {
      expect(record.tagIds).toEqual(tags);
    }
    const page = await api.listRecords({});
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    for (const listed of page.items) {
      const opened = await api.getRecord(listed.id);
      expect(opened.id).toBe(listed.id);
      expect(opened.tagIds).toEqual(tags);
    }
    const byTag = await api.listRecords({ tagId: first.id });
    expect(byTag.items).toHaveLength(5);
  });
});

describe("KindRecordsApi list", () => {
  it("pages in created-descending order with a derived cursor", async () => {
    const { api } = makeApi();
    for (const text of ["one", "two", "three"]) {
      await api.createRecord(buildTextCreateBody(text, { tagIds: [1] }));
    }
    const first = await api.listRecords({ limit: 2 });
    expect(first.items.map((item) => item.content)).toEqual(["three", "two"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = await api.listRecords({ limit: 2 }, first.nextCursor ?? undefined);
    expect(second.items.map((item) => item.content)).toEqual(["one"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    const all = await api.listAllRecords({});
    expect(all.map((item) => item.content)).toEqual(["three", "two", "one"]);
  });

  it("filters trash and all through the deleted filter", async () => {
    const { api } = makeApi();
    const kept = await api.createRecord(buildTextCreateBody("kept", { tagIds: [1] }));
    const trashed = await api.createRecord(buildTextCreateBody("trashed", { tagIds: [1] }));
    await api.softDeleteRecord(trashed.id);
    expect((await api.listRecords({})).items.map((item) => item.id)).toEqual([kept.id]);
    expect((await api.listRecords({ status: "trash" })).items.map((item) => item.id)).toEqual([trashed.id]);
    expect((await api.listRecords({ status: "all" })).items).toHaveLength(2);
  });

  it("treats a single-element tagIds filter as one tag", async () => {
    const { api } = makeApi();
    await api.createRecord(buildTextCreateBody("a", { tagIds: [1] }));
    await api.createRecord(buildTextCreateBody("b", { tagIds: [2] }));
    const page = await api.listRecords({ tagIds: [2] });
    expect(page.items.map((item) => item.content)).toEqual(["b"]);
  });

  it("translates a malformed cursor to invalid_cursor", async () => {
    const { api } = makeApi();
    await expect(api.listRecords({}, "not-a-cursor")).rejects.toMatchObject({
      wireCode: "invalid_cursor",
      status: 400,
    });
  });

  it("rejects filters the kinds cannot express", async () => {
    const { api } = makeApi();
    await expect(api.listRecords({ q: "hello" })).rejects.toThrow(
      /not available over the kind path/,
    );
    await expect(api.listRecords({ types: ["text"] })).rejects.toThrow(
      /not available over the kind path/,
    );
    await expect(api.listRecords({ createdAfter: 1 })).rejects.toThrow(
      /not available over the kind path/,
    );
    await expect(api.listRecords({ sort: "updated_desc" })).rejects.toThrow(
      /not available over the kind path/,
    );
    await expect(
      api.listRecords({ tagRules: { include: ["Research"], exclude: [], match: "all" } }),
    ).rejects.toThrow(/not available over the kind path/);
    await expect(api.listRecords({ tagIds: [1, 2] })).rejects.toThrow(
      /not available over the kind path/,
    );
  });

  it("rejects invalid filter combinations", async () => {
    const { api } = makeApi();
    await expect(api.listRecords({ tagId: 1, tagIds: [2] })).rejects.toThrow(
      "tagId and tagIds must not be combined.",
    );
    await expect(
      api.listRecords({ status: "trash", tagId: 1 }),
    ).rejects.toThrow("Trash list must not be combined with other filters.");
  });
});

describe("KindRecordsApi create", () => {
  it("answers duplicate for a repeated sourceId without a second row", async () => {
    const { api } = makeApi();
    const sourceId = makeSourceId("paste", "same-action");
    const first = await api.createRecord(
      buildTextCreateBody("Hello", { tagIds: [1] }, sourceId),
    );
    expect(first.duplicate).toBeUndefined();
    const second = await api.createRecord(
      buildTextCreateBody("Hello", { tagIds: [1] }, sourceId),
    );
    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);
    expect((await api.listAllRecords({})).length).toBe(1);
  });

  it("uses the locked tag when no tag is selected", async () => {
    const { api } = makeApi();
    const record = await api.createRecord(buildTextCreateBody("No tag picked", {}));
    expect(record.tagId).toBe(1);
    expect(record.tagIds).toEqual([1]);
  });

  it("fails honestly when no tag is selected and no locked tag exists", async () => {
    const { api } = makeApi(false);
    await expect(
      api.createRecord(buildTextCreateBody("No tag picked", {})),
    ).rejects.toThrow(/no locked default tag/);
  });

  it("rejects tag combinations and per-type url violations", async () => {
    const { api } = makeApi();
    await expect(
      api.createRecord({ type: "text", content: "x", desc: "x", tagIds: [] }),
    ).rejects.toThrow("tagIds must not be empty.");
    await expect(
      api.createRecord({
        type: "text",
        content: "x",
        desc: "x",
        tagId: 1,
        tagIds: [2],
      }),
    ).rejects.toThrow("tagId must be a member of tagIds.");
    expect(() =>
      buildLinkCreateBody("not a url [[", { tagIds: [1] }),
    ).toThrow("Link URL is not a valid URL.");
    await expect(
      api.createRecord({
        type: "link",
        content: "",
        desc: "ftp link",
        url: "ftp://example.com/file",
        tagIds: [1],
      }),
    ).rejects.toThrow(/valid http or https/);
    await expect(
      api.createRecord({
        type: "text",
        content: "x",
        desc: "x",
        url: "https://example.com",
        tagIds: [1],
      }),
    ).rejects.toThrow(/must not carry a URL/);
    await expect(
      api.createRecord({
        type: "image",
        content: "",
        desc: "",
        tagIds: [1],
      }),
    ).rejects.toThrow(/asset key/);
  });

  it("enforces the todo JSON shape and desc-equals-title rule", async () => {
    const { api } = makeApi();
    await expect(
      api.createRecord({
        type: "todo",
        content: "not json",
        desc: "Title",
        tagIds: [1],
      }),
    ).rejects.toThrow(/valid JSON/);
    await expect(
      api.createRecord({
        type: "todo",
        content: JSON.stringify({ title: "Title", description: "", priority: "medium", completed: false }),
        desc: "Different",
        tagIds: [1],
      }),
    ).rejects.toThrow(/desc must equal/);
    const derived = await api.createRecord({
      type: "todo",
      content: JSON.stringify({ title: "Derived", description: "", priority: "low", completed: false }),
      tagIds: [1],
    });
    expect(derived.desc).toBe("Derived");
  });

  it("surfaces tag_not_found for an unknown tag", async () => {
    const { api } = makeApi();
    await expect(
      api.createRecord(buildTextCreateBody("x", { tagIds: [999] })),
    ).rejects.toMatchObject({ wireCode: "tag_not_found", status: 400 });
  });

  it("maps kind rows with the documented unknown fields", async () => {
    const { api } = makeApi();
    const record = await api.createRecord(buildTextCreateBody("x", { tagIds: [1] }));
    expect(record.fileName).toBeNull();
    expect(record.tagVersion).toBe(0);
    expect(record.deletedAt).toBeNull();
    expect(record.enrichmentStatus).toBe("none");
    expect(record.thumbnailUrl).toBeNull();
  });
});

describe("KindRecordsApi guards", () => {
  it("guards edits with expectedVersion and honors force", async () => {
    const { api } = makeApi();
    const record = await api.createRecord(buildTextCreateBody("v1", { tagIds: [1] }));
    const updated = await api.updateRecord(record.id, {
      content: "v2",
      desc: "v2",
      expectedVersion: record.version,
    });
    expect(updated.version).toBe(record.version + 1);
    await expect(
      api.updateRecord(record.id, {
        content: "stale",
        desc: "stale",
        expectedVersion: record.version,
      }),
    ).rejects.toMatchObject({ wireCode: "revision_conflict", status: 409 });
    const forced = await api.updateRecord(record.id, {
      content: "forced",
      desc: "forced",
      expectedVersion: record.version,
      force: true,
    });
    expect(forced.content).toBe("forced");
  });

  it("guards tag sets and converts a version-only guard", async () => {
    const { api } = makeApi();
    const record = await api.createRecord(buildTextCreateBody("x", { tagIds: [1] }));
    const moved = await api.updateRecordTags(record.id, {
      tagIds: [1, 2],
      expectedTagIds: [1],
    });
    expect(moved.tagIds).toEqual([1, 2]);
    await expect(
      api.updateRecordTags(record.id, {
        tagIds: [1],
        expectedTagIds: [1],
      }),
    ).rejects.toMatchObject({ wireCode: "record_tags_changed", status: 409 });
    const viaVersion = await api.updateRecordTags(record.id, {
      tagIds: [1],
      expectedTagVersion: 99,
    });
    expect(viaVersion.tagIds).toEqual([1]);
    await expect(
      api.updateRecordTags(record.id, { tagIds: [2] }),
    ).rejects.toThrow(/expectedTagIds/);
  });

  it("answers not_found for missing records", async () => {
    const { api } = makeApi();
    await expect(api.getRecord(999)).rejects.toMatchObject({
      wireCode: "not_found",
      status: 404,
    });
    await expect(
      api.updateRecord(999, { content: "x", expectedVersion: 1 }),
    ).rejects.toMatchObject({ wireCode: "not_found" });
  });
});

describe("KindRecordsApi trash, restore, and sequential multi-select", () => {
  it("soft deletes and restores from the inbox view", async () => {
    const { api } = makeApi();
    const record = await api.createRecord(buildTextCreateBody("x", { tagIds: [1, 2] }));
    const trashed = await api.softDeleteRecord(record.id);
    expect(trashed.deleted).toBe(true);
    expect(trashed.tagIds).toEqual([1, 2]);
    const restored = await api.restoreRecord(record.id);
    expect(restored.deleted).toBe(false);
    expect(restored.tagIds).toEqual([1, 2]);
    const permanent = await api.deleteRecordPermanent(record.id);
    expect(permanent).toEqual({ id: record.id, deleted: true, permanent: true });
    await expect(api.getRecord(record.id)).rejects.toMatchObject({
      wireCode: "not_found",
    });
  });

  it("treats a missing record as success in sequential delete and continues", async () => {
    const { api } = makeApi();
    const first = await api.createRecord(buildTextCreateBody("a", { tagIds: [1] }));
    const second = await api.createRecord(buildTextCreateBody("b", { tagIds: [1] }));
    const result = await softDeleteRecordsSequential(api, [first.id, 999, second.id]);
    expect(result).toEqual({
      succeeded: [first.id, 999, second.id],
      failed: [],
      stoppedEarly: false,
    });
    const restored = await restoreRecordsSequential(api, [first.id, second.id]);
    expect(restored.stoppedEarly).toBe(false);
  });

  it("stops sequential tag moves at the first conflict and reports", async () => {
    const { api } = makeApi();
    const first = await api.createRecord(buildTextCreateBody("a", { tagIds: [1] }));
    const second = await api.createRecord(buildTextCreateBody("b", { tagIds: [1] }));
    await api.updateRecordTags(second.id, { tagIds: [1, 2], expectedTagIds: [1] });
    const result = await moveRecordsTagsSequential(api, [
      { id: first.id, tagIds: [1, 2], expectedTagIds: [1] },
      { id: second.id, tagIds: [1], expectedTagIds: [1] },
    ]);
    expect(result.succeeded).toEqual([first.id]);
    expect(result.stoppedEarly).toBe(true);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(second.id);
    expect(result.failed[0].code).toBe("record_tags_changed");
  });
});

describe("KindRecordsApi tags", () => {
  it("lists tags pinned first, then by name, with real counts", async () => {
    const { api } = makeApi();
    await api.createTag("Zebra");
    await api.createTag("Apple");
    await api.createRecord(buildTextCreateBody("x", { tagIds: [1] }));
    const { tags } = await api.listTags();
    expect(tags.map((tag) => tag.name)).toEqual([
      "Idea",
      "Apple",
      "Research",
      "Zebra",
    ]);
    expect(tags.find((tag) => tag.name === "Idea")?.recordCount).toBe(1);
  });

  it("converts a duplicate tag create to tag_name_taken", async () => {
    const { api } = makeApi();
    await expect(api.createTag("Research")).rejects.toMatchObject({
      wireCode: "tag_name_taken",
      status: 409,
    });
  });

  it("renames tags and enforces the locked-tag contract rule", async () => {
    const { api } = makeApi();
    const renamed = await api.updateTag(2, { name: "Studies" });
    expect(renamed.name).toBe("Studies");
    await expect(api.updateTag(1, { name: "Other" })).rejects.toMatchObject({
      wireCode: "tag_locked",
      status: 409,
    });
    await expect(api.updateTag(1, { pinned: false })).rejects.toMatchObject({
      wireCode: "tag_locked",
      status: 409,
    });
    const noop = await api.updateTag(1, { pinned: true });
    expect(noop.name).toBe("Idea");
    await expect(api.updateTag(2, {})).rejects.toThrow(/at least one/);
  });

  it("answers not_found for a missing tag", async () => {
    const { api } = makeApi();
    await expect(api.getTag(999)).rejects.toMatchObject({
      wireCode: "not_found",
      status: 404,
    });
  });

  it("reports tag delete and empty-trash as honestly unavailable", async () => {
    const { api } = makeApi();
    await expect(api.deleteTag(2)).rejects.toMatchObject({
      wireCode: "capability_unavailable",
      status: 410,
    });
    await expect(api.emptyTrash()).rejects.toMatchObject({
      wireCode: "capability_unavailable",
      status: 410,
    });
  });

  it("delegates asset upload to the injected uploader", async () => {
    const { api, uploads } = makeApi();
    const file = new Blob(["x"], { type: "image/png" });
    const uploaded = await api.uploadAsset(file, "a.png");
    expect(uploaded.assetKey).toBe("asset-1");
    expect(uploads).toEqual([{ file, fileName: "a.png" }]);
  });
});

describe("translateKindError", () => {
  it("preserves the wire code, status, and request id", () => {
    const translated = translateKindError(
      kindFailure("revision_conflict", 409, { current: { version: 3 } }),
    );
    expect(translated).toBeInstanceOf(ApiError);
    const error = translated as ApiError;
    expect(error.wireCode).toBe("revision_conflict");
    expect(error.status).toBe(409);
    expect(error.requestId).toBe("req-fake");
    expect(error.localCode).toBe("CONFLICT");
  });

  it("passes ApiError through and rethrows plain errors unchanged", () => {
    const apiError = new ApiError({
      localCode: "CONFLICT",
      wireCode: "tag_in_use",
      status: 409,
    });
    expect(translateKindError(apiError)).toBe(apiError);
    const plain = new Error("local validation");
    expect(translateKindError(plain)).toBe(plain);
  });
});
