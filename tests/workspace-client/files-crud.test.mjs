// SPDX-License-Identifier: GPL-3.0-only
// Conformance: file/folder CRUD, list, scan, stat, path validation.
// Contract: kontrak-api-kanonis.md section 3.1; V1-09 sections 2.1,
// 2.2, 2.3, 2.6, 2.9, 2.10, 8.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEntryShape,
  assertIsoUtc,
  createFile,
  expectError,
  expectOk,
  getFileText,
  getRevision,
  mkdirOk,
  query,
  request,
  setupContext,
  skipUnlessMock,
} from "./helpers.mjs";

const ctx = await setupContext();

test("PUT creates a file with envelope, ETag, and version 1", async () => {
  const path = ctx.path("crud", "a.md");
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-None-Match": "*" },
    body: "# Hello\n",
  });
  const data = expectOk(resp, 201, "PUT create");
  assert.equal(data.path, path);
  assert.equal(data.created, true);
  assert.equal(data.version, 1);
  assert.equal(data.size, 8);
  assert.ok(data.revision.startsWith("sha256:"));
  assertIsoUtc(data.modifiedAt);
  assert.equal(resp.headers.get("ETag"), `"${data.revision}"`);
  assert.equal(resp.headers.get("X-Revision"), data.revision);
});

test("PUT creates parent folders automatically", async () => {
  const path = ctx.path("crud", "deep", "deeper", "leaf.md");
  await createFile(ctx, path, "leaf");
  const resp = await request(ctx, "GET", `/api/workspace/stat${query({ path: ctx.path("crud", "deep") })}`);
  const data = expectOk(resp, 200, "stat parent");
  assert.equal(data.isDirectory, true);
});

test("GET returns raw text with file headers", async () => {
  const path = ctx.path("crud", "read.md");
  await createFile(ctx, path, "line one\nline two\n");
  const resp = await getFileText(ctx, path);
  assert.equal(resp.text, "line one\nline two\n");
  assert.equal(resp.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.ok(resp.headers.get("ETag").startsWith('"sha256:'));
  assert.equal(resp.headers.get("X-Revision"), resp.headers.get("ETag").slice(1, -1));
  assert.equal(resp.headers.get("X-Version"), "1");
  assert.ok(resp.headers.get("Last-Modified"));
  assert.equal(resp.headers.get("Cache-Control"), "private, no-cache");
});

test("GET .txt returns text/plain", async () => {
  const path = ctx.path("crud", "notes.txt");
  await createFile(ctx, path, "plain");
  const resp = await getFileText(ctx, path);
  assert.equal(resp.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.equal(resp.text, "plain");
});

test("GET with matching If-None-Match returns 304 without body", async () => {
  const path = ctx.path("crud", "cached.md");
  await createFile(ctx, path, "cached");
  const revision = await getRevision(ctx, path);
  const resp = await request(ctx, "GET", `/api/workspace/file${query({ path })}`, {
    headers: { "If-None-Match": `"${revision}"` },
  });
  assert.equal(resp.status, 304);
  assert.equal(resp.bytes.length, 0);
});

test("GET missing file returns 404 not_found envelope", async () => {
  const resp = await request(ctx, "GET", `/api/workspace/file${query({ path: ctx.path("crud", "missing.md") })}`);
  expectError(resp, 404, "not_found");
});

test("GET folder path returns 404", async () => {
  const folder = ctx.path("crud", "afolder");
  await mkdirOk(ctx, folder);
  const resp = await request(ctx, "GET", `/api/workspace/file${query({ path: folder })}`);
  expectError(resp, 404, "not_found");
});

test("GET non-text extension returns 415 not_text_file", async () => {
  const path = ctx.path("crud", "pic.png");
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16, 0),
  ]);
  const up = await request(ctx, "PUT", `/api/workspace/media${query({ path })}`, {
    headers: { "If-None-Match": "*", "Content-Type": "application/octet-stream" },
    body: png,
  });
  expectOk(up, 201, "PUT media png");
  const resp = await request(ctx, "GET", `/api/workspace/file${query({ path })}`);
  expectError(resp, 415, "not_text_file");
});

test("HEAD returns GET headers without a body", async () => {
  const path = ctx.path("crud", "head.md");
  await createFile(ctx, path, "head-body");
  const resp = await request(ctx, "HEAD", `/api/workspace/file${query({ path })}`);
  assert.equal(resp.status, 200);
  assert.equal(resp.bytes.length, 0);
  assert.ok(resp.headers.get("ETag").startsWith('"sha256:'));
  assert.equal(resp.headers.get("X-Version"), "1");
});

