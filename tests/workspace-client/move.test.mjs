// SPDX-License-Identifier: GPL-3.0-only
// Conformance: move/rename, folder move, link rewriting, and
// repair-links. Contract: kontrak-api-kanonis.md section 3.1;
// V1-09 sections 2.7, 6.1-6.7.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createFile,
  expectError,
  expectOk,
  getFileText,
  getRevision,
  mkdirOk,
  query,
  request,
  setupContext,
} from "./helpers.mjs";

const ctx = await setupContext();

async function move(source, target, extra = {}) {
  return request(ctx, "POST", "/api/workspace/move", {
    json: { source, target, ...extra },
  });
}

test("move renames a file and changes its revision", async () => {
  const source = ctx.path("move", "old.md");
  const target = ctx.path("move", "new.md");
  const created = await createFile(ctx, source, "moved content");
  const resp = await move(source, target);
  const data = expectOk(resp, 200, "move");
  assert.equal(data.source, source);
  assert.equal(data.target, target);
  assert.equal(data.kind, "file");
  assert.equal(data.rewriteLinks, true);
  assert.equal(data.rewriteStatus, "complete");
  assert.notEqual(data.revision, created.revision);
  assert.deepEqual(data.rewrittenFiles, []);
  assert.deepEqual(data.skipped, []);
  assert.deepEqual(data.pending, []);
  assert.equal(data.affectedCount, 1);
  assert.equal(data.indexHookWarning, null);
  const gone = await request(ctx, "GET", `/api/workspace/file${query({ path: source })}`);
  expectError(gone, 404, "not_found");
  assert.equal((await getFileText(ctx, target)).text, "moved content");
  assert.equal(await getRevision(ctx, target), data.revision);
});

test("move with correct expectedRevision succeeds", async () => {
  const source = ctx.path("move", "guarded.md");
  const target = ctx.path("move", "guarded-new.md");
  await createFile(ctx, source, "g");
  const revision = await getRevision(ctx, source);
  const resp = await move(source, target, { expectedRevision: revision });
  expectOk(resp, 200, "guarded move");
});

test("move with stale expectedRevision returns 412 and moves nothing", async () => {
  const source = ctx.path("move", "stale.md");
  const target = ctx.path("move", "stale-new.md");
  const created = await createFile(ctx, source, "v1");
  const current = await getRevision(ctx, source);
  const overwrite = await request(ctx, "PUT", `/api/workspace/file${query({ path: source })}`, {
    headers: { "If-Match": current },
    body: "v2",
  });
  expectOk(overwrite, 200, "advance");
  const resp = await move(source, target, { expectedRevision: created.revision });
  const error = expectError(resp, 412, "revision_conflict");
  assert.equal(error.details.path, source);
  assert.equal((await getFileText(ctx, source)).text, "v2");
  const targetGet = await request(ctx, "GET", `/api/workspace/file${query({ path: target })}`);
  expectError(targetGet, 404, "not_found");
});

test("move ignores expectedRevision for folders", async () => {
  const source = ctx.path("move", "folderguard");
  const target = ctx.path("move", "folderguard-new");
  await mkdirOk(ctx, source);
  await createFile(ctx, ctx.path("move", "folderguard", "inside.md"), "in");
  const resp = await move(source, target, { expectedRevision: "sha256:bogus" });
  const data = expectOk(resp, 200, "folder move ignores guard");
  assert.equal(data.kind, "folder");
  assert.equal(data.revision, null);
});

test("move rejects same source and target", async () => {
  const source = ctx.path("move", "same.md");
  await createFile(ctx, source, "s");
  const resp = await move(source, source);
  expectError(resp, 400, "invalid_move");
});

test("move of a missing source returns 404", async () => {
  const resp = await move(ctx.path("move", "ghost.md"), ctx.path("move", "ghost-new.md"));
  expectError(resp, 404, "not_found");
});

