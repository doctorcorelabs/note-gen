// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import {
  SQL_OP_KINDS,
  SQL_OP_METADATA,
  SQL_READ_OP_KINDS,
  SQL_WRITE_OP_KINDS,
  type DbReadOperation,
  type DbWriteOperation,
  type SqlOpKind,
  type SqlReadOpKind,
  type SqlWriteOpKind,
} from "./ops-catalog";

/**
 * HTTP transport for the typed SQL operations: POST /api/transactions
 * and POST /api/db/batch (kontrak-api-kanonis.md section 3.4).
 *
 * This module is the transport the web SqlAdapter calls. It owns
 * client-side operation validation against the catalog, 50-operation
 * chunking, idempotency-key generation and attachment, envelope
 * parsing, wire-to-client error mapping, and the retry policy. It
 * owns no adapter behavior: row narrowing per kind, query/queryOne
 * semantics, and the SqlAdapter interface itself belong to the
 * adapter module (sql.web.ts, worker v3b-14a). That module depends
 * on the `SqlDbClient` interface defined here; this module must never
 * import the adapter, so the dependency points one way only.
 *
 * SEAM (V3-30 unification): the centralized API client and CSRF
 * seam have landed (src/lib/web/api-client.ts, csrf.ts), and this
 * module deliberately still carries a minimal typed fetch of its
 * own: exactly two fixed relative paths, JSON bodies, cookie
 * credentials, an injected CSRF token provider plus an injected
 * token refresher, and envelope parsing. It stays standalone
 * because the retry wrapper needs the `Retry-After` header and
 * the CSRF refresh branch, which `ApiClient.requestJson` does
 * not surface, and because every transaction call carries an
 * idempotency key the centralized client does not manage. The
 * error type below mirrors the V3-30a `ApiError` fields (`code`
 * flat alias of `wireCode`, `status`, `retryable`, `requestId`,
 * frozen `details`, message built from codes and status only).
 * The CSRF provider and refresher arrive through deps from the
 * one shared token store owned by boot (see wiring.ts and
 * platform-boot.ts); a request without a token is sent without
 * the header and the server answers honestly.
 *
 * Server semantics this client matches (server/src/services/db/):
 * - Request limits: at most 50 operations per request, body at most
 *   1 MB (kinds.ts). Chunking is client-side; see the atomicity note
 *   on `executeTransaction`.
 * - Idempotency (kontrak 1.6, idempotency.ts): the same key with the
 *   same request replays the stored success without a second write;
 *   the same key with a different request answers 409
 *   `idempotency_key_reused`. Keys are opaque client strings, at most
 *   128 characters; an overlong key is a 400. Only success responses
 *   are stored, for 24 hours.
 * - Validation order (validation.ts): unknown top-level fields,
 *   non-array or oversized `operations`, non-object operations,
 *   missing kinds, forbidden fields, then unknown or wrong-group
 *   kinds as `invalid_operation` with `operationIndex` and `kind`.
 * - The server-only kind (`vector.replaceChunks`) is rejected by the
 *   client before any HTTP with `capability_unavailable`; the server
 *   410 is only the second defense (kinds.ts rule, kontrak 6.5).
 *   Every other W2 kind is sent normally: the server answers 410
 *   when no handler is registered.
 * - Error details always carry `operationIndex` and `kind` for the
 *   failing operation (dispatch.ts). Chunked calls remap a chunk
 *   local index to the global index in the caller's array.
 *
 * Catalog delta (AD-44): the server kind mirror carries `messages.get`
 * as a 74th W1 read kind, but the catalog at this base does not list
 * it yet; the catalog amendment is V3-14 wave 3B work. Validation
 * here is derived from the catalog constants, so `messages.get` is
 * rejected locally as `invalid_operation` until that amendment lands,
 * and admitted with no code change here once it does.
 *
 * Retry policy (kontrak 2.2 K-07, kontrak 6.2, kontrak 1.2 butir 6):
 * each chunk request gets at most one retry (two attempts total).
 * The retry fires only when (a) no response was received at all (a
 * rejected fetch: a network failure), (b) the response is 429 or
 * 503 and its envelope does not say `retryable: false`, or (c) the
 * response is 403 `csrf_invalid` and a `refreshCsrfToken` dep is
 * injected: the token is refreshed once and the same request is
 * retried once with rebuilt headers (same body, same idempotency
 * key, freshly read token). Rule (b) is the contract's `retryable`
 * semantics: K-07 makes `retryable: true` mean the exact same
 * request may be repeated, and the 6.2 catalog marks exactly
 * `rate_limited`, `service_unavailable`, and `write_queue_timeout`
 * (429/503) retryable. The CSRF branch (c) shares the single retry
 * budget: whichever trigger fires first consumes it, a second
 * `csrf_invalid` throws, and a failed refresh surfaces the
 * original `csrf_invalid` error. Every other HTTP response is
 * never retried: 409 conflicts (including `revision_conflict`)
 * need a new guard or a user decision, never a blind repeat, and
 * 400/401/403/404/410/413/500/501 responses cannot succeed by
 * repetition (the one 403 exception is the CSRF branch above).
 * Every retry reuses the same body and the same idempotency key
 * (desain-sql-adapter 4.3 rule 6: keys exist so network retries
 * cannot double-write). Triggers (a) and (b) wait out a backoff
 * delay first (the `Retry-After` delta-seconds value on 429/503 when the
 * server sends one, capped; else a 500 ms default taken from the
 * 6.2 `write_queue_timeout` backoff ladder). The CSRF branch (c)
 * waits for the refresh fetch instead of a backoff delay. No
 * retry ever fires on a caller abort. This is a deliberate, narrow difference from the
 * V3-30a client, which never retries anything: the centralized
 * client carries no idempotency keys, so a blind repeat could
 * double-write, while every transaction call here carries a key and
 * every batch call is side-effect-free, so the single keyed retry
 * cannot duplicate an effect. The `retryable` flag on thrown errors
 * still tells the caller whether ITS OWN repeat (with a fresh call
 * and, for transactions, an explicit key) may succeed.
 */

// ---------------------------------------------------------------------------
// Constants mirrored from server/src/services/db/kinds.ts
// ---------------------------------------------------------------------------

/** Canonical paths (kontrak 3.4). No version prefix, no workspace id. */
export const SQL_TRANSACTIONS_PATH = "/api/transactions";
export const SQL_DB_BATCH_PATH = "/api/db/batch";

/** Maximum operations per request (kontrak 3.4, CT-X5). */
export const DB_CLIENT_MAX_OPERATIONS_PER_REQUEST = 50;

/** Maximum idempotency-key length in characters (kontrak 1.6). */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * Field names that must never appear on an operation object
 * (kontrak 1.3 and 1.5, V1-03 4.3 rule 2). Mirrors
 * FORBIDDEN_OPERATION_FIELDS in server/src/services/db/kinds.ts.
 * Field VALUES are never inspected: an injection-looking string
 * carried as data is data, and handlers bind it as a parameter.
 */
