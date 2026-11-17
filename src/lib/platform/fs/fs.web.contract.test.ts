// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Contract tests for the web FsAdapter (node:test) against a fake fetch
// transport. No V2-06 fake is used: the V2-06 scaffold had not landed
// when this file was written, so the fake below is self-contained. The
// integrator may re-point these cases at the shared fake once it
// exists; the cases assert the V1-09 wire contract, not fake details.
//
// Run without Vitest: bundle with esbuild and run under node --test
// (see the V2-11 report for the exact commands).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PlatformCapabilityError } from "../errors";
import {
  createWebFsAdapter,
  type FetchLike,
  type FetchResponseLike,
  type WebFsFileHandle,
  type WebSocketImpl,
  type WebSocketLike,
} from "./fs.web";
import { BaseDirectory } from "./interface";
import {
  FsAdapterError,
  isFsAdapterError,
  isRevisionConflictError,
} from "./errors";
import type { WatchEvent } from "./interface";

// ---------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
  credentials: string | undefined;
}

class FakeResponse implements FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  private readonly raw: string | Uint8Array;

  constructor(init: {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Uint8Array | unknown;
  }) {
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(init.headers ?? {})) {
      map.set(key.toLowerCase(), value);
    }
    this.headers = { get: (name: string) => map.get(name.toLowerCase()) ?? null };
    if (init.body instanceof Uint8Array) {
      this.raw = init.body;
    } else if (typeof init.body === "string") {
      this.raw = init.body;
    } else if (init.body !== undefined) {
      this.raw = JSON.stringify(init.body);
    } else {
      this.raw = "";
    }
  }

  async text(): Promise<string> {
    return typeof this.raw === "string"
      ? this.raw
      : new TextDecoder().decode(this.raw);
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes =
      typeof this.raw === "string" ? new TextEncoder().encode(this.raw) : this.raw;
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
  }
}

type RouteHandler = (req: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Array<{
    method: string;
    match: (url: string) => boolean;
    handler: RouteHandler;
  }> = [];
  failNextWith: Error | null = null;

  on(method: string, match: (url: string) => boolean, handler: RouteHandler): void {
    this.routes.push({ method, match, handler });
  }

  onPath(
    method: string,
    pathname: string,
    handler: RouteHandler,
  ): void {
    this.on(method, (url) => new URL(url, "http://test.local").pathname === pathname, handler);
  }

  fetch: FetchLike = async (url, init) => {
    const req: RecordedRequest = {
      method: init?.method ?? "GET",
      url,
      headers: { ...(init?.headers ?? {}) },
      body: init?.body,
      credentials: init?.credentials,
    };
    this.requests.push(req);
    if (this.failNextWith) {
      const err = this.failNextWith;
      this.failNextWith = null;
      throw err;
    }
    for (const route of this.routes) {
      if (route.method === req.method && route.match(url)) {
        return route.handler(req);
      }
    }
    return new FakeResponse({
      status: 500,
      body: { code: "internal_error", message: "no route", requestId: "req-test" },
    });
  };
}

function queryOf(url: string): URLSearchParams {
  return new URL(url, "http://test.local").searchParams;
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "x.md",
    path: "x.md",
    isDirectory: false,
    isFile: true,
    size: 5,
    modifiedAt: "2026-11-14T13:00:00.000Z",
    createdAt: "2026-11-14T12:00:00.000Z",
    revision: "sha256:aaa",
    version: 3,
    isLocale: true,
    ...overrides,
  };
}

function errorBody(code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { code, message: `message for ${code}`, detail: "d", requestId: "req-1", ...extra };
}

function conflictBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return errorBody("revision_conflict", {
    path: "x.md",
    serverRevision: "sha256:server",
    serverVersion: 11,
    serverModifiedAt: "2026-11-14T13:08:00.000Z",
    serverSize: 2048,
    currentPreview: "first paragraph",
    previewTruncated: true,
    suggestedCopyPath: "x (salinan).md",
    actions: ["reload", "saveAsCopy", "forceOverwrite"],
    ...extra,
  });
}

// Canonical wire shapes (kontrak-api-kanonis.md section 2, W4-DEMO
// B1): errors nest code/message/requestId under `error` with per-code
// fields under `error.details`; successes wrap the payload in `data`.
function nestedErrorBody(
  code: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code,
      message: `message for ${code}`,
      requestId: "req-1",
      retryable: false,
      details,
    },
  };
}

function nestedConflictBody(): Record<string, unknown> {
  return nestedErrorBody("revision_conflict", {
    path: "x.md",
    serverRevision: "sha256:server",
    serverVersion: 11,
    serverModifiedAt: "2026-11-14T13:08:00.000Z",
    serverSize: 2048,
    currentPreview: "first paragraph",
    previewTruncated: true,
    suggestedCopyPath: "x (salinan).md",
    actions: ["reload", "saveAsCopy", "forceOverwrite"],
  });
}