test("move onto an occupied target returns 409 and keeps the source", async () => {
  const source = ctx.path("move", "clash-src.md");
  const target = ctx.path("move", "clash-dst.md");
  await createFile(ctx, source, "src");
  await createFile(ctx, target, "dst");
  const resp = await move(source, target);
  expectError(resp, 409, "already_exists");
  assert.equal((await getFileText(ctx, source)).text, "src");
  assert.equal((await getFileText(ctx, target)).text, "dst");
});

test("move of a folder into its own subtree returns 400 invalid_move", async () => {
  const source = ctx.path("move", "tree");
  await mkdirOk(ctx, source);
  const resp = await move(source, ctx.path("move", "tree", "child"));
  expectError(resp, 400, "invalid_move");
});

test("move of a folder moves the whole subtree", async () => {
  const source = ctx.path("move", "srcdir");
  const target = ctx.path("move", "dstdir");
  await createFile(ctx, ctx.path("move", "srcdir", "a.md"), "a");
  await createFile(ctx, ctx.path("move", "srcdir", "sub", "b.md"), "b");
  const resp = await move(source, target);
  const data = expectOk(resp, 200, "folder move");
  assert.equal(data.affectedCount, 4);
  assert.equal((await getFileText(ctx, ctx.path("move", "dstdir", "a.md"))).text, "a");
  assert.equal((await getFileText(ctx, ctx.path("move", "dstdir", "sub", "b.md"))).text, "b");
  const gone = await request(ctx, "GET", `/api/workspace/stat${query({ path: source })}`);
  expectError(gone, 404, "not_found");
});

test("move creates target parent folders", async () => {
  const source = ctx.path("move", "orphan.md");
  const target = ctx.path("move", "fresh", "nested", "orphan.md");
  await createFile(ctx, source, "o");
  const resp = await move(source, target);
  expectOk(resp, 200, "move with fresh parents");
  assert.equal((await getFileText(ctx, target)).text, "o");
});

test("move rewrites relative links in referring files", async () => {
  const doc = ctx.path("links", "old", "doc.md");
  const index = ctx.path("links", "index.md");
  await createFile(ctx, doc, "# Doc\n");
  await createFile(
    ctx,
    index,
    "See [Doc](old/doc.md) and ![Diagram](old/doc.md).\n",
  );
  const target = ctx.path("links", "new", "doc.md");
  const resp = await move(doc, target);
  const data = expectOk(resp, 200, "move with rewrite");
  assert.equal(data.rewrittenFiles.length, 1);
  assert.equal(data.rewrittenFiles[0].path, index);
  assert.equal(data.rewrittenFiles[0].replacements, 2);
  assert.equal(
    (await getFileText(ctx, index)).text,
    "See [Doc](new/doc.md) and ![Diagram](new/doc.md).\n",
  );
});

test("move with rewriteLinks false leaves links untouched", async () => {
  const doc = ctx.path("links", "old2", "doc.md");
  const index = ctx.path("links", "index2.md");
  await createFile(ctx, doc, "# Doc\n");
  const original = "See [Doc](old2/doc.md).\n";
  await createFile(ctx, index, original);
  const resp = await move(doc, ctx.path("links", "new2", "doc.md"), { rewriteLinks: false });
  const data = expectOk(resp, 200, "move without rewrite");
  assert.equal(data.rewriteStatus, "disabled");
  assert.deepEqual(data.rewrittenFiles, []);
  assert.equal((await getFileText(ctx, index)).text, original);
});

test("move does not rewrite links inside fenced code blocks", async () => {
  const doc = ctx.path("links", "old3", "doc.md");
  const index = ctx.path("links", "index3.md");
  await createFile(ctx, doc, "# Doc\n");
  await createFile(
    ctx,
    index,
    "See [Doc](old3/doc.md).\n```md\n[Doc](old3/doc.md)\n```\n",
  );
  const resp = await move(doc, ctx.path("links", "new3", "doc.md"));
  expectOk(resp, 200, "move with code fence");
  assert.equal(
    (await getFileText(ctx, index)).text,
    "See [Doc](new3/doc.md).\n```md\n[Doc](old3/doc.md)\n```\n",
  );
});

