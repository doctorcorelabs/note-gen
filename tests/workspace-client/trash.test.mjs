// SPDX-License-Identifier: GPL-3.0-only
// Conformance: delete to trash, batch trash, trash list, restore,
// purge, and empty-all. Contract: kontrak-api-kanonis.md section
// 3.1; V1-09 sections 2.8, 5.1, 5.2.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIsoUtc,
  createFile,
  expectError,
  expectOk,
  getFileText,
  getRevision,
  listTrash,
  mkdirOk,
  query,
  request,
  setupContext,
  skipUnlessMock,
} from "./helpers.mjs";

const ctx = await setupContext();

async function trashCountForPrefix() {
  const data = await listTrash(ctx);
  return data.entries.filter((e) => e.originalPath.startsWith(`${ctx.prefix}/`)).length;
}

test("DELETE file moves it to trash and removes it from the tree", async () => {
  const path = ctx.path("trash", "gone.md");
  await createFile(ctx, path, "to trash");
  const before = await trashCountForPrefix();
  const resp = await request(ctx, "DELETE", `/api/workspace/file${query({ path })}`);
  const data = expectOk(resp, 200, "delete file");
  assert.equal(data.path, path);
  assert.equal(typeof data.trashId, "string");
  assert.equal(data.kind, "file");
  assert.equal(data.entryCount, 1);
  assert.equal(data.size, 8);
  assertIsoUtc(data.deletedAt);
  const get = await request(ctx, "GET", `/api/workspace/file${query({ path })}`);
  expectError(get, 404, "not_found");
  assert.equal(await trashCountForPrefix(), before + 1);
  const scan = await request(ctx, "GET", `/api/workspace/scan${query({ folder: ctx.path("trash") })}`);
  const scanData = expectOk(scan, 200, "scan after delete");
  assert.ok(!scanData.entries.some((e) => e.path === path));
});

test("DELETE folder moves the subtree as one trash entry", async () => {
  const folder = ctx.path("trash", "folder1");
  await createFile(ctx, ctx.path("trash", "folder1", "a.md"), "aa");
  await createFile(ctx, ctx.path("trash", "folder1", "sub", "b.md"), "bbb");
  const before = await trashCountForPrefix();
  const resp = await request(ctx, "DELETE", `/api/workspace/folder${query({ path: folder })}`);
  const data = expectOk(resp, 200, "delete folder");
  assert.equal(data.kind, "folder");
  assert.equal(data.entryCount, 4);
  assert.equal(data.size, 5);
  assert.equal(await trashCountForPrefix(), before + 1);
  const get = await request(ctx, "GET", `/api/workspace/file${query({ path: ctx.path("trash", "folder1", "a.md") })}`);
  expectError(get, 404, "not_found");
});

test("DELETE with the wrong kind returns 409 wrong_kind", async () => {
  const file = ctx.path("trash", "kindfile.md");
  await createFile(ctx, file, "k");
  const wrongFile = await request(ctx, "DELETE", `/api/workspace/folder${query({ path: file })}`);
  expectError(wrongFile, 409, "wrong_kind");
  const folder = ctx.path("trash", "kindfolder");
  await mkdirOk(ctx, folder);
  const wrongFolder = await request(ctx, "DELETE", `/api/workspace/file${query({ path: folder })}`);
  expectError(wrongFolder, 409, "wrong_kind");
});

test("DELETE missing path returns 404", async () => {
  const resp = await request(ctx, "DELETE", `/api/workspace/file${query({ path: ctx.path("trash", "ghost.md") })}`);
  expectError(resp, 404, "not_found");
});

test("DELETE with permanent=true returns 400 invalid_query and keeps the file", async () => {
  const path = ctx.path("trash", "keep.md");
  await createFile(ctx, path, "keep");
  const resp = await request(ctx, "DELETE", `/api/workspace/file${query({ path, permanent: "true" })}`);
  expectError(resp, 400, "invalid_query");
  assert.equal((await getFileText(ctx, path)).text, "keep");
});

