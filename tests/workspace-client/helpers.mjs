// SPDX-License-Identifier: GPL-3.0-only
// Shared helpers for the workspace client conformance suite.
//
// The same suite runs in two modes:
// - Mock mode (default): a fresh in-process mock server per test
//   file. Fixture-dependent cases run.
// - Real-backend mode: WORKSPACE_BASE_URL points at a deployed
//   backend. Auth comes from WORKSPACE_COOKIE, WORKSPACE_CSRF_TOKEN,
//   and WORKSPACE_ORIGIN. Fixture-dependent cases are skipped.
//
// All test data lives under one unique prefix folder per test file
// so parallel runs and real-backend runs do not collide.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { after } from "node:test";
import { MOCK_CSRF_TOKEN, MOCK_SESSION_COOKIE, startMockServer } from "./mock-server.mjs";

export async function setupContext() {
  const externalBase = process.env.WORKSPACE_BASE_URL
    ? process.env.WORKSPACE_BASE_URL.replace(/\/+$/, "")
    : null;
  let mock = null;
  let baseUrl = externalBase;
  if (!externalBase) {
    mock = await startMockServer();
    baseUrl = mock.baseUrl;
    after(async () => {
      await mock.close();
    });
  }
  const isMock = mock !== null;
  const ctx = {
    baseUrl,
    isMock,
    store: mock ? mock.store : null,
    prefix: `wsct-${randomUUID().slice(0, 8)}`,
    cookie: isMock
      ? `session=${MOCK_SESSION_COOKIE}`
      : process.env.WORKSPACE_COOKIE || "",
    csrfToken: isMock ? MOCK_CSRF_TOKEN : process.env.WORKSPACE_CSRF_TOKEN || "",
    origin: process.env.WORKSPACE_ORIGIN || new URL(baseUrl).origin,
  };
  ctx.path = (...segments) => `${ctx.prefix}/${segments.join("/")}`;
  return ctx;
}

// Skip option for fixture-dependent cases. Usage:
// test("...", skipUnlessMock(ctx), async () => { ... })
export function skipUnlessMock(ctx, reason = "requires mock fixtures") {
  return { skip: ctx.isMock ? false : reason };
}

const MUTATION_METHODS = new Set(["PUT", "POST", "PATCH", "DELETE"]);

export async function request(ctx, method, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const auth = options.auth === undefined ? "full" : options.auth;
  const isMutation = MUTATION_METHODS.has(method);
  if (auth === "full") {
    if (ctx.cookie) headers.Cookie = ctx.cookie;
    if (isMutation) {
      if (ctx.csrfToken) headers["X-CSRF-Token"] = ctx.csrfToken;
      headers.Origin = ctx.origin;
    }
  } else if (auth === "no-cookie") {
    if (isMutation) {
      if (ctx.csrfToken) headers["X-CSRF-Token"] = ctx.csrfToken;
      headers.Origin = ctx.origin;
    }
  } else if (auth === "no-csrf") {
    if (ctx.cookie) headers.Cookie = ctx.cookie;
    if (isMutation) headers.Origin = ctx.origin;
  } else if (auth === "no-origin") {
    if (ctx.cookie) headers.Cookie = ctx.cookie;
    if (isMutation && ctx.csrfToken) headers["X-CSRF-Token"] = ctx.csrfToken;
  } else if (auth === "bearer") {
    headers.Authorization = "Bearer mock-bearer-token";
  } else if (auth === "none") {
    // No credentials at all.
  }
  let body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers["Content-Type"] = "application/json";
  } else if (options.body !== undefined) {
    body = options.body;
  }
  const response = await fetch(`${ctx.baseUrl}${path}`, { method, headers, body });
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buffer.toString("utf8"));
  } catch {
    json = null;
  }
  return {
    status: response.status,
    headers: response.headers,
    text: buffer.toString("utf8"),
    bytes: buffer,
    json,
  };
}

