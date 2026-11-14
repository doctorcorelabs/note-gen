// SPDX-License-Identifier: GPL-3.0-only
// Conformance: revision guards, append, patch, force writes, and
// idempotency. Contract: kontrak-api-kanonis.md sections 1.6, 2.2,
// 3.1, 6; V1-09 sections 2.3, 2.4, 2.5, 3.2, 3.3, 3.4, 3.5.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIsoUtc,
  createFile,
  expectError,
  expectOk,
  getFileText,
  getRevision,
  query,
  request,
  setupContext,
  skipUnlessMock,
} from "./helpers.mjs";

const ctx = await setupContext();

function assertConflictDetails(error, path) {
  const d = error.details;
  assert.equal(d.path, path);
  assert.ok(d.serverRevision.startsWith("sha256:"));
  assert.ok(Number.isInteger(d.serverVersion));
  assertIsoUtc(d.serverModifiedAt);
  assert.ok(Number.isInteger(d.serverSize));
  assert.equal(typeof d.currentPreview, "string");
  assert.equal(typeof d.previewTruncated, "boolean");
  assert.equal(typeof d.suggestedCopyPath, "string");
  assert.deepEqual(d.actions, ["reload", "saveAsCopy", "forceOverwrite"]);
}

test("stale If-Match returns 412 revision_conflict with details payload", async () => {
  const path = ctx.path("guard", "stale.md");
  const created = await createFile(ctx, path, "first version of the text");
  const current = await getRevision(ctx, path);
  const overwrite = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-Match": current },
    body: "second version",
  });
  expectOk(overwrite, 200, "overwrite to advance revision");
  const stale = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-Match": created.revision },
    body: "stale write",
  });
  const error = expectError(stale, 412, "revision_conflict");
  assertConflictDetails(error, path);
  assert.equal((await getFileText(ctx, path)).text, "second version");
});

test("If-Match on a deleted file returns 404", async () => {
  const path = ctx.path("guard", "deleted.md");
  const created = await createFile(ctx, path, "gone");
  const del = await request(ctx, "DELETE", `/api/workspace/file${query({ path })}`);
  expectOk(del, 200, "delete to trash");
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-Match": created.revision },
    body: "resurrect",
  });
  expectError(resp, 404, "not_found");
});

test("If-Match star force-overwrites a stale file", async () => {
  const path = ctx.path("guard", "force.md");
  await createFile(ctx, path, "v1");
  const current = await getRevision(ctx, path);
  const overwrite = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-Match": current },
    body: "v2",
  });
  expectOk(overwrite, 200, "advance");
  const forced = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-Match": "*" },
    body: "forced",
  });
  const data = expectOk(forced, 200, "force write");
  assert.equal(data.version, 3);
  assert.equal((await getFileText(ctx, path)).text, "forced");
});

test("weak If-Match validator is tolerated", async () => {
  const path = ctx.path("guard", "weak.md");
  const created = await createFile(ctx, path, "v1");
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-Match": `W/"${created.revision}"` },
    body: "v2",
  });
  expectOk(resp, 200, "weak validator");
});

test("append concatenates exactly and bumps version", async () => {
  const path = ctx.path("guard", "append.md");
  await createFile(ctx, path, "head\n");
  const revision = await getRevision(ctx, path);
  const resp = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    json: { expectedRevision: revision, content: "tail\n", force: false },
  });
  const data = expectOk(resp, 200, "append");
  assert.equal(data.version, 2);
  assert.equal(data.appendedBytes, 5);
  assert.equal((await getFileText(ctx, path)).text, "head\ntail\n");
});

test("append of empty content is a no-op returning current revision", async () => {
  const path = ctx.path("guard", "append-empty.md");
  const created = await createFile(ctx, path, "same");
  const resp = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    json: { expectedRevision: created.revision, content: "" },
  });
  const data = expectOk(resp, 200, "empty append");
  assert.equal(data.appendedBytes, 0);
  assert.equal(data.revision, created.revision);
  assert.equal(data.version, 1);
});