test("DELETE without a path returns 400 invalid_path", async () => {
  const resp = await request(ctx, "DELETE", "/api/workspace/file");
  expectError(resp, 400, "invalid_path");
});

test("DELETE repeat returns 404 without duplicating trash", async () => {
  const path = ctx.path("trash", "once.md");
  await createFile(ctx, path, "once");
  const first = await request(ctx, "DELETE", `/api/workspace/file${query({ path })}`);
  expectOk(first, 200, "first delete");
  const before = await trashCountForPrefix();
  const second = await request(ctx, "DELETE", `/api/workspace/file${query({ path })}`);
  expectError(second, 404, "not_found");
  assert.equal(await trashCountForPrefix(), before);
});

test("trash list shape, totals, ordering, and pagination", async () => {
  const folder = ctx.path("trash", "listset");
  await mkdirOk(ctx, folder);
  for (let i = 0; i < 3; i += 1) {
    const path = ctx.path("trash", "listset", `t${i}.md`);
    await createFile(ctx, path, `t${i}`);
    const del = await request(ctx, "DELETE", `/api/workspace/file${query({ path })}`);
    expectOk(del, 200, "delete for list");
  }
  const first = await request(ctx, "GET", "/api/workspace/trash?limit=1");
  const firstData = expectOk(first, 200, "trash page 1");
  assert.equal(firstData.entries.length, 1);
  assert.equal(firstData.hasMore, firstData.nextCursor !== null);
  assert.ok(Number.isInteger(firstData.totalCount));
  assert.ok(Number.isInteger(firstData.totalSize));
  const entry = firstData.entries[0];
  assert.equal(typeof entry.id, "string");
  assert.equal(typeof entry.originalPath, "string");
  assert.equal(typeof entry.name, "string");
  assert.ok(entry.kind === "file" || entry.kind === "folder");
  assert.ok(Number.isInteger(entry.size));
  assert.ok(Number.isInteger(entry.entryCount));
  assertIsoUtc(entry.deletedAt);
  const badLimit = await request(ctx, "GET", "/api/workspace/trash?limit=0");
  expectError(badLimit, 400, "invalid_limit");
  const badCursor = await request(ctx, "GET", "/api/workspace/trash?cursor=nope!!");
  expectError(badCursor, 400, "invalid_cursor");
});

test("restore returns the file to its original path with the same revision", async () => {
  const path = ctx.path("trash", "restore-me.md");
  const created = await createFile(ctx, path, "back again");
  const del = await request(ctx, "DELETE", `/api/workspace/file${query({ path })}`);
  const trashId = expectOk(del, 200, "delete").trashId;
  const resp = await request(ctx, "POST", `/api/workspace/trash/${trashId}/restore`, { json: {} });
  const data = expectOk(resp, 200, "restore");
  assert.equal(data.id, trashId);
  assert.equal(data.originalPath, path);
  assert.equal(data.restoredPath, path);
  assert.equal(data.kind, "file");
  assert.equal(data.revision, created.revision);
  assert.equal(data.size, 10);
  assertIsoUtc(data.restoredAt);
  assert.equal((await getFileText(ctx, path)).text, "back again");
});

test("restore to a target path changes the revision", async () => {
  const path = ctx.path("trash", "restore-target.md");
  const target = ctx.path("trash", "restored-elsewhere.md");
  const created = await createFile(ctx, path, "moved back");
  const del = await request(ctx, "DELETE", `/api/workspace/file${query({ path })}`);
  const trashId = expectOk(del, 200, "delete").trashId;
  const resp = await request(ctx, "POST", `/api/workspace/trash/${trashId}/restore`, {
    json: { target },
  });
  const data = expectOk(resp, 200, "restore to target");
  assert.equal(data.restoredPath, target);
  assert.notEqual(data.revision, created.revision);
  assert.equal((await getFileText(ctx, target)).text, "moved back");
  const gone = await request(ctx, "GET", `/api/workspace/file${query({ path })}`);
  expectError(gone, 404, "not_found");
});

