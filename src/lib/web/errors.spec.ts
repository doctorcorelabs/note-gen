// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the wire error vocabulary and wire-to-local mapping
 * (errors.ts), using the repo convention (node:test with
 * node:assert/strict). Run through an esbuild bundle, because the
 * sources use extensionless imports (bundler module resolution)
 * which raw node cannot resolve:
 *
 *   ./node_modules/.bin/esbuild src/lib/web/errors.spec.ts \
 *     --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert \
 *     --outfile=<staging-dir>/errors.spec.mjs
 *   node --test <staging-dir>/errors.spec.mjs
 *
 * The staging dir lives under ~/workspace (never /tmp for this
 * project). No test in this file sends HTTP: every case exercises
 * pure mapping and parsing functions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  API_ERROR_CODES,
  ApiError,
  DocumentParseUnavailableError,
  FuzzySearchUnavailableError,
  RestoreUnavailableError,
  WIRE_TO_LOCAL_CODE,
  createApiErrorFromWire,
  createApiErrorWithoutEnvelope,
  createLocalApiError,
  createNetworkError,
  createTimeoutError,
  deriveRetryable,
  isApiErrorCode,
  mapStatusToLocalCode,
  mapWireCodeToLocalCode,
  parseErrorEnvelope,
  parseSuccessEnvelope,
  type LocalApiErrorCode,
} from "./errors";

/**
 * Canonical status per wire code (contract 6.2) with the expected
 * local code. revision_conflict appears with 409 here; the 412
 * variant is asserted separately, because D1 (AD-29) makes the
 * status endpoint-dependent while the code mapping stays fixed.
 */
