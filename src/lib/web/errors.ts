// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Wire error vocabulary and wire-to-local mapping for the centralized
// web API client (Fase 1, V3-30a).
//
// Canonical sources: fase1/kontrak-api-kanonis.md section 2 (envelope),
// section 6.2 (wire catalog, snake_case), and section 6.5 (local
// router/adapter vocabulary, SCREAMING). The wire catalog here mirrors
// server/src/plugins/envelope.ts (the frozen middleware shape, AD-40);
// the two lists must stay identical, and any new wire code needs a
// contract amendment first (contract section 6.1 rule 2).
//
// Mapping rules (contract 6.5, binding):
// - 401 unauthenticated / invalid_credentials / invalid_verification_code
//   become AUTH_REQUIRED.
// - 400 validation_failed becomes VALIDATION_ERROR.
// - 409/412 revision_conflict / record_tags_changed become CONFLICT.
// - 410 capability_unavailable becomes CAPABILITY_UNAVAILABLE.
// - 413 becomes PAYLOAD_TOO_LARGE.
// - 429 becomes RATE_LIMITED.
// - 5xx becomes SERVER_ERROR (or TIMEOUT for a network timeout).
// - 501 with a specific code becomes a typed per-capability error
//   (FuzzySearchUnavailableError for fuzzy search), never an empty
//   list and never a disguised null (contract 7.1 rule 4).
//
// Extensions beyond the binding sentences above are deliberate and
// documented in WIRE_TO_LOCAL_CODE below. The local vocabulary has no
// code for several wire families (forbidden, not_found, tag conflicts,
// 415/422 rejections), so those map to the closest coarse family and
// the exact wire code is always preserved on the error object.
// Callers that need precision branch on wireCode, never on message
// text and never on the coarse local code alone. This follows AD-39:
// code in src/lib/ returns stable machine codes; translation happens
// only in the UI layer.
//
// Mapping is CODE-FIRST, never status-first, for known codes. Contract
// amendment D1 (AD-29) proves why: revision_conflict is 412 on some
// endpoints and 409 on others, decided per endpoint table, so the
// status cannot decide the local code. Status is used only as a
// fallback for unknown wire codes and for non-envelope failures.
//
// CAPABILITY_GATED and UNKNOWN_COMMAND are part of the local
// vocabulary but are never produced from the wire: the invoke router
// throws them locally without HTTP (contract 6.5). NETWORK_ERROR and
// TIMEOUT are produced only by transport failures, never from an
// envelope. FEATURE_NOT_YET_AVAILABLE is produced from the wire only
// through the three typed 501 subclasses below; that is the adapter
// mapping contract 7.1 rule 4 requires, distinct from the router's
// local FEATURE_NOT_YET_AVAILABLE rejections, which send no HTTP.
//
// No secret handling lives here: error messages are stable strings
// built only from codes and the HTTP status. The raw server message
// is kept on wireMessage for debugging and must never be displayed
// directly or logged wholesale by callers.

/** Every snake_case wire code in contract section 6.2, in table order. */
export const API_ERROR_CODES = Object.freeze([
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
  "unauthenticated",
  "invalid_credentials",
  "invalid_verification_code",
  "invalid_setup_token",
  "forbidden",
  "csrf_invalid",
  "origin_rejected",
  "step_up_required",
  "not_found",
  "method_not_allowed",
  "already_exists",
  "target_exists",
  "revision_conflict",
  "record_tags_changed",
  "wrong_kind",
  "repair_precondition_failed",
  "reconcile_already_running",
  "idempotency_key_reused",
  "tag_in_use",
  "tag_locked",
  "tag_name_taken",
  "backup_in_progress",
  "capability_unavailable",
  "text_too_large",
  "media_too_large",
  "asset_too_large",
  "payload_too_large",
  "not_text_file",
  "unsupported_media_type",
  "range_not_satisfiable",
  "invalid_text_encoding",
  "unsupported_backup_format",
  "backup_corrupt",
  "backup_decrypt_failed",
  "schema_too_new",
  "precondition_required",
  "rate_limited",
  "internal_error",
  "index_update_failed",
  "trash_blob_missing",
  "fuzzy_search_unavailable",
  "document_parse_unavailable",
  "restore_unavailable",
  "service_unavailable",
  "write_queue_timeout",
] as const);