function successBody(data: unknown): Record<string, unknown> {
  return { ok: true, data };
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: string,
): Promise<FsAdapterError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(isFsAdapterError(err), `expected FsAdapterError, got ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected rejection with code ${code}`);
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

describe("web FsAdapter reads", () => {
  it("reads text through GET file and encodes the path", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", (req) => {
      assert.equal(queryOf(req.url).get("path"), "my file #1.md");
      return new FakeResponse({
        headers: { "X-Revision": "sha256:aaa", "Content-Type": "text/markdown; charset=utf-8" },
        body: "# hello",
      });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    assert.equal(await fs.readTextFile("my file #1.md"), "# hello");
    assert.ok(fake.requests[0].url.includes("my%20file%20%231.md"));
    assert.equal(fake.requests[0].credentials, "same-origin");
  });

  it("returns revision data from ETag and X-Version", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", () =>
      new FakeResponse({
        headers: {
          ETag: 'W/"sha256:bbb"',
          "X-Version": "7",
          "Last-Modified": "Fri, 14 Nov 2026 13:00:00 GMT",
        },
        body: "body",
      }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const detailed = await fs.readTextFileDetailed("x.md");
    assert.equal(detailed.content, "body");
    assert.equal(detailed.revision, "sha256:bbb");
    assert.equal(detailed.version, 7);
    assert.equal(detailed.modifiedAt, "Fri, 14 Nov 2026 13:00:00 GMT");
  });

  it("prefers X-Revision over ETag", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", () =>
      new FakeResponse({
        headers: { ETag: '"sha256:etag"', "X-Revision": "sha256:xrev" },
        body: "body",
      }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    assert.equal((await fs.readTextFileDetailed("x.md")).revision, "sha256:xrev");
  });

  it("maps 404 to not_found with the request id", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", () =>
      new FakeResponse({ status: 404, body: errorBody("not_found") }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const err = await rejectsWithCode(fs.readTextFile("gone.md"), "not_found");
    assert.equal(err.status, 404);
    assert.equal(err.requestId, "req-1");
    assert.equal(err.path, "gone.md");
  });

  it("maps a nested 404 envelope to not_found so exists() returns false (B1)", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ status: 404, body: nestedErrorBody("not_found") }),
    );
    fake.onPath("GET", "/api/workspace/file", () =>
      new FakeResponse({ status: 404, body: nestedErrorBody("not_found") }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    assert.equal(await fs.exists("gone.md"), false);
    const err = await rejectsWithCode(fs.readTextFile("gone.md"), "not_found");
    assert.equal(err.status, 404);
    assert.equal(err.message, "message for not_found");
    assert.equal(err.requestId, "req-1");
  });

  it("maps a nested 412 envelope to revision_conflict with details payload (B1)", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ body: successBody(entry({ revision: "sha256:stale" })) }),
    );
    fake.onPath("PUT", "/api/workspace/file", () =>
      new FakeResponse({ status: 412, body: nestedConflictBody() }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const err = await rejectsWithCode(fs.writeTextFile("x.md", "v2"), "revision_conflict");
    assert.equal(err.status, 412);
    assert.equal(err.conflict?.serverRevision, "sha256:server");
    assert.equal(err.conflict?.serverVersion, 11);
    assert.equal(err.conflict?.suggestedCopyPath, "x (salinan).md");
    assert.equal(err.conflict?.previewTruncated, true);
  });

  it("reads diskWritten from nested error details (B1)", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", () =>
      new FakeResponse({
        status: 500,
        body: nestedErrorBody("index_update_failed", {
          diskWritten: true,
          revision: "sha256:new",
          path: "x.md",
        }),
      }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const err = await rejectsWithCode(fs.readTextFile("x.md"), "index_update_failed");
    assert.equal(err.diskWritten, true);
  });

  it("unwraps success envelopes for stat and list (B1/B5)", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ body: successBody(entry({ revision: "sha256:aaa" })) }),
    );
    fake.onPath("GET", "/api/workspace/list", () =>
      new FakeResponse({
        body: successBody({
          path: "",
          entries: [entry({ name: "notes", path: "notes", isDirectory: true, isFile: false, size: null, revision: null, version: null })],
          nextCursor: null,
        }),
      }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    assert.equal(await fs.exists("x.md"), true);
    const entries = await fs.readDir("");
    assert.deepEqual(entries.map((e) => e.name), ["notes"]);
    assert.equal(entries[0].isDirectory, true);
  });

  it("maps 415, 401 and 403 codes without rewriting them", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", (req) => {
      const path = queryOf(req.url).get("path");
      if (path === "pic.png") {
        return new FakeResponse({ status: 415, body: errorBody("not_text_file") });
      }
      if (path === "locked.md") {
        return new FakeResponse({ status: 401, body: errorBody("unauthenticated") });
      }
      return new FakeResponse({ status: 403, body: errorBody("csrf_invalid") });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await rejectsWithCode(fs.readTextFile("pic.png"), "not_text_file");
    await rejectsWithCode(fs.readTextFile("locked.md"), "unauthenticated");
    await rejectsWithCode(fs.readTextFile("other.md"), "csrf_invalid");
  });

  it("maps 429 with Retry-After", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", () =>
      new FakeResponse({
        status: 429,
        headers: { "Retry-After": "5" },
        body: errorBody("rate_limited"),
      }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const err = await rejectsWithCode(fs.readTextFile("x.md"), "rate_limited");
    assert.equal(err.retryAfterSeconds, 5);
  });

  it("maps a network failure to network_error with status 0", async () => {
    const fake = new FakeFetch();
    fake.failNextWith = new TypeError("fetch failed");
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const err = await rejectsWithCode(fs.readTextFile("x.md"), "network_error");
    assert.equal(err.status, 0);
  });

  it("maps a non-JSON error body to a generic error with the status", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", () =>
      new FakeResponse({ status: 502, body: "<html>bad gateway</html>" }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const err = await rejectsWithCode(fs.readTextFile("x.md"), "internal_error");
    assert.equal(err.status, 502);
  });

  it("reads binary through the media endpoint with per-segment encoding", async () => {
    const fake = new FakeFetch();
    fake.on(
      "GET",
      (url) => new URL(url, "http://test.local").pathname.startsWith("/api/workspace/media/"),
      (req) => {
        assert.equal(
          new URL(req.url, "http://test.local").pathname,
          "/api/workspace/media/a%20b/c%23d.png",
        );
        return new FakeResponse({
          headers: { ETag: '"sha256:img"' },
          body: new Uint8Array([1, 2, 3]),
        });
      },
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const data = await fs.readFile("a b/c#d.png");
    assert.deepEqual([...data], [1, 2, 3]);
  });

  it("ignores unknown response fields", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ body: entry({ futureField: { nested: true } }) }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const info = await fs.stat("x.md");
    assert.equal(info.isFile, true);
    assert.equal(info.revision, "sha256:aaa");
  });
});