test("HEAD missing file returns 404 without a body", async () => {
  // HEAD responses never carry a body, so the error envelope cannot be
  // read back; the contract point is the status plus an empty body.
  const resp = await request(ctx, "HEAD", `/api/workspace/file${query({ path: ctx.path("crud", "nope.md") })}`);
  assert.equal(resp.status, 404);
  assert.equal(resp.bytes.length, 0);
});

test("PUT overwrite with quoted If-Match bumps version and revision", async () => {
  const path = ctx.path("crud", "overwrite.md");
  const created = await createFile(ctx, path, "v1");
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-Match": `"${created.revision}"` },
    body: "v2 content",
  });
  const data = expectOk(resp, 200, "PUT overwrite");
  assert.equal(data.created, false);
  assert.equal(data.version, 2);
  assert.notEqual(data.revision, created.revision);
  assert.equal((await getFileText(ctx, path)).text, "v2 content");
});

test("PUT with unquoted If-Match is tolerated", async () => {
  const path = ctx.path("crud", "unquoted.md");
  const created = await createFile(ctx, path, "v1");
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-Match": created.revision },
    body: "v2",
  });
  expectOk(resp, 200, "PUT unquoted guard");
});

test("PUT without any guard returns 428 precondition_required", async () => {
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path: ctx.path("crud", "noguard.md") })}`, {
    body: "x",
  });
  expectError(resp, 428, "precondition_required");
});

test("PUT If-None-Match star on existing file returns 409 already_exists", async () => {
  const path = ctx.path("crud", "exists.md");
  await createFile(ctx, path, "x");
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-None-Match": "*" },
    body: "y",
  });
  expectError(resp, 409, "already_exists");
  assert.equal((await getFileText(ctx, path)).text, "x");
});

test("PUT with both guards returns 400 invalid_precondition", async () => {
  const path = ctx.path("crud", "both.md");
  await createFile(ctx, path, "x");
  const revision = await getRevision(ctx, path);
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-Match": revision, "If-None-Match": "*" },
    body: "y",
  });
  expectError(resp, 400, "invalid_precondition");
});

test("PUT with If-Match list returns 400 invalid_precondition", async () => {
  const path = ctx.path("crud", "listguard.md");
  await createFile(ctx, path, "x");
  const revision = await getRevision(ctx, path);
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-Match": `"${revision}", "sha256:other"` },
    body: "y",
  });
  expectError(resp, 400, "invalid_precondition");
});

test("PUT with If-None-Match revision value returns 400 invalid_precondition", async () => {
  const path = ctx.path("crud", "nonematch.md");
  await createFile(ctx, path, "x");
  const revision = await getRevision(ctx, path);
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-None-Match": `"${revision}"` },
    body: "y",
  });
  expectError(resp, 400, "invalid_precondition");
});

test("PUT invalid UTF-8 body returns 422 invalid_text_encoding", async () => {
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path: ctx.path("crud", "badutf.md") })}`, {
    headers: { "If-None-Match": "*" },
    body: Buffer.from([0xff, 0xfe, 0x41]),
  });
  expectError(resp, 422, "invalid_text_encoding");
});