/** Snake_case wire error code, exactly as it appears on the wire. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const API_ERROR_CODE_SET: ReadonlySet<string> = new Set(API_ERROR_CODES);

/** True when the value is a wire code from the contract catalog. */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && API_ERROR_CODE_SET.has(value);
}

/**
 * Local router/adapter vocabulary (contract 6.5). This set is closed:
 * do not add codes here without a contract amendment. The vocabulary
 * is coarse by design; the exact wire code rides on ApiError.wireCode.
 */
export type LocalApiErrorCode =
  | "CAPABILITY_UNAVAILABLE"
  | "CAPABILITY_GATED"
  | "FEATURE_NOT_YET_AVAILABLE"
  | "UNKNOWN_COMMAND"
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "SERVER_ERROR";

/**
 * Wire-to-local mapping for every catalog code. TypeScript enforces
 * exhaustiveness: adding a wire code to API_ERROR_CODES without a
 * row here is a compile error.
 *
 * Rows marked (6.5) are the binding sentences from contract 6.5.
 * Other rows are documented extensions:
 * - Auth layer (401/403 family): invalid_setup_token, forbidden,
 *   csrf_invalid, origin_rejected, and step_up_required join
 *   AUTH_REQUIRED. The wire code stays available, which matters for
 *   CSRF handling: only csrf_invalid means "token stale, fetch a
 *   fresh one", while origin_rejected means something else entirely.
 *   Callers must not treat the whole family as "go to login".
 * - invalid_action_token (400, reset-confirm token): VALIDATION_ERROR,
 *   because the request's token field is invalid, not the session.
 * - tag_not_found / asset_not_found (400): VALIDATION_ERROR, because
 *   the referenced entity in the request body does not exist; this
 *   differs from 404 not_found for the addressed resource itself.
 * - not_found (404) / method_not_allowed (405): VALIDATION_ERROR as
 *   the closest 4xx family. There is no local NOT_FOUND code, and
 *   inventing one would change the 6.5 vocabulary. Branch on
 *   wireCode for "resource does not exist" handling.
 * - Other 409 codes (already_exists, target_exists, wrong_kind,
 *   repair_precondition_failed, reconcile_already_running,
 *   idempotency_key_reused, tag_in_use, tag_locked, tag_name_taken,
 *   backup_in_progress): CONFLICT, the state-conflict family. A
 *   conflict needs a new guard or a user decision, never a blind
 *   retry (contract K-07).
 * - 415/416/422 codes (not_text_file, unsupported_media_type,
 *   range_not_satisfiable, invalid_text_encoding, and the four
 *   Fase 2 restore codes): VALIDATION_ERROR, the request-rejection
 *   family.
 * - precondition_required (428): VALIDATION_ERROR, because the
 *   request is missing its guard, as opposed to carrying a stale
 *   guard (which is revision_conflict / CONFLICT).
 * - 500/503 codes (internal_error, index_update_failed,
 *   trash_blob_missing, service_unavailable, write_queue_timeout):
 *   SERVER_ERROR (6.5: 5xx becomes SERVER_ERROR). The retryable
 *   flag, not the local code, distinguishes transient 503s.
 * - 501 codes: FEATURE_NOT_YET_AVAILABLE, delivered through the
 *   typed subclasses below, never as a bare ApiError.
 */