export const DB_CLIENT_FORBIDDEN_OPERATION_FIELDS: readonly string[] = [
  "sql",
  "query",
  "statement",
  "table",
  "columns",
  "raw",
  "workspaceId",
  "workspace_id",
  "operations",
];

// Kind membership derived from the catalog constants, so a catalog
// amendment (for example `messages.get`, AD-44) flows through with no
// change here. The metadata lookup is guarded the same way: an
// unknown kind never reaches it.
const READ_KIND_SET: ReadonlySet<string> = new Set(SQL_READ_OP_KINDS);
const WRITE_KIND_SET: ReadonlySet<string> = new Set(SQL_WRITE_OP_KINDS);
const KNOWN_KIND_SET: ReadonlySet<string> = new Set(SQL_OP_KINDS);

// ---------------------------------------------------------------------------
// Error type: mirrors the V3-30a ApiError field shape
// ---------------------------------------------------------------------------

/**
 * Coarse local families from kontrak 6.5. Callers branch on `code`
 * (the exact wire code) for precise handling and on `localCode`
 * only for coarse handling (auth vs conflict vs retryable).
 */
export type SqlDbLocalCode =
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "CAPABILITY_UNAVAILABLE"
  | "FEATURE_NOT_YET_AVAILABLE"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "AUTH_REQUIRED";

/** Per-code fields from the envelope, plus local validation fields. */
export interface SqlDbErrorDetails {
  [key: string]: unknown;
}

export interface SqlDbClientErrorOptions {
  /** Exact wire code, or null when no envelope arrived. */
  code: string | null;
  localCode: SqlDbLocalCode;
  /** HTTP status, or null when no response was received. */
  status: number | null;
  retryable: boolean;
  requestId?: string | null;
  details?: SqlDbErrorDetails;
}

/**
 * The single error type thrown by the SQL database client.
 *
 * Fields mirror V3-30a `ApiError` (see the module header): `code` is
 * the flat wire code and `wireCode` is the same value under the
 * explicit name; `status` is null for errors thrown before any HTTP
 * (local validation, network failure, caller abort); `details` is a
 * frozen shallow copy of the envelope details. `operationIndex` and
 * `kind` are convenience views of the same-named details fields when
 * the server (or local validation) identified the failing operation;
 * they are null otherwise. The Error message is built only from codes
 * and status, never from request content, so throwing can never leak
 * operation data into a log.
 */
export class SqlDbClientError extends Error {
  readonly code: string | null;
  readonly wireCode: string | null;
  readonly localCode: SqlDbLocalCode;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: Readonly<SqlDbErrorDetails>;
  readonly operationIndex: number | null;
  readonly kind: string | null;

  constructor(options: SqlDbClientErrorOptions) {
    const wireCode = options.code;
    const status = options.status;
    const statusText = status === null ? "no response" : `HTTP ${status}`;
    super(
      wireCode !== null
        ? `Database request failed ${wireCode} (${statusText}, ${options.localCode})`
        : `Database request failed (${statusText}, ${options.localCode})`,
    );
    this.name = "SqlDbClientError";
    this.code = wireCode;
    this.wireCode = wireCode;
    this.localCode = options.localCode;
    this.status = status;
    this.retryable = options.retryable;
    this.requestId = options.requestId ?? null;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    const operationIndex = this.details["operationIndex"];
    this.operationIndex =
      typeof operationIndex === "number" && Number.isInteger(operationIndex) ? operationIndex : null;
    const kind = this.details["kind"];
    this.kind = typeof kind === "string" ? kind : null;
  }

  /**
   * Log-safe summary: codes, status, retryable, requestId, and the
   * failing operation identity only. No details, no message text.
   * This is the only shape callers should log for this error.
   */
  toSafeSummary(): {
    code: string | null;
    localCode: SqlDbLocalCode;
    status: number | null;
    retryable: boolean;
    requestId: string | null;
    operationIndex: number | null;
    kind: string | null;
  } {
    return {
      code: this.code,
      localCode: this.localCode,
      status: this.status,
      retryable: this.retryable,
      requestId: this.requestId,
      operationIndex: this.operationIndex,
      kind: this.kind,
    };
  }
}

export function isSqlDbClientError(error: unknown): error is SqlDbClientError {
  return error instanceof SqlDbClientError;
}

// ---------------------------------------------------------------------------
// Wire code to local code mapping (kontrak 6.5)
// ---------------------------------------------------------------------------

const CONFLICT_WIRE_CODES: ReadonlySet<string> = new Set([
  "revision_conflict",
  "record_tags_changed",
  "already_exists",
  "target_exists",
  "wrong_kind",
  "repair_precondition_failed",
  "reconcile_already_running",
  "idempotency_key_reused",
  "tag_in_use",
  "tag_locked",
  "tag_name_taken",
  "backup_in_progress",
]);

const VALIDATION_WIRE_CODES: ReadonlySet<string> = new Set([
  "validation_failed",
  "invalid_json",
  "invalid_path",
  "symlink_not_allowed",
  "invalid_query",
  "invalid_cursor",
  "invalid_limit",
  "invalid_precondition",
  "invalid_patch_range",
  "invalid_upload",
  "invalid_move",
  "invalid_operation",
  "not_a_directory",
  "confirm_required",
  "tag_not_found",
  "asset_not_found",
  "invalid_action_token",
  // Documented V3-30a extension: `not_found` and
  // `method_not_allowed` map to VALIDATION_ERROR, the closest 4xx
  // family (there is no local NOT_FOUND code), the 415/422 families
  // map here as well, and `precondition_required` (428, a missing
  // guard) maps here as opposed to a stale guard (which is
  // `revision_conflict` / CONFLICT). Preserved so V3-30 unification
  // keeps the same coarse behavior.
  "not_found",
  "method_not_allowed",
  "not_text_file",
  "unsupported_media_type",
  "range_not_satisfiable",
  "invalid_text_encoding",
  "unsupported_backup_format",
  "backup_corrupt",
  "backup_decrypt_failed",
  "schema_too_new",
  "precondition_required",
]);

const NOT_YET_AVAILABLE_WIRE_CODES: ReadonlySet<string> = new Set([
  "fuzzy_search_unavailable",
  "document_parse_unavailable",
  "restore_unavailable",
]);

const SERVER_WIRE_CODES: ReadonlySet<string> = new Set([
  "internal_error",
  "index_update_failed",
  "trash_blob_missing",
  "service_unavailable",
  "write_queue_timeout",
]);

