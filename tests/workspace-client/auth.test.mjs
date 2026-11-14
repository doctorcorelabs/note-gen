// SPDX-License-Identifier: GPL-3.0-only
// Conformance: session auth, CSRF plus Origin checks, Bearer rejection,
// method handling, and the error envelope. Contract:
// kontrak-api-kanonis.md sections 1.2, 1.4, 2.2, 6; V1-09 section 1.2.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createFile,
  expectError,
  query,
  request,
  setupContext,
} from "./helpers.mjs";

const ctx = await setupContext();

test("reads without a session return 401 unauthenticated", async () => {
  const list = await request(ctx, "GET", "/api/workspace/list", { auth: "none" });
  expectError(list, 401, "unauthenticated");
  const file = await request(ctx, "GET", `/api/workspace/file${query({ path: ctx.path("auth", "x.md") })}`, { auth: "no-cookie" });
  expectError(file, 401, "unauthenticated");
  const trash = await request(ctx, "GET", "/api/workspace/trash", { auth: "none" });
  expectError(trash, 401, "unauthenticated");
  const reconcile = await request(ctx, "GET", "/api/workspace/reconcile", { auth: "none" });
  expectError(reconcile, 401, "unauthenticated");
});

test("mutations without a session return 401 before CSRF is evaluated", async () => {
  const mk = await request(ctx, "POST", "/api/workspace/mkdir", {
    auth: "none",
    json: { path: ctx.path("auth", "nosession") },
  });
  expectError(mk, 401, "unauthenticated");
  const put = await request(ctx, "PUT", `/api/workspace/file${query({ path: ctx.path("auth", "nosession.md") })}`, {
    auth: "no-cookie",
    headers: { "If-None-Match": "*" },
    body: "x",
  });
  expectError(put, 401, "unauthenticated");
});

test("Bearer-only requests return 401: no Bearer path in MVP", async () => {
  const list = await request(ctx, "GET", "/api/workspace/list", { auth: "bearer" });
  expectError(list, 401, "unauthenticated");
  const mk = await request(ctx, "POST", "/api/workspace/mkdir", {
    auth: "bearer",
    json: { path: ctx.path("auth", "bearer") },
  });
  expectError(mk, 401, "unauthenticated");
});

test("mutations without a CSRF token return 403 csrf_invalid", async () => {
  const mk = await request(ctx, "POST", "/api/workspace/mkdir", {
    auth: "no-csrf",
    json: { path: ctx.path("auth", "nocsrf") },
  });
  expectError(mk, 403, "csrf_invalid");
  const put = await request(ctx, "PUT", `/api/workspace/file${query({ path: ctx.path("auth", "nocsrf.md") })}`, {
    auth: "no-csrf",
    headers: { "If-None-Match": "*" },
    body: "x",
  });
  expectError(put, 403, "csrf_invalid");
  const del = await request(ctx, "DELETE", `/api/workspace/file${query({ path: ctx.path("auth", "nocsrf.md") })}`, {
    auth: "no-csrf",
  });
  expectError(del, 403, "csrf_invalid");
});

test("mutations with a wrong CSRF token return 403 csrf_invalid", async () => {
  const resp = await request(ctx, "POST", "/api/workspace/mkdir", {
    auth: "no-csrf",
    headers: { "X-CSRF-Token": "wrong-token" },
    json: { path: ctx.path("auth", "wrongcsrf") },
  });
  // The helper adds no CSRF header in no-csrf mode, so the wrong token
  // supplied here is the one the server sees.
  expectError(resp, 403, "csrf_invalid");
});

test("mutations without Origin or with a wrong Origin return 403 origin_rejected", async () => {
  const noOrigin = await request(ctx, "POST", "/api/workspace/mkdir", {
    auth: "no-origin",
    json: { path: ctx.path("auth", "noorigin") },
  });
  expectError(noOrigin, 403, "origin_rejected");
  const wrongOrigin = await request(ctx, "POST", "/api/workspace/mkdir", {
    auth: "no-origin",
    headers: { Origin: "https://evil.example.invalid" },
    json: { path: ctx.path("auth", "wrongorigin") },
  });
  expectError(wrongOrigin, 403, "origin_rejected");
});

test("CSRF and Origin rejections share one generic message, differing only by code", async () => {
  const csrf = await request(ctx, "POST", "/api/workspace/mkdir", {
    auth: "no-csrf",
    json: { path: ctx.path("auth", "msg-csrf") },
  });
  const csrfError = expectError(csrf, 403, "csrf_invalid");
  const origin = await request(ctx, "POST", "/api/workspace/mkdir", {
    auth: "no-origin",
    json: { path: ctx.path("auth", "msg-origin") },
  });
  const originError = expectError(origin, 403, "origin_rejected");
  assert.equal(originError.message, csrfError.message);
  assert.notEqual(originError.code, csrfError.code);
});

