// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Vitest-style flow specs for the inbox records client
// (records-client.ts) against an in-memory fake transport. No test
// sends real HTTP. The fake answers the canonical envelope and the
// canonical error codes so the specs prove the client-side flow
// logic: the five create flows, duplicate sourceId handling,
// optimistic guards, trash/restore, tag moves, and sequential
// stop-and-report multi-select. Live verification against the real
// REST routes (V3-25) runs in the V3-41 contract/E2E leg.
//
// Runs in the Vitest leg of `pnpm test:unit` and is listed in
// VITEST_SPECS in scripts/run-adapter-tests.mjs.

import { describe, expect, it } from "vitest";

import { ApiClient } from "./api-client";
import { ApiError } from "./errors";
import {
  RecordsApi,
  deleteRecordsPermanentSequential,
  moveRecordsTagsSequential,
  restoreRecordsSequential,
  softDeleteRecordsSequential,
  type ApiRecord,
  type ApiTag,
} from "./records-client";
import {
  buildFileCreateBody,
  buildImageCreateBody,
  buildLinkCreateBody,
  buildTextCreateBody,
  buildTodoCreateBody,
  makeSourceId,
} from "./record-inputs";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function fakeResponse(status: number, body: string): Response {
  return {
    status,
    headers: { get: () => null },
    text: async () => body,
    arrayBuffer: async () =>
      new TextEncoder().encode(body).buffer as ArrayBuffer,
  } as unknown as Response;
}

function ok(data: unknown, status = 200): Response {
  return fakeResponse(status, JSON.stringify({ ok: true, data }));
}

function fail(
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): Response {
  return fakeResponse(
    status,
    JSON.stringify({
      ok: false,
      error: {
        code,
        message: code,
        requestId: "req-test",
        retryable: false,
        details,
      },
    }),
  );
}

type Row = Omit<ApiRecord, "duplicate">;

function makeRecord(partial: Partial<Row> & { id: number }): Row {
  return {
    type: "text",
    content: "",
    desc: "",
    url: "",
    fileName: null,
    tagId: 1,
    tagIds: [1],
    tagVersion: 1,
    version: 1,
    deleted: false,
    deletedAt: null,
    sourceId: null,
    enrichmentStatus: "none",
    thumbnailUrl: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  };
}

function makeTag(partial: Partial<ApiTag> & { id: number }): ApiTag {
  return {
    name: `tag-${partial.id}`,
    locked: false,
    pinned: false,
    recordCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  };
}

/**
 * Minimal in-memory stand-in for the V3-25 REST routes. It
 * implements only the semantics these specs assert: sourceId
 * first-write-wins, version/tag guards, soft delete/restore,
 * permanent delete, empty trash, tag CRUD, and cursor paging over
 * the active list. Anything else answers 404 not_found.
 */