export const WIRE_TO_LOCAL_CODE: Readonly<Record<ApiErrorCode, LocalApiErrorCode>> =
  Object.freeze({
    validation_failed: "VALIDATION_ERROR",
    invalid_json: "VALIDATION_ERROR",
    invalid_path: "VALIDATION_ERROR",
    symlink_not_allowed: "VALIDATION_ERROR",
    invalid_query: "VALIDATION_ERROR",
    invalid_cursor: "VALIDATION_ERROR",
    invalid_limit: "VALIDATION_ERROR",
    invalid_precondition: "VALIDATION_ERROR",
    invalid_patch_range: "VALIDATION_ERROR",
    invalid_upload: "VALIDATION_ERROR",
    invalid_move: "VALIDATION_ERROR",
    invalid_operation: "VALIDATION_ERROR",
    not_a_directory: "VALIDATION_ERROR",
    confirm_required: "VALIDATION_ERROR",
    tag_not_found: "VALIDATION_ERROR",
    asset_not_found: "VALIDATION_ERROR",
    invalid_action_token: "VALIDATION_ERROR",
    unauthenticated: "AUTH_REQUIRED",
    invalid_credentials: "AUTH_REQUIRED",
    invalid_verification_code: "AUTH_REQUIRED",
    invalid_setup_token: "AUTH_REQUIRED",
    forbidden: "AUTH_REQUIRED",
    csrf_invalid: "AUTH_REQUIRED",
    origin_rejected: "AUTH_REQUIRED",
    step_up_required: "AUTH_REQUIRED",
    not_found: "VALIDATION_ERROR",
    method_not_allowed: "VALIDATION_ERROR",
    already_exists: "CONFLICT",
    target_exists: "CONFLICT",
    revision_conflict: "CONFLICT",
    record_tags_changed: "CONFLICT",
    wrong_kind: "CONFLICT",
    repair_precondition_failed: "CONFLICT",
    reconcile_already_running: "CONFLICT",
    idempotency_key_reused: "CONFLICT",
    tag_in_use: "CONFLICT",
    tag_locked: "CONFLICT",
    tag_name_taken: "CONFLICT",
    backup_in_progress: "CONFLICT",
    capability_unavailable: "CAPABILITY_UNAVAILABLE",
    text_too_large: "PAYLOAD_TOO_LARGE",
    media_too_large: "PAYLOAD_TOO_LARGE",
    asset_too_large: "PAYLOAD_TOO_LARGE",
    payload_too_large: "PAYLOAD_TOO_LARGE",
    not_text_file: "VALIDATION_ERROR",
    unsupported_media_type: "VALIDATION_ERROR",
    range_not_satisfiable: "VALIDATION_ERROR",
    invalid_text_encoding: "VALIDATION_ERROR",
    unsupported_backup_format: "VALIDATION_ERROR",
    backup_corrupt: "VALIDATION_ERROR",
    backup_decrypt_failed: "VALIDATION_ERROR",
    schema_too_new: "VALIDATION_ERROR",
    precondition_required: "VALIDATION_ERROR",
    rate_limited: "RATE_LIMITED",
    internal_error: "SERVER_ERROR",
    index_update_failed: "SERVER_ERROR",
    trash_blob_missing: "SERVER_ERROR",
    fuzzy_search_unavailable: "FEATURE_NOT_YET_AVAILABLE",
    document_parse_unavailable: "FEATURE_NOT_YET_AVAILABLE",
    restore_unavailable: "FEATURE_NOT_YET_AVAILABLE",
    service_unavailable: "SERVER_ERROR",
    write_queue_timeout: "SERVER_ERROR",
  });

/**
 * Map an HTTP status to the closest local code. Used ONLY for unknown
 * wire codes and for failures that carry no envelope at all. Known
 * wire codes always go through WIRE_TO_LOCAL_CODE instead, because
 * the status alone cannot decide the mapping (see D1, above).
 */
export function mapStatusToLocalCode(status: number): LocalApiErrorCode {
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
  return "SERVER_ERROR";
}

/**
 * Map a wire code to its local code. Known codes use the table;
 * unknown codes fall back to the status mapping so that a future
 * server code degrades gracefully instead of crashing the client.
 * An unknown code on the wire still needs a contract amendment
 * server-side; client tolerance is not permission to invent codes.
 */
export function mapWireCodeToLocalCode(
  wireCode: string,
  status?: number,
): LocalApiErrorCode {
  if (isApiErrorCode(wireCode)) {
    return WIRE_TO_LOCAL_CODE[wireCode];
  }
  if (status !== undefined) {
    return mapStatusToLocalCode(status);
  }
  return "SERVER_ERROR";
}

/**
 * Derive the retryable flag when an error envelope omits it. The
 * envelope value, when present, always wins; this fills only the
 * missing case, following K-07: retryable is true only when repeating
 * the exact same request may succeed (429 and 503).
 */