// Raw HTTP request without URL normalization, for encoded-path cases
// that fetch would rewrite before sending. HTTP only; used by
// mock-mode cases against the local mock server.
export function rawRequest(ctx, method, rawPath, headers = {}) {
  const target = new URL(ctx.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: Number(target.port),
        method,
        path: rawPath,
        headers: { Cookie: ctx.cookie, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(buffer.toString("utf8"));
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text: buffer.toString("utf8"), bytes: buffer, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export function expectOk(resp, status, label = "") {
  assert.equal(resp.status, status, `${label} expected HTTP ${status}, got ${resp.status}: ${resp.text.slice(0, 300)}`);
  assert.equal(resp.json !== null && typeof resp.json, "object", `${label} expected a JSON body`);
  assert.equal(resp.json.ok, true, `${label} expected ok:true, got ${resp.text.slice(0, 300)}`);
  assert.ok("data" in resp.json, `${label} expected data field`);
  return resp.json.data;
}

export function expectError(resp, status, code, label = "") {
  assert.equal(resp.status, status, `${label} expected HTTP ${status}, got ${resp.status}: ${resp.text.slice(0, 300)}`);
  assert.ok(resp.json !== null, `${label} expected a JSON error body`);
  assert.equal(resp.json.ok, false, `${label} expected ok:false`);
  const error = resp.json.error;
  assert.equal(typeof error, "object", `${label} expected error object`);
  assert.equal(error.code, code, `${label} expected code ${code}, got ${error.code}: ${resp.text.slice(0, 300)}`);
  assert.equal(typeof error.message, "string", `${label} expected message string`);
  assert.ok(error.message.length > 0, `${label} expected non-empty message`);
  assert.equal(typeof error.requestId, "string", `${label} expected requestId string`);
  assert.ok(error.requestId.length > 0, `${label} expected non-empty requestId`);
  assert.equal(typeof error.retryable, "boolean", `${label} expected retryable boolean`);
  assert.equal(error.retryable, status === 429 || status === 503, `${label} retryable must be true only for 429/503`);
  assert.equal(typeof error.details, "object", `${label} expected details object`);
  assert.ok(error.details !== null && !Array.isArray(error.details), `${label} expected details object`);
  return error;
}

export function assertIsoUtc(value, label = "timestamp") {
  assert.equal(typeof value, "string", `${label} expected string`);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), `${label} expected ISO 8601 UTC, got ${value}`);
  assert.ok(!Number.isNaN(Date.parse(value)), `${label} unparsable: ${value}`);
}

export function assertEntryShape(entry, label = "entry") {
  assert.equal(typeof entry.name, "string", `${label}.name`);
  assert.equal(typeof entry.path, "string", `${label}.path`);
  assert.equal(typeof entry.isDirectory, "boolean", `${label}.isDirectory`);
  assert.equal(typeof entry.isFile, "boolean", `${label}.isFile`);
  assert.equal(entry.isDirectory !== entry.isFile, true, `${label} exactly one of isDirectory/isFile`);
  assert.ok(entry.size === null || Number.isInteger(entry.size), `${label}.size`);
  assert.equal(entry.isLocale, true, `${label}.isLocale`);
  if (!entry.isDirectory) {
    assert.equal(typeof entry.revision, "string", `${label}.revision`);
    assert.ok(entry.revision.startsWith("sha256:"), `${label}.revision prefix`);
    assert.ok(Number.isInteger(entry.version), `${label}.version`);
  }
}

export function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

// --- Convenience operations (assert success) ---
export async function createFile(ctx, path, content) {
  const resp = await request(ctx, "PUT", `/api/workspace/file${query({ path })}`, {
    headers: { "If-None-Match": "*" },
    body: content,
  });
  return expectOk(resp, 201, `create ${path}`);
}

export async function getFileText(ctx, path) {
  const resp = await request(ctx, "GET", `/api/workspace/file${query({ path })}`);
  assert.equal(resp.status, 200, `GET ${path}: ${resp.text.slice(0, 200)}`);
  return resp;
}

export async function getRevision(ctx, path) {
  const resp = await getFileText(ctx, path);
  return resp.headers.get("X-Revision");
}

export async function mkdirOk(ctx, path) {
  const resp = await request(ctx, "POST", "/api/workspace/mkdir", { json: { path } });
  assert.ok(resp.status === 200 || resp.status === 201, `mkdir ${path}: ${resp.text.slice(0, 200)}`);
  return expectOk(resp, resp.status, `mkdir ${path}`);
}

export async function listTrash(ctx) {
  const resp = await request(ctx, "GET", "/api/workspace/trash?limit=200");
  return expectOk(resp, 200, "list trash");
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