test("move does not rewrite absolute or external destinations", async () => {
  const doc = ctx.path("links", "old4", "doc.md");
  const index = ctx.path("links", "index4.md");
  await createFile(ctx, doc, "# Doc\n");
  const original = "See [Ext](https://example.invalid/x.md) and [Abs](/old4/doc.md) and [Doc](old4/doc.md).\n";
  await createFile(ctx, index, original);
  const resp = await move(doc, ctx.path("links", "new4", "doc.md"));
  const data = expectOk(resp, 200, "move with external links");
  assert.equal(data.rewrittenFiles[0].replacements, 1);
  assert.equal(
    (await getFileText(ctx, index)).text,
    "See [Ext](https://example.invalid/x.md) and [Abs](/old4/doc.md) and [Doc](new4/doc.md).\n",
  );
});

test("move rejects unknown fields", async () => {
  const source = ctx.path("move", "fields.md");
  await createFile(ctx, source, "f");
  const resp = await request(ctx, "POST", "/api/workspace/move", {
    json: { source, target: ctx.path("move", "fields-new.md"), workspaceId: "ws-1" },
  });
  expectError(resp, 400, "validation_failed");
});

test("repair-links rewrites after a move with rewriteLinks false", async () => {
  const source = ctx.path("repair", "old", "doc.md");
  const target = ctx.path("repair", "new", "doc.md");
  const index = ctx.path("repair", "index.md");
  await createFile(ctx, source, "# Doc\n");
  await createFile(ctx, index, "See [Doc](old/doc.md).\n");
  const moved = await move(source, target, { rewriteLinks: false });
  expectOk(moved, 200, "move without rewrite");
  const repair = await request(ctx, "POST", "/api/workspace/move/repair-links", {
    json: { source, target },
  });
  const data = expectOk(repair, 200, "repair-links");
  assert.equal(data.repaired, true);
  assert.equal(data.rewrittenFiles.length, 1);
  assert.equal((await getFileText(ctx, index)).text, "See [Doc](new/doc.md).\n");
  const again = await request(ctx, "POST", "/api/workspace/move/repair-links", {
    json: { source, target },
  });
  const againData = expectOk(again, 200, "repair-links again");
  assert.deepEqual(againData.rewrittenFiles, []);
});

test("repair-links preconditions return 409", async () => {
  const missing = await request(ctx, "POST", "/api/workspace/move/repair-links", {
    json: { source: ctx.path("repair", "ghost-old.md"), target: ctx.path("repair", "ghost-new.md") },
  });
  expectError(missing, 409, "repair_precondition_failed");
  const source = ctx.path("repair", "still.md");
  const target = ctx.path("repair", "still-new.md");
  await createFile(ctx, source, "s");
  await createFile(ctx, target, "t");
  const both = await request(ctx, "POST", "/api/workspace/move/repair-links", {
    json: { source, target },
  });
  expectError(both, 409, "repair_precondition_failed");
});

test("move idempotency key replays without moving twice", async () => {
  const source = ctx.path("move", "idem-old.md");
  const target = ctx.path("move", "idem-new.md");
  await createFile(ctx, source, "once");
  const key = `idem-move-${Date.now()}`;
  const body = { source, target, rewriteLinks: false };
  const first = await request(ctx, "POST", "/api/workspace/move", {
    headers: { "Idempotency-Key": key },
    json: body,
  });
  const firstData = expectOk(first, 200, "move first");
  const second = await request(ctx, "POST", "/api/workspace/move", {
    headers: { "Idempotency-Key": key },
    json: body,
  });
  const secondData = expectOk(second, 200, "move replay");
  assert.deepEqual(secondData, firstData);
  assert.equal((await getFileText(ctx, target)).text, "once");
  const gone = await request(ctx, "GET", `/api/workspace/file${query({ path: source })}`);
  expectError(gone, 404, "not_found");
});