function makeFakeServer() {
  let nextId = 1;
  let nextTagId = 10;
  const records: Row[] = [];
  const tags: ApiTag[] = [makeTag({ id: 1, name: "Idea", locked: true, pinned: true })];
  const calls: CapturedCall[] = [];

  const responder = async (call: CapturedCall): Promise<Response> => {
    calls.push(call);
    const url = new URL(call.url, "http://test.local");
    const method = (call.init.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body =
      typeof call.init.body === "string"
        ? (JSON.parse(call.init.body) as Record<string, unknown>)
        : {};
    const findRecord = (id: number) => records.find((r) => r.id === id);

    if (path === "/api/assets" && method === "POST") {
      const form = call.init.body as FormData;
      const file = form.get("file");
      const fileName =
        (form.get("fileName") as string | null) ?? "upload.bin";
      if (!(file instanceof Blob)) {
        return fail(400, "invalid_upload");
      }
      return ok(
        {
          assetKey: `assets/k-${fileName}`,
          fileName,
          mimeType: "application/octet-stream",
          sizeBytes: file.size,
          contentHash: "sha256:test",
          createdAt: 1000,
        },
        201,
      );
    }

    if (path === "/api/marks" && method === "POST") {
      const sourceId = body.sourceId as string | undefined;
      if (sourceId) {
        const existing = records.find((r) => r.sourceId === sourceId);
        if (existing) return ok({ ...existing, duplicate: true });
      }
      const tagIds = (body.tagIds as number[] | undefined) ?? [1];
      const row = makeRecord({
        id: nextId,
        type: body.type as Row["type"],
        content: (body.content as string) ?? "",
        desc: (body.desc as string) ?? "",
        url: (body.url as string) ?? "",
        tagId: tagIds[0],
        tagIds,
        sourceId: sourceId ?? `server-uuid-${nextId}`,
        createdAt: 1000 + nextId,
        updatedAt: 1000 + nextId,
      });
      nextId += 1;
      records.push(row);
      return ok(row, 201);
    }

    if (path === "/api/marks" && method === "GET") {
      const status = url.searchParams.get("status") ?? "active";
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const cursor = url.searchParams.get("cursor");
      const offset = cursor ? Number(cursor) : 0;
      const visible = records.filter((r) =>
        status === "trash"
          ? r.deleted
          : status === "all"
            ? true
            : !r.deleted,
      );
      const page = visible.slice(offset, offset + limit);
      const next = offset + page.length;
      return ok({
        items: page,
        nextCursor: next < visible.length ? String(next) : null,
        hasMore: next < visible.length,
      });
    }

    if (path === "/api/marks/trash" && method === "DELETE") {
      if (body.confirm !== true) return fail(400, "confirm_required");
      const purged = records.filter((r) => r.deleted).length;
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i].deleted) records.splice(i, 1);
      }
      return ok({ purged, purgedAt: 2000 });
    }

    const markMatch = /^\/api\/marks\/(\d+)(\/tags|\/restore|\/permanent)?$/.exec(path);
    if (markMatch) {
      const id = Number(markMatch[1]);
      const suffix = markMatch[2] ?? "";
      const row = findRecord(id);
      if (!row) return fail(404, "not_found");
      if (method === "GET" && suffix === "") return ok(row);
      if (method === "PATCH" && suffix === "") {
        const expected = body.expectedVersion as number | undefined;
        if (
          expected !== undefined &&
          expected !== row.version &&
          body.force !== true
        ) {
          return fail(409, "revision_conflict", {
            current: { version: row.version, updatedAt: row.updatedAt },
          });
        }
        if (typeof body.content === "string") row.content = body.content;
        if (typeof body.desc === "string") row.desc = body.desc;
        if (typeof body.url === "string") row.url = body.url;
        row.version += 1;
        row.updatedAt += 1;
        return ok(row);
      }
      if (method === "PUT" && suffix === "/tags") {
        const tagIds = body.tagIds as number[];
        const expected = body.expectedTagIds as number[] | undefined;
        if (expected === undefined && body.force !== true) {
          return fail(400, "validation_failed", {
            fields: [{ field: "expectedTagIds", issue: "required" }],
          });
        }
        const sameSet =
          expected !== undefined &&
          expected.length === row.tagIds.length &&
          expected.every((t) => row.tagIds.includes(t));
        if (!sameSet && body.force !== true) {
          return fail(409, "record_tags_changed", {
            currentTagIds: row.tagIds,
          });
        }
        row.tagIds = tagIds;
        row.tagId = tagIds[0];
        row.tagVersion += 1;
        row.version += 1;
        return ok(row);
      }
      if (method === "DELETE" && suffix === "") {
        if (!row.deleted) {
          row.deleted = true;
          row.deletedAt = 2000;
          row.version += 1;
        }
        return ok(row);
      }
      if (method === "POST" && suffix === "/restore") {
        if (row.deleted) {
          row.deleted = false;
          row.deletedAt = null;
          row.version += 1;
        }
        return ok(row);
      }
      if (method === "DELETE" && suffix === "/permanent") {
        records.splice(records.indexOf(row), 1);
        return ok({ id, deleted: true, permanent: true });
      }
    }

    if (path === "/api/tags" && method === "GET") return ok({ tags });
    if (path === "/api/tags" && method === "POST") {
      const name = (body.name as string).trim();
      if (tags.some((t) => t.name === name)) {
        return fail(409, "tag_name_taken");
      }
      const tag = makeTag({ id: nextTagId, name });
      nextTagId += 1;
      tags.push(tag);
      return ok(tag, 201);
    }
    const tagMatch = /^\/api\/tags\/(\d+)$/.exec(path);
    if (tagMatch) {
      const id = Number(tagMatch[1]);
      const tag = tags.find((t) => t.id === id);
      if (!tag) return fail(404, "not_found");
      if (method === "GET") return ok(tag);
      if (method === "PATCH") {
        if (typeof body.name === "string") {
          if (tag.locked) return fail(409, "tag_locked");
          tag.name = body.name;
        }
        if (typeof body.pinned === "boolean") {
          if (tag.locked && body.pinned !== tag.pinned) {
            return fail(409, "tag_locked");
          }
          tag.pinned = body.pinned;
        }
        return ok(tag);
      }
      if (method === "DELETE") {
        if (tag.locked) return fail(409, "tag_locked");
        const inUse = records.some((r) => r.tagIds.includes(id));
        const reassignTo = url.searchParams.get("reassignTo");
        if (inUse && reassignTo === null) {
          return fail(409, "tag_in_use", { recordCount: 1 });
        }
        tags.splice(tags.indexOf(tag), 1);
        return ok({
          id,
          deleted: true,
          reassignedTo: reassignTo === null ? null : Number(reassignTo),
        });
      }
    }
    return fail(404, "not_found");
  };

  const fetchFn = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    return responder({ url: String(input), init: init ?? {} });
  }) as typeof fetch;

  return { fetchFn, calls, records, tags };
}

