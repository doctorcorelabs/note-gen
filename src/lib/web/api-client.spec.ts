// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the centralized web API client (api-client.ts),
 * using the repo convention (node:test with node:assert/strict).
 * Run through an esbuild bundle, because the sources use
 * extensionless imports (bundler module resolution) which raw node
 * cannot resolve:
 *
 *   ./node_modules/.bin/esbuild src/lib/web/api-client.spec.ts \
 *     --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert \
 *     --outfile=<staging-dir>/api-client.spec.mjs
 *   node --test <staging-dir>/api-client.spec.mjs
 *
 * The staging dir lives under ~/workspace (never /tmp for this
 * project). No test in this file sends real HTTP: every case uses
 * an injected fake fetch. The versioned-path strings in the path
 * guard cases are rejection fixtures only; each case asserts the
 * fake fetch was never called, so no versioned request is ever
 * built, let alone sent.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ApiClient,
  createApiClient,
  defaultApiClient,
} from "./api-client";
import {
  ApiError,
  DocumentParseUnavailableError,
  FuzzySearchUnavailableError,
  RestoreUnavailableError,
  type LocalApiErrorCode,
} from "./errors";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

type Responder = (call: CapturedCall) => Response | Promise<Response>;

interface FakeResponseOptions {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  bytes?: ArrayBuffer;
  textError?: unknown;
  arrayBufferError?: unknown;
  onText?: () => void;
  onArrayBuffer?: () => void;
}

function fakeResponse(options: FakeResponseOptions): Response {
  const headerMap = new Map<string, string>();
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headerMap.set(name.toLowerCase(), value);
  }
  const response = {
    status: options.status,
    headers: {
      get(name: string): string | null {
        return headerMap.get(name.toLowerCase()) ?? null;
      },
    },
    text: async (): Promise<string> => {
      options.onText?.();
      if (options.textError !== undefined) {
        throw options.textError;
      }
      return options.body ?? "";
    },
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      options.onArrayBuffer?.();
      if (options.arrayBufferError !== undefined) {
        throw options.arrayBufferError;
      }
      if (options.bytes !== undefined) {
        return options.bytes;
      }
      return new TextEncoder().encode(options.body ?? "").buffer as ArrayBuffer;
    },
  };
  return response as unknown as Response;
}

function makeFetch(responder: Responder): { fetchFn: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: CapturedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function headersOf(call: CapturedCall): Record<string, string> {
  return call.init.headers as unknown as Record<string, string>;
}

function successBody(data: unknown): string {
  return JSON.stringify({ ok: true, data });
}

function errorBody(
  code: string,
  overrides: {
    message?: string;
    requestId?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
    includeRetryable?: boolean;
  } = {},
): string {
  const error: Record<string, unknown> = {
    code,
    message: overrides.message ?? "Something went wrong.",
    requestId: overrides.requestId ?? "req-test-1",
    details: overrides.details ?? {},
  };
  if (overrides.includeRetryable !== false && overrides.retryable !== undefined) {
    error.retryable = overrides.retryable;
  }
  return JSON.stringify({ ok: false, error });
}

async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the promise to reject with ApiError");
}

describe("success envelope", () => {
  it("returns envelope data for object, array, scalar, and null bodies", async () => {
    const { fetchFn } = makeFetch(() => fakeResponse({ status: 200, body: successBody({ a: 1 }) }));
    const client = createApiClient({ fetchFn });
    assert.deepEqual(await client.requestJson("/api/marks"), { a: 1 });

    const arrayFetch = makeFetch(() => fakeResponse({ status: 200, body: successBody([1, 2]) }));
    assert.deepEqual(
      await createApiClient({ fetchFn: arrayFetch.fetchFn }).requestJson("/api/tags"),
      [1, 2],
    );
    const scalarFetch = makeFetch(() => fakeResponse({ status: 200, body: successBody("ok") }));
    assert.equal(
      await createApiClient({ fetchFn: scalarFetch.fetchFn }).requestJson("/api/settings/revision"),
      "ok",
    );
    const nullFetch = makeFetch(() => fakeResponse({ status: 200, body: successBody(null) }));
    assert.equal(
      await createApiClient({ fetchFn: nullFetch.fetchFn }).requestJson("/api/auth/logout"),
      null,
    );
  });

  it("returns data on 201", async () => {
    const { fetchFn } = makeFetch(() => fakeResponse({ status: 201, body: successBody({ id: 7 }) }));
    const client = createApiClient({ fetchFn });
    assert.deepEqual(await client.requestJson("/api/marks", { method: "POST", jsonBody: {} }), {
      id: 7,
    });
  });

  it("returns null on 204 without parsing a body", async () => {
    const { fetchFn } = makeFetch(() => fakeResponse({ status: 204, body: "" }));
    const client = createApiClient({ fetchFn });
    assert.equal(await client.requestJson("/api/csp-reports", { method: "POST" }), null);
  });

  it("convenience helpers send the right method and JSON body", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    await client.getJson("/api/tags");
    await client.postJson("/api/marks", { content: "hi" });
    await client.putJson("/api/marks/1/tags", { tagIds: [2] });
    await client.patchJson("/api/marks/1", { content: "edited" });
    await client.deleteJson("/api/workspace/trash", { confirm: true });
    assert.equal(calls.length, 5);
    assert.equal(calls[0]?.init.method, "GET");
    assert.equal(calls[0]?.init.body, undefined);
    assert.equal(calls[1]?.init.method, "POST");
    assert.equal(calls[1]?.init.body, JSON.stringify({ content: "hi" }));
    assert.equal(headersOf(calls[1] as CapturedCall)["Content-Type"], "application/json");
    assert.equal(calls[2]?.init.method, "PUT");
    assert.equal(calls[3]?.init.method, "PATCH");
    assert.equal(calls[4]?.init.method, "DELETE");
    assert.equal(calls[4]?.init.body, JSON.stringify({ confirm: true }));
  });

  it("postJson without a body sends no body", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    await client.postJson("/api/marks/1/restore");
    assert.equal(calls[0]?.init.body, undefined);
    assert.equal("Content-Type" in headersOf(calls[0] as CapturedCall), false);
  });
});