const AUTH_WIRE_CODES: ReadonlySet<string> = new Set([
  "unauthenticated",
  "invalid_credentials",
  "invalid_verification_code",
  "invalid_setup_token",
  "forbidden",
  "csrf_invalid",
  "origin_rejected",
  "step_up_required",
]);

const PAYLOAD_WIRE_CODES: ReadonlySet<string> = new Set([
  "text_too_large",
  "media_too_large",
  "asset_too_large",
  "payload_too_large",
]);

// Declared after every member set: spreading a `const` set before
// its declaration throws a temporal-dead-zone ReferenceError at
// module load, which would make this module unimportable.
const KNOWN_WIRE_CODES: ReadonlySet<string> = new Set([
  ...CONFLICT_WIRE_CODES,
  ...VALIDATION_WIRE_CODES,
  ...AUTH_WIRE_CODES,
  ...PAYLOAD_WIRE_CODES,
  ...NOT_YET_AVAILABLE_WIRE_CODES,
  ...SERVER_WIRE_CODES,
  "capability_unavailable",
  "rate_limited",
]);

/**
 * Map a wire code to its coarse local family, code-first (kontrak
 * 6.1 rule 3: `revision_conflict` 409 vs 412 is decided by endpoint,
 * never by status). The sets above cover all 62 catalog codes
 * (kontrak 6.2), matching the V3-30a `WIRE_TO_LOCAL_CODE` table
 * exactly, including the three 501 codes, which the db endpoints
 * never answer but which map to FEATURE_NOT_YET_AVAILABLE for
 * completeness. An unknown code falls back to the HTTP status
 * (V3-30a `mapStatusToLocalCode`: any other 4xx is
 * VALIDATION_ERROR), and a missing status falls back to
 * SERVER_ERROR.
 */
export function mapWireCodeToLocalCode(
  wireCode: string | null,
  status: number | null,
): SqlDbLocalCode {
  if (wireCode !== null) {
    if (wireCode === "capability_unavailable") {
      return "CAPABILITY_UNAVAILABLE";
    }
    if (wireCode === "rate_limited") {
      return "RATE_LIMITED";
    }
    if (CONFLICT_WIRE_CODES.has(wireCode)) {
      return "CONFLICT";
    }
    if (VALIDATION_WIRE_CODES.has(wireCode)) {
      return "VALIDATION_ERROR";
    }
    if (AUTH_WIRE_CODES.has(wireCode)) {
      return "AUTH_REQUIRED";
    }
    if (PAYLOAD_WIRE_CODES.has(wireCode)) {
      return "PAYLOAD_TOO_LARGE";
    }
    if (NOT_YET_AVAILABLE_WIRE_CODES.has(wireCode)) {
      return "FEATURE_NOT_YET_AVAILABLE";
    }
    if (SERVER_WIRE_CODES.has(wireCode)) {
      return "SERVER_ERROR";
    }
    // Unknown wire code: fall through to the status mapping below.
  }
  if (status !== null) {
    if (status === 401 || status === 403) {
      return "AUTH_REQUIRED";
    }
    if (status === 409 || status === 412) {
      return "CONFLICT";
    }
    if (status === 410) {
      return "CAPABILITY_UNAVAILABLE";
    }
    if (status === 413) {
      return "PAYLOAD_TOO_LARGE";
    }
    if (status === 429) {
      return "RATE_LIMITED";
    }
    if (status >= 400 && status < 500) {
      return "VALIDATION_ERROR";
    }
  }
  return "SERVER_ERROR";
}

/**
 * K-07 retryability: true only for `rate_limited`,
 * `service_unavailable`, and `write_queue_timeout` (429/503). Every
 * 409 conflict is false: a conflict needs a new guard or a user
 * decision, not a blind retry. The envelope value, when present,
 * always wins over this derivation. When there is no envelope value
 * and the code is unknown or absent (a malformed body), the HTTP
 * status decides: 429/503 is retryable, anything else is not. This
 * matches the V3-30a `deriveRetryable` semantics exactly.
 */