test("restore onto an occupied target returns 409 target_exists with a suggestion", async () => {
  const path = ctx.path("trash", "restore-clash.md");
  const target = ctx.path("trash", "restore-clash-target.md");
  await createFile(ctx, path, "old");
  const del = await request(ctx, "DELETE", `/api/workspace/file${query({ path })}`);
  const trashId = expectOk(del, 200, "delete").trashId;
  await createFile(ctx, target, "occupant");
  const resp = await request(ctx, "POST", `/api/workspace/trash/${trashId}/restore`, {
    json: { target },
  });
  const error = expectError(resp, 409, "target_exists");
  assert.equal(typeof error.details.suggestedTarget, "string");
  assert.notEqual(error.details.suggestedTarget, target);
  assert.equal(error.details.existingKind, "file");
  const suggested = await request(ctx, "GET", `/api/workspace/file${query({ path: error.details.suggestedTarget })}`);
  expectError(suggested, 404, "not_found");
});

test("restore of an unknown id returns 404", async () => {
  const resp = await request(ctx, "POST", "/api/workspace/trash/00000000-0000-4000-8000-000000000000/restore", { json: {} });
  expectError(resp, 404, "not_found");
});

test("restore rejects unknown fields and invalid targets", async () => {
  const path = ctx.path("trash", "restore-fields.md");
  await createFile(ctx, path, "f");
  const del = await request(ctx, "DELETE", `/api/workspace/file${query({ path })}`);
  const trashId = expectOk(del, 200, "delete").trashId;
  const unknown = await request(ctx, "POST", `/api/workspace/trash/${trashId}/restore`, {
    json: { target: ctx.path("trash", "x.md"), extra: 1 },
  });
  expectError(unknown, 400, "validation_failed");
  const invalid = await request(ctx, "POST", `/api/workspace/trash/${trashId}/restore`, {
    json: { target: "../escape.md" },
  });
  expectError(invalid, 400, "invalid_path");
  const restored = await request(ctx, "POST", `/api/workspace/trash/${trashId}/restore`, { json: {} });
  expectOk(restored, 200, "restore after rejections");
});

test("purge one entry then repeat returns 404", async () => {
  const path = ctx.path("trash", "purge-me.md");
  await createFile(ctx, path, "p");
  const del = await request(ctx, "DELETE", `/api/workspace/file${query({ path })}`);
  const trashId = expectOk(del, 200, "delete").trashId;
  const purge = await request(ctx, "DELETE", `/api/workspace/trash/${trashId}`);
  const data = expectOk(purge, 200, "purge");
  assert.equal(data.id, trashId);
  assert.equal(data.purged, true);
  assertIsoUtc(data.purgedAt);
  const again = await request(ctx, "DELETE", `/api/workspace/trash/${trashId}`);
  expectError(again, 404, "not_found");
  const purgeUnknown = await request(ctx, "DELETE", "/api/workspace/trash/00000000-0000-4000-8000-000000000001");
  expectError(purgeUnknown, 404, "not_found");
});

test("batch trash reports per-item results independently", async () => {
  const file = ctx.path("trash", "batch", "a.md");
  const folder = ctx.path("trash", "batch", "dir");
  await createFile(ctx, file, "a");
  await mkdirOk(ctx, folder);
  const missing = ctx.path("trash", "batch", "ghost.md");
  const resp = await request(ctx, "POST", "/api/workspace/trash", {
    json: { paths: [file, folder, missing, "../escape.md"] },
  });
  const data = expectOk(resp, 200, "batch trash");
  assert.equal(data.moved.length, 2);
  assert.deepEqual(data.notFound, [missing]);
  assert.equal(data.rejected.length, 1);
  assert.equal(data.rejected[0].path, "../escape.md");
  assert.equal(data.rejected[0].reason, "invalid_path");
  const getFile = await request(ctx, "GET", `/api/workspace/file${query({ path: file })}`);
  expectError(getFile, 404, "not_found");
});