describe("request shape: same-origin, credentials, headers, query", () => {
  it("sends relative URLs with credentials include on every call", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    await client.requestJson("/api/marks");
    await client.requestText("/api/workspace/file");
    await client.requestBytes("/api/assets/abc");
    await client.requestNoContent("/api/csp-reports", { method: "POST" });
    await client.requestHealth("/api/health/ready");
    assert.equal(calls.length, 5);
    for (const call of calls) {
      assert.ok(call.url.startsWith("/api/"), `URL must stay relative: ${call.url}`);
      assert.equal(call.init.credentials, "include");
    }
  });

  it("passes encoded path segments through verbatim", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    await client.requestJson("/api/assets/abc%2Fdef");
    assert.equal(calls[0]?.url, "/api/assets/abc%2Fdef");
  });

  it("merges path and option query strings, encoding values", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    await client.requestJson("/api/marks?status=trash", {
      query: { limit: 50, q: "a b&c", flag: false, skipMe: null, skipToo: undefined },
    });
    assert.equal(calls[0]?.url, "/api/marks?status=trash&limit=50&q=a+b%26c&flag=false");
  });

  it("accepts string and URLSearchParams query values", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    await client.requestJson("/api/search", { query: "q=hello&scope=all" });
    assert.equal(calls[0]?.url, "/api/search?q=hello&scope=all");
    await client.requestJson("/api/search", { query: new URLSearchParams({ q: "x y" }) });
    assert.equal(calls[1]?.url, "/api/search?q=x+y");
  });

  it("sends a distinct X-Request-Id per request by default", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    await client.requestJson("/api/marks");
    await client.requestJson("/api/tags");
    const first = headersOf(calls[0] as CapturedCall)["X-Request-Id"];
    const second = headersOf(calls[1] as CapturedCall)["X-Request-Id"];
    assert.ok(first !== undefined && first !== "");
    assert.ok(second !== undefined && second !== "");
    assert.notEqual(first, second);
  });

  it("honors an explicit requestId and a requestIdProvider", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    await client.requestJson("/api/marks", { requestId: "req-explicit" });
    assert.equal(headersOf(calls[0] as CapturedCall)["X-Request-Id"], "req-explicit");
    const provided = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const providedClient = createApiClient({
      fetchFn: provided.fetchFn,
      requestIdProvider: () => "req-provided",
    });
    await providedClient.requestJson("/api/marks");
    assert.equal(headersOf(provided.calls[0] as CapturedCall)["X-Request-Id"], "req-provided");
  });

  it("sends Idempotency-Key only when provided", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    await client.requestJson("/api/settings", {
      method: "PATCH",
      jsonBody: {},
      idempotencyKey: "key-123",
    });
    assert.equal(headersOf(calls[0] as CapturedCall)["Idempotency-Key"], "key-123");
    await client.requestJson("/api/marks");
    assert.equal("Idempotency-Key" in headersOf(calls[1] as CapturedCall), false);
  });

  it("sends an Accept header per response kind", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    await client.requestJson("/api/marks");
    await client.requestText("/api/workspace/file");
    await client.requestBytes("/api/assets/abc");
    await client.requestHealth("/api/health/ready");
    assert.equal(headersOf(calls[0] as CapturedCall).Accept, "application/json");
    assert.equal(headersOf(calls[1] as CapturedCall).Accept, "text/plain, */*");
    assert.equal(headersOf(calls[2] as CapturedCall).Accept, "*/*");
    assert.equal(headersOf(calls[3] as CapturedCall).Accept, "application/json");
  });

  it("passes caller headers through, with client headers winning conflicts", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    await client.requestJson("/api/marks", {
      headers: { "X-Custom": "yes", Accept: "text/html" },
    });
    const headers = headersOf(calls[0] as CapturedCall);
    assert.equal(headers["X-Custom"], "yes");
    assert.equal(headers.Accept, "application/json");
  });

  it("sends FormData and byte bodies without a client Content-Type", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 201, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    const form = new FormData();
    form.append("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
    await client.requestJson("/api/assets", { method: "POST", formDataBody: form });
    assert.equal(calls[0]?.init.body, form);
    assert.equal("Content-Type" in headersOf(calls[0] as CapturedCall), false);
    const bytes = new Uint8Array([1, 2, 3]);
    await client.requestJson("/api/workspace/media", {
      method: "PUT",
      query: { path: "notes/a.png" },
      bytesBody: bytes,
    });
    assert.equal(calls[1]?.init.body, bytes);
    assert.equal(calls[1]?.url, "/api/workspace/media?path=notes%2Fa.png");
    await client.requestJson("/api/workspace/file", { method: "PUT", textBody: "hello" });
    assert.equal(calls[2]?.init.body, "hello");
  });
});