export function deriveRetryable(wireCode: string | null, status: number | null): boolean {
  if (
    wireCode === "rate_limited" ||
    wireCode === "service_unavailable" ||
    wireCode === "write_queue_timeout"
  ) {
    return true;
  }
  if (wireCode === null || !isApiErrorCode(wireCode)) {
    return status === 429 || status === 503;
  }
  return false;
}

/** Success envelope (contract 2.1): data holds the per-endpoint shape. */
export interface ApiSuccessEnvelope<T> {
  ok: true;
  data: T;
}

/** Error body inside an error envelope (contract 2.2). */
export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

/** Error envelope (contract 2.2). */
export interface ApiErrorEnvelope {
  ok: false;
  error: ApiErrorBody;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Validate a parsed JSON value as a success envelope. Returns the
 * envelope when ok is exactly true and a data field is present (data
 * may be null, an array, or a scalar, per contract 2.1); otherwise
 * returns null. A 200 response that reports failure (ok false) is
 * not a success envelope and must never be treated as one.
 */
export function parseSuccessEnvelope<T>(value: unknown): ApiSuccessEnvelope<T> | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.ok !== true || !hasOwn(value, "data")) {
    return null;
  }
  return { ok: true, data: value.data as T };
}

/** Normalized form of a parsed error envelope, with gaps filled. */
export interface ParsedErrorEnvelope {
  wireCode: string;
  /** Raw server message text, or null when absent or not a string. */
  wireMessage: string | null;
  /** requestId from the envelope, or null when absent (header wins then). */
  requestId: string | null;
  /** retryable from the envelope, or undefined when absent (derive then). */
  retryable: boolean | undefined;
  details: Record<string, unknown>;
}

/**
 * Validate a parsed JSON value as an error envelope. Requires
 * ok === false and an error object with a non-empty string code;
 * every other field is normalized defensively, because a malformed
 * envelope must degrade to a typed error, never to a crash and never
 * to a success. Returns null when the shape is not an error envelope
 * at all (including a success envelope and a non-object value).
 */
export function parseErrorEnvelope(value: unknown): ParsedErrorEnvelope | null {
  if (!isRecord(value) || value.ok !== false) {
    return null;
  }
  const errorValue = value.error;
  if (!isRecord(errorValue)) {
    return null;
  }
  const code = errorValue.code;
  if (typeof code !== "string" || code === "") {
    return null;
  }
  const message = errorValue.message;
  const requestId = errorValue.requestId;
  const retryable = errorValue.retryable;
  const details = errorValue.details;
  return {
    wireCode: code,
    wireMessage: typeof message === "string" && message !== "" ? message : null,
    requestId: typeof requestId === "string" && requestId !== "" ? requestId : null,
    retryable: typeof retryable === "boolean" ? retryable : undefined,
    details: isRecord(details) ? { ...details } : {},
  };
}

export interface ApiErrorOptions {
  localCode: LocalApiErrorCode;
  /** Exact wire code, or null when no envelope was received. */
  wireCode?: string | null;
  /** HTTP status, or null when no response was received. */
  status?: number | null;
  retryable?: boolean;
  /** requestId from the envelope or the X-Request-Id header, else null. */
  requestId?: string | null;
  /** Per-code fields from error.details. Never contains secrets by contract. */
  details?: Record<string, unknown>;
  /** Raw server message text. Never used in Error.message. */
  wireMessage?: string | null;
}

function buildApiErrorMessage(
  localCode: LocalApiErrorCode,
  wireCode: string | null,
  status: number | null,
): string {
  if (wireCode !== null) {
    const statusText = status === null ? "unknown status" : `HTTP ${status}`;
    return `API error ${wireCode} (${statusText}, ${localCode})`;
  }
  return `API request failed (${localCode})`;
}