test("append with stale revision returns 409 revision_conflict with failedOperation", async () => {
  const path = ctx.path("guard", "append-stale.md");
  const created = await createFile(ctx, path, "v1");
  const current = await getRevision(ctx, path);
  const overwrite = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-Match": current },
    body: "v2",
  });
  expectOk(overwrite, 200, "advance");
  const resp = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    json: { expectedRevision: created.revision, content: "late" },
  });
  const error = expectError(resp, 409, "revision_conflict");
  assert.equal(error.details.failedOperation, "append");
  assertConflictDetails(error, path);
});

test("append force without expectedRevision succeeds", async () => {
  const path = ctx.path("guard", "append-force.md");
  await createFile(ctx, path, "a");
  const resp = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    json: { content: "b", force: true },
  });
  expectOk(resp, 200, "append force");
  assert.equal((await getFileText(ctx, path)).text, "ab");
});

test("append without expectedRevision and without force is rejected", async () => {
  const path = ctx.path("guard", "append-noguard.md");
  await createFile(ctx, path, "a");
  const resp = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    json: { content: "b" },
  });
  expectError(resp, 400, "validation_failed");
});

test("append to a missing file returns 404 and never creates", async () => {
  const path = ctx.path("guard", "append-missing.md");
  const resp = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    json: { expectedRevision: "sha256:doesnotmatter", content: "x" },
  });
  expectError(resp, 404, "not_found");
  const get = await request(ctx, "GET", `/api/workspace/file${query({ path })}`);
  expectError(get, 404, "not_found");
});

test("append rejects unknown fields and wrong types", async () => {
  const path = ctx.path("guard", "append-fields.md");
  await createFile(ctx, path, "a");
  const revision = await getRevision(ctx, path);
  const unknown = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    json: { expectedRevision: revision, content: "b", workspaceId: "ws-1" },
  });
  const unknownError = expectError(unknown, 400, "validation_failed");
  assert.ok(unknownError.details.fields.some((f) => f.field === "workspaceId"));
  const wrongType = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    json: { expectedRevision: revision, content: "b", force: "true" },
  });
  expectError(wrongType, 400, "validation_failed");
});

test("patch replaces a line range exactly", async () => {
  const path = ctx.path("guard", "patch.md");
  await createFile(ctx, path, "one\ntwo\nthree\nfour\n");
  const revision = await getRevision(ctx, path);
  const resp = await request(ctx, "POST", `/api/workspace/file/patch${query({ path })}`, {
    json: { expectedRevision: revision, startLine: 2, endLine: 4, replacement: "TWO\nTHREE\n" },
  });
  const data = expectOk(resp, 200, "patch");
  assert.equal(data.patchedLines, 2);
  assert.equal((await getFileText(ctx, path)).text, "one\nTWO\nTHREE\nfour\n");
});

test("patch with empty range inserts before a line", async () => {
  const path = ctx.path("guard", "patch-insert.md");
  await createFile(ctx, path, "one\nthree\n");
  const revision = await getRevision(ctx, path);
  const resp = await request(ctx, "POST", `/api/workspace/file/patch${query({ path })}`, {
    json: { expectedRevision: revision, startLine: 2, endLine: 2, replacement: "two\n" },
  });
  const data = expectOk(resp, 200, "patch insert");
  assert.equal(data.patchedLines, 0);
  assert.equal((await getFileText(ctx, path)).text, "one\ntwo\nthree\n");
});

test("patch to end of file uses lineCount plus one", async () => {
  const path = ctx.path("guard", "patch-end.md");
  await createFile(ctx, path, "one\ntwo\n");
  const revision = await getRevision(ctx, path);
  const resp = await request(ctx, "POST", `/api/workspace/file/patch${query({ path })}`, {
    json: { expectedRevision: revision, startLine: 2, endLine: 4, replacement: "TWO\nTHREE\n" },
  });
  expectOk(resp, 200, "patch to end");
  assert.equal((await getFileText(ctx, path)).text, "one\nTWO\nTHREE\n");
});