test("GET and HEAD need only the session: no CSRF or Origin check applies", async () => {
  const path = ctx.path("auth", "read-only.md");
  await createFile(ctx, path, "readable");
  const wrongOrigin = await request(ctx, "GET", `/api/workspace/file${query({ path })}`, {
    headers: { Origin: "https://evil.example.invalid" },
  });
  assert.equal(wrongOrigin.status, 200);
  assert.equal(wrongOrigin.text, "readable");
  const head = await request(ctx, "HEAD", `/api/workspace/file${query({ path })}`, {
    auth: "no-csrf",
    headers: { Origin: "https://evil.example.invalid" },
  });
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
});

test("wrong methods on known paths return 405 method_not_allowed", async () => {
  const postList = await request(ctx, "POST", "/api/workspace/list", { json: {} });
  expectError(postList, 405, "method_not_allowed");
  const getMkdir = await request(ctx, "GET", "/api/workspace/mkdir");
  expectError(getMkdir, 405, "method_not_allowed");
  const putTrashId = await request(ctx, "PUT", "/api/workspace/trash/00000000-0000-4000-8000-000000000001", {
    body: "{}",
  });
  expectError(putTrashId, 405, "method_not_allowed");
  const deleteMedia = await request(ctx, "DELETE", `/api/workspace/media/${ctx.path("auth", "x.png")}`);
  expectError(deleteMedia, 405, "method_not_allowed");
  const patchFile = await request(ctx, "PATCH", `/api/workspace/file${query({ path: ctx.path("auth", "x.md") })}`, {
    body: "{}",
  });
  expectError(patchFile, 405, "method_not_allowed");
});

test("unknown paths return 404 not_found, never 405", async () => {
  const get = await request(ctx, "GET", "/api/workspace/nope");
  expectError(get, 404, "not_found");
  const post = await request(ctx, "POST", "/api/workspace/nope", { json: {} });
  expectError(post, 404, "not_found");
  const outside = await request(ctx, "GET", "/other/path");
  expectError(outside, 404, "not_found");
});

test("405 still requires a session first", async () => {
  const resp = await request(ctx, "POST", "/api/workspace/list", { auth: "none", json: {} });
  expectError(resp, 401, "unauthenticated");
});

test("success envelope is exactly ok plus data", async () => {
  const resp = await request(ctx, "GET", "/api/workspace/list");
  assert.equal(resp.status, 200);
  assert.equal(resp.json.ok, true);
  assert.ok("data" in resp.json);
  assert.ok(!("error" in resp.json));
  assert.equal(typeof resp.json.data.path, "string");
  assert.ok(Array.isArray(resp.json.data.entries));
});

test("error requestIds are unique per request", async () => {
  const first = await request(ctx, "GET", `/api/workspace/file${query({ path: ctx.path("auth", "ghost-1.md") })}`);
  const firstError = expectError(first, 404, "not_found");
  const second = await request(ctx, "GET", `/api/workspace/file${query({ path: ctx.path("auth", "ghost-2.md") })}`);
  const secondError = expectError(second, 404, "not_found");
  assert.notEqual(secondError.requestId, firstError.requestId);
});

test("a client-sent X-Request-Id is echoed in the error envelope", async () => {
  const sent = `req-conformance-${Date.now()}`;
  const resp = await request(ctx, "GET", `/api/workspace/file${query({ path: ctx.path("auth", "ghost-3.md") })}`, {
    headers: { "X-Request-Id": sent },
  });
  const error = expectError(resp, 404, "not_found");
  assert.equal(error.requestId, sent);
  // The response header is SHOULD: when present it must carry the same id.
  const header = resp.headers.get("X-Request-Id");
  if (header !== null) assert.equal(header, sent);
});

test("error codes are snake_case and retryable is false for 4xx", async () => {
  const resp = await request(ctx, "GET", `/api/workspace/file${query({ path: ctx.path("auth", "ghost-4.md") })}`);
  const error = expectError(resp, 404, "not_found");
  assert.match(error.code, /^[a-z][a-z0-9_]*$/);
  assert.equal(error.retryable, false);
  assert.equal(typeof error.message, "string");
  assert.ok(error.message.length > 0);
  assert.equal(typeof error.details, "object");
});

test("raw text reads keep the raw body and file headers on success", async () => {
  const path = ctx.path("auth", "raw.md");
  const created = await createFile(ctx, path, "raw content");
  const resp = await request(ctx, "GET", `/api/workspace/file${query({ path })}`);
  assert.equal(resp.status, 200);
  assert.equal(resp.text, "raw content");
  assert.equal(resp.json, null);
  assert.equal(resp.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(resp.headers.get("X-Revision"), created.revision);
  assert.equal(resp.headers.get("X-Version"), "1");
  assert.ok(resp.headers.get("Last-Modified"));
});