test("PUT text over 2 MiB returns 413 text_too_large", async () => {
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path: ctx.path("crud", "huge.md") })}`, {
    headers: { "If-None-Match": "*" },
    body: "x".repeat(2 * 1024 * 1024 + 1),
  });
  expectError(resp, 413, "text_too_large");
});

test("mkdir creates, is idempotent, and rejects file collision", async () => {
  const folder = ctx.path("crud", "newdir");
  const first = await request(ctx, "POST", "/api/workspace/mkdir", { json: { path: folder } });
  const firstData = expectOk(first, 201, "mkdir create");
  assert.equal(firstData.created, true);
  assertEntryShape(firstData.entry);
  assert.equal(firstData.entry.isDirectory, true);
  const second = await request(ctx, "POST", "/api/workspace/mkdir", { json: { path: folder } });
  const secondData = expectOk(second, 200, "mkdir existing");
  assert.equal(secondData.created, false);
  const filePath = ctx.path("crud", "afile.md");
  await createFile(ctx, filePath, "x");
  const clash = await request(ctx, "POST", "/api/workspace/mkdir", { json: { path: filePath } });
  expectError(clash, 409, "already_exists");
});

test("mkdir with unknown field returns 400 validation_failed", async () => {
  const resp = await request(ctx, "POST", "/api/workspace/mkdir", {
    json: { path: ctx.path("crud", "extra"), workspaceId: "ws-1" },
  });
  const error = expectError(resp, 400, "validation_failed");
  assert.ok(error.details.fields.some((f) => f.field === "workspaceId"));
});

test("stat returns DirEntry shape for file and folder", async () => {
  const file = ctx.path("crud", "statme.md");
  await createFile(ctx, file, "stat");
  const fileResp = await request(ctx, "GET", `/api/workspace/stat${query({ path: file })}`);
  const fileData = expectOk(fileResp, 200, "stat file");
  assertEntryShape(fileData);
  assert.equal(fileData.size, 4);
  assert.ok(fileResp.headers.get("ETag"));
  const folder = ctx.path("crud");
  const folderResp = await request(ctx, "GET", `/api/workspace/stat${query({ path: folder })}`);
  const folderData = expectOk(folderResp, 200, "stat folder");
  assertEntryShape(folderData);
  assert.equal(folderData.isDirectory, true);
  assert.equal(folderData.size, null);
  assert.equal(folderData.revision, null);
  assert.equal(folderResp.headers.get("ETag"), null);
});

test("list sorts folders first then files alphabetically", async () => {
  const folder = ctx.path("sort");
  await mkdirOk(ctx, folder);
  await createFile(ctx, ctx.path("sort", "zebra.md"), "z");
  await createFile(ctx, ctx.path("sort", "apple.md"), "a");
  await mkdirOk(ctx, ctx.path("sort", "zfolder"));
  await mkdirOk(ctx, ctx.path("sort", "afolder"));
  const resp = await request(ctx, "GET", `/api/workspace/list${query({ path: folder })}`);
  const data = expectOk(resp, 200, "list sort");
  assert.deepEqual(data.entries.map((e) => e.name), ["afolder", "zfolder", "apple.md", "zebra.md"]);
});

test("list includeMetadata=false nulls size and timestamps but keeps revision", async () => {
  const folder = ctx.path("sort");
  const resp = await request(ctx, "GET", `/api/workspace/list${query({ path: folder, includeMetadata: "false" })}`);
  const data = expectOk(resp, 200, "list no metadata");
  const file = data.entries.find((e) => e.name === "apple.md");
  assert.equal(file.size, null);
  assert.equal(file.modifiedAt, null);
  assert.equal(file.createdAt, null);
  assert.ok(file.revision.startsWith("sha256:"));
});

test("list on a file returns 400 not_a_directory", async () => {
  const file = ctx.path("sort", "apple.md");
  const resp = await request(ctx, "GET", `/api/workspace/list${query({ path: file })}`);
  expectError(resp, 400, "not_a_directory");
});

test("list missing folder returns 404", async () => {
  const resp = await request(ctx, "GET", `/api/workspace/list${query({ path: ctx.path("sort", "ghost") })}`);
  expectError(resp, 404, "not_found");
});

test("list pagination walks cursors with consistent hasMore", async () => {
  const folder = ctx.path("pages");
  await mkdirOk(ctx, folder);
  for (let i = 0; i < 5; i += 1) {
    await createFile(ctx, ctx.path("pages", `p${i}.md`), `p${i}`);
  }
  const seen = [];
  let cursor = null;
  let guard = 0;
  do {
    const params = { path: folder, limit: "2" };
    if (cursor) params.cursor = cursor;
    const resp = await request(ctx, "GET", `/api/workspace/list${query(params)}`);
    const data = expectOk(resp, 200, "list page");
    assert.equal(data.hasMore, data.nextCursor !== null);
    seen.push(...data.entries.map((e) => e.name));
    cursor = data.nextCursor;
    guard += 1;
    assert.ok(guard < 10, "pagination must terminate");
  } while (cursor !== null);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
});

test("list limit validation and clamping", async () => {
  const folder = ctx.path("pages");
  const zero = await request(ctx, "GET", `/api/workspace/list${query({ path: folder, limit: "0" })}`);
  expectError(zero, 400, "invalid_limit");
  const text = await request(ctx, "GET", `/api/workspace/list${query({ path: folder, limit: "abc" })}`);
  expectError(text, 400, "invalid_limit");
  const huge = await request(ctx, "GET", `/api/workspace/list${query({ path: folder, limit: "5000" })}`);
  const data = expectOk(huge, 200, "list clamped");
  assert.equal(data.entries.length, 5);
  const badCursor = await request(ctx, "GET", `/api/workspace/list${query({ path: folder, cursor: "not-a-cursor!!" })}`);
  expectError(badCursor, 400, "invalid_cursor");
});

test("scan returns only .md recursively with relativePath sorted by path", async () => {
  const folder = ctx.path("vault");
  await createFile(ctx, ctx.path("vault", "b.md"), "b");
  await createFile(ctx, ctx.path("vault", "sub", "a.md"), "a");
  await createFile(ctx, ctx.path("vault", "sub", "note.txt"), "t");
  await createFile(ctx, ctx.path("vault", "UPPER.MD"), "u");
  await createFile(ctx, ctx.path("vault", "doc.markdown"), "m");
  const resp = await request(ctx, "GET", `/api/workspace/scan${query({ folder, includeMetadata: "true" })}`);
  const data = expectOk(resp, 200, "scan");
  assert.deepEqual(data.entries.map((e) => e.path), [
    ctx.path("vault", "b.md"),
    ctx.path("vault", "sub", "a.md"),
  ]);
  assert.equal(data.entries[1].relativePath, "sub/a.md");
  assert.equal(data.folder, folder);
  assert.equal(data.hasMore, false);
  assert.equal(data.nextCursor, null);
});

test("scan missing folder returns 404", async () => {
  const resp = await request(ctx, "GET", `/api/workspace/scan${query({ folder: ctx.path("vault", "ghost") })}`);
  expectError(resp, 404, "not_found");
});

test("scan pagination is consistent", async () => {
  const folder = ctx.path("vault");
  const first = await request(ctx, "GET", `/api/workspace/scan${query({ folder, limit: "1" })}`);
  const firstData = expectOk(first, 200, "scan page 1");
  assert.equal(firstData.entries.length, 1);
  assert.equal(firstData.hasMore, true);
  const second = await request(ctx, "GET", `/api/workspace/scan${query({ folder, limit: "1", cursor: firstData.nextCursor })}`);
  const secondData = expectOk(second, 200, "scan page 2");
  assert.equal(secondData.entries.length, 1);
  assert.equal(secondData.hasMore, false);
});

test("traversal and absolute paths are rejected with invalid_path", async () => {
  const bad = ["../escape.md", "a/../../escape.md", "/abs.md", "C:/win.md", "..", "a/../b.md"];
  for (const badPath of bad) {
    const resp = await request(ctx, "GET", `/api/workspace/file${query({ path: badPath })}`);
    expectError(resp, 400, "invalid_path", `GET ${badPath}`);
    const put = await request(ctx, "PUT", `/api/workspace/file${query({ path: badPath })}`, {
      headers: { "If-None-Match": "*" },
      body: "x",
    });
    expectError(put, 400, "invalid_path", `PUT ${badPath}`);
  }
});

test("strict segment forms are rejected", skipUnlessMock(ctx, "segment normalization differs between V1-09 and the canonical catalog"), async () => {
  const bad = ["a//b.md", "a/./b.md", "a\\b.md", "a/b.md/"];
  for (const badPath of bad) {
    const resp = await request(ctx, "GET", `/api/workspace/file${query({ path: badPath })}`);
    expectError(resp, 400, "invalid_path", `GET ${badPath}`);
  }
});

test("write to a hidden path returns 400 invalid_path", async () => {
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path: ctx.path(".hidden", "x.md") })}`, {
    headers: { "If-None-Match": "*" },
    body: "x",
  });
  expectError(resp, 400, "invalid_path");
  const mk = await request(ctx, "POST", "/api/workspace/mkdir", { json: { path: ctx.path(".hidden2") } });
  expectError(mk, 400, "invalid_path");
});