test("patch out-of-range lines return 400 invalid_patch_range", async () => {
  const path = ctx.path("guard", "patch-range.md");
  await createFile(ctx, path, "one\ntwo\n");
  const revision = await getRevision(ctx, path);
  for (const range of [
    { startLine: 0, endLine: 1 },
    { startLine: 2, endLine: 1 },
    { startLine: 1, endLine: 99 },
    { startLine: 99, endLine: 99 },
  ]) {
    const resp = await request(ctx, "POST", `/api/workspace/file/patch${query({ path })}`, {
      json: { expectedRevision: revision, ...range, replacement: "x" },
    });
    expectError(resp, 400, "invalid_patch_range", JSON.stringify(range));
  }
});

test("patch with stale revision returns 409 with failedOperation patch", async () => {
  const path = ctx.path("guard", "patch-stale.md");
  const created = await createFile(ctx, path, "v1\n");
  const current = await getRevision(ctx, path);
  const overwrite = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-Match": current },
    body: "v2\n",
  });
  expectOk(overwrite, 200, "advance");
  const resp = await request(ctx, "POST", `/api/workspace/file/patch${query({ path })}`, {
    json: { expectedRevision: created.revision, startLine: 1, endLine: 2, replacement: "late\n" },
  });
  const error = expectError(resp, 409, "revision_conflict");
  assert.equal(error.details.failedOperation, "patch");
});

test("patch force without expectedRevision succeeds", async () => {
  const path = ctx.path("guard", "patch-force.md");
  await createFile(ctx, path, "one\ntwo\n");
  const resp = await request(ctx, "POST", `/api/workspace/file/patch${query({ path })}`, {
    json: { startLine: 1, endLine: 2, replacement: "ONE\n", force: true },
  });
  expectOk(resp, 200, "patch force");
  assert.equal((await getFileText(ctx, path)).text, "ONE\ntwo\n");
});

test("patch preserves CRLF in untouched lines", async () => {
  const path = ctx.path("guard", "patch-crlf.md");
  await createFile(ctx, path, "one\r\ntwo\r\nthree\r\n");
  const revision = await getRevision(ctx, path);
  const resp = await request(ctx, "POST", `/api/workspace/file/patch${query({ path })}`, {
    json: { expectedRevision: revision, startLine: 2, endLine: 3, replacement: "TWO\r\n" },
  });
  expectOk(resp, 200, "patch crlf");
  assert.equal((await getFileText(ctx, path)).text, "one\r\nTWO\r\nthree\r\n");
});

test("PUT idempotency key replays the same response without rewriting", async () => {
  const path = ctx.path("guard", "idem-put.md");
  const key = `idem-put-${Date.now()}`;
  const first = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-None-Match": "*", "Idempotency-Key": key },
    body: "idem",
  });
  const firstData = expectOk(first, 201, "PUT idem first");
  const second = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-None-Match": "*", "Idempotency-Key": key },
    body: "idem",
  });
  const secondData = expectOk(second, 201, "PUT idem replay");
  assert.deepEqual(secondData, firstData);
  const stat = await request(ctx, "GET", `/api/workspace/stat${query({ path })}`);
  assert.equal(expectOk(stat, 200).version, 1);
});

test("idempotency key reused with a different request returns 409", async () => {
  const path = ctx.path("guard", "idem-reuse.md");
  const key = `idem-reuse-${Date.now()}`;
  const first = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-None-Match": "*", "Idempotency-Key": key },
    body: "first",
  });
  expectOk(first, 201, "PUT idem first");
  const other = await request(ctx, "PUT", `/api/workspace/file${query({ path: ctx.path("guard", "idem-other.md") })}`, {
    headers: { "If-None-Match": "*", "Idempotency-Key": key },
    body: "first",
  });
  expectError(other, 409, "idempotency_key_reused");
});