// ---------------------------------------------------------------------
// Writes and guards
// ---------------------------------------------------------------------

describe("web FsAdapter writes", () => {
  function statThenPut(fake: FakeFetch, putStatus = 200, putBody: unknown = {}): void {
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ status: 404, body: errorBody("not_found") }),
    );
    fake.onPath("PUT", "/api/workspace/file", () =>
      new FakeResponse({ status: putStatus, body: putBody }),
    );
  }

  it("creates a missing file with If-None-Match and a CSRF header", async () => {
    const fake = new FakeFetch();
    statThenPut(fake, 201, { path: "x.md", revision: "sha256:new", version: 1 });
    const fs = createWebFsAdapter({
      fetchImpl: fake.fetch,
      getCsrfToken: () => "tok-123",
    });
    await fs.writeTextFile("x.md", "hello");
    const put = fake.requests.find((r) => r.method === "PUT");
    assert.ok(put);
    assert.equal(put.headers["If-None-Match"], "*");
    assert.equal(put.headers["X-CSRF-Token"], "tok-123");
    assert.equal(put.body, "hello");
    const get = fake.requests.find((r) => r.method === "GET");
    assert.ok(get);
    assert.equal(get.headers["X-CSRF-Token"], undefined);
  });

  it("overwrites an existing file with If-Match from stat", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ body: entry({ revision: "sha256:old" }) }),
    );
    fake.onPath("PUT", "/api/workspace/file", () =>
      new FakeResponse({ body: { path: "x.md", revision: "sha256:new", version: 4 } }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await fs.writeTextFile("x.md", "v2");
    const put = fake.requests.find((r) => r.method === "PUT");
    assert.equal(put?.headers["If-Match"], '"sha256:old"');
  });

  it("uses an explicit expectedRevision without a stat round trip", async () => {
    const fake = new FakeFetch();
    fake.onPath("PUT", "/api/workspace/file", () =>
      new FakeResponse({ body: {} }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await fs.writeTextFile("x.md", "v2", { expectedRevision: "sha256:known" });
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].headers["If-Match"], '"sha256:known"');
  });

  it("maps createNew collisions to already_exists", async () => {
    const fake = new FakeFetch();
    fake.onPath("PUT", "/api/workspace/file", () =>
      new FakeResponse({ status: 409, body: errorBody("already_exists") }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const err = await rejectsWithCode(
      fs.writeTextFile("x.md", "v", { createNew: true }),
      "already_exists",
    );
    assert.equal(fake.requests[0].headers["If-None-Match"], "*");
    assert.equal(err.status, 409);
  });

  it("maps 412 to revision_conflict with the conflict payload", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ body: entry({ revision: "sha256:stale" }) }),
    );
    fake.onPath("PUT", "/api/workspace/file", () =>
      new FakeResponse({ status: 412, body: conflictBody() }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const err = await rejectsWithCode(fs.writeTextFile("x.md", "v2"), "revision_conflict");
    assert.equal(err.status, 412);
    assert.ok(isRevisionConflictError(err));
    assert.equal(err.conflict?.serverRevision, "sha256:server");
    assert.equal(err.conflict?.serverVersion, 11);
    assert.equal(err.conflict?.suggestedCopyPath, "x (salinan).md");
    assert.deepEqual(err.conflict?.actions, ["reload", "saveAsCopy", "forceOverwrite"]);
    assert.equal(err.conflict?.previewTruncated, true);
  });

  it("writes with If-Match star only when force is explicit", async () => {
    const fake = new FakeFetch();
    fake.onPath("PUT", "/api/workspace/file", () =>
      new FakeResponse({ body: {} }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await fs.writeTextFile("x.md", "v2", { force: true });
    assert.equal(fake.requests[0].headers["If-Match"], "*");
  });

  it("refuses create:false for a missing file without a PUT", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ status: 404, body: errorBody("not_found") }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await rejectsWithCode(
      fs.writeTextFile("x.md", "v", { create: false }),
      "not_found",
    );
    assert.equal(fake.requests.filter((r) => r.method === "PUT").length, 0);
  });

  it("appends through the append endpoint and normalizes 409 version_conflict", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ body: entry({ revision: "sha256:cur" }) }),
    );
    fake.onPath("POST", "/api/workspace/file/append", (req) => {
      const body = JSON.parse(req.body as string) as Record<string, unknown>;
      assert.equal(body.expectedRevision, "sha256:cur");
      assert.equal(body.content, "\nmore");
      assert.equal(body.force, false);
      return new FakeResponse({
        status: 409,
        body: conflictBody({ code: "version_conflict", failedOperation: "append" }),
      });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const err = await rejectsWithCode(
      fs.writeTextFile("x.md", "\nmore", { append: true }),
      "revision_conflict",
    );
    assert.equal(err.status, 409);
    assert.equal(err.conflict?.failedOperation, "append");
  });

  it("appends binary by read-modify-write with the read revision", async () => {
    const fake = new FakeFetch();
    fake.on(
      "GET",
      (url) => new URL(url, "http://test.local").pathname === "/api/workspace/media/a.png",
      () =>
        new FakeResponse({
          headers: { ETag: '"sha256:img1"' },
          body: new Uint8Array([1, 2]),
        }),
    );
    fake.onPath("PUT", "/api/workspace/media", (req) => {
      assert.equal(req.headers["If-Match"], '"sha256:img1"');
      assert.deepEqual([...(req.body as Uint8Array)], [1, 2, 3]);
      return new FakeResponse({ body: {} });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await fs.writeFile("a.png", new Uint8Array([3]), { append: true });
  });

  it("writes new binary through PUT media with If-None-Match", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ status: 404, body: errorBody("not_found") }),
    );
    fake.onPath("PUT", "/api/workspace/media", (req) => {
      assert.equal(req.headers["If-None-Match"], "*");
      assert.equal(queryOf(req.url).get("path"), "a.png");
      return new FakeResponse({ status: 201, body: {} });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await fs.writeFile("a.png", new Uint8Array([9]));
  });

  it("rejects binary content that is not valid UTF-8 for text paths", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ status: 404, body: errorBody("not_found") }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await rejectsWithCode(
      fs.writeFile("x.md", new Uint8Array([0xff, 0xfe])),
      "invalid_text_encoding",
    );
    assert.equal(fake.requests.filter((r) => r.method === "PUT").length, 0);
  });
});