test("read of a hidden path returns 404", skipUnlessMock(ctx, "hidden fixture cannot be planted via the API"), async () => {
  const hiddenPath = ctx.path(".secret", "h.md");
  ctx.store.injectFile(hiddenPath, Buffer.from("secret", "utf8"));
  const resp = await request(ctx, "GET", `/api/workspace/file${query({ path: hiddenPath })}`);
  expectError(resp, 404, "not_found");
  const stat = await request(ctx, "GET", `/api/workspace/stat${query({ path: hiddenPath })}`);
  expectError(stat, 404, "not_found");
});

test("unknown query parameters are ignored", async () => {
  const resp = await request(ctx, "GET", `/api/workspace/list${query({ path: ctx.path("sort"), bogusParam: "1" })}`);
  expectOk(resp, 200, "list with unknown query param");
});

test("trailing-slash route variant returns 404 without redirect", async () => {
  const resp = await request(ctx, "GET", "/api/workspace/list/");
  expectError(resp, 404, "not_found");
});

test("versioned prefix and wrong case return 404", async () => {
  const v1 = await request(ctx, "GET", "/api/v1/workspace/list");
  expectError(v1, 404, "not_found");
  const cased = await request(ctx, "GET", "/api/workspace/List");
  expectError(cased, 404, "not_found");
});