describe("error envelope through the client", () => {
  it("maps an error envelope to ApiError fields", async () => {
    const { fetchFn } = makeFetch(() =>
      fakeResponse({
        status: 400,
        body: errorBody("validation_failed", {
          message: "Bad body.",
          requestId: "req-env-1",
          retryable: false,
          details: { fields: [{ field: "name", issue: "required" }] },
        }),
      }),
    );
    const client = createApiClient({ fetchFn });
    const error = await expectApiError(client.requestJson("/api/tags", { method: "POST", jsonBody: {} }));
    assert.equal(error.localCode, "VALIDATION_ERROR");
    assert.equal(error.wireCode, "validation_failed");
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false);
    assert.equal(error.requestId, "req-env-1");
    assert.deepEqual({ ...error.details }, { fields: [{ field: "name", issue: "required" }] });
    assert.equal(error.wireMessage, "Bad body.");
  });

  it("falls back to the X-Request-Id header when the envelope omits requestId", async () => {
    const body = JSON.stringify({
      ok: false,
      error: { code: "not_found", message: "Missing.", retryable: false, details: {} },
    });
    const { fetchFn } = makeFetch(() =>
      fakeResponse({ status: 404, headers: { "X-Request-Id": "req-header-1" }, body }),
    );
    const client = createApiClient({ fetchFn });
    const error = await expectApiError(client.requestJson("/api/marks/99"));
    assert.equal(error.requestId, "req-header-1");
    const noId = makeFetch(() => fakeResponse({ status: 404, body }));
    const noIdError = await expectApiError(
      createApiClient({ fetchFn: noId.fetchFn }).requestJson("/api/marks/99"),
    );
    assert.equal(noIdError.requestId, null);
  });

  it("derives retryable when the envelope omits it", async () => {
    const rateLimited = makeFetch(() =>
      fakeResponse({
        status: 429,
        body: JSON.stringify({
          ok: false,
          error: { code: "rate_limited", message: "Slow down.", requestId: "r1", details: {} },
        }),
      }),
    );
    const error = await expectApiError(
      createApiClient({ fetchFn: rateLimited.fetchFn }).requestJson("/api/marks"),
    );
    assert.equal(error.retryable, true);
    assert.equal(error.localCode, "RATE_LIMITED");
  });

  it("preserves conflict payloads at 409 and 412", async () => {
    const details = { serverRevision: "rev-2", serverVersion: 3 };
    const at409 = makeFetch(() =>
      fakeResponse({ status: 409, body: errorBody("revision_conflict", { details, retryable: false }) }),
    );
    const error409 = await expectApiError(
      createApiClient({ fetchFn: at409.fetchFn }).requestJson("/api/workspace/file/append", {
        method: "POST",
        jsonBody: {},
      }),
    );
    assert.equal(error409.localCode, "CONFLICT");
    assert.deepEqual({ ...error409.details }, details);
    const at412 = makeFetch(() =>
      fakeResponse({ status: 412, body: errorBody("revision_conflict", { details, retryable: false }) }),
    );
    const error412 = await expectApiError(
      createApiClient({ fetchFn: at412.fetchFn }).requestJson("/api/workspace/file", {
        method: "PUT",
        jsonBody: {},
      }),
    );
    assert.equal(error412.localCode, "CONFLICT");
    assert.equal(error412.status, 412);
  });

  it("preserves an unknown wire code verbatim with a status fallback", async () => {
    const { fetchFn } = makeFetch(() =>
      fakeResponse({ status: 418, body: errorBody("future_code", { retryable: false }) }),
    );
    const client = createApiClient({ fetchFn });
    const error = await expectApiError(client.requestJson("/api/marks"));
    assert.equal(error.wireCode, "future_code");
    assert.equal(error.localCode, "VALIDATION_ERROR");
  });

  it("treats non-JSON, empty, and malformed error bodies as status errors without keeping body text", async () => {
    const htmlSecret = "PROXY-SECRET-9911";
    const html = makeFetch(() =>
      fakeResponse({ status: 502, body: `<html>proxy page ${htmlSecret}</html>` }),
    );
    const htmlError = await expectApiError(
      createApiClient({ fetchFn: html.fetchFn }).requestJson("/api/marks"),
    );
    assert.equal(htmlError.localCode, "SERVER_ERROR");
    assert.equal(htmlError.wireCode, null);
    assert.equal(htmlError.message.includes(htmlSecret), false);
    assert.equal(JSON.stringify(htmlError.toSafeSummary()).includes(htmlSecret), false);
    const empty = makeFetch(() => fakeResponse({ status: 500, body: "" }));
    const emptyError = await expectApiError(
      createApiClient({ fetchFn: empty.fetchFn }).requestJson("/api/marks"),
    );
    assert.equal(emptyError.localCode, "SERVER_ERROR");
    assert.equal(emptyError.wireCode, null);
    const malformed = makeFetch(() => fakeResponse({ status: 500, body: "{not json" }));
    const malformedError = await expectApiError(
      createApiClient({ fetchFn: malformed.fetchFn }).requestJson("/api/marks"),
    );
    assert.equal(malformedError.localCode, "SERVER_ERROR");
  });

  it("fails closed on a 2xx response that reports failure", async () => {
    const { fetchFn } = makeFetch(() =>
      fakeResponse({ status: 200, body: errorBody("not_found", { retryable: false }) }),
    );
    const client = createApiClient({ fetchFn });
    const error = await expectApiError(client.requestJson("/api/marks/1"));
    assert.equal(error.wireCode, "not_found");
    assert.equal(error.status, 200);
  });

  it("rejects 2xx JSON without an envelope and unparseable 2xx bodies", async () => {
    const bare = makeFetch(() => fakeResponse({ status: 200, body: JSON.stringify({ id: 1 }) }));
    const bareError = await expectApiError(
      createApiClient({ fetchFn: bare.fetchFn }).requestJson("/api/marks/1"),
    );
    assert.equal(bareError.localCode, "SERVER_ERROR");
    assert.equal(bareError.wireCode, null);
    const unparseable = makeFetch(() => fakeResponse({ status: 200, body: "not json at all" }));
    const unparseableError = await expectApiError(
      createApiClient({ fetchFn: unparseable.fetchFn }).requestJson("/api/marks/1"),
    );
    assert.equal(unparseableError.localCode, "SERVER_ERROR");
  });

  it("never retries: 429 and 503 produce exactly one fetch call", async () => {
    const rate = makeFetch(() =>
      fakeResponse({ status: 429, body: errorBody("rate_limited", { retryable: true }) }),
    );
    await expectApiError(createApiClient({ fetchFn: rate.fetchFn }).requestJson("/api/marks"));
    assert.equal(rate.calls.length, 1);
    const unavailable = makeFetch(() =>
      fakeResponse({ status: 503, body: errorBody("service_unavailable", { retryable: true }) }),
    );
    await expectApiError(
      createApiClient({ fetchFn: unavailable.fetchFn }).requestJson("/api/marks"),
    );
    assert.equal(unavailable.calls.length, 1);
  });
});