// ---------------------------------------------------------------------
// Directories, stat, remove, rename, copy
// ---------------------------------------------------------------------

describe("web FsAdapter directories and metadata", () => {
  it("pages through list results and dedupes repeated entries", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/list", (req) => {
      const cursor = queryOf(req.url).get("cursor");
      if (!cursor) {
        return new FakeResponse({
          body: {
            path: "sub",
            entries: [
              entry({ name: "a.md", path: "sub/a.md" }),
              entry({ name: "b.md", path: "sub/b.md" }),
            ],
            nextCursor: "c1",
          },
        });
      }
      assert.equal(cursor, "c1");
      return new FakeResponse({
        body: {
          path: "sub",
          entries: [
            entry({ name: "b.md", path: "sub/b.md" }),
            entry({ name: "c", path: "sub/c", isDirectory: true, isFile: false, size: null, revision: null, version: null }),
          ],
          nextCursor: null,
        },
      });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const entries = await fs.readDir("sub");
    assert.deepEqual(
      entries.map((e) => e.name),
      ["a.md", "b.md", "c"],
    );
    assert.equal(entries[2].isDirectory, true);
    assert.equal(entries[2].isSymlink, false);
  });

  it("creates folders through POST mkdir and treats root as a no-op", async () => {
    const fake = new FakeFetch();
    fake.onPath("POST", "/api/workspace/mkdir", (req) => {
      const body = JSON.parse(req.body as string) as Record<string, unknown>;
      assert.equal(body.path, "sub/new");
      return new FakeResponse({ status: 201, body: { path: "sub/new", created: true } });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await fs.mkdir("sub/new", { recursive: true });
    await fs.mkdir("");
    assert.equal(fake.requests.length, 1);
  });

  it("maps stat entries to FileInfo including revision data", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ body: entry({ size: 1823, version: 7 }) }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const info = await fs.stat("x.md");
    assert.equal(info.isFile, true);
    assert.equal(info.isDirectory, false);
    assert.equal(info.isSymlink, false);
    assert.equal(info.size, 1823);
    assert.equal(info.mtime?.toISOString(), "2026-11-14T13:00:00.000Z");
    assert.equal(info.birthtime?.toISOString(), "2026-11-14T12:00:00.000Z");
    assert.equal(info.atime, null);
    assert.equal(info.revision, "sha256:aaa");
    assert.equal(info.version, 7);
    const linfo = await fs.lstat("x.md");
    assert.equal(linfo.isSymlink, false);
  });

  it("answers exists from stat and true for the root without a request", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", (req) => {
      const path = queryOf(req.url).get("path");
      if (path === "here.md") {
        return new FakeResponse({ body: entry() });
      }
      return new FakeResponse({ status: 404, body: errorBody("not_found") });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    assert.equal(await fs.exists("here.md"), true);
    assert.equal(await fs.exists("gone.md"), false);
    assert.equal(await fs.exists(""), true);
    assert.equal(fake.requests.length, 2);
  });

  it("removes files and folders through the matching trash endpoint", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", (req) => {
      const path = queryOf(req.url).get("path");
      if (path === "dir") {
        return new FakeResponse({
          body: entry({ name: "dir", path: "dir", isDirectory: true, isFile: false, size: null, revision: null, version: null }),
        });
      }
      return new FakeResponse({ body: entry() });
    });
    fake.onPath("GET", "/api/workspace/list", () =>
      new FakeResponse({ body: { path: "dir", entries: [], nextCursor: null } }),
    );
    fake.onPath("DELETE", "/api/workspace/file", () =>
      new FakeResponse({ body: { path: "x.md", trashId: "t1" } }),
    );
    fake.onPath("DELETE", "/api/workspace/folder", () =>
      new FakeResponse({ body: { path: "dir", trashId: "t2" } }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await fs.remove("x.md");
    await fs.remove("dir", { recursive: true });
    const deletes = fake.requests.filter((r) => r.method === "DELETE");
    assert.equal(deletes.length, 2);
    assert.ok(deletes[0].url.startsWith("/api/workspace/file?"));
    assert.ok(deletes[1].url.startsWith("/api/workspace/folder?"));
  });

  it("refuses non-recursive removal of a non-empty folder", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({
        body: entry({ name: "dir", path: "dir", isDirectory: true, isFile: false, size: null, revision: null, version: null }),
      }),
    );
    fake.onPath("GET", "/api/workspace/list", () =>
      new FakeResponse({
        body: { path: "dir", entries: [entry({ name: "a.md", path: "dir/a.md" })], nextCursor: null },
      }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await rejectsWithCode(fs.remove("dir"), "directory_not_empty");
    assert.equal(fake.requests.filter((r) => r.method === "DELETE").length, 0);
  });

  it("renames through POST move with link rewriting by default", async () => {
    const fake = new FakeFetch();
    fake.onPath("POST", "/api/workspace/move", (req) => {
      const body = JSON.parse(req.body as string) as Record<string, unknown>;
      assert.equal(body.source, "old.md");
      assert.equal(body.target, "new.md");
      assert.equal(body.rewriteLinks, true);
      return new FakeResponse({
        body: {
          source: "old.md",
          target: "new.md",
          kind: "file",
          rewriteLinks: true,
          rewriteStatus: "complete",
          revision: "sha256:moved",
          rewrittenFiles: [],
          skipped: [],
          pending: [],
          affectedCount: 1,
          indexHookWarning: null,
        },
      });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const result = await fs.renameWithResult("old.md", "new.md");
    assert.equal(result.revision, "sha256:moved");
    assert.equal(result.rewriteStatus, "complete");
    await fs.rename("old.md", "new.md");
  });

  it("reports partial link rewrites through renameWithResult", async () => {
    const fake = new FakeFetch();
    fake.onPath("POST", "/api/workspace/move", () =>
      new FakeResponse({
        body: {
          source: "old.md",
          target: "new.md",
          kind: "file",
          rewriteLinks: true,
          rewriteStatus: "partial",
          revision: "sha256:moved",
          rewrittenFiles: [
            { path: "index.md", oldRevision: "sha256:a", newRevision: "sha256:b", replacements: 2 },
          ],
          skipped: [{ path: "draft.md", reason: "revision_changed", detail: "changed during scan" }],
          pending: [],
          affectedCount: 1,
          indexHookWarning: null,
        },
      }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const result = await fs.renameWithResult("old.md", "new.md");
    assert.equal(result.rewriteStatus, "partial");
    assert.equal(result.rewrittenFiles.length, 1);
    assert.equal(result.skipped[0].reason, "revision_changed");
  });

  it("copies by read plus guarded write", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", () =>
      new FakeResponse({
        headers: { "X-Revision": "sha256:src" },
        body: "copied",
      }),
    );
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ status: 404, body: errorBody("not_found") }),
    );
    fake.onPath("PUT", "/api/workspace/file", (req) => {
      assert.equal(req.body, "copied");
      assert.equal(req.headers["If-None-Match"], "*");
      return new FakeResponse({ status: 201, body: {} });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await fs.copyFile("src.md", "dst.md");
  });
});