function makeApi() {
  const server = makeFakeServer();
  const api = new RecordsApi({
    client: new ApiClient({ fetchFn: server.fetchFn }),
  });
  return { api, server };
}

async function expectWireError(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.wireCode).toBe(code);
    expect(apiError.status).toBe(status);
    return apiError;
  }
  throw new Error("expected the promise to reject");
}

describe("five create flows", () => {
  it("creates five records, one per MVP type, and opens each from the inbox list", async () => {
    const { api } = makeApi();
    const created = [
      await api.createRecord(
        buildTextCreateBody("hello inbox", {}, makeSourceId("paste", "hello inbox")),
      ),
      await api.createRecord(
        buildLinkCreateBody("example.com/article", {}, makeSourceId("paste", "example.com/article")),
      ),
      await api.createRecord(
        buildImageCreateBody("assets/k-photo", "a photo", {}, makeSourceId("upload", "photo")),
      ),
      await api.createRecord(
        buildFileCreateBody("assets/k-doc", "doc.pdf", undefined, {}, makeSourceId("upload", "doc")),
      ),
      await api.createRecord(
        buildTodoCreateBody({ title: "Ship it", priority: "high" }, {}, makeSourceId("paste", "Ship it")),
      ),
    ];
    expect(created.map((r) => r.type)).toEqual([
      "text",
      "link",
      "image",
      "file",
      "todo",
    ]);
    expect(created.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);

    const page = await api.listRecords({});
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(false);
    for (const item of page.items) {
      const opened = await api.getRecord(item.id);
      expect(opened.id).toBe(item.id);
      expect(opened.type).toBe(item.type);
    }
    const todo = await api.getRecord(5);
    expect(todo.desc).toBe("Ship it");
    expect(JSON.parse(todo.content)).toEqual({
      title: "Ship it",
      description: "",
      priority: "high",
      completed: false,
    });
    const link = await api.getRecord(2);
    expect(link.url).toBe("https://example.com/article");
    expect(link.content).toBe("");
  });

  it("creates records with two tags and keeps the first primary", async () => {
    const { api } = makeApi();
    const second = await api.createTag("Research");
    const record = await api.createRecord(
      buildTextCreateBody("tagged", { tagIds: [1, second.id] }),
    );
    expect(record.tagIds).toEqual([1, second.id]);
    expect(record.tagId).toBe(1);
  });

  it("answers duplicate without a second row for a repeated sourceId", async () => {
    const { api, server } = makeApi();
    const sourceId = makeSourceId("paste", "once");
    const first = await api.createRecord(
      buildTextCreateBody("once", {}, sourceId),
    );
    const second = await api.createRecord(
      buildTextCreateBody("changed text", {}, sourceId),
    );
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.content).toBe("once");
    expect(server.records).toHaveLength(1);
  });

  it("uploads an asset before creating an image record", async () => {
    const { api, server } = makeApi();
    const file = new Blob(["fake-png"], { type: "image/png" });
    const asset = await api.uploadAsset(file, "photo.png");
    expect(asset.assetKey).toBe("assets/k-photo.png");
    const record = await api.createRecord(
      buildImageCreateBody(asset.assetKey, "", {}),
    );
    expect(record.url).toBe("assets/k-photo.png");
    expect(server.calls[0].url).toBe("/api/assets");
  });

  it("never sends workspaceId or a versioned path", async () => {
    const { api, server } = makeApi();
    await api.createRecord(buildTextCreateBody("x", {}));
    await api.listRecords({ q: "x" });
    await api.listTags();
    for (const call of server.calls) {
      expect(call.url).not.toContain("workspaceId");
      expect(call.url).not.toContain("/api/v1/");
      expect(call.url.startsWith("/api/")).toBe(true);
      if (typeof call.init.body === "string") {
        expect(call.init.body).not.toContain("workspaceId");
      }
    }
  });
});