describe("every wire code through the client, one case per code", () => {
  const table: ReadonlyArray<{ code: string; status: number; local: LocalApiErrorCode }> = [
    { code: "validation_failed", status: 400, local: "VALIDATION_ERROR" },
    { code: "invalid_json", status: 400, local: "VALIDATION_ERROR" },
    { code: "invalid_path", status: 400, local: "VALIDATION_ERROR" },
    { code: "symlink_not_allowed", status: 400, local: "VALIDATION_ERROR" },
    { code: "invalid_query", status: 400, local: "VALIDATION_ERROR" },
    { code: "invalid_cursor", status: 400, local: "VALIDATION_ERROR" },
    { code: "invalid_limit", status: 400, local: "VALIDATION_ERROR" },
    { code: "invalid_precondition", status: 400, local: "VALIDATION_ERROR" },
    { code: "invalid_patch_range", status: 400, local: "VALIDATION_ERROR" },
    { code: "invalid_upload", status: 400, local: "VALIDATION_ERROR" },
    { code: "invalid_move", status: 400, local: "VALIDATION_ERROR" },
    { code: "invalid_operation", status: 400, local: "VALIDATION_ERROR" },
    { code: "not_a_directory", status: 400, local: "VALIDATION_ERROR" },
    { code: "confirm_required", status: 400, local: "VALIDATION_ERROR" },
    { code: "tag_not_found", status: 400, local: "VALIDATION_ERROR" },
    { code: "asset_not_found", status: 400, local: "VALIDATION_ERROR" },
    { code: "invalid_action_token", status: 400, local: "VALIDATION_ERROR" },
    { code: "unauthenticated", status: 401, local: "AUTH_REQUIRED" },
    { code: "invalid_credentials", status: 401, local: "AUTH_REQUIRED" },
    { code: "invalid_verification_code", status: 401, local: "AUTH_REQUIRED" },
    { code: "invalid_setup_token", status: 401, local: "AUTH_REQUIRED" },
    { code: "forbidden", status: 403, local: "AUTH_REQUIRED" },
    { code: "csrf_invalid", status: 403, local: "AUTH_REQUIRED" },
    { code: "origin_rejected", status: 403, local: "AUTH_REQUIRED" },
    { code: "step_up_required", status: 403, local: "AUTH_REQUIRED" },
    { code: "not_found", status: 404, local: "VALIDATION_ERROR" },
    { code: "method_not_allowed", status: 405, local: "VALIDATION_ERROR" },
    { code: "already_exists", status: 409, local: "CONFLICT" },
    { code: "target_exists", status: 409, local: "CONFLICT" },
    { code: "revision_conflict", status: 409, local: "CONFLICT" },
    { code: "record_tags_changed", status: 409, local: "CONFLICT" },
    { code: "wrong_kind", status: 409, local: "CONFLICT" },
    { code: "repair_precondition_failed", status: 409, local: "CONFLICT" },
    { code: "reconcile_already_running", status: 409, local: "CONFLICT" },
    { code: "idempotency_key_reused", status: 409, local: "CONFLICT" },
    { code: "tag_in_use", status: 409, local: "CONFLICT" },
    { code: "tag_locked", status: 409, local: "CONFLICT" },
    { code: "tag_name_taken", status: 409, local: "CONFLICT" },
    { code: "backup_in_progress", status: 409, local: "CONFLICT" },
    { code: "capability_unavailable", status: 410, local: "CAPABILITY_UNAVAILABLE" },
    { code: "text_too_large", status: 413, local: "PAYLOAD_TOO_LARGE" },
    { code: "media_too_large", status: 413, local: "PAYLOAD_TOO_LARGE" },
    { code: "asset_too_large", status: 413, local: "PAYLOAD_TOO_LARGE" },
    { code: "payload_too_large", status: 413, local: "PAYLOAD_TOO_LARGE" },
    { code: "not_text_file", status: 415, local: "VALIDATION_ERROR" },
    { code: "unsupported_media_type", status: 415, local: "VALIDATION_ERROR" },
    { code: "range_not_satisfiable", status: 416, local: "VALIDATION_ERROR" },
    { code: "invalid_text_encoding", status: 422, local: "VALIDATION_ERROR" },
    { code: "unsupported_backup_format", status: 422, local: "VALIDATION_ERROR" },
    { code: "backup_corrupt", status: 422, local: "VALIDATION_ERROR" },
    { code: "backup_decrypt_failed", status: 422, local: "VALIDATION_ERROR" },
    { code: "schema_too_new", status: 422, local: "VALIDATION_ERROR" },
    { code: "precondition_required", status: 428, local: "VALIDATION_ERROR" },
    { code: "rate_limited", status: 429, local: "RATE_LIMITED" },
    { code: "internal_error", status: 500, local: "SERVER_ERROR" },
    { code: "index_update_failed", status: 500, local: "SERVER_ERROR" },
    { code: "trash_blob_missing", status: 500, local: "SERVER_ERROR" },
    { code: "fuzzy_search_unavailable", status: 501, local: "FEATURE_NOT_YET_AVAILABLE" },
    { code: "document_parse_unavailable", status: 501, local: "FEATURE_NOT_YET_AVAILABLE" },
    { code: "restore_unavailable", status: 501, local: "FEATURE_NOT_YET_AVAILABLE" },
    { code: "service_unavailable", status: 503, local: "SERVER_ERROR" },
    { code: "write_queue_timeout", status: 503, local: "SERVER_ERROR" },
  ];
  assert.equal(table.length, 62);

  for (const row of table) {
    it(`${row.code} (${row.status}) throws ${row.local} through the client`, async () => {
      const body = JSON.stringify({
        ok: false,
        error: { code: row.code, message: "Wire message.", requestId: "req-loop", details: {} },
      });
      const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: row.status, body }));
      const client = createApiClient({ fetchFn });
      const error = await expectApiError(client.requestJson("/api/marks"));
      assert.equal(error.wireCode, row.code);
      assert.equal(error.localCode, row.local);
      assert.equal(error.status, row.status);
      assert.equal(calls.length, 1);
      const derivedRetryable =
        row.code === "rate_limited" ||
        row.code === "service_unavailable" ||
        row.code === "write_queue_timeout";
      assert.equal(error.retryable, derivedRetryable);
      if (row.code === "fuzzy_search_unavailable") {
        assert.ok(error instanceof FuzzySearchUnavailableError);
      }
      if (row.code === "document_parse_unavailable") {
        assert.ok(error instanceof DocumentParseUnavailableError);
      }
      if (row.code === "restore_unavailable") {
        assert.ok(error instanceof RestoreUnavailableError);
      }
    });
  }
});