// ---------------------------------------------------------------------
// File handles
// ---------------------------------------------------------------------

describe("web FsAdapter open handles", () => {
  it("reads sequentially, seeks, and reports EOF", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({ body: entry({ size: 5 }) }),
    );
    fake.onPath("GET", "/api/workspace/file", () =>
      new FakeResponse({ body: "hello" }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const handle = await fs.open("article/x.md", { read: true, baseDir: BaseDirectory.AppData });
    // seek() is web-implementation behavior beyond the canonical
    // FsFileHandle surface (audit V2-40); narrow for this test only.
    const seekable = handle as WebFsFileHandle;
    const info = await handle.stat();
    assert.equal(info.isFile, true);
    const buf = new Uint8Array(3);
    assert.equal(await handle.read(buf), 3);
    assert.equal(new TextDecoder().decode(buf), "hel");
    assert.equal(await seekable.seek(0, 0), 0);
    const all = new Uint8Array(10);
    assert.equal(await handle.read(all), 5);
    assert.equal(await handle.read(all), null);
    assert.equal(await seekable.seek(-2, 2), 3);
    const tail = new Uint8Array(2);
    assert.equal(await handle.read(tail), 2);
    assert.equal(new TextDecoder().decode(tail), "lo");
    await handle.close();
    await handle.close();
  });

  it("rejects writable handles with a capability error", async () => {
    const fake = new FakeFetch();
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await assert.rejects(
      fs.open("x.md", { write: true }),
      (err: unknown) => err instanceof PlatformCapabilityError,
    );
    assert.equal(fake.requests.length, 0);
  });

  it("rejects opening a directory as a file", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/stat", () =>
      new FakeResponse({
        body: entry({ name: "dir", path: "dir", isDirectory: true, isFile: false, size: null, revision: null, version: null }),
      }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await rejectsWithCode(fs.open("dir", { read: true }), "not_a_file");
  });
});

