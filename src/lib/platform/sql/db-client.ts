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
 * SEAM (V3-30 unification): at this base there is no centralized API
 * client module in the tree (V3-30a/b land on branches web-api-client
 * and web-api-csrf, not yet merged), so this module carries a minimal
 * typed fetch of its own: exactly two fixed relative paths, JSON
 * bodies, cookie credentials, an injected CSRF token provider, and
 * envelope parsing. It deliberately duplicates none of the V3-30a
 * client: no timeout budget, no abort race, no 401 seam, no request
 * id generation, no path validation beyond the two fixed constants.
 * When V3-30 lands, the integrator replaces the single internal fetch
 * call with `ApiClient.requestJson` (same paths, same bodies, same
 * idempotency-key header, CSRF from the V3-30b provider) and keeps
 * validation, chunking, and error mapping unchanged. The error type
 * below mirrors the V3-30a `ApiError` fields (`code` flat alias of
 * `wireCode`, `status`, `retryable`, `requestId`, frozen `details`,
 * message built from codes and status only) so that replacement is
 * mechanical: catch `ApiError`, feed its fields to
 * `sqlDbErrorFromWire`, and throw the result.
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
 * Retry policy (kontrak 2.2, K-07): an HTTP response is never
 * retried automatically, including 409 conflicts and 429/503
 * responses whose envelope says `retryable: true`. Only a rejected
 * fetch (a network failure, no response received) is retried, exactly
 * once, with the same body and the same idempotency key. A caller
 * abort is never retried. The `retryable` flag on errors is advisory
 * for the caller, never a trigger for this client.
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
  // Documented V3-30a extension: `not_found` maps to VALIDATION_ERROR,
  // and the 415/422 families map here as well (kontrak 6.5 names no
  // local code for them). Preserved so V3-30 unification keeps the
  // same coarse behavior.
  "not_found",
  "not_text_file",
  "unsupported_media_type",
  "range_not_satisfiable",
  "invalid_text_encoding",
  "unsupported_backup_format",
  "backup_corrupt",
  "backup_decrypt_failed",
  "schema_too_new",
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

/**
 * Map a wire code to its coarse local family, code-first (kontrak
 * 6.1 rule 3: `revision_conflict` 409 vs 412 is decided by endpoint,
 * never by status). An unknown code falls back to the HTTP status,
 * and a missing status falls back to SERVER_ERROR.
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
    // 5xx codes, 501 capability codes, and anything unlisted land in
    // SERVER_ERROR unless the status says otherwise below.
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
    if (status === 400 || status === 404 || status === 415 || status === 422) {
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
 * always wins over this derivation.
 */
export function deriveSqlDbRetryable(
  wireCode: string | null,
  envelopeRetryable: boolean | null,
): boolean {
  if (envelopeRetryable !== null) {
    return envelopeRetryable;
  }
  return (
    wireCode === "rate_limited" ||
    wireCode === "service_unavailable" ||
    wireCode === "write_queue_timeout"
  );
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
    retryable: deriveSqlDbRetryable(input.code, input.retryable ?? null),
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
  /** Idempotency-key generator. Defaults to `createIdempotencyKey`. Injectable for tests. */
  generateIdempotencyKey?: () => string;
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
}

export interface SqlBatchCallOptions {
  /** Caller abort signal, passed through to fetch. Aborting is never retried. */
  signal?: AbortSignal;
}

/**
 * Transport seam for the web SqlAdapter (sql.web.ts, v3b-14a). The
 * adapter calls these two methods and narrows batch rows per kind;
 * it never touches fetch, chunking, keys, or envelopes directly.
 */
export interface SqlDbClient {
  executeTransaction(
    operations: readonly DbWriteOperation[],
    options?: SqlTransactionCallOptions,
  ): Promise<SqlTransactionResult>;
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

export function createSqlDbClient(deps: SqlDbClientDeps = {}): SqlDbClient {
  const generateKey = deps.generateIdempotencyKey ?? createIdempotencyKey;

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
   * One POST attempt: fetch, read the body as text, parse the
   * envelope. Throws `SqlDbClientError` for error envelopes and
   * malformed bodies (both are responses: never retried). Lets
   * fetch rejections propagate untouched so the retry wrapper can
   * tell a network failure from a response.
   */
  async function postOnce(
    path: string,
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    fetchImpl: SqlDbFetchLike,
  ): Promise<{ status: number; data: unknown }> {
    const response = await fetchImpl(path, {
      method: "POST",
      headers,
      body,
      credentials: "same-origin",
      signal,
    });
    const bodyText = await response.text();
    const headerRequestId = response.headers.get("x-request-id");
    const envelope = parseSqlDbEnvelope(bodyText);
    if (envelope.kind === "success") {
      if (response.status < 200 || response.status >= 300) {
        throw sqlDbErrorFromWire({
          status: response.status,
          code: "internal_error",
          requestId: headerRequestId,
          details: { mismatch: "success envelope on an error status" },
        });
      }
      return { status: response.status, data: envelope.data };
    }
    if (envelope.kind === "error") {
      throw sqlDbErrorFromWire({
        status: response.status,
        code: envelope.code,
        requestId: envelope.requestId ?? headerRequestId,
        retryable: envelope.retryable,
        details: envelope.details,
      });
    }
    // Malformed body: no usable envelope. The wire code is unknown,
    // so the local family falls back to the HTTP status.
    throw sqlDbErrorFromWire({
      status: response.status,
      code: null,
      requestId: headerRequestId,
      details: { mismatch: "response body is not a valid envelope" },
    });
  }

  /**
   * POST with the retry policy: exactly one retry, only when the
   * attempt failed without a response (a rejected fetch or body
   * read), reusing the same headers (hence the same idempotency
   * key) and the same body. `SqlDbClientError` from `postOnce`
   * always means a response arrived and is never retried. A caller
   * abort is never retried either.
   */
  async function postWithSingleNetworkRetry(
    path: string,
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    fetchImpl: SqlDbFetchLike,
  ): Promise<{ status: number; data: unknown }> {
    try {
      return await postOnce(path, body, headers, signal, fetchImpl);
    } catch (error) {
      if (error instanceof SqlDbClientError) {
        throw error;
      }
      if (signal?.aborted === true || errorNameOf(error) === "AbortError") {
        throwAborted();
      }
      try {
        return await postOnce(path, body, headers, signal, fetchImpl);
      } catch (retryError) {
        if (retryError instanceof SqlDbClientError) {
          throw retryError;
        }
        if (signal?.aborted === true || errorNameOf(retryError) === "AbortError") {
          throwAborted();
        }
        const name = errorNameOf(retryError);
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
        ({ data } = await postWithSingleNetworkRetry(
          SQL_TRANSACTIONS_PATH,
          body,
          headers,
          options.signal,
          fetchImpl,
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
        ({ data } = await postWithSingleNetworkRetry(
          SQL_DB_BATCH_PATH,
          body,
          headers,
          options.signal,
          fetchImpl,
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