describe("path and request guards: no fetch happens", () => {
  it("rejects absolute, protocol-relative, versioned, and malformed paths", async () => {
    const badPaths = [
      "https://example.com/api/marks",
      "http://example.com/api/marks",
      "//example.com/api/marks",
      "/api/v1/marks",
      "/api/v1",
      "/api/v1?x=1",
      "/api/marks#fragment",
      "/api\\marks",
      "/api/marks with space",
      "",
      "api/marks",
      "/other/marks",
      "/api",
    ];
    for (const badPath of badPaths) {
      const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
      const client = createApiClient({ fetchFn });
      const error = await expectApiError(client.requestJson(badPath));
      assert.equal(error.localCode, "VALIDATION_ERROR");
      assert.equal(calls.length, 0, `no fetch must happen for ${JSON.stringify(badPath)}`);
    }
  });

  it("rejects workspace identifiers in the path query string", async () => {
    for (const badPath of ["/api/marks?workspaceId=abc", "/api/marks?workspace_id=abc", "/api/backups?x=1&workspaceId=abc"]) {
      const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
      const error = await expectApiError(
        createApiClient({ fetchFn }).requestJson(badPath),
      );
      assert.equal(error.localCode, "VALIDATION_ERROR");
      assert.equal(calls.length, 0);
    }
  });

  it("rejects workspace identifiers in option queries of every accepted shape", async () => {
    const badQueries: ApiClientQuery[] = [
      { workspaceId: "abc" },
      { workspace_id: "abc" },
      "workspaceId=abc",
      new URLSearchParams({ workspaceId: "abc" }),
    ];
    for (const query of badQueries) {
      const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
      const error = await expectApiError(
        createApiClient({ fetchFn }).requestJson("/api/marks", { query }),
      );
      assert.equal(error.localCode, "VALIDATION_ERROR");
      assert.equal(calls.length, 0);
    }
  });

  it("rejects workspace identifiers anywhere in a JSON body", async () => {
    const badBodies: unknown[] = [
      { workspaceId: "abc" },
      { workspace_id: "abc" },
      { nested: { workspaceId: "abc" } },
      { items: [{ workspace_id: "abc" }] },
      [{ workspaceId: "abc" }],
    ];
    for (const jsonBody of badBodies) {
      const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
      const error = await expectApiError(
        createApiClient({ fetchFn }).requestJson("/api/marks", { method: "POST", jsonBody }),
      );
      assert.equal(error.localCode, "VALIDATION_ERROR");
      assert.equal(calls.length, 0);
    }
  });

  it("rejects forbidden caller headers, case-insensitively", async () => {
    const badHeaders: Record<string, string>[] = [
      { Authorization: "Bearer x" },
      { authorization: "Bearer x" },
      { AUTHORIZATION: "Bearer x" },
      { "X-CSRF-Token": "direct" },
      { "x-csrf-token": "direct" },
      { Cookie: "session=x" },
      { cookie: "session=x" },
    ];
    for (const headers of badHeaders) {
      const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
      const error = await expectApiError(
        createApiClient({ fetchFn }).requestJson("/api/marks", { headers }),
      );
      assert.equal(error.localCode, "VALIDATION_ERROR");
      assert.equal(calls.length, 0);
    }
  });

  it("rejects conflicting body kinds and bodies on GET and HEAD", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    const form = new FormData();
    form.append("a", "b");
    const badOptions = [
      { method: "POST" as const, jsonBody: {}, textBody: "x" },
      { method: "POST" as const, textBody: "x", formDataBody: form },
      { method: "POST" as const, jsonBody: {}, bytesBody: new Uint8Array([1]) },
      { method: "GET" as const, jsonBody: {} },
      { method: "HEAD" as const, textBody: "x" },
    ];
    for (const options of badOptions) {
      const error = await expectApiError(client.requestJson("/api/marks", options));
      assert.equal(error.localCode, "VALIDATION_ERROR");
    }
    assert.equal(calls.length, 0);
  });

  it("rejects unserializable JSON bodies", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicError = await expectApiError(
      client.requestJson("/api/marks", { method: "POST", jsonBody: cyclic }),
    );
    assert.equal(cyclicError.localCode, "VALIDATION_ERROR");
    const bigintError = await expectApiError(
      client.requestJson("/api/marks", { method: "POST", jsonBody: { n: BigInt(10) } }),
    );
    assert.equal(bigintError.localCode, "VALIDATION_ERROR");
    assert.equal(calls.length, 0);
  });

  it("rejects invalid idempotency keys, request ids, and timeouts", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    const badOptions = [
      { idempotencyKey: "" },
      { idempotencyKey: "k".repeat(129) },
      { idempotencyKey: "bad\r\nkey" },
      { requestId: "" },
      { requestId: "bad\nid" },
      { timeoutMs: 0 },
      { timeoutMs: -5 },
      { timeoutMs: Number.NaN },
      { timeoutMs: Number.POSITIVE_INFINITY },
    ];
    for (const options of badOptions) {
      const error = await expectApiError(client.requestJson("/api/marks", options));
      assert.equal(error.localCode, "VALIDATION_ERROR");
    }
    assert.equal(calls.length, 0);
    const maxKey = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    await createApiClient({ fetchFn: maxKey.fetchFn }).requestJson("/api/marks", {
      idempotencyKey: "k".repeat(128),
    });
    assert.equal(maxKey.calls.length, 1);
    const badDefault = createApiClient({ fetchFn, defaultTimeoutMs: 0 });
    const defaultError = await expectApiError(badDefault.requestJson("/api/marks"));
    assert.equal(defaultError.localCode, "VALIDATION_ERROR");
  });
});

/** Mirrors the query option of ApiRequestOptions (kept local to this spec). */
type ApiClientQuery =
  | Record<string, string | number | boolean | null | undefined>
  | URLSearchParams
  | string;

describe("CSRF seam (V3-30b provider)", () => {
  it("attaches the provider token on every mutation method", async () => {
    const methods = ["POST", "PUT", "PATCH", "DELETE"] as const;
    for (const method of methods) {
      const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
      const client = createApiClient({ fetchFn, csrfTokenProvider: () => "token-abc" });
      await client.requestJson("/api/marks", { method });
      assert.equal(headersOf(calls[0] as CapturedCall)["X-CSRF-Token"], "token-abc");
    }
  });

  it("never consults the provider for GET and HEAD, and never sends the header there", async () => {
    let providerCalls = 0;
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({
      fetchFn,
      csrfTokenProvider: () => {
        providerCalls += 1;
        return "token-abc";
      },
    });
    await client.requestJson("/api/marks", { method: "GET" });
    await client.requestNoContent("/api/workspace/file", { method: "HEAD" });
    assert.equal(providerCalls, 0);
    assert.equal("X-CSRF-Token" in headersOf(calls[0] as CapturedCall), false);
    assert.equal("X-CSRF-Token" in headersOf(calls[1] as CapturedCall), false);
  });

  it("does not consult the provider when skipCsrf is set", async () => {
    let providerCalls = 0;
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({
      fetchFn,
      csrfTokenProvider: () => {
        providerCalls += 1;
        return "token-abc";
      },
    });
    await client.requestJson("/api/auth/login", { method: "POST", jsonBody: {}, skipCsrf: true });
    assert.equal(providerCalls, 0);
    assert.equal("X-CSRF-Token" in headersOf(calls[0] as CapturedCall), false);
  });

  it("sends no header when the provider returns null, undefined, or an empty token", async () => {
    for (const token of [null, undefined, ""]) {
      const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
      const client = createApiClient({ fetchFn, csrfTokenProvider: () => token });
      await client.requestJson("/api/marks", { method: "POST", jsonBody: {} });
      assert.equal("X-CSRF-Token" in headersOf(calls[0] as CapturedCall), false);
      assert.equal(calls.length, 1);
    }
    const asyncProvider = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const asyncClient = createApiClient({
      fetchFn: asyncProvider.fetchFn,
      csrfTokenProvider: async () => "token-async",
    });
    await asyncClient.requestJson("/api/marks", { method: "POST", jsonBody: {} });
    assert.equal(headersOf(asyncProvider.calls[0] as CapturedCall)["X-CSRF-Token"], "token-async");
  });

  it("sends no header when no provider is wired", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({ fetchFn });
    await client.requestJson("/api/marks", { method: "POST", jsonBody: {} });
    assert.equal("X-CSRF-Token" in headersOf(calls[0] as CapturedCall), false);
    assert.equal(calls.length, 1);
  });

  it("fails closed without fetching when the provider throws or rejects", async () => {
    const providerSecret = "PROVIDER-SECRET-44aa";
    const throwing = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const throwingClient = createApiClient({
      fetchFn: throwing.fetchFn,
      csrfTokenProvider: () => {
        throw new Error(`provider blew up: ${providerSecret}`);
      },
    });
    const thrown = await expectApiError(
      throwingClient.requestJson("/api/marks", { method: "POST", jsonBody: {} }),
    );
    assert.equal(thrown.localCode, "SERVER_ERROR");
    assert.equal(thrown.message.includes(providerSecret), false);
    assert.equal(throwing.calls.length, 0);
    const rejecting = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const rejectingClient = createApiClient({
      fetchFn: rejecting.fetchFn,
      csrfTokenProvider: async () => {
        throw new Error(`provider rejected: ${providerSecret}`);
      },
    });
    const rejected = await expectApiError(
      rejectingClient.requestJson("/api/marks", { method: "POST", jsonBody: {} }),
    );
    assert.equal(rejected.localCode, "SERVER_ERROR");
    assert.equal(rejected.message.includes(providerSecret), false);
    assert.equal(rejecting.calls.length, 0);
  });

  it("fails closed when the provider returns a non-string token", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const client = createApiClient({
      fetchFn,
      csrfTokenProvider: () => 42 as unknown as string,
    });
    const error = await expectApiError(
      client.requestJson("/api/marks", { method: "POST", jsonBody: {} }),
    );
    assert.equal(error.localCode, "SERVER_ERROR");
    assert.equal(calls.length, 0);
  });
});