// ---------------------------------------------------------------------
// Client-side path validation (defense in depth)
// ---------------------------------------------------------------------

describe("web FsAdapter path validation", () => {
  it("strips the article prefix for AppData paths", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", (req) => {
      assert.equal(queryOf(req.url).get("path"), "sub/x.md");
      return new FakeResponse({ body: "ok" });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    assert.equal(
      await fs.readTextFile("article/sub/x.md", { baseDir: BaseDirectory.AppData }),
      "ok",
    );
  });

  it("maps the virtual app-data prefix to workspace paths", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", (req) => {
      assert.equal(queryOf(req.url).get("path"), "x.md");
      return new FakeResponse({ body: "ok" });
    });
    fake.onPath("GET", "/api/workspace/list", () =>
      new FakeResponse({ body: { path: "", entries: [], nextCursor: null } }),
    );
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    assert.equal(await fs.readTextFile("/appdata/article/x.md"), "ok");
    assert.deepEqual(await fs.readDir("/appdata/article"), []);
  });

  it("rejects app-data paths outside the workspace without a request", async () => {
    const fake = new FakeFetch();
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await assert.rejects(
      fs.readTextFile("image/a.png", { baseDir: BaseDirectory.AppData }),
      (err: unknown) => err instanceof PlatformCapabilityError,
    );
    await assert.rejects(
      fs.readTextFile("/appdata/workspaces/self-hosted/x.md"),
      (err: unknown) => err instanceof PlatformCapabilityError,
    );
    await assert.rejects(
      fs.readTextFile("/appconfig/settings.json"),
      (err: unknown) => err instanceof PlatformCapabilityError,
    );
    await assert.rejects(
      fs.readTextFile("x.md", { baseDir: BaseDirectory.AppConfig }),
      (err: unknown) => err instanceof PlatformCapabilityError,
    );
    assert.equal(fake.requests.length, 0);
  });

  it("rejects traversal, absolute, and malformed paths without a request", async () => {
    const fake = new FakeFetch();
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    const bad = [
      "../x.md",
      "a/../../x.md",
      "a/../..",
      "/etc/passwd",
      "C:/secret.txt",
      "C:\\secret.txt",
      "x\u0000.md",
      "x\u0001.md",
      `${"a/".repeat(51)}x.md`,
      `${"a".repeat(1025)}.md`,
    ];
    for (const path of bad) {
      await rejectsWithCode(fs.readTextFile(path), "invalid_path");
    }
    assert.equal(fake.requests.length, 0);
  });

  it("normalizes harmless dot segments and duplicate separators", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", (req) => {
      assert.equal(queryOf(req.url).get("path"), "a/b.md");
      return new FakeResponse({ body: "ok" });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    assert.equal(await fs.readTextFile("./a//./b.md"), "ok");
    assert.equal(await fs.readTextFile("a\\b.md"), "ok");
  });

  it("keeps a bare article/ path as a real workspace folder", async () => {
    const fake = new FakeFetch();
    fake.onPath("GET", "/api/workspace/file", (req) => {
      assert.equal(queryOf(req.url).get("path"), "article/x.md");
      return new FakeResponse({ body: "ok" });
    });
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    assert.equal(await fs.readTextFile("article/x.md"), "ok");
  });

  it("rejects removing or writing the workspace root", async () => {
    const fake = new FakeFetch();
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch });
    await rejectsWithCode(fs.remove(""), "invalid_path");
    await rejectsWithCode(fs.writeTextFile("", "x"), "invalid_path");
    await rejectsWithCode(fs.readTextFile(""), "invalid_path");
    assert.equal(fake.requests.length, 0);
  });
});