export function deriveSqlDbRetryable(
  wireCode: string | null,
  envelopeRetryable: boolean | null,
  status: number | null,
): boolean {
  if (envelopeRetryable !== null) {
    return envelopeRetryable;
  }
  if (
    wireCode === "rate_limited" ||
    wireCode === "service_unavailable" ||
    wireCode === "write_queue_timeout"
  ) {
    return true;
  }
  if (wireCode === null || !KNOWN_WIRE_CODES.has(wireCode)) {
    return status === 429 || status === 503;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Envelope parsing and wire error construction
// ---------------------------------------------------------------------------

export interface SqlDbWireErrorInput {
  status: number | null;
  code: string | null;
  requestId?: string | null;
  /** Envelope retryable value, or null when the envelope had none. */
  retryable?: boolean | null;
  details?: SqlDbErrorDetails;
}

/**
 * Build the typed client error for one wire failure. This is the one
 * mapping both transports feed: the fetch transport below parses the
 * envelope and calls this, and the future V3-30 transport calls this
 * with the caught `ApiError` fields. Local pre-flight errors are
 * built with `status: null` and the wire code the server would
 * answer, so callers branch on `code` identically for local and
 * wire failures.
 */
export function sqlDbErrorFromWire(input: SqlDbWireErrorInput): SqlDbClientError {
  return new SqlDbClientError({
    code: input.code,
    localCode: mapWireCodeToLocalCode(input.code, input.status),
    status: input.status,
    retryable: deriveSqlDbRetryable(input.code, input.retryable ?? null, input.status),
    requestId: input.requestId ?? null,
    details: input.details ?? {},
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecordDetails(value: unknown): SqlDbErrorDetails {
  return isRecord(value) ? { ...value } : {};
}

export type ParsedSqlDbEnvelope =
  | { kind: "success"; data: unknown }
  | {
      kind: "error";
      code: string | null;
      requestId: string | null;
      retryable: boolean | null;
      details: SqlDbErrorDetails;
    }
  | { kind: "malformed" };

/**
 * Parse one response body as a kontrak section 2 envelope. A success
 * envelope requires `ok === true` and a present `data` field (null,
 * array, and scalar data are all valid). An error envelope requires
 * `ok === false` and an `error` object with a non-empty string `code`;
 * the remaining error fields are normalized defensively. Anything
 * else is malformed and must never become a success.
 */
export function parseSqlDbEnvelope(bodyText: string): ParsedSqlDbEnvelope {
  if (bodyText === "") {
    return { kind: "malformed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return { kind: "malformed" };
  }
  if (!isRecord(parsed)) {
    return { kind: "malformed" };
  }
  if (parsed["ok"] === true) {
    if (!("data" in parsed)) {
      return { kind: "malformed" };
    }
    return { kind: "success", data: parsed["data"] };
  }
  if (parsed["ok"] === false) {
    const error = parsed["error"];
    if (!isRecord(error)) {
      return { kind: "malformed" };
    }
    const code = error["code"];
    if (typeof code !== "string" || code === "") {
      return { kind: "malformed" };
    }
    const requestId = error["requestId"];
    const retryable = error["retryable"];
    return {
      kind: "error",
      code,
      requestId: typeof requestId === "string" ? requestId : null,
      retryable: typeof retryable === "boolean" ? retryable : null,
      details: asRecordDetails(error["details"]),
    };
  }
  return { kind: "malformed" };
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split operations into consecutive chunks of at most `chunkSize`,
 * preserving request order. The default is the contract maximum of
 * 50. An empty input yields no chunks; callers that must still send
 * one request (both endpoints accept an empty `operations` array as
 * a valid no-op) handle the empty case explicitly.
 */
export function chunkOperations<T>(
  operations: readonly T[],
  chunkSize: number = DB_CLIENT_MAX_OPERATIONS_PER_REQUEST,
): T[][] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new SqlDbClientError({
      code: "validation_failed",
      localCode: "VALIDATION_ERROR",
      status: null,
      retryable: false,
      details: {
        fields: [{ field: "chunkSize", issue: "must be a positive integer" }],
      },
    });
  }
  const chunks: T[][] = [];
  for (let start = 0; start < operations.length; start += chunkSize) {
    chunks.push(operations.slice(start, start + chunkSize));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

let fallbackKeyCounter = 0;

/**
 * Generate one opaque idempotency key, at most 128 characters.
 * Prefers `crypto.randomUUID`; falls back to a time, counter, and
 * random suffix when no crypto implementation is available. Keys are
 * unique per call within a process; the caller owns key lifecycle
 * across retries (see `executeTransaction`).
 */
export function createIdempotencyKey(): string {
  const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const randomUUID = cryptoObject?.randomUUID;
  if (typeof randomUUID === "function") {
    try {
      return randomUUID.call(cryptoObject);
    } catch {
      // Fall through to the counter-based key below.
    }
  }
  fallbackKeyCounter += 1;
  const randomPart = Math.floor(Math.random() * 0xffffffff).toString(16);
  return `db-${Date.now().toString(36)}-${fallbackKeyCounter.toString(36)}-${randomPart}`;
}

/**
 * Validate a caller-supplied idempotency key, matching the server
 * rule (validation.ts): null, undefined, and the empty string mean
 * no key; an overlong key is a local `validation_failed` thrown
 * before any HTTP, with the same `details.fields` shape the server
 * would answer.
 */
export function validateIdempotencyKeyValue(key: string | null | undefined): string | null {
  if (key === null || key === undefined || key === "") {
    return null;
  }
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new SqlDbClientError({
      code: "validation_failed",
      localCode: "VALIDATION_ERROR",
      status: null,
      retryable: false,
      details: {
        fields: [
          {
            field: "Idempotency-Key",
            issue: `must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
          },
        ],
      },
    });
  }
  return key;
}

/**
 * Derive the key for one chunk of a multi-chunk transaction call.
 * A single chunk uses the base key unchanged, so its replay
 * semantics are exactly the caller's key semantics. Multiple chunks
 * each get a distinct suffixed key, so chunk replays never collide
 * with each other; a base key too long to hold the suffix is
 * truncated to fit, keeping the chunk discriminator intact. Callers
 * with keys near 128 characters that also send multi-chunk calls
 * should prefer shorter keys: truncation keeps chunks of one call
 * distinct, but two different long keys sharing a prefix could
 * truncate to the same chunk keys.
 */
export function deriveChunkIdempotencyKey(
  baseKey: string,
  chunkIndex: number,
  chunkCount: number,
): string {
  if (chunkCount <= 1) {
    return baseKey;
  }
  const suffix = `-chunk-${chunkIndex + 1}-of-${chunkCount}`;
  const maxBaseLength = IDEMPOTENCY_KEY_MAX_LENGTH - suffix.length;
  const truncated = baseKey.length > maxBaseLength ? baseKey.slice(0, maxBaseLength) : baseKey;
  return `${truncated}${suffix}`;
}

// ---------------------------------------------------------------------------
// Retry backoff (kontrak 1.2 butir 6, kontrak 6.2)
// ---------------------------------------------------------------------------

/**
 * Default delay before the single retry, in milliseconds. Taken from
 * the start of the kontrak 6.2 `write_queue_timeout` backoff ladder
 * (500 ms, 1 s, 2 s): this client retries at most once, so only the
 * first rung applies.
 */
export const DB_CLIENT_DEFAULT_RETRY_DELAY_MS = 500;

/**
 * Default per-request timeout in milliseconds (DA28-01 / S-P0-17).
 * Matches the ApiClient production budget (15 seconds). Every chunk
 * request is raced against this budget unless the caller supplies
 * its own timeoutMs or the client was built with a different
 * defaultTimeoutMs, so a stalled API, tunnel, or database surfaces
 * a retryable TIMEOUT error instead of hanging the caller forever.
 * A timeout on the first attempt still gets the single retry this
 * client allows for a rejected fetch, exactly like any other
 * transport failure; a timeout on the retry surfaces TIMEOUT.
 */
export const DB_CLIENT_DEFAULT_TIMEOUT_MS = 15000;

/**
 * Cap for a server-sent `Retry-After` delay, in milliseconds. A
 * `Retry-After` beyond this cap waits the cap, never longer: an
 * unbounded wait would hang the caller on a transient failure.
 */
export const DB_CLIENT_RETRY_AFTER_MAX_MS = 30000;

/**
 * Delay before the single retry for one 429/503 response, from its
 * `Retry-After` header value (kontrak 1.2 butir 6: 429 answers carry
 * `Retry-After`). Only the delta-seconds form is honored; a missing,
 * negative, non-numeric, or HTTP-date value falls back to the
 * default delay. The result never exceeds
 * `DB_CLIENT_RETRY_AFTER_MAX_MS`.
 */
export function retryDelayMsForResponse(retryAfter: string | null): number {
  if (retryAfter === null) {
    return DB_CLIENT_DEFAULT_RETRY_DELAY_MS;
  }
  const seconds = Number.parseInt(retryAfter.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return DB_CLIENT_DEFAULT_RETRY_DELAY_MS;
  }
  return Math.min(seconds * 1000, DB_CLIENT_RETRY_AFTER_MAX_MS);
}

/**
 * Backoff wait used before the single retry. The signal, when given,
 * aborts the wait: the implementation rejects (or the caller checks
 * the signal afterwards) and no second attempt is sent.
 */
export type SqlDbDelayLike = (ms: number, signal?: AbortSignal) => Promise<void>;

// ---------------------------------------------------------------------------
// Operation validation against the catalog
// ---------------------------------------------------------------------------

export type SqlDbOperationGroup = "read" | "write";

function validationFailedError(fields: Array<{ field: string; issue: string }>): SqlDbClientError {
  return new SqlDbClientError({
    code: "validation_failed",
    localCode: "VALIDATION_ERROR",
    status: null,
    retryable: false,
    details: { fields },
  });
}

function invalidOperationError(operationIndex: number, kind: string): SqlDbClientError {
  return new SqlDbClientError({
    code: "invalid_operation",
    localCode: "VALIDATION_ERROR",
    status: null,
    retryable: false,
    details: { operationIndex, kind },
  });
}

/**
 * Validate operations for one endpoint group, in the server's check
 * order (validation.ts): object shape, string kind, forbidden
 * fields, then known-kind and group membership as
 * `invalid_operation`, then server-only exposure as
 * `capability_unavailable` with the server's details shape
 * (`capability`, `phase: "Fase 2"`, `operationIndex`, `kind`).
 * The group check runs before the exposure check, matching the
 * server: the server-only kind in a read batch is a wrong-group
 * `invalid_operation`, not a 410. W2 kinds other than the
 * server-only kind are NOT rejected here; the server answers 410
 * when no handler is registered. Throws on the first problem, in
 * index order, before any HTTP. This is fail-fast validation only;
 * the server remains the final authority.
 */
export function validateDbClientOperations(
  operations: readonly unknown[],
  group: SqlDbOperationGroup,
): void {
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const prefix = `operations[${index}]`;
    if (!isRecord(operation)) {
      throw validationFailedError([{ field: prefix, issue: "must be an object" }]);
    }
    const kind = operation["kind"];
    if (typeof kind !== "string" || kind === "") {
      throw validationFailedError([
        { field: `${prefix}.kind`, issue: "is required and must be a string" },
      ]);
    }
    const forbiddenPresent = DB_CLIENT_FORBIDDEN_OPERATION_FIELDS.filter(
      (field) => field in operation,
    );
    if (forbiddenPresent.length > 0) {
      throw validationFailedError(
        forbiddenPresent.map((field) => ({ field: `${prefix}.${field}`, issue: "unknown field" })),
      );
    }
    if (!KNOWN_KIND_SET.has(kind)) {
      throw invalidOperationError(index, kind);
    }
    const inGroup = group === "read" ? READ_KIND_SET.has(kind) : WRITE_KIND_SET.has(kind);
    if (!inGroup) {
      throw invalidOperationError(index, kind);
    }
    const metadata = SQL_OP_METADATA[kind as SqlOpKind];
    if (metadata !== undefined && metadata.exposure === "server-only") {
      throw new SqlDbClientError({
        code: "capability_unavailable",
        localCode: "CAPABILITY_UNAVAILABLE",
        status: null,
        retryable: false,
        details: { capability: kind, phase: "Fase 2", operationIndex: index, kind },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/**
 * One write result entry, mirroring the contract 3.4 transaction
 * result shape. `committed` appears only for `wiki.commitRevision`,
 * where a guard miss reports `committed: false` with HTTP 200.
 */
export interface SqlTransactionResultEntry {
  kind: SqlWriteOpKind;
  affected: number;
  id?: number | string;
  version?: number;
  committed?: boolean;
}

export interface SqlTransactionResult {
  /**
   * One server-minted id per chunk sent, in chunk order. A call of
   * at most 50 operations has exactly one id.
   */
  transactionIds: string[];
  /** Write results in request order, concatenated across chunks. */
  results: SqlTransactionResultEntry[];
}

/**
 * One read batch result entry. Rows are untyped here: row narrowing
 * per kind (via `SqlReadRowByKind`) is the adapter's job, not the
 * transport's. The transport guarantees only that `rows` is an array
 * and that entries keep request order with matching kinds.
 */
export interface SqlBatchResultEntry {
  kind: SqlReadOpKind;
  rows: readonly unknown[];
}

export interface SqlBatchResult {
  /** Batch results in request order, concatenated across chunks. */
  results: SqlBatchResultEntry[];
}

function shapeMismatchError(reason: string): SqlDbClientError {
  return new SqlDbClientError({
    code: "internal_error",
    localCode: "SERVER_ERROR",
    status: null,
    retryable: false,
    details: { mismatch: reason },
  });
}

function validateTransactionData(
  data: unknown,
  expectedKinds: readonly string[],
): { transactionId: string; results: SqlTransactionResultEntry[] } {
  if (!isRecord(data)) {
    throw shapeMismatchError("transaction data is not an object");
  }
  const transactionId = data["transactionId"];
  if (typeof transactionId !== "string") {
    throw shapeMismatchError("transactionId is missing or not a string");
  }
  const results = data["results"];
  if (!Array.isArray(results)) {
    throw shapeMismatchError("results is not an array");
  }
  if (results.length !== expectedKinds.length) {
    throw shapeMismatchError("results length does not match the request");
  }
  const validated: SqlTransactionResultEntry[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const entry = results[index];
    if (!isRecord(entry)) {
      throw shapeMismatchError("result entry is not an object");
    }
    if (entry["kind"] !== expectedKinds[index]) {
      throw shapeMismatchError("result kind order does not match the request");
    }
    const affected = entry["affected"];
    if (typeof affected !== "number" || !Number.isInteger(affected) || affected < 0) {
      throw shapeMismatchError("affected is not a non-negative integer");
    }
    const validatedEntry: SqlTransactionResultEntry = {
      kind: expectedKinds[index] as SqlWriteOpKind,
      affected,
    };
    const id = entry["id"];
    if (id !== undefined) {
      if (typeof id !== "number" && typeof id !== "string") {
        throw shapeMismatchError("id is not a number or string");
      }
      validatedEntry.id = id;
    }
    const version = entry["version"];
    if (version !== undefined) {
      if (typeof version !== "number") {
        throw shapeMismatchError("version is not a number");
      }
      validatedEntry.version = version;
    }
    const committed = entry["committed"];
    if (committed !== undefined) {
      if (typeof committed !== "boolean") {
        throw shapeMismatchError("committed is not a boolean");
      }
      validatedEntry.committed = committed;
    }
    validated.push(validatedEntry);
  }
  return { transactionId, results: validated };
}

function validateBatchData(data: unknown, expectedKinds: readonly string[]): SqlBatchResultEntry[] {
  if (!isRecord(data)) {
    throw shapeMismatchError("batch data is not an object");
  }
  const results = data["results"];
  if (!Array.isArray(results)) {
    throw shapeMismatchError("results is not an array");
  }
  if (results.length !== expectedKinds.length) {
    throw shapeMismatchError("results length does not match the request");
  }
  const validated: SqlBatchResultEntry[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const entry = results[index];
    if (!isRecord(entry)) {
      throw shapeMismatchError("result entry is not an object");
    }
    if (entry["kind"] !== expectedKinds[index]) {
      throw shapeMismatchError("result kind order does not match the request");
    }
    const rows = entry["rows"];
    if (!Array.isArray(rows)) {
      throw shapeMismatchError("rows is not an array");
    }
    validated.push({ kind: expectedKinds[index] as SqlReadOpKind, rows });
  }
  return validated;
}

// ---------------------------------------------------------------------------
// Minimal fetch surface (mirrors the fs.web.ts FetchLike subset)
// ---------------------------------------------------------------------------

/** Minimal fetch response surface, so tests can inject a fake. */
export interface SqlDbFetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface SqlDbFetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  credentials?: string;
  signal?: AbortSignal;
}

export type SqlDbFetchLike = (
  url: string,
  init?: SqlDbFetchInitLike,
) => Promise<SqlDbFetchResponseLike>;

/** CSRF token provider, same shape as the fs.web.ts seam and the V3-30b `CsrfTokenProvider`. */
export type SqlDbCsrfTokenProvider = () =>
  | string
  | null
  | undefined
  | Promise<string | null | undefined>;

/**
 * CSRF token refresher, from the same shared seam as the provider:
 * refresh the cached token so the next `getCsrfToken` call reads a
 * fresh one (mirrors `CsrfTokenStore.refreshToken`). The return
 * value is ignored; a throw leaves the original error to surface.
 */
export type SqlDbCsrfTokenRefresher = () => Promise<unknown>;

export interface SqlDbClientDeps {
  /** Fetch implementation. Defaults to the global fetch, resolved per request. */
  fetchImpl?: SqlDbFetchLike;
  /**
   * CSRF token provider. Both endpoints are POST, so both carry
   * `X-CSRF-Token` when a token is available (kontrak 3.4 note).
   * Return null/undefined when no token is available; the request
   * is then sent without the header.
   */
  getCsrfToken?: SqlDbCsrfTokenProvider;
  /**
   * CSRF token refresher. Called at most once per chunk request,
   * only after the server answers 403 `csrf_invalid`; the request
   * is then retried once with rebuilt headers (see postWithRetry).
   * When absent, a stale token fails with the server error.
   */
  refreshCsrfToken?: SqlDbCsrfTokenRefresher;
  /** Idempotency-key generator. Defaults to `createIdempotencyKey`. Injectable for tests. */
  generateIdempotencyKey?: () => string;
  /**
   * Backoff wait before the single retry. Defaults to a
   * timer-based wait that rejects on abort. Injectable for tests
   * so specs can observe the delay without waiting in real time.
   */
  delayImpl?: SqlDbDelayLike;
  /**
   * Default per-request timeout in milliseconds. A call may
   * override it with options.timeoutMs. Defaults to
   * DB_CLIENT_DEFAULT_TIMEOUT_MS. Must be a finite number above
   * zero when set; anything else throws at construction.
   */
  defaultTimeoutMs?: number;
}

export interface SqlTransactionCallOptions {
  /**
   * Idempotency key for the call. When absent (undefined), a fresh
   * key is generated for the call. An explicit null or empty string
   * sends no key. A supplied key is used verbatim for a single
   * chunk and derived per chunk (see `deriveChunkIdempotencyKey`)
   * for a multi-chunk call. Callers that retry a failed call with
   * the same key and the same operations get server replay, never
   * a second write; callers that reuse a key with different
   * operations get 409 `idempotency_key_reused`.
   */
  idempotencyKey?: string | null;
  /** Caller abort signal, passed through to fetch. Aborting is never retried. */
  signal?: AbortSignal;
  /**
   * Per-request timeout in milliseconds; overrides the client
   * defaultTimeoutMs. Must be a finite number above zero when
   * set. A timeout rejects the fetch race and follows the normal
   * retry policy for a rejected fetch.
   */
  timeoutMs?: number;
}

export interface SqlBatchCallOptions {
  /** Caller abort signal, passed through to fetch. Aborting is never retried. */
  signal?: AbortSignal;
  /**
   * Per-request timeout in milliseconds; overrides the client
   * defaultTimeoutMs. Must be a finite number above zero when
   * set. A timeout rejects the fetch race and follows the normal
   * retry policy for a rejected fetch.
   */
  timeoutMs?: number;
}

/**
 * Transport seam for the web SqlAdapter (sql.web.ts, v3b-14a). The
 * adapter calls these two methods and narrows batch rows per kind;
 * it never touches fetch, chunking, keys, or envelopes directly.
 * This interface is the port the adapter depends on: construct it
 * with `createSqlDbClient` (production) or a fake in adapter specs.
 *
 * Shared behavior of both methods: operations are validated against
 * the catalog before any HTTP (first problem wins, in index order);
 * calls over 50 operations are split into consecutive 50-operation
 * chunk requests sent in order, and results are reassembled in
 * request order; every failure is thrown as `SqlDbClientError`
 * (never a partial result); a caller abort is never retried.
 *
 * Atomicity: all-or-nothing holds per server transaction, which is
 * one chunk request. A call of at most 50 operations is exactly one
 * server transaction: one failure rolls back the whole call. A call
 * over 50 operations is several server transactions, sent in order:
 * when a later chunk fails, earlier chunks stay committed, and the
 * thrown error's details carry `failedChunkIndex` and
 * `completedOperations` (plus a remapped global `operationIndex`)
 * so the caller can report exactly what committed and what did
 * not. Single-chunk failures pass through untouched.
 *
 * Retry: each chunk request is retried at most once, after a
 * backoff delay, only on a network failure (no response) or a
 * retryable 429/503 response; the retry reuses the same body and
 * the same idempotency key. See the module header for the rule and
 * its contract citations.
 *
 * Timeout: each chunk request is raced against a timeout budget
 * (DB_CLIENT_DEFAULT_TIMEOUT_MS unless overridden per call or per
 * client), so a stalled server surfaces a retryable TIMEOUT error
 * instead of hanging the caller (DA28-01). A timeout on the first
 * attempt follows the same single-retry rule as any other
 * transport failure.
 */
export interface SqlDbClient {
  /**
   * Run write operations in `POST /api/transactions` chunks. An
   * idempotency key is generated per call unless the caller
   * supplies one (see `SqlTransactionCallOptions`); a replayed
   * response returns the stored `transactionId` and results
   * without a second write. A `wiki.commitRevision` guard miss
   * arrives as HTTP 200 with `committed: false` on its result
   * entry, not as an error.
   */
  executeTransaction(
    operations: readonly DbWriteOperation[],
    options?: SqlTransactionCallOptions,
  ): Promise<SqlTransactionResult>;
  /**
   * Run read operations in `POST /api/db/batch` chunks. Reads
   * carry no idempotency key (kontrak 3.4: batch has no key
   * semantics). Rows are untyped here; the adapter narrows them
   * per kind.
   */
  executeBatch(
    operations: readonly DbReadOperation[],
    options?: SqlBatchCallOptions,
  ): Promise<SqlBatchResult>;
}

function errorNameOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function createTimeoutError(): Error {
  const error = new Error("The operation timed out.");
  error.name = "TimeoutError";
  return error;
}

function validateTimeoutMs(timeoutMs: number | undefined, owner: string): void {
  if (timeoutMs === undefined) {
    return;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`${owner} must be a finite number above zero`);
  }
}

function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(createAbortError());
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createSqlDbClient(deps: SqlDbClientDeps = {}): SqlDbClient {
  const generateKey = deps.generateIdempotencyKey ?? createIdempotencyKey;
  const delayImpl = deps.delayImpl ?? defaultDelay;
  validateTimeoutMs(deps.defaultTimeoutMs, "SqlDbClientDeps.defaultTimeoutMs");
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DB_CLIENT_DEFAULT_TIMEOUT_MS;

  function resolveFetch(): SqlDbFetchLike {
    if (deps.fetchImpl !== undefined) {
      return deps.fetchImpl;
    }
    const fetchFn = (globalThis as { fetch?: unknown }).fetch;
    if (typeof fetchFn !== "function") {
      throw new SqlDbClientError({
        code: null,
        localCode: "NETWORK_ERROR",
        status: null,
        retryable: true,
        details: {},
      });
    }
    return fetchFn as SqlDbFetchLike;
  }

  function throwAborted(): never {
    throw new SqlDbClientError({
      code: null,
      localCode: "TIMEOUT",
      status: null,
      retryable: false,
      details: {},
    });
  }

  /**
   * Run one POST fetch with the timeout budget and the caller's
   * abort signal. The fetch is raced against explicit timeout and
   * abort promises on top of the AbortSignal, mirroring
   * ApiClient.fetchWithBudget, so the call can never hang on a
   * fetch implementation that ignores the signal. A timeout
   * rejects with a TimeoutError-named error, which postWithRetry
   * maps to a retryable TIMEOUT on the final attempt; an outer
   * abort rejects with an AbortError-named error, which is never
   * retried. Only the fetch itself is raced; reading the response
   * body happens in postAttempt after the fetch resolves.
   */
  async function fetchWithBudget(
    path: string,
    headers: Record<string, string>,
    body: string,
    outerSignal: AbortSignal | undefined,
    timeoutMs: number,
    fetchImpl: SqlDbFetchLike,
  ): Promise<SqlDbFetchResponseLike> {
    const controller = new AbortController();
    let timedOut = false;
    let rejectOnTimeout: ((error: Error) => void) | undefined;
    let rejectOnAbort: ((error: Error) => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectOnTimeout = reject;
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectOnTimeout?.(createTimeoutError());
    }, timeoutMs);
    const onOuterAbort = (): void => {
      controller.abort();
      rejectOnAbort?.(createAbortError());
    };
    if (outerSignal) {
      if (outerSignal.aborted) {
        clearTimeout(timer);
        throw createAbortError();
      }
      outerSignal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      return await Promise.race([
        fetchImpl(path, {
          method: "POST",
          headers,
          body,
          credentials: "same-origin",
          signal: controller.signal,
        }),
        timeoutPromise,
        abortPromise,
      ]);
    } catch (error) {
      if (timedOut) {
        throw createTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (outerSignal) {
        outerSignal.removeEventListener("abort", onOuterAbort);
      }
    }
  }

  /**
   * One POST attempt: fetch, read the body as text, parse the
   * envelope. A response always becomes a result value, never a
   * throw, so the retry wrapper can read the error and the
   * `Retry-After` header together. Only a rejected fetch or body
   * read throws, which is exactly the no-response case the
   * wrapper may retry.
   */
  type PostAttemptResult =
    | { outcome: "success"; status: number; data: unknown }
    | { outcome: "error"; error: SqlDbClientError; retryAfter: string | null };

  async function postAttempt(
    path: string,
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    fetchImpl: SqlDbFetchLike,
    timeoutMs: number,
  ): Promise<PostAttemptResult> {
    const response = await fetchWithBudget(
      path,
      headers,
      body,
      signal,
      timeoutMs,
      fetchImpl,
    );
    const bodyText = await response.text();
    const headerRequestId = response.headers.get("x-request-id");
    const retryAfter = response.headers.get("retry-after");
    const envelope = parseSqlDbEnvelope(bodyText);
    if (envelope.kind === "success") {
      if (response.status < 200 || response.status >= 300) {
        return {
          outcome: "error",
          error: sqlDbErrorFromWire({
            status: response.status,
            code: "internal_error",
            requestId: headerRequestId,
            details: { mismatch: "success envelope on an error status" },
          }),
          retryAfter,
        };
      }
      return { outcome: "success", status: response.status, data: envelope.data };
    }
    if (envelope.kind === "error") {
      return {
        outcome: "error",
        error: sqlDbErrorFromWire({
          status: response.status,
          code: envelope.code,
          requestId: envelope.requestId ?? headerRequestId,
          retryable: envelope.retryable,
          details: envelope.details,
        }),
        retryAfter,
      };
    }
    // Malformed body: no usable envelope. The wire code is unknown,
    // so the local family and retryability fall back to the HTTP
    // status (a malformed 429/503 is retryable, like V3-30a).
    return {
      outcome: "error",
      error: sqlDbErrorFromWire({
        status: response.status,
        code: null,
        requestId: headerRequestId,
        details: { mismatch: "response body is not a valid envelope" },
      }),
      retryAfter,
    };
  }

  /**
   * Wait out one backoff delay. An abort during the wait (or a
   * signal found aborted right after it, for delay implementations
   * that ignore the signal) throws the aborted error and no second
   * attempt is ever sent.
   */
  async function waitForRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await delayImpl(ms, signal);
    } catch (error) {
      if (signal?.aborted === true || errorNameOf(error) === "AbortError") {
        throwAborted();
      }
      throw error;
    }
    if (signal?.aborted === true) {
      throwAborted();
    }
  }

  /**
   * POST with the retry policy from the module header: at most one
   * retry, reusing the same body and the same idempotency key. The
   * retry fires only when no response was received (a rejected
   * fetch, after a backoff delay), when the response is a
   * retryable 429/503 (after a backoff delay), or when the
   * response is 403 `csrf_invalid` and a refresher is injected
   * (after a token refresh, with headers rebuilt through
   * `rebuildHeaders` so the retry carries the fresh token). The
   * three triggers share one retry budget. Every other response
   * (409, 400/401/403/404, and the rest) throws on the first
   * attempt. A caller abort is never retried. A timeout rejects
   * the fetch race like any other transport failure: it consumes
   * the one retry, then surfaces as a retryable TIMEOUT.
   */
  async function postWithRetry(
    path: string,
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    fetchImpl: SqlDbFetchLike,
    rebuildHeaders: () => Promise<Record<string, string>>,
    timeoutMs: number,
  ): Promise<{ status: number; data: unknown }> {
    let attemptedRetry = false;
    let attemptHeaders = headers;
    for (;;) {
      let result: PostAttemptResult;
      try {
        result = await postAttempt(
          path,
          body,
          attemptHeaders,
          signal,
          fetchImpl,
          timeoutMs,
        );
      } catch (error) {
        if (signal?.aborted === true || errorNameOf(error) === "AbortError") {
          throwAborted();
        }
        if (attemptedRetry) {
          const name = errorNameOf(error);
          if (name === "TimeoutError") {
            throw new SqlDbClientError({
              code: null,
              localCode: "TIMEOUT",
              status: null,
              retryable: true,
              details: {},
            });
          }
          throw new SqlDbClientError({
            code: null,
            localCode: "NETWORK_ERROR",
            status: null,
            retryable: true,
            details: {},
          });
        }
        attemptedRetry = true;
        await waitForRetry(DB_CLIENT_DEFAULT_RETRY_DELAY_MS, signal);
        continue;
      }
      if (result.outcome === "success") {
        return { status: result.status, data: result.data };
      }
      const error = result.error;
      const retryableResponse =
        (error.status === 429 || error.status === 503) && error.retryable;
      if (!attemptedRetry && error.code === "csrf_invalid" && deps.refreshCsrfToken !== undefined) {
        attemptedRetry = true;
        try {
          await deps.refreshCsrfToken();
        } catch {
          throw error;
        }
        attemptHeaders = await rebuildHeaders();
        continue;
      }
      if (attemptedRetry || !retryableResponse) {
        throw error;
      }
      attemptedRetry = true;
      await waitForRetry(retryDelayMsForResponse(result.retryAfter), signal);
    }
  }

  async function buildHeaders(
    idempotencyKey: string | null,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (deps.getCsrfToken !== undefined) {
      const token = await deps.getCsrfToken();
      if (token) {
        headers["X-CSRF-Token"] = token;
      }
    }
    if (idempotencyKey !== null) {
      headers["Idempotency-Key"] = idempotencyKey;
    }
    return headers;
  }

  /**
   * Remap a chunk-local failure to the caller's global operation
   * array: add the chunk offset to a numeric `operationIndex` in
   * the error details, and record how many operations in earlier
   * chunks already committed. Only used when the call actually
   * chunked; single-chunk failures pass through untouched.
   */
  function remapChunkError(
    error: SqlDbClientError,
    chunkIndex: number,
    completedOperations: number,
  ): SqlDbClientError {
    if (chunkIndex === 0 && completedOperations === 0) {
      return error;
    }
    const details: SqlDbErrorDetails = { ...error.details };
    if (error.operationIndex !== null) {
      details["operationIndex"] = error.operationIndex + completedOperations;
    }
    details["failedChunkIndex"] = chunkIndex;
    details["completedOperations"] = completedOperations;
    return new SqlDbClientError({
      code: error.code,
      localCode: error.localCode,
      status: error.status,
      retryable: error.retryable,
      requestId: error.requestId,
      details,
    });
  }

  async function executeTransaction(
    operations: readonly DbWriteOperation[],
    options: SqlTransactionCallOptions = {},
  ): Promise<SqlTransactionResult> {
    validateDbClientOperations(operations, "write");
    if (options.signal?.aborted === true) {
      throwAborted();
    }
    validateTimeoutMs(options.timeoutMs, "SqlTransactionCallOptions.timeoutMs");
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const fetchImpl = resolveFetch();
    const baseKey =
      options.idempotencyKey === undefined
        ? validateIdempotencyKeyValue(generateKey())
        : validateIdempotencyKeyValue(options.idempotencyKey);
    // An empty call still sends one request: the server mints the
    // transaction id and resolves the workspace (404 when none),
    // both observable. Chunking an empty array yields no chunks,
    // so the empty case is one explicit empty chunk.
    const chunks =
      operations.length === 0
        ? [[] as DbWriteOperation[]]
        : chunkOperations(operations, DB_CLIENT_MAX_OPERATIONS_PER_REQUEST);
    const transactionIds: string[] = [];
    const results: SqlTransactionResultEntry[] = [];
    let completedOperations = 0;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      const chunkKey =
        baseKey === null
          ? null
          : deriveChunkIdempotencyKey(baseKey, chunkIndex, chunks.length);
      const headers = await buildHeaders(chunkKey);
      const body = JSON.stringify({ operations: chunk });
      let data: unknown;
      try {
        ({ data } = await postWithRetry(
          SQL_TRANSACTIONS_PATH,
          body,
          headers,
          options.signal,
          fetchImpl,
          () => buildHeaders(chunkKey),
          timeoutMs,
        ));
      } catch (error) {
        if (error instanceof SqlDbClientError) {
          throw remapChunkError(error, chunkIndex, completedOperations);
        }
        throw error;
      }
      const validated = validateTransactionData(
        data,
        chunk.map((operation) => operation.kind),
      );
      transactionIds.push(validated.transactionId);
      results.push(...validated.results);
      completedOperations += chunk.length;
    }
    return { transactionIds, results };
  }

  async function executeBatch(
    operations: readonly DbReadOperation[],
    options: SqlBatchCallOptions = {},
  ): Promise<SqlBatchResult> {
    validateDbClientOperations(operations, "read");
    if (options.signal?.aborted === true) {
      throwAborted();
    }
    validateTimeoutMs(options.timeoutMs, "SqlBatchCallOptions.timeoutMs");
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const fetchImpl = resolveFetch();
    // Reads carry no idempotency key (kontrak 3.4: batch has no key
    // semantics). An empty call still sends one request, matching
    // the transaction path: the server resolves the workspace.
    const chunks =
      operations.length === 0
        ? [[] as DbReadOperation[]]
        : chunkOperations(operations, DB_CLIENT_MAX_OPERATIONS_PER_REQUEST);
    const results: SqlBatchResultEntry[] = [];
    let completedOperations = 0;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      const headers = await buildHeaders(null);
      const body = JSON.stringify({ operations: chunk });
      let data: unknown;
      try {
        ({ data } = await postWithRetry(
          SQL_DB_BATCH_PATH,
          body,
          headers,
          options.signal,
          fetchImpl,
          () => buildHeaders(null),
          timeoutMs,
        ));
      } catch (error) {
        if (error instanceof SqlDbClientError) {
          throw remapChunkError(error, chunkIndex, completedOperations);
        }
        throw error;
      }
      const validated = validateBatchData(
        data,
        chunk.map((operation) => operation.kind),
      );
      results.push(...validated);
      completedOperations += chunk.length;
    }
    return { results };
  }

  return { executeTransaction, executeBatch };
}