test("batch trash validates the paths array", async () => {
  const empty = await request(ctx, "POST", "/api/workspace/trash", { json: { paths: [] } });
  expectError(empty, 400, "validation_failed");
  const tooMany = await request(ctx, "POST", "/api/workspace/trash", {
    json: { paths: Array.from({ length: 101 }, (_, i) => ctx.path("trash", `bulk${i}.md`)) },
  });
  expectError(tooMany, 400, "validation_failed");
  const unknown = await request(ctx, "POST", "/api/workspace/trash", {
    json: { paths: [ctx.path("trash", "x.md")], workspaceId: "ws-1" },
  });
  expectError(unknown, 400, "validation_failed");
});

test("batch trash of the same path twice creates one trash entry", async () => {
  const path = ctx.path("trash", "batch-dup.md");
  await createFile(ctx, path, "dup");
  const before = await trashCountForPrefix();
  const resp = await request(ctx, "POST", "/api/workspace/trash", {
    json: { paths: [path, path] },
  });
  const data = expectOk(resp, 200, "batch duplicate");
  assert.equal(data.moved.length, 2);
  assert.equal(data.moved[0].trashId, data.moved[1].trashId);
  assert.equal(await trashCountForPrefix(), before + 1);
});

test("missing trash blob returns 500 trash_blob_missing", skipUnlessMock(ctx, "blob loss cannot be planted via the API"), async () => {
  const path = ctx.path("trash", "blobless.md");
  await createFile(ctx, path, "blob");
  const del = await request(ctx, "DELETE", `/api/workspace/file${query({ path })}`);
  const trashId = expectOk(del, 200, "delete").trashId;
  assert.equal(ctx.store.markBlobMissing(trashId), true);
  const restore = await request(ctx, "POST", `/api/workspace/trash/${trashId}/restore`, { json: {} });
  expectError(restore, 500, "trash_blob_missing");
  const purge = await request(ctx, "DELETE", `/api/workspace/trash/${trashId}`);
  expectError(purge, 500, "trash_blob_missing");
  const empty = await request(ctx, "DELETE", "/api/workspace/trash", { json: { confirm: true } });
  const emptyData = expectOk(empty, 200, "empty with blob failure");
  assert.ok(emptyData.failures.some((f) => f.id === trashId && f.code === "trash_blob_missing"));
  assert.ok(emptyData.failed >= 1);
});

test("empty trash requires confirm true", async () => {
  const noBody = await request(ctx, "DELETE", "/api/workspace/trash", {});
  expectError(noBody, 400, "confirm_required");
  const falseConfirm = await request(ctx, "DELETE", "/api/workspace/trash", { json: { confirm: false } });
  expectError(falseConfirm, 400, "confirm_required");
  const missingConfirm = await request(ctx, "DELETE", "/api/workspace/trash", { json: {} });
  expectError(missingConfirm, 400, "confirm_required");
});

test("empty trash purges entries and reports zero on a second run", async () => {
  const path = ctx.path("trash", "empty-me.md");
  await createFile(ctx, path, "e");
  const del = await request(ctx, "DELETE", `/api/workspace/file${query({ path })}`);
  expectOk(del, 200, "delete");
  const first = await request(ctx, "DELETE", "/api/workspace/trash", { json: { confirm: true } });
  const firstData = expectOk(first, 200, "empty trash");
  assert.ok(firstData.purged >= 1);
  assert.equal(firstData.failed, 0);
  assert.deepEqual(firstData.failures, []);
  assertIsoUtc(firstData.purgedAt);
  assert.equal(await trashCountForPrefix(), 0);
  const second = await request(ctx, "DELETE", "/api/workspace/trash", { json: { confirm: true } });
  const secondData = expectOk(second, 200, "empty trash again");
  assert.equal(secondData.purged, 0);
  assert.equal(secondData.failed, 0);
});