// ---------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  readonly url: string;
  readonly sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.({});
  }

  emitMessage(value: unknown): void {
    this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) });
  }

  emitClose(code?: number): void {
    this.onclose?.({ code });
  }
}

const fakeSocketCtor = FakeWebSocket as unknown as WebSocketImpl;

function serverEvent(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "workspace-file-changed",
    seq: 11,
    kind: "created",
    path: "x.md",
    previousPath: null,
    workspaceRoot: "default",
    revision: "sha256:aaa",
    modifiedAt: "2026-11-14T13:00:00.000Z",
    isDirectory: false,
    actor: "other",
    originConnectionId: "conn-1",
    ...overrides,
  };
}

async function waitFor(
  check: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("web FsAdapter watch over WebSocket", () => {
  it("translates server events to WatchEvent shapes with virtual paths", async () => {
    FakeWebSocket.reset();
    const fake = new FakeFetch();
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch, webSocketImpl: fakeSocketCtor });
    const events: WatchEvent[] = [];
    const unwatch = await fs.watch("/appdata/article", (e) => events.push(e));
    assert.equal(FakeWebSocket.instances.length, 1);
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket.url.endsWith("/api/workspace/events"));
    socket.emitOpen();
    socket.emitMessage({
      type: "hello",
      protocolVersion: 1,
      workspaceRoot: "default",
      serverTime: "2026-11-14T13:00:00.000Z",
      lastSeq: 10,
      connectionId: "conn-1",
    });
    socket.emitMessage(serverEvent({ seq: 11, kind: "created", path: "x.md" }));
    socket.emitMessage(serverEvent({ seq: 11, kind: "created", path: "x.md" }));
    socket.emitMessage(serverEvent({ seq: 12, kind: "changed", path: ".hidden/x.md" }));
    socket.emitMessage(
      serverEvent({ seq: 13, kind: "moved", path: "b.md", previousPath: "a.md" }),
    );
    socket.emitMessage(serverEvent({ seq: 14, kind: "rescan", path: "", revision: null, modifiedAt: null }));
    socket.emitMessage({
      type: "batch",
      events: [
        serverEvent({ seq: 15, kind: "deleted", path: "gone.md" }),
        serverEvent({ seq: 16, kind: "created", path: "dir", isDirectory: true }),
      ],
    });
    assert.equal(events.length, 5);
    assert.deepEqual(events[0].type, { create: { kind: "file" } });
    assert.deepEqual(events[0].paths, ["/appdata/article/x.md"]);
    assert.deepEqual(events[1].type, { modify: { kind: "rename", mode: "both" } });
    assert.deepEqual(events[1].paths, ["/appdata/article/a.md", "/appdata/article/b.md"]);
    assert.equal(events[2].type, "any");
    assert.deepEqual(events[2].paths, ["/appdata/article"]);
    assert.deepEqual(events[3].type, { remove: { kind: "file" } });
    assert.deepEqual(events[4].type, { create: { kind: "folder" } });
    unwatch();
    assert.equal(socket.closed, true);
    socket.emitMessage(serverEvent({ seq: 17, kind: "created", path: "late.md" }));
    assert.equal(events.length, 5);
  });

  it("requests resync on a sequence gap and on resync-required", async () => {
    FakeWebSocket.reset();
    const fake = new FakeFetch();
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch, webSocketImpl: fakeSocketCtor });
    const events: WatchEvent[] = [];
    const unwatch = await fs.watch("", (e) => events.push(e));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitMessage({ type: "hello", lastSeq: 10 });
    socket.emitMessage(serverEvent({ seq: 11 }));
    socket.emitMessage(serverEvent({ seq: 20, path: "gap.md" }));
    assert.equal(events.length, 2);
    assert.equal(socket.sent.length, 1);
    const resync = JSON.parse(socket.sent[0]) as Record<string, unknown>;
    assert.equal(resync.type, "resync");
    assert.equal(resync.sinceSeq, 11);
    socket.emitMessage({ type: "resync-required", lastSeq: 20 });
    assert.equal(events.length, 3);
    assert.equal(events[2].type, "any");
    unwatch();
  });

  it("filters events to the watched subtree", async () => {
    FakeWebSocket.reset();
    const fake = new FakeFetch();
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch, webSocketImpl: fakeSocketCtor });
    const events: WatchEvent[] = [];
    const unwatch = await fs.watch("sub", (e) => events.push(e));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitMessage({ type: "hello", lastSeq: 0 });
    socket.emitMessage(serverEvent({ seq: 1, path: "other/x.md" }));
    socket.emitMessage(serverEvent({ seq: 2, path: "sub/x.md" }));
    socket.emitMessage(serverEvent({ seq: 3, path: "sub" }));
    assert.equal(events.length, 2);
    assert.deepEqual(events[0].paths, ["/appdata/article/sub/x.md"]);
    unwatch();
  });

  it("rejects out-of-root watch paths before connecting", async () => {
    FakeWebSocket.reset();
    const fake = new FakeFetch();
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch, webSocketImpl: fakeSocketCtor });
    await rejectsWithCode(fs.watch("../evil", () => {}), "invalid_path");
    assert.equal(FakeWebSocket.instances.length, 0);
  });

  it("ignores malformed messages", async () => {
    FakeWebSocket.reset();
    const fake = new FakeFetch();
    const fs = createWebFsAdapter({ fetchImpl: fake.fetch, webSocketImpl: fakeSocketCtor });
    const events: WatchEvent[] = [];
    const unwatch = await fs.watch("", (e) => events.push(e));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitMessage("{not json");
    socket.emitMessage("42");
    socket.emitMessage({ type: "pong" });
    socket.emitMessage(serverEvent({ seq: 1 }));
    assert.equal(events.length, 1);
    unwatch();
  });
});