describe("onUnauthorized seam (V3-30b 401 handling)", () => {
  it("invokes the handler once with the ApiError, awaited, before throwing", async () => {
    const order: string[] = [];
    let seen: ApiError | undefined;
    const { fetchFn, calls } = makeFetch(() =>
      fakeResponse({ status: 401, body: errorBody("unauthenticated", { retryable: false }) }),
    );
    const client = createApiClient({
      fetchFn,
      onUnauthorized: async (error) => {
        order.push("start");
        seen = error;
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("end");
      },
    });
    const error = await expectApiError(client.requestJson("/api/marks"));
    order.push("caught");
    assert.deepEqual(order, ["start", "end", "caught"]);
    assert.equal(seen, error);
    assert.equal(error.wireCode, "unauthenticated");
    assert.equal(error.status, 401);
    assert.equal(calls.length, 1);
  });

  it("still throws the original ApiError when the handler throws or rejects", async () => {
    const handlerSecret = "HANDLER-SECRET-88bb";
    const throwing = makeFetch(() =>
      fakeResponse({ status: 401, body: errorBody("unauthenticated", { retryable: false }) }),
    );
    const throwingClient = createApiClient({
      fetchFn: throwing.fetchFn,
      onUnauthorized: () => {
        throw new Error(`handler boom: ${handlerSecret}`);
      },
    });
    const thrown = await expectApiError(throwingClient.requestJson("/api/marks"));
    assert.equal(thrown.wireCode, "unauthenticated");
    assert.equal(thrown.message.includes(handlerSecret), false);
    const rejecting = makeFetch(() =>
      fakeResponse({ status: 401, body: errorBody("unauthenticated", { retryable: false }) }),
    );
    const rejectingClient = createApiClient({
      fetchFn: rejecting.fetchFn,
      onUnauthorized: async () => {
        throw new Error(`handler reject: ${handlerSecret}`);
      },
    });
    const rejected = await expectApiError(rejectingClient.requestJson("/api/marks"));
    assert.equal(rejected.wireCode, "unauthenticated");
    assert.equal(rejected.message.includes(handlerSecret), false);
  });

  it("throws ApiError on 401 without a handler", async () => {
    const { fetchFn } = makeFetch(() =>
      fakeResponse({ status: 401, body: errorBody("unauthenticated", { retryable: false }) }),
    );
    const error = await expectApiError(createApiClient({ fetchFn }).requestJson("/api/marks"));
    assert.equal(error.localCode, "AUTH_REQUIRED");
  });

  it("does not invoke the handler for other statuses, network failures, or local rejections", async () => {
    let handlerCalls = 0;
    const handler = () => {
      handlerCalls += 1;
    };
    const statuses = [403, 404, 500];
    for (const status of statuses) {
      const { fetchFn } = makeFetch(() =>
        fakeResponse({ status, body: errorBody("not_found", { retryable: false }) }),
      );
      await expectApiError(createApiClient({ fetchFn, onUnauthorized: handler }).requestJson("/api/marks"));
    }
    const networkFetch = makeFetch(() => {
      throw new Error("down");
    });
    await expectApiError(
      createApiClient({ fetchFn: networkFetch.fetchFn, onUnauthorized: handler }).requestJson(
        "/api/marks",
      ),
    );
    const guardFetch = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    await expectApiError(
      createApiClient({ fetchFn: guardFetch.fetchFn, onUnauthorized: handler }).requestJson(
        "/api/marks?workspaceId=x",
      ),
    );
    assert.equal(handlerCalls, 0);
  });

  it("invokes the handler once per 401 for every response kind", async () => {
    const kinds = ["json", "text", "bytes", "empty", "health"] as const;
    for (const kind of kinds) {
      let handlerCalls = 0;
      const { fetchFn } = makeFetch(() =>
        fakeResponse({ status: 401, body: errorBody("unauthenticated", { retryable: false }) }),
      );
      const client = createApiClient({
        fetchFn,
        onUnauthorized: () => {
          handlerCalls += 1;
        },
      });
      if (kind === "json") {
        await expectApiError(client.requestJson("/api/marks"));
      } else if (kind === "text") {
        await expectApiError(client.requestText("/api/workspace/file"));
      } else if (kind === "bytes") {
        await expectApiError(client.requestBytes("/api/assets/abc"));
      } else if (kind === "empty") {
        await expectApiError(client.requestNoContent("/api/csp-reports", { method: "POST" }));
      } else {
        await expectApiError(client.requestHealth("/api/health/ready"));
      }
      assert.equal(handlerCalls, 1, `handler must run once for ${kind}`);
    }
  });
});