test("append idempotency key replays without appending twice", async () => {
  const path = ctx.path("guard", "idem-append.md");
  await createFile(ctx, path, "base");
  const revision = await getRevision(ctx, path);
  const key = `idem-append-${Date.now()}`;
  const body = { expectedRevision: revision, content: "+1" };
  const first = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    headers: { "Idempotency-Key": key },
    json: body,
  });
  const firstData = expectOk(first, 200, "append idem first");
  const second = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    headers: { "Idempotency-Key": key },
    json: body,
  });
  const secondData = expectOk(second, 200, "append idem replay");
  assert.deepEqual(secondData, firstData);
  assert.equal((await getFileText(ctx, path)).text, "base+1");
});

test("legacy X-Idempotency-Key header is not honored", async () => {
  const path = ctx.path("guard", "idem-legacy.md");
  await createFile(ctx, path, "base");
  const revision = await getRevision(ctx, path);
  const body = { expectedRevision: revision, content: "+1" };
  const legacyKey = `legacy-${Date.now()}`;
  const first = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    headers: { "X-Idempotency-Key": legacyKey },
    json: body,
  });
  expectOk(first, 200, "append with legacy header");
  const second = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    headers: { "X-Idempotency-Key": legacyKey },
    json: body,
  });
  expectError(second, 409, "revision_conflict");
});

test("append past 2 MiB returns 413 text_too_large", skipUnlessMock(ctx, "a 2 MiB fixture cannot be grown past the limit via the API"), async () => {
  const path = ctx.path("guard", "append-limit.md");
  ctx.store.injectFile(path, Buffer.alloc(2 * 1024 * 1024, 0x61));
  const revision = await getRevision(ctx, path);
  const resp = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    json: { expectedRevision: revision, content: "b" },
  });
  expectError(resp, 413, "text_too_large");
  assert.equal((await getFileText(ctx, path)).bytes.length, 2 * 1024 * 1024);
});

test("patch past 2 MiB returns 413 text_too_large", skipUnlessMock(ctx, "a 2 MiB fixture cannot be grown past the limit via the API"), async () => {
  const path = ctx.path("guard", "patch-limit.md");
  ctx.store.injectFile(path, Buffer.alloc(2 * 1024 * 1024, 0x61));
  const revision = await getRevision(ctx, path);
  const resp = await request(ctx, "POST", `/api/workspace/file/patch${query({ path })}`, {
    json: { expectedRevision: revision, startLine: 1, endLine: 1, replacement: "b" },
  });
  expectError(resp, 413, "text_too_large");
});

test("malformed JSON bodies return 400 invalid_json", async () => {
  const mk = await request(ctx, "POST", "/api/workspace/mkdir", {
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  expectError(mk, 400, "invalid_json");
  const path = ctx.path("guard", "bad-json.md");
  await createFile(ctx, path, "base");
  const ap = await request(ctx, "POST", `/api/workspace/file/append${query({ path })}`, {
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  expectError(ap, 400, "invalid_json");
  const arr = await request(ctx, "POST", "/api/workspace/mkdir", {
    headers: { "Content-Type": "application/json" },
    body: "[1, 2]",
  });
  expectError(arr, 400, "validation_failed");
});

test("JSON body limit is exactly 64 KiB", async () => {
  const path = ctx.path("guard", "json-limit");
  const base = JSON.stringify({ path, pad: "" });
  const padLen = 64 * 1024 - base.length;
  const exact = JSON.stringify({ path, pad: "p".repeat(padLen) });
  assert.equal(Buffer.byteLength(exact, "utf8"), 64 * 1024);
  // Accepted for parsing (unknown field is a 400, not a 413).
  const ok = await request(ctx, "POST", "/api/workspace/mkdir", {
    headers: { "Content-Type": "application/json" },
    body: exact,
  });
  expectError(ok, 400, "validation_failed");
  const over = `${exact} `;
  assert.equal(Buffer.byteLength(over, "utf8"), 64 * 1024 + 1);
  const big = await request(ctx, "POST", "/api/workspace/mkdir", {
    headers: { "Content-Type": "application/json" },
    body: over,
  });
  expectError(big, 413, "payload_too_large");
});