test("PUT of exactly 2 MiB succeeds at the limit", async () => {
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path: ctx.path("crud", "exact-limit.md") })}`, {
    headers: { "If-None-Match": "*" },
    body: "y".repeat(2 * 1024 * 1024),
  });
  const data = expectOk(resp, 201, "PUT exactly 2 MiB");
  assert.equal(data.size, 2 * 1024 * 1024);
});

test("GET of invalid UTF-8 returns 422, HEAD returns 200", skipUnlessMock(ctx, "invalid bytes cannot be planted via the API"), async () => {
  const path = ctx.path("crud", "bad-utf8.md");
  ctx.store.injectFile(path, Buffer.from([0x41, 0xff, 0xfe, 0x42]));
  const get = await request(ctx, "GET", `/api/workspace/file${query({ path })}`);
  expectError(get, 422, "invalid_text_encoding");
  // Contract 3.1: HEAD errors match GET except 415/422 do not apply.
  const head = await request(ctx, "HEAD", `/api/workspace/file${query({ path })}`);
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.ok(head.headers.get("ETag").startsWith('"sha256:'));
});

test("HEAD of a non-text file returns 200 without a body", async () => {
  const path = ctx.path("crud", "head-media.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  const up = await request(ctx, "PUT", `/api/workspace/media${query({ path })}`, {
    headers: { "If-None-Match": "*" },
    body: png,
  });
  expectOk(up, 201, "PUT media png for HEAD");
  const get = await request(ctx, "GET", `/api/workspace/file${query({ path })}`);
  expectError(get, 415, "not_text_file");
  const head = await request(ctx, "HEAD", `/api/workspace/file${query({ path })}`);
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
});

test("GET with an If-None-Match list containing the revision returns 304", async () => {
  const path = ctx.path("crud", "list-match.md");
  await createFile(ctx, path, "cached");
  const revision = await getRevision(ctx, path);
  const resp = await request(ctx, "GET", `/api/workspace/file${query({ path })}`, {
    headers: { "If-None-Match": `"sha256:deadbeef", "${revision}"` },
  });
  assert.equal(resp.status, 304);
  assert.equal(resp.bytes.length, 0);
});

test("stat errors: missing path 404, invalid path 400", async () => {
  const missing = await request(ctx, "GET", `/api/workspace/stat${query({ path: ctx.path("crud", "ghost.md") })}`);
  expectError(missing, 404, "not_found");
  const invalid = await request(ctx, "GET", `/api/workspace/stat${query({ path: "../escape.md" })}`);
  expectError(invalid, 400, "invalid_path");
  const noParam = await request(ctx, "GET", "/api/workspace/stat");
  expectError(noParam, 400, "invalid_path");
});

test("scan rejects invalid cursor and limit", async () => {
  const folder = ctx.path("scan", "limits");
  await mkdirOk(ctx, folder);
  const badLimit = await request(ctx, "GET", `/api/workspace/scan${query({ folder, limit: "0" })}`);
  expectError(badLimit, 400, "invalid_limit");
  const badCursor = await request(ctx, "GET", `/api/workspace/scan${query({ folder, cursor: "nope!!" })}`);
  expectError(badCursor, 400, "invalid_cursor");
  const clamped = await request(ctx, "GET", `/api/workspace/scan${query({ folder, limit: "99999" })}`);
  expectOk(clamped, 200, "scan limit clamps to the maximum");
});

test("symlink reads return 404 and symlink writes return 400", skipUnlessMock(ctx, "symlinks cannot be planted via the API"), async () => {
  const target = ctx.path("crud", "link-target.md");
  await createFile(ctx, target, "real");
  const link = ctx.path("crud", "link.md");
  ctx.store.injectSymlink(link, target);
  const get = await request(ctx, "GET", `/api/workspace/file${query({ path: link })}`);
  expectError(get, 404, "not_found");
  const stat = await request(ctx, "GET", `/api/workspace/stat${query({ path: link })}`);
  expectError(stat, 404, "not_found");
  const revision = await getRevision(ctx, target);
  const put = await request(ctx, "PUT", `/api/workspace/file${query({ path: link })}`, {
    headers: { "If-Match": `"${revision}"` },
    body: "through link",
  });
  expectError(put, 400, "symlink_not_allowed");
  const del = await request(ctx, "DELETE", `/api/workspace/file${query({ path: link })}`);
  expectError(del, 400, "symlink_not_allowed");
});