describe("guards", () => {
  it("rejects a stale PATCH guard and applies a fresh one", async () => {
    const { api } = makeApi();
    const record = await api.createRecord(buildTextCreateBody("v1", {}));
    await expectWireError(
      api.updateRecord(record.id, { content: "v2", expectedVersion: 99 }),
      "revision_conflict",
      409,
    );
    const updated = await api.updateRecord(record.id, {
      content: "v2",
      desc: "v2",
      expectedVersion: 1,
    });
    expect(updated.content).toBe("v2");
    expect(updated.version).toBe(2);
  });

  it("rejects a changed tag set and reports the current tags", async () => {
    const { api } = makeApi();
    const record = await api.createRecord(buildTextCreateBody("t", {}));
    const error = await expectWireError(
      api.updateRecordTags(record.id, {
        tagIds: [1, 2],
        expectedTagIds: [2],
      }),
      "record_tags_changed",
      409,
    );
    expect(error.details).toEqual({ currentTagIds: [1] });
    const moved = await api.updateRecordTags(record.id, {
      tagIds: [1, 2],
      expectedTagIds: [1],
    });
    expect(moved.tagIds).toEqual([1, 2]);
    expect(moved.tagVersion).toBe(2);
  });

  it("requires expectedTagIds unless forced", async () => {
    const { api } = makeApi();
    const record = await api.createRecord(buildTextCreateBody("t", {}));
    await expectWireError(
      api.updateRecordTags(record.id, { tagIds: [1] }),
      "validation_failed",
      400,
    );
  });
});