const WIRE_CODE_TABLE: ReadonlyArray<{
  code: string;
  status: number;
  local: LocalApiErrorCode;
}> = [
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

describe("wire catalog", () => {
  it("holds 62 unique snake_case codes", () => {
    assert.equal(API_ERROR_CODES.length, 62);
    assert.equal(new Set(API_ERROR_CODES).size, 62);
    for (const code of API_ERROR_CODES) {
      assert.match(code, /^[a-z][a-z0-9_]*$/, `code must be snake_case: ${code}`);
      assert.equal(isApiErrorCode(code), true);
    }
    assert.equal(isApiErrorCode("VALIDATION_ERROR"), false);
    assert.equal(isApiErrorCode(""), false);
    assert.equal(isApiErrorCode(42), false);
    assert.equal(isApiErrorCode(null), false);
  });

  it("test table covers the catalog exactly once per code", () => {
    assert.equal(WIRE_CODE_TABLE.length, 62);
    const tableCodes = WIRE_CODE_TABLE.map((row) => row.code).sort();
    const catalogCodes = [...API_ERROR_CODES].sort();
    assert.deepEqual(tableCodes, catalogCodes);
  });

  it("mapping table covers every catalog code", () => {
    for (const code of API_ERROR_CODES) {
      assert.notEqual(WIRE_TO_LOCAL_CODE[code], undefined);
    }
  });

  it("never maps a wire code to a router-local-only code", () => {
    for (const code of API_ERROR_CODES) {
      const local = WIRE_TO_LOCAL_CODE[code];
      assert.notEqual(local, "CAPABILITY_GATED");
      assert.notEqual(local, "UNKNOWN_COMMAND");
      assert.notEqual(local, "NETWORK_ERROR");
      assert.notEqual(local, "TIMEOUT");
    }
  });
});

describe("wire-to-local mapping, one case per catalog code", () => {
  for (const row of WIRE_CODE_TABLE) {
    it(`${row.code} (${row.status}) maps to ${row.local}`, () => {
      assert.equal(mapWireCodeToLocalCode(row.code, row.status), row.local);
    });
  }

  it("revision_conflict maps to CONFLICT at both 409 and 412 (D1)", () => {
    assert.equal(mapWireCodeToLocalCode("revision_conflict", 409), "CONFLICT");
    assert.equal(mapWireCodeToLocalCode("revision_conflict", 412), "CONFLICT");
  });

  it("mapping is code-first: a mismatched status does not change it", () => {
    assert.equal(mapWireCodeToLocalCode("validation_failed", 500), "VALIDATION_ERROR");
    assert.equal(mapWireCodeToLocalCode("rate_limited", 200), "RATE_LIMITED");
    assert.equal(mapWireCodeToLocalCode("not_found", 500), "VALIDATION_ERROR");
  });
});

describe("unknown wire code fallback", () => {
  it("falls back by status for unknown codes", () => {
    assert.equal(mapWireCodeToLocalCode("future_code", 401), "AUTH_REQUIRED");
    assert.equal(mapWireCodeToLocalCode("future_code", 403), "AUTH_REQUIRED");
    assert.equal(mapWireCodeToLocalCode("future_code", 409), "CONFLICT");
    assert.equal(mapWireCodeToLocalCode("future_code", 412), "CONFLICT");
    assert.equal(mapWireCodeToLocalCode("future_code", 410), "CAPABILITY_UNAVAILABLE");
    assert.equal(mapWireCodeToLocalCode("future_code", 413), "PAYLOAD_TOO_LARGE");
    assert.equal(mapWireCodeToLocalCode("future_code", 429), "RATE_LIMITED");
    assert.equal(mapWireCodeToLocalCode("future_code", 404), "VALIDATION_ERROR");
    assert.equal(mapWireCodeToLocalCode("future_code", 422), "VALIDATION_ERROR");
    assert.equal(mapWireCodeToLocalCode("future_code", 500), "SERVER_ERROR");
    assert.equal(mapWireCodeToLocalCode("future_code", 503), "SERVER_ERROR");
  });

  it("falls back to SERVER_ERROR with no status", () => {
    assert.equal(mapWireCodeToLocalCode("future_code"), "SERVER_ERROR");
  });

  it("mapStatusToLocalCode covers the status families", () => {
    assert.equal(mapStatusToLocalCode(400), "VALIDATION_ERROR");
    assert.equal(mapStatusToLocalCode(418), "VALIDATION_ERROR");
    assert.equal(mapStatusToLocalCode(501), "SERVER_ERROR");
    assert.equal(mapStatusToLocalCode(599), "SERVER_ERROR");
    assert.equal(mapStatusToLocalCode(302), "SERVER_ERROR");
  });
});

describe("retryable derivation (K-07)", () => {
  it("is true only for 429 and 503 families when the envelope omits it", () => {
    assert.equal(deriveRetryable("rate_limited", 429), true);
    assert.equal(deriveRetryable("service_unavailable", 503), true);
    assert.equal(deriveRetryable("write_queue_timeout", 503), true);
    assert.equal(deriveRetryable("revision_conflict", 409), false);
    assert.equal(deriveRetryable("revision_conflict", 412), false);
    assert.equal(deriveRetryable("internal_error", 500), false);
    assert.equal(deriveRetryable("validation_failed", 400), false);
    assert.equal(deriveRetryable(null, 429), true);
    assert.equal(deriveRetryable(null, 503), true);
    assert.equal(deriveRetryable(null, 500), false);
    assert.equal(deriveRetryable("future_code", 429), true);
    assert.equal(deriveRetryable("future_code", 404), false);
  });
});

describe("success envelope parsing", () => {
  it("accepts object, array, scalar, and null data", () => {
    assert.deepEqual(parseSuccessEnvelope({ ok: true, data: { a: 1 } }), {
      ok: true,
      data: { a: 1 },
    });
    assert.deepEqual(parseSuccessEnvelope({ ok: true, data: [1, 2] }), {
      ok: true,
      data: [1, 2],
    });
    assert.deepEqual(parseSuccessEnvelope({ ok: true, data: "x" }), { ok: true, data: "x" });
    assert.deepEqual(parseSuccessEnvelope({ ok: true, data: null }), { ok: true, data: null });
    assert.deepEqual(parseSuccessEnvelope({ ok: true, data: 0 }), { ok: true, data: 0 });
    assert.deepEqual(parseSuccessEnvelope({ ok: true, data: false }), { ok: true, data: false });
  });

  it("rejects non-success shapes", () => {
    assert.equal(parseSuccessEnvelope({ ok: false, data: {} }), null);
    assert.equal(parseSuccessEnvelope({ ok: true }), null);
    assert.equal(parseSuccessEnvelope({ data: {} }), null);
    assert.equal(parseSuccessEnvelope({ ok: "true", data: {} }), null);
    assert.equal(parseSuccessEnvelope(null), null);
    assert.equal(parseSuccessEnvelope([1, 2]), null);
    assert.equal(parseSuccessEnvelope("text"), null);
  });
});

describe("error envelope parsing", () => {
  it("normalizes a full error envelope", () => {
    const parsed = parseErrorEnvelope({
      ok: false,
      error: {
        code: "not_found",
        message: "The requested resource was not found.",
        requestId: "req-1",
        retryable: false,
        details: { path: "notes/a.md" },
      },
    });
    assert.deepEqual(parsed, {
      wireCode: "not_found",
      wireMessage: "The requested resource was not found.",
      requestId: "req-1",
      retryable: false,
      details: { path: "notes/a.md" },
    });
  });

  it("fills gaps defensively instead of crashing", () => {
    const parsed = parseErrorEnvelope({ ok: false, error: { code: "internal_error" } });
    assert.deepEqual(parsed, {
      wireCode: "internal_error",
      wireMessage: null,
      requestId: null,
      retryable: undefined,
      details: {},
    });
    const wrongTypes = parseErrorEnvelope({
      ok: false,
      error: { code: "not_found", message: 7, requestId: 9, retryable: "yes", details: "x" },
    });
    assert.deepEqual(wrongTypes, {
      wireCode: "not_found",
      wireMessage: null,
      requestId: null,
      retryable: undefined,
      details: {},
    });
    const emptyStrings = parseErrorEnvelope({
      ok: false,
      error: { code: "not_found", message: "", requestId: "" },
    });
    assert.equal(emptyStrings?.wireMessage, null);
    assert.equal(emptyStrings?.requestId, null);
  });

  it("rejects non-error-envelope shapes", () => {
    assert.equal(parseErrorEnvelope({ ok: true, data: {} }), null);
    assert.equal(parseErrorEnvelope({ ok: false }), null);
    assert.equal(parseErrorEnvelope({ ok: false, error: "not_found" }), null);
    assert.equal(parseErrorEnvelope({ ok: false, error: {} }), null);
    assert.equal(parseErrorEnvelope({ ok: false, error: { code: "" } }), null);
    assert.equal(parseErrorEnvelope({ ok: false, error: { code: 404 } }), null);
    assert.equal(parseErrorEnvelope(null), null);
    assert.equal(parseErrorEnvelope("text"), null);
  });
});

describe("ApiError", () => {
  it("carries codes, status, retryable, requestId, and details", () => {
    const error = new ApiError({
      localCode: "CONFLICT",
      wireCode: "revision_conflict",
      status: 412,
      retryable: false,
      requestId: "req-9",
      details: { serverRevision: "abc" },
      wireMessage: "Revision conflict.",
    });
    assert.equal(error.name, "ApiError");
    assert.equal(error.localCode, "CONFLICT");
    assert.equal(error.wireCode, "revision_conflict");
    assert.equal(error.status, 412);
    assert.equal(error.retryable, false);
    assert.equal(error.requestId, "req-9");
    assert.deepEqual({ ...error.details }, { serverRevision: "abc" });
    assert.equal(error.wireMessage, "Revision conflict.");
    assert.equal(error.message, "API error revision_conflict (HTTP 412, CONFLICT)");
    assert.ok(error instanceof Error);
  });

  it("message never contains the raw server message text", () => {
    const secretText = "SECRET-VALUE-7f3a9c";
    const error = new ApiError({
      localCode: "VALIDATION_ERROR",
      wireCode: "validation_failed",
      status: 400,
      wireMessage: `Rejected because of ${secretText}`,
    });
    assert.equal(error.message.includes(secretText), false);
    assert.equal(error.message, "API error validation_failed (HTTP 400, VALIDATION_ERROR)");
  });

  it("message without a wire code names only the local code", () => {
    const error = new ApiError({ localCode: "NETWORK_ERROR" });
    assert.equal(error.message, "API request failed (NETWORK_ERROR)");
    assert.equal(error.wireCode, null);
    assert.equal(error.status, null);
    assert.equal(error.retryable, false);
    assert.equal(error.requestId, null);
    assert.equal(error.wireMessage, null);
  });

  it("details are copied and frozen at the top level", () => {
    const details = { count: 1 };
    const error = new ApiError({ localCode: "SERVER_ERROR", details });
    details.count = 2;
    assert.equal(error.details.count, 1);
    assert.equal(Object.isFrozen(error.details), true);
  });

  it("safe summary holds codes and ids only, no details or message", () => {
    const error = new ApiError({
      localCode: "AUTH_REQUIRED",
      wireCode: "csrf_invalid",
      status: 403,
      retryable: false,
      requestId: "req-2",
      details: { anything: "goes-here" },
      wireMessage: "Generic text.",
    });
    assert.deepEqual(error.toSafeSummary(), {
      localCode: "AUTH_REQUIRED",
      wireCode: "csrf_invalid",
      status: 403,
      retryable: false,
      requestId: "req-2",
    });
    assert.equal(JSON.stringify(error.toSafeSummary()).includes("goes-here"), false);
    assert.equal(JSON.stringify(error.toSafeSummary()).includes("Generic text"), false);
  });
});

describe("flat code field for the V3-30b seam (csrf.ts predicates)", () => {
  it("code always equals wireCode, for every catalog code", () => {
    for (const entry of WIRE_CODE_TABLE) {
      const error = createApiErrorFromWire({
        status: entry.status,
        wireCode: entry.code,
        requestId: "req-seam",
        details: {},
      });
      assert.equal(error.code, entry.code);
      assert.equal(error.wireCode, entry.code);
    }
    const conflict412 = createApiErrorFromWire({
      status: 412,
      wireCode: "revision_conflict",
      requestId: "req-seam",
      details: {},
    });
    assert.equal(conflict412.code, "revision_conflict");
  });

  it("code is null exactly when no envelope arrived", () => {
    assert.equal(createNetworkError().code, null);
    assert.equal(createTimeoutError(false).code, null);
    assert.equal(createTimeoutError(true).code, null);
    assert.equal(createLocalApiError("VALIDATION_ERROR").code, null);
    assert.equal(createLocalApiError("SERVER_ERROR").code, null);
    assert.equal(createApiErrorWithoutEnvelope({ status: 502 }).code, null);
    assert.equal(new ApiError({ localCode: "SERVER_ERROR" }).code, null);
  });

  it("typed 501 subclasses carry their wire code in code", () => {
    const cases: Array<{ wireCode: string; ctor: unknown }> = [
      { wireCode: "fuzzy_search_unavailable", ctor: FuzzySearchUnavailableError },
      { wireCode: "document_parse_unavailable", ctor: DocumentParseUnavailableError },
      { wireCode: "restore_unavailable", ctor: RestoreUnavailableError },
    ];
    for (const entry of cases) {
      const error = createApiErrorFromWire({
        status: 501,
        wireCode: entry.wireCode,
        requestId: "req-seam",
        details: {},
      });
      assert.equal(error.code, entry.wireCode);
      assert.ok(error instanceof (entry.ctor as new (...args: never[]) => unknown));
    }
  });

  it("flat status/code/requestId fields satisfy the csrf.ts predicate shape", () => {
    // This mirrors the field reads in csrf.ts readErrorStatusCode
    // without importing that module: csrf.ts lives on the V3-30b
    // branch, and this branch must stay green on its own. The pin
    // is the field NAMES (status, code, requestId) and their flat
    // placement on the error object.
    function readFlat(error: unknown): { status?: number; code?: string; requestId?: string } {
      if (typeof error !== "object" || error === null) {
        return {};
      }
      const record = error as Record<string, unknown>;
      return {
        status: typeof record.status === "number" ? record.status : undefined,
        code: typeof record.code === "string" ? record.code : undefined,
        requestId: typeof record.requestId === "string" ? record.requestId : undefined,
      };
    }
    const csrfError = createApiErrorFromWire({
      status: 403,
      wireCode: "csrf_invalid",
      requestId: "req-csrf-1",
      details: {},
    });
    assert.deepEqual(readFlat(csrfError), {
      status: 403,
      code: "csrf_invalid",
      requestId: "req-csrf-1",
    });
    const expiredError = createApiErrorFromWire({
      status: 401,
      wireCode: "unauthenticated",
      requestId: "req-401-1",
      details: {},
    });
    assert.deepEqual(readFlat(expiredError), {
      status: 401,
      code: "unauthenticated",
      requestId: "req-401-1",
    });
    const networkFlat = readFlat(createNetworkError());
    assert.equal(networkFlat.status, undefined);
    assert.equal(networkFlat.code, undefined);
    assert.equal(networkFlat.requestId, undefined);
  });
});

describe("typed 501 errors", () => {
  it("fuzzy 501 becomes FuzzySearchUnavailableError", () => {
    const error = createApiErrorFromWire({
      status: 501,
      wireCode: "fuzzy_search_unavailable",
      requestId: "req-3",
      details: {},
    });
    assert.ok(error instanceof FuzzySearchUnavailableError);
    assert.ok(error instanceof ApiError);
    assert.equal(error.name, "FuzzySearchUnavailableError");
    assert.equal(error.localCode, "FEATURE_NOT_YET_AVAILABLE");
    assert.equal(error.wireCode, "fuzzy_search_unavailable");
    assert.equal(error.status, 501);
    assert.equal(error.retryable, false);
  });

  it("document parse 501 becomes DocumentParseUnavailableError", () => {
    const error = createApiErrorFromWire({
      status: 501,
      wireCode: "document_parse_unavailable",
    });
    assert.ok(error instanceof DocumentParseUnavailableError);
    assert.ok(error instanceof ApiError);
    assert.equal(error.name, "DocumentParseUnavailableError");
    assert.equal(error.localCode, "FEATURE_NOT_YET_AVAILABLE");
  });

  it("restore 501 becomes RestoreUnavailableError", () => {
    const error = createApiErrorFromWire({
      status: 501,
      wireCode: "restore_unavailable",
    });
    assert.ok(error instanceof RestoreUnavailableError);
    assert.ok(error instanceof ApiError);
    assert.equal(error.name, "RestoreUnavailableError");
    assert.equal(error.localCode, "FEATURE_NOT_YET_AVAILABLE");
  });

  it("other wire codes become plain ApiError, not a 501 subclass", () => {
    const error = createApiErrorFromWire({ status: 412, wireCode: "revision_conflict" });
    assert.equal(error.constructor, ApiError);
    assert.equal(error instanceof FuzzySearchUnavailableError, false);
    assert.equal(error.localCode, "CONFLICT");
  });
});

describe("error factories", () => {
  it("createApiErrorFromWire honors the envelope retryable value when present", () => {
    const honored = createApiErrorFromWire({
      status: 409,
      wireCode: "revision_conflict",
      retryable: true,
    });
    assert.equal(honored.retryable, true);
    const derived = createApiErrorFromWire({ status: 429, wireCode: "rate_limited" });
    assert.equal(derived.retryable, true);
    const derivedFalse = createApiErrorFromWire({
      status: 400,
      wireCode: "validation_failed",
    });
    assert.equal(derivedFalse.retryable, false);
  });

  it("createApiErrorFromWire preserves an unknown wire code verbatim", () => {
    const error = createApiErrorFromWire({ status: 418, wireCode: "future_code" });
    assert.equal(error.wireCode, "future_code");
    assert.equal(error.localCode, "VALIDATION_ERROR");
    assert.equal(error.message.includes("future_code"), true);
  });

  it("without-envelope errors use the status fallback and keep no wire code", () => {
    const notFound = createApiErrorWithoutEnvelope({ status: 404, requestId: "req-4" });
    assert.equal(notFound.localCode, "VALIDATION_ERROR");
    assert.equal(notFound.wireCode, null);
    assert.equal(notFound.status, 404);
    assert.equal(notFound.retryable, false);
    assert.equal(notFound.requestId, "req-4");
    const rateLimited = createApiErrorWithoutEnvelope({ status: 429 });
    assert.equal(rateLimited.localCode, "RATE_LIMITED");
    assert.equal(rateLimited.retryable, true);
    assert.equal(rateLimited.requestId, null);
  });

  it("network errors are retryable NETWORK_ERROR with no status", () => {
    const error = createNetworkError();
    assert.equal(error.localCode, "NETWORK_ERROR");
    assert.equal(error.retryable, true);
    assert.equal(error.status, null);
    assert.equal(error.wireCode, null);
  });

  it("timeout errors distinguish caller aborts from budget expiry", () => {
    assert.equal(createTimeoutError(true).localCode, "TIMEOUT");
    assert.equal(createTimeoutError(true).retryable, false);
    assert.equal(createTimeoutError(false).retryable, true);
    assert.equal(createTimeoutError(false).status, null);
  });

  it("local pre-flight errors carry no wire data and are not retryable", () => {
    const validation = createLocalApiError("VALIDATION_ERROR");
    assert.equal(validation.localCode, "VALIDATION_ERROR");
    assert.equal(validation.wireCode, null);
    assert.equal(validation.retryable, false);
    const preparation = createLocalApiError("SERVER_ERROR");
    assert.equal(preparation.localCode, "SERVER_ERROR");
    assert.equal(preparation.retryable, false);
  });
});