describe("web FsAdapter watch polling fallback", () => {
  it("detects changes by snapshot comparison when WebSocket is disabled", async () => {
    const fake = new FakeFetch();
    let files: Array<Record<string, unknown>> = [entry({ name: "a.md", path: "a.md" })];
    fake.onPath("GET", "/api/workspace/list", () =>
      new FakeResponse({ body: { path: "", entries: files, nextCursor: null } }),
    );
    const fs = createWebFsAdapter({
      fetchImpl: fake.fetch,
      webSocketImpl: null,
      watchPollIntervalMs: 5,
    });
    const events: WatchEvent[] = [];
    const unwatch = await fs.watch("", (e) => events.push(e));
    await waitFor(() => fake.requests.length >= 2, "baseline polls");
    assert.equal(events.length, 0);
    files = [
      entry({ name: "a.md", path: "a.md" }),
      entry({ name: "b.md", path: "b.md", revision: "sha256:b" }),
    ];
    await waitFor(() => events.length >= 1, "created event for b.md");
    assert.deepEqual(events[0].type, { create: { kind: "file" } });
    assert.deepEqual(events[0].paths, ["/appdata/article/b.md"]);
    unwatch();
    const countAfterUnwatch = fake.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fake.requests.length, countAfterUnwatch);
  });

  it("starts polling when a connected socket stays silent after hello", async () => {
    FakeWebSocket.reset();
    const fake = new FakeFetch();
    let files: Array<Record<string, unknown>> = [entry({ name: "a.md", path: "a.md" })];
    fake.onPath("GET", "/api/workspace/list", () =>
      new FakeResponse({ body: { path: "", entries: files, nextCursor: null } }),
    );
    const fs = createWebFsAdapter({
      fetchImpl: fake.fetch,
      webSocketImpl: fakeSocketCtor,
      watchPollIntervalMs: 5,
    });
    const events: WatchEvent[] = [];
    const unwatch = await fs.watch("", (e) => events.push(e));
    assert.equal(FakeWebSocket.instances.length, 1);
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitMessage({ type: "hello", lastSeq: 0 });
    // D-WATCHER: silence after hello must arm polling while the
    // socket stays connected; baseline polls establish the snapshot.
    await waitFor(() => fake.requests.length >= 2, "silence polls");
    assert.equal(socket.closed, false);
    assert.equal(events.length, 0);
    files = [
      entry({ name: "a.md", path: "a.md" }),
      entry({ name: "b.md", path: "b.md", revision: "sha256:b" }),
    ];
    await waitFor(() => events.length >= 1, "created event for b.md");
    assert.deepEqual(events[0].type, { create: { kind: "file" } });
    assert.deepEqual(events[0].paths, ["/appdata/article/b.md"]);
    unwatch();
    const countAfterUnwatch = fake.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fake.requests.length, countAfterUnwatch);
  });
});