describe("trash and restore", () => {
  it("soft deletes, lists trash, restores, and empties the trash", async () => {
    const { api } = makeApi();
    const a = await api.createRecord(buildTextCreateBody("a", {}));
    const b = await api.createRecord(buildTextCreateBody("b", {}));
    await api.softDeleteRecord(a.id);
    expect((await api.listRecords({})).items.map((r) => r.id)).toEqual([
      b.id,
    ]);
    expect(
      (await api.listRecords({ status: "trash" })).items.map((r) => r.id),
    ).toEqual([a.id]);
    const restored = await api.restoreRecord(a.id);
    expect(restored.deleted).toBe(false);
    await api.softDeleteRecord(a.id);
    await api.softDeleteRecord(b.id);
    const emptied = await api.emptyTrash();
    expect(emptied.purged).toBe(2);
    expect((await api.listRecords({ status: "trash" })).items).toHaveLength(0);
  });

  it("deletes permanently and answers 404 afterwards", async () => {
    const { api } = makeApi();
    const record = await api.createRecord(buildTextCreateBody("gone", {}));
    const result = await api.deleteRecordPermanent(record.id);
    expect(result).toEqual({ id: record.id, deleted: true, permanent: true });
    await expectWireError(api.getRecord(record.id), "not_found", 404);
  });

  it("pages through the list without skipping", async () => {
    const { api } = makeApi();
    for (let i = 0; i < 5; i += 1) {
      await api.createRecord(buildTextCreateBody(`r${i}`, {}));
    }
    const all = await api.listAllRecords({ limit: 2 });
    expect(all.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("tags", () => {
  it("lists, creates, renames, and deletes tags", async () => {
    const { api } = makeApi();
    expect((await api.listTags()).tags.map((t) => t.name)).toEqual([
      "Idea",
    ]);
    const tag = await api.createTag("Research");
    await expectWireError(api.createTag("Research"), "tag_name_taken", 409);
    const renamed = await api.updateTag(tag.id, { name: "Riset" });
    expect(renamed.name).toBe("Riset");
    const deleted = await api.deleteTag(tag.id);
    expect(deleted).toEqual({ id: tag.id, deleted: true, reassignedTo: null });
  });

  it("refuses to rename or unpin the locked tag", async () => {
    const { api } = makeApi();
    await expectWireError(
      api.updateTag(1, { name: "Other" }),
      "tag_locked",
      409,
    );
    await expectWireError(
      api.updateTag(1, { pinned: false }),
      "tag_locked",
      409,
    );
    const noop = await api.updateTag(1, { pinned: true });
    expect(noop.pinned).toBe(true);
  });

  it("refuses to delete a tag in use without reassignTo", async () => {
    const { api } = makeApi();
    const tag = await api.createTag("Used");
    await api.createRecord(buildTextCreateBody("x", { tagIds: [tag.id] }));
    await expectWireError(api.deleteTag(tag.id), "tag_in_use", 409);
    const deleted = await api.deleteTag(tag.id, 1);
    expect(deleted.reassignedTo).toBe(1);
  });
});

describe("sequential multi-select", () => {
  it("moves tags in order and stops at the first 409", async () => {
    const { api } = makeApi();
    const a = await api.createRecord(buildTextCreateBody("a", {}));
    const b = await api.createRecord(buildTextCreateBody("b", {}));
    const c = await api.createRecord(buildTextCreateBody("c", {}));
    const result = await moveRecordsTagsSequential(api, [
      { id: a.id, tagIds: [1, 2], expectedTagIds: [1] },
      { id: b.id, tagIds: [1, 2], expectedTagIds: [9] },
      { id: c.id, tagIds: [1, 2], expectedTagIds: [1] },
    ]);
    expect(result.succeeded).toEqual([a.id]);
    expect(result.stoppedEarly).toBe(true);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(b.id);
    expect(result.failed[0].code).toBe("record_tags_changed");
    expect((await api.getRecord(c.id)).tagIds).toEqual([1]);
  });

  it("treats a missing record as success on delete and continues", async () => {
    const { api } = makeApi();
    const a = await api.createRecord(buildTextCreateBody("a", {}));
    const b = await api.createRecord(buildTextCreateBody("b", {}));
    const result = await softDeleteRecordsSequential(api, [a.id, 999, b.id]);
    expect(result.succeeded).toEqual([a.id, 999, b.id]);
    expect(result.failed).toHaveLength(0);
    expect(result.stoppedEarly).toBe(false);
  });

  it("restores and permanently deletes sequentially", async () => {
    const { api } = makeApi();
    const a = await api.createRecord(buildTextCreateBody("a", {}));
    const b = await api.createRecord(buildTextCreateBody("b", {}));
    await api.softDeleteRecord(a.id);
    await api.softDeleteRecord(b.id);
    const restored = await restoreRecordsSequential(api, [a.id, b.id]);
    expect(restored.succeeded).toEqual([a.id, b.id]);
    const deleted = await deleteRecordsPermanentSequential(api, [a.id, b.id]);
    expect(deleted.succeeded).toEqual([a.id, b.id]);
    expect((await api.listRecords({ status: "all" })).items).toHaveLength(0);
  });
});