describe("non-envelope response kinds (contract 2.3)", () => {
  it("requestText returns text with headers on 2xx and empty text on 304", async () => {
    const { fetchFn } = makeFetch(() =>
      fakeResponse({
        status: 200,
        headers: { ETag: '"rev-1"', "X-Revision": "rev-1" },
        body: "# hello",
      }),
    );
    const client = createApiClient({ fetchFn });
    const ok = await client.requestText("/api/workspace/file", { query: { path: "a.md" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.text, "# hello");
    assert.equal(ok.headers.get("etag"), '"rev-1"');
    assert.equal(ok.headers.get("X-Revision"), "rev-1");
    const notModified = makeFetch(() => fakeResponse({ status: 304, body: "" }));
    const cached = await createApiClient({ fetchFn: notModified.fetchFn }).requestText(
      "/api/workspace/file",
    );
    assert.equal(cached.status, 304);
    assert.equal(cached.text, "");
  });

  it("requestText throws the envelope error on failure statuses", async () => {
    const { fetchFn } = makeFetch(() =>
      fakeResponse({ status: 404, body: errorBody("not_found", { retryable: false }) }),
    );
    const error = await expectApiError(
      createApiClient({ fetchFn }).requestText("/api/workspace/file"),
    );
    assert.equal(error.wireCode, "not_found");
  });

  it("requestBytes returns bytes with content type on 2xx and empty bytes on 304", async () => {
    const bytes = new TextEncoder().encode("PNGDATA").buffer as ArrayBuffer;
    const { fetchFn } = makeFetch(() =>
      fakeResponse({ status: 200, headers: { "Content-Type": "image/png" }, bytes }),
    );
    const ok = await createApiClient({ fetchFn }).requestBytes("/api/assets/abc");
    assert.equal(ok.status, 200);
    assert.equal(ok.contentType, "image/png");
    assert.deepEqual(new Uint8Array(ok.bytes), new Uint8Array(bytes));
    const notModified = makeFetch(() => fakeResponse({ status: 304, bytes: new ArrayBuffer(0) }));
    const cached = await createApiClient({ fetchFn: notModified.fetchFn }).requestBytes(
      "/api/assets/abc",
    );
    assert.equal(cached.status, 304);
    assert.equal(cached.bytes.byteLength, 0);
    assert.equal(cached.contentType, null);
  });

  it("requestBytes throws the envelope error on failure statuses", async () => {
    const { fetchFn } = makeFetch(() =>
      fakeResponse({ status: 404, body: errorBody("not_found", { retryable: false }) }),
    );
    const error = await expectApiError(createApiClient({ fetchFn }).requestBytes("/api/assets/abc"));
    assert.equal(error.wireCode, "not_found");
  });

  it("requestNoContent returns headers without reading a body", async () => {
    let textCalls = 0;
    let bufferCalls = 0;
    const { fetchFn, calls } = makeFetch(() =>
      fakeResponse({
        status: 204,
        headers: { "X-Request-Id": "req-204" },
        onText: () => {
          textCalls += 1;
        },
        onArrayBuffer: () => {
          bufferCalls += 1;
        },
      }),
    );
    const client = createApiClient({ fetchFn });
    const empty = await client.requestNoContent("/api/csp-reports", { method: "POST" });
    assert.equal(empty.status, 204);
    assert.equal(empty.headers.get("x-request-id"), "req-204");
    assert.equal(textCalls, 0);
    assert.equal(bufferCalls, 0);
    const head = makeFetch(() =>
      fakeResponse({ status: 200, headers: { ETag: '"rev-2"' }, body: "" }),
    );
    const headResult = await createApiClient({ fetchFn: head.fetchFn }).requestNoContent(
      "/api/workspace/file",
      { method: "HEAD" },
    );
    assert.equal(headResult.status, 200);
    assert.equal(headResult.headers.get("etag"), '"rev-2"');
    assert.equal(head.calls[0]?.init.method, "HEAD");
    assert.equal(calls.length, 1);
  });

  it("requestNoContent throws the envelope error on failure statuses", async () => {
    const { fetchFn } = makeFetch(() =>
      fakeResponse({ status: 404, body: errorBody("not_found", { retryable: false }) }),
    );
    const error = await expectApiError(
      createApiClient({ fetchFn }).requestNoContent("/api/workspace/file", { method: "HEAD" }),
    );
    assert.equal(error.wireCode, "not_found");
  });
});

describe("health shape (AD-19, not the envelope)", () => {
  it("returns 200 and 503 health bodies without throwing", async () => {
    const readyBody = JSON.stringify({
      ok: true,
      status: "ready",
      checks: { db: { status: "ok" } },
      version: "test",
    });
    const ready = makeFetch(() => fakeResponse({ status: 200, body: readyBody }));
    const readyResult = await createApiClient({ fetchFn: ready.fetchFn }).requestHealth(
      "/api/health/ready",
    );
    assert.equal(readyResult.status, 200);
    assert.equal(readyResult.body.ok, true);
    assert.deepEqual(readyResult.body.checks, { db: { status: "ok" } });
    const notReadyBody = JSON.stringify({
      ok: false,
      status: "not_ready",
      checks: { db: { status: "fail", error: "DB_UNAVAILABLE" } },
    });
    const notReady = makeFetch(() => fakeResponse({ status: 503, body: notReadyBody }));
    const notReadyResult = await createApiClient({ fetchFn: notReady.fetchFn }).requestHealth(
      "/api/health/ready",
    );
    assert.equal(notReadyResult.status, 503);
    assert.equal(notReadyResult.body.ok, false);
  });

  it("throws on envelope errors, malformed bodies, non-boolean ok, and non-GET methods", async () => {
    const envelope = makeFetch(() =>
      fakeResponse({ status: 200, body: errorBody("internal_error", { retryable: false }) }),
    );
    const envelopeError = await expectApiError(
      createApiClient({ fetchFn: envelope.fetchFn }).requestHealth("/api/health/ready"),
    );
    assert.equal(envelopeError.wireCode, "internal_error");
    const malformed = makeFetch(() => fakeResponse({ status: 200, body: "not json" }));
    const malformedError = await expectApiError(
      createApiClient({ fetchFn: malformed.fetchFn }).requestHealth("/api/health/ready"),
    );
    assert.equal(malformedError.localCode, "SERVER_ERROR");
    const wrongOk = makeFetch(() => fakeResponse({ status: 200, body: JSON.stringify({ ok: "yes" }) }));
    const wrongOkError = await expectApiError(
      createApiClient({ fetchFn: wrongOk.fetchFn }).requestHealth("/api/health/ready"),
    );
    assert.equal(wrongOkError.localCode, "SERVER_ERROR");
    const post = makeFetch(() => fakeResponse({ status: 200, body: JSON.stringify({ ok: true }) }));
    const postError = await expectApiError(
      createApiClient({ fetchFn: post.fetchFn }).requestHealth("/api/health/ready", { method: "POST" }),
    );
    assert.equal(postError.localCode, "VALIDATION_ERROR");
    assert.equal(post.calls.length, 0);
  });
});

describe("network failure, timeout, and abort", () => {
  it("maps fetch rejection to NETWORK_ERROR without keeping the rejection text", async () => {
    const networkSecret = "NET-SECRET-1a2b";
    const { fetchFn, calls } = makeFetch(() => {
      throw new Error(`fetch failed for https://internal/api/marks?token=${networkSecret}`);
    });
    const error = await expectApiError(createApiClient({ fetchFn }).requestJson("/api/marks"));
    assert.equal(error.localCode, "NETWORK_ERROR");
    assert.equal(error.retryable, true);
    assert.equal(error.status, null);
    assert.equal(error.wireCode, null);
    assert.equal(error.message.includes(networkSecret), false);
    assert.equal(JSON.stringify(error.toSafeSummary()).includes(networkSecret), false);
    assert.equal(calls.length, 1);
  });

  it("maps non-Error rejections to NETWORK_ERROR without keeping the value", async () => {
    const { fetchFn } = makeFetch(() => Promise.reject(`string rejection NET-SECRET-2c3d`));
    const error = await expectApiError(createApiClient({ fetchFn }).requestJson("/api/marks"));
    assert.equal(error.localCode, "NETWORK_ERROR");
    assert.equal(error.message.includes("NET-SECRET-2c3d"), false);
  });

  it("times out a signal-ignoring fetch via the race, producing retryable TIMEOUT", async () => {
    const neverFetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const client = createApiClient({ fetchFn: neverFetch });
    const error = await expectApiError(client.requestJson("/api/marks", { timeoutMs: 20 }));
    assert.equal(error.localCode, "TIMEOUT");
    assert.equal(error.retryable, true);
    assert.equal(error.status, null);
  });

  it("times out a signal-honoring fetch that rejects AbortError", async () => {
    const honoringFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const abortError = new Error("Aborted");
            abortError.name = "AbortError";
            reject(abortError);
          },
          { once: true },
        );
      })) as typeof fetch;
    const client = createApiClient({ fetchFn: honoringFetch });
    const error = await expectApiError(client.requestJson("/api/marks", { timeoutMs: 20 }));
    assert.equal(error.localCode, "TIMEOUT");
    assert.equal(error.retryable, true);
  });

  it("applies defaultTimeoutMs and honors a per-request override", async () => {
    const neverFetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const defaulted = createApiClient({ fetchFn: neverFetch, defaultTimeoutMs: 20 });
    const defaultError = await expectApiError(defaulted.requestJson("/api/marks"));
    assert.equal(defaultError.localCode, "TIMEOUT");
    const overriding = createApiClient({ fetchFn: neverFetch, defaultTimeoutMs: 10_000 });
    const started = Date.now();
    const overrideError = await expectApiError(
      overriding.requestJson("/api/marks", { timeoutMs: 20 }),
    );
    assert.equal(overrideError.localCode, "TIMEOUT");
    assert.ok(Date.now() - started < 5000, "per-request timeout must win over the default");
  });

  it("rejects immediately without fetching when the outer signal is already aborted", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
    const controller = new AbortController();
    controller.abort();
    const error = await expectApiError(
      createApiClient({ fetchFn }).requestJson("/api/marks", { signal: controller.signal }),
    );
    assert.equal(error.localCode, "TIMEOUT");
    assert.equal(error.retryable, false);
    assert.equal(calls.length, 0);
  });

  it("maps an abort during a pending fetch to non-retryable TIMEOUT", async () => {
    const neverFetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const controller = new AbortController();
    const promise = createApiClient({ fetchFn: neverFetch }).requestJson("/api/marks", {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);
    const error = await expectApiError(promise);
    assert.equal(error.localCode, "TIMEOUT");
    assert.equal(error.retryable, false);
  });

  it("maps body stream failures to NETWORK_ERROR", async () => {
    const textFail = makeFetch(() =>
      fakeResponse({ status: 200, body: successBody({}), textError: new Error("stream broke") }),
    );
    const textError = await expectApiError(
      createApiClient({ fetchFn: textFail.fetchFn }).requestJson("/api/marks"),
    );
    assert.equal(textError.localCode, "NETWORK_ERROR");
    const bytesFail = makeFetch(() =>
      fakeResponse({ status: 200, arrayBufferError: new Error("stream broke") }),
    );
    const bytesError = await expectApiError(
      createApiClient({ fetchFn: bytesFail.fetchFn }).requestBytes("/api/assets/abc"),
    );
    assert.equal(bytesError.localCode, "NETWORK_ERROR");
  });
});