/**
 * The single error type thrown by the centralized API client.
 *
 * Fields:
 * - localCode: coarse family from the 6.5 vocabulary. Branch on this
 *   only for coarse handling (auth vs conflict vs retryable).
 * - wireCode: exact snake_case server code, or null when no envelope
 *   arrived. Branch on this for precise handling (csrf_invalid vs
 *   origin_rejected, revision_conflict payloads, tag codes).
 * - code: alias of wireCode, kept as a flat field. The V3-30b seam
 *   in csrf.ts (readErrorStatusCode) branches on the flat status
 *   and code fields of the thrown error; without this alias its
 *   csrf_invalid predicate could never see the wire code. Always
 *   equal to wireCode; never set independently.
 * - status: HTTP status, or null when no response arrived.
 * - retryable: K-07 semantics. Advisory only: the client never
 *   retries on its own, and a retry still needs a fresh guard or an
 *   idempotency key where the contract requires one.
 * - requestId: correlation id from the envelope or the response
 *   header. Safe to log; it carries no secret.
 * - details: per-code fields from the envelope, shallow-copied and
 *   frozen at the top level. Treat as untrusted server data.
 * - wireMessage: raw server text. Kept for debugging only. Never
 *   display it directly: UI text comes from i18n keys (AD-39), and
 *   branching must use codes, never message text.
 *
 * The Error message itself is a stable string built only from codes
 * and the status. It never contains the request path (which may hold
 * a single-use download token), query values, request bodies, header
 * values, or server message text, so throwing this error can never
 * leak a secret into a log through the message.
 *
 * The request path is deliberately NOT stored on the error, for the
 * same reason: GET /api/backups/downloads/:downloadToken puts a
 * secret-bearing token in the path, and any field that holds a URL
 * will eventually be logged.
 */
export class ApiError extends Error {
  readonly localCode: LocalApiErrorCode;
  readonly wireCode: string | null;
  /** Alias of wireCode. Flat `code` field required by the V3-30b seam (see the class doc). */
  readonly code: string | null;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly wireMessage: string | null;

  constructor(options: ApiErrorOptions) {
    const wireCode = options.wireCode ?? null;
    const status = options.status ?? null;
    super(buildApiErrorMessage(options.localCode, wireCode, status));
    this.name = "ApiError";
    this.localCode = options.localCode;
    this.wireCode = wireCode;
    this.code = wireCode;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId ?? null;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    this.wireMessage = options.wireMessage ?? null;
  }

  /**
   * Log-safe summary: codes, status, retryable, and requestId only.
   * No details, no message text, no path. This is the only shape
   * callers should log for an ApiError.
   */
  toSafeSummary(): {
    localCode: LocalApiErrorCode;
    wireCode: string | null;
    status: number | null;
    retryable: boolean;
    requestId: string | null;
  } {
    return {
      localCode: this.localCode,
      wireCode: this.wireCode,
      status: this.status,
      retryable: this.retryable,
      requestId: this.requestId,
    };
  }
}

/**
 * Typed 501 error for fuzzy search (contract 6.5 and 7.1 rule 4,
 * V1-14 section 9.4). The contract names this type
 * FuzzySearchUnavailable; the Error suffix follows the repo error
 * naming convention, and the alias below keeps the contract name
 * usable. Adapters must surface this error, never an empty list.
 */
export class FuzzySearchUnavailableError extends ApiError {
  constructor(options: Omit<ApiErrorOptions, "localCode" | "wireCode">) {
    super({
      ...options,
      localCode: "FEATURE_NOT_YET_AVAILABLE",
      wireCode: "fuzzy_search_unavailable",
    });
    this.name = "FuzzySearchUnavailableError";
  }
}

/** Contract name for FuzzySearchUnavailableError (see above). */
export type FuzzySearchUnavailable = FuzzySearchUnavailableError;

/**
 * Typed 501 error for document parsing (contract 7.2). Same rule as
 * fuzzy search: surface the error, never a fake result.
 */
export class DocumentParseUnavailableError extends ApiError {
  constructor(options: Omit<ApiErrorOptions, "localCode" | "wireCode">) {
    super({
      ...options,
      localCode: "FEATURE_NOT_YET_AVAILABLE",
      wireCode: "document_parse_unavailable",
    });
    this.name = "DocumentParseUnavailableError";
  }
}

/** Contract-style name for DocumentParseUnavailableError. */
export type DocumentParseUnavailable = DocumentParseUnavailableError;

/**
 * Typed 501 error for backup restore (contract 7.2). Same rule:
 * surface the error, never a fake success.
 */
export class RestoreUnavailableError extends ApiError {
  constructor(options: Omit<ApiErrorOptions, "localCode" | "wireCode">) {
    super({
      ...options,
      localCode: "FEATURE_NOT_YET_AVAILABLE",
      wireCode: "restore_unavailable",
    });
    this.name = "RestoreUnavailableError";
  }
}

/** Contract-style name for RestoreUnavailableError. */
export type RestoreUnavailable = RestoreUnavailableError;

export interface WireErrorInput {
  status: number;
  wireCode: string;
  wireMessage?: string | null;
  requestId?: string | null;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

/**
 * Build the ApiError for a wire error envelope. The three 501 codes
 * produce their typed subclasses; every other code produces a plain
 * ApiError with the mapped local code. When retryable is undefined
 * (envelope omitted it), it is derived by K-07 rules.
 */
export function createApiErrorFromWire(input: WireErrorInput): ApiError {
  const retryable =
    input.retryable ?? deriveRetryable(input.wireCode, input.status);
  const shared = {
    status: input.status,
    requestId: input.requestId ?? null,
    retryable,
    details: input.details ?? {},
    wireMessage: input.wireMessage ?? null,
  };
  if (input.wireCode === "fuzzy_search_unavailable") {
    return new FuzzySearchUnavailableError(shared);
  }
  if (input.wireCode === "document_parse_unavailable") {
    return new DocumentParseUnavailableError(shared);
  }
  if (input.wireCode === "restore_unavailable") {
    return new RestoreUnavailableError(shared);
  }
  return new ApiError({
    ...shared,
    localCode: mapWireCodeToLocalCode(input.wireCode, input.status),
    wireCode: input.wireCode,
  });
}

/**
 * Build the ApiError for a failure with no usable envelope (empty
 * body, non-JSON body, malformed envelope, proxy error page). The
 * local code comes from the status fallback, the wire code stays
 * null (the client must not invent wire data), and the body text is
 * never kept, because a proxy page may echo request details.
 */
export function createApiErrorWithoutEnvelope(input: {
  status: number;
  requestId?: string | null;
}): ApiError {
  return new ApiError({
    localCode: mapStatusToLocalCode(input.status),
    wireCode: null,
    status: input.status,
    retryable: deriveRetryable(null, input.status),
    requestId: input.requestId ?? null,
    details: {},
    wireMessage: null,
  });
}

/**
 * Build a transport error: the fetch itself rejected (network down,
 * DNS failure, connection reset) or the response body stream broke.
 * There is no status and no wire code. retryable is true because the
 * same request may succeed once connectivity returns; the client
 * still never retries on its own.
 */
export function createNetworkError(): ApiError {
  return new ApiError({
    localCode: "NETWORK_ERROR",
    wireCode: null,
    status: null,
    retryable: true,
    requestId: null,
    details: {},
    wireMessage: null,
  });
}

/**
 * Build a timeout error (contract 6.5: 5xx becomes SERVER_ERROR, or
 * TIMEOUT for a network timeout). A timeout caused by the caller's
 * own abort signal is not retryable by the client: the caller ended
 * the request on purpose. A timeout caused by the client's own
 * timeout budget is retryable, with the usual caller-owned retry
 * discipline.
 */
export function createTimeoutError(abortedByCaller: boolean): ApiError {
  return new ApiError({
    localCode: "TIMEOUT",
    wireCode: null,
    status: null,
    retryable: !abortedByCaller,
    requestId: null,
    details: {},
    wireMessage: null,
  });
}

/**
 * Build a local pre-flight error: the request was rejected before
 * any fetch happened (invalid path, forbidden field, conflicting
 * body kinds, CSRF provider failure). The message carries no detail
 * about the rejected input, because the input may contain a token
 * or a secret value. Callers get the coarse code only, by design.
 */
export function createLocalApiError(
  localCode: "VALIDATION_ERROR" | "SERVER_ERROR",
): ApiError {
  return new ApiError({
    localCode,
    wireCode: null,
    status: null,
    retryable: false,
    requestId: null,
    details: {},
    wireMessage: null,
  });
}