describe("no secret leakage", () => {
  it("never puts the CSRF token into an error message or summary", async () => {
    const token = "CSRF-TOKEN-VALUE-9d2e";
    const { fetchFn } = makeFetch(() =>
      fakeResponse({ status: 403, body: errorBody("csrf_invalid", { retryable: false }) }),
    );
    const client = createApiClient({ fetchFn, csrfTokenProvider: () => token });
    const error = await expectApiError(
      client.requestJson("/api/marks", { method: "POST", jsonBody: {} }),
    );
    assert.equal(error.wireCode, "csrf_invalid");
    assert.equal(error.message.includes(token), false);
    assert.equal(JSON.stringify(error.toSafeSummary()).includes(token), false);
    assert.equal(JSON.stringify({ ...error.details }).includes(token), false);
  });

  it("never puts a download token from the path into an error", async () => {
    const downloadToken = "DOWNLOAD-TOKEN-SECRET-123";
    const { fetchFn } = makeFetch(() =>
      fakeResponse({ status: 404, body: errorBody("not_found", { retryable: false }) }),
    );
    const error = await expectApiError(
      createApiClient({ fetchFn }).requestBytes(`/api/backups/downloads/${downloadToken}`),
    );
    assert.equal(error.message.includes(downloadToken), false);
    assert.equal(JSON.stringify(error.toSafeSummary()).includes(downloadToken), false);
    assert.equal("url" in error, false);
    assert.equal("path" in error, false);
    assert.equal("requestUrl" in error, false);
  });

  it("never puts request body values into an error message, even when the server echoes them", async () => {
    const bodySecret = "BODY-SECRET-xyz789";
    const { fetchFn } = makeFetch(() =>
      fakeResponse({
        status: 400,
        body: errorBody("validation_failed", {
          message: `Rejected value ${bodySecret}`,
          retryable: false,
        }),
      }),
    );
    const client = createApiClient({ fetchFn });
    const error = await expectApiError(
      client.requestJson(
        "/api/auth/login",
        { method: "POST", jsonBody: { password: bodySecret }, skipCsrf: true },
      ),
    );
    assert.equal(error.message.includes(bodySecret), false);
    assert.equal(JSON.stringify(error.toSafeSummary()).includes(bodySecret), false);
    assert.equal(error.wireMessage?.includes(bodySecret), true);
  });

  it("never writes to the console on failure paths", async () => {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;
    const originalDebug = console.debug;
    let consoleCalls = 0;
    const counting = () => {
      consoleCalls += 1;
    };
    console.log = counting;
    console.error = counting;
    console.warn = counting;
    console.info = counting;
    console.debug = counting;
    try {
      const failing = makeFetch(() =>
        fakeResponse({ status: 500, body: errorBody("internal_error", { retryable: false }) }),
      );
      await expectApiError(createApiClient({ fetchFn: failing.fetchFn }).requestJson("/api/marks"));
      const network = makeFetch(() => {
        throw new Error("down");
      });
      await expectApiError(createApiClient({ fetchFn: network.fetchFn }).requestJson("/api/marks"));
      const guard = makeFetch(() => fakeResponse({ status: 200, body: successBody({}) }));
      await expectApiError(
        createApiClient({ fetchFn: guard.fetchFn }).requestJson("/api/marks?workspaceId=x"),
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
      console.info = originalInfo;
      console.debug = originalDebug;
    }
    assert.equal(consoleCalls, 0);
  });
});

describe("client construction", () => {
  it("createApiClient returns distinct instances and defaultApiClient is unwired", () => {
    const first = createApiClient();
    const second = createApiClient();
    assert.ok(first instanceof ApiClient);
    assert.ok(second instanceof ApiClient);
    assert.notEqual(first, second);
    assert.ok(defaultApiClient instanceof ApiClient);
    assert.notEqual(defaultApiClient, first);
  });
});
