// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Centralized web API client (Fase 1, V3-30a). This module is the ONE
// fetch path for frontend API calls in wave 3: every adapter and UI
// caller goes through ApiClient, and no new ad hoc fetch to /api/*
// may be added elsewhere. The only pre-existing exceptions are the
// M14 boot files in this directory (session-check.ts and
// boot-guard.ts), which predate this client and are intentionally NOT
// migrated by this task (validasi-peta-gelombang3.md, V3-30 row).
//
// Canonical sources: fase1/kontrak-api-kanonis.md sections 1-2 and 6
// (namespace, envelope, error catalog, wire-to-local mapping) and the
// frozen middleware shape (AD-40, bentuk-middleware-beku.md).
//
// Rules enforced here:
// - Same-origin only: paths are relative and must start with /api/.
//   Absolute URLs, protocol-relative URLs, and fragments are
//   rejected before any fetch happens. There is deliberately no base
//   URL setting: the browser calls the API through the relative
//   /api/* path and the edge routes it to the API service (AD-18),
//   exactly like the M14 session probe.
// - No version segment in paths: a version segment directly after
//   /api/ is rejected (contract 1.1 rule 1). The client never builds
//   a versioned path.
// - No workspace identifier in requests: workspaceId / workspace_id
//   in the query string or anywhere in a JSON body is rejected
//   before any fetch happens (contract 1.1 rule 2). The workspace
//   comes from the session, server-side. Echoed workspaceId values
//   in RESPONSES are untouched; callers must not use them to build
//   paths or authorization decisions.
// - Cookie credentials always: every request sends
//   credentials "include". There is no Bearer path in the MVP
//   (contract 1.2 rule 4); an Authorization header from a caller is
//   rejected before any fetch happens.
// - Envelope parsing: JSON responses must carry the contract
//   envelope. Success returns data; failure throws ApiError (see
//   errors.ts). The non-envelope exceptions of contract 2.3 have
//   dedicated methods: requestText (raw text), requestBytes (raw
//   bytes), requestNoContent (204 / HEAD), requestHealth (AD-19
//   health shape, where 503 is data, not an exception).
// - No automatic retry: the client never repeats a request, even
//   when retryable is true. Retries need caller-owned discipline
//   (fresh guards, idempotency keys); see contract K-07 and 1.6.
// - No logging: this module never logs. Error objects never carry
//   the request path, query values, bodies, or header values, so
//   throwing can never leak a token or a secret into a log.
//
// SEAMS FOR V3-30b (CSRF / 401 handling). This task owns the client
// and the envelope/error mapping only. It deliberately does NOT
// implement CSRF token fetching, token storage, token refresh, 401
// redirects, or 401 retries. V3-30b owns csrf.ts (branch
// web-api-csrf) and the 401/CSRF-stale behavior, and wires it
// through these two seams, whose names follow the V3-30b module:
// - onUnauthorized (type OnUnauthorized): called exactly once per
//   HTTP 401 response, awaited, with the ApiError, before the error
//   is thrown. Errors thrown by the handler are swallowed so they
//   can never mask the ApiError. The ApiError carries the flat
//   status, code, and requestId fields that the csrf.ts predicates
//   read, so wiring code forwards it with
//   handleUnauthorizedError(seam, error), where seam is the
//   WebApiAuthSeam from createWebApiAuthSeam (csrf.ts). That call
//   clears the cached token and notifies expiry listeners once;
//   this module never navigates and the handler must not retry the
//   request through this client (contract K-10: 401 means the
//   session is expired; there is no refresh endpoint and no
//   automatic retry; the UI layer decides what to show without
//   losing form data). Do not confuse OnUnauthorized (this
//   callback) with the UnauthorizedHandler interface in csrf.ts,
//   which is the session-status holder behind the seam.
// - csrfTokenProvider: supplies the in-memory CSRF token for
//   mutations, normally as () => seam.csrf.getToken() over the
//   shared CsrfTokenStore from createCsrfTokenStore (csrf.ts).
//   The client only attaches the X-CSRF-Token header when the
//   provider returns a non-empty token; it never fetches the token
//   endpoint itself, never stores a token, and never refreshes a
//   stale token. The single refresh-and-retry on 403 csrf_invalid
//   belongs to V3-30b's withCsrfRetry, applied at the wiring layer
//   around mutation attempts; it composes with this seam because
//   both share the one store instance, so the retried attempt
//   reads the refreshed cached token through this provider. When
//   no provider is wired, mutations are sent without the header
//   and the server answers 403; that is the correct unwired
//   behavior, not a fallback. GET and HEAD never carry the header
//   (contract 1.2 rule 3). Pre-session mutations (login, setup)
//   pass skipCsrf so the provider is not consulted before a
//   session exists. csrf.ts has landed (V3-30b): the shared store
//   comes from createCsrfTokenStore there, and the wiring layer
//   supplies this provider from that same store instance.
//
// Callers import from this file and errors.ts directly. There is no
// barrel index.ts in src/lib/web/ (N-13); do not create one without
// a coordinator decision.

import {
  createApiErrorFromWire,
  createApiErrorWithoutEnvelope,
  createLocalApiError,
  createNetworkError,
  createTimeoutError,
  deriveRetryable,
  parseErrorEnvelope,
  parseSuccessEnvelope,
  ApiError,
} from "./errors";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

const MUTATION_METHODS: ReadonlySet<HttpMethod> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const CSRF_HEADER = "X-CSRF-Token";
const REQUEST_ID_HEADER = "X-Request-Id";
const IDEMPOTENCY_HEADER = "Idempotency-Key";
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * Default per-request timeout for production ApiClient instances
 * (DA28-01 / S-P0-17). Matches the auth budget
 * (AUTH_REQUEST_TIMEOUT_MS in auth-client.ts) and the boot guard
 * total budget. Every production construction site sets this as
 * its defaultTimeoutMs so a stalled API, tunnel, or database
 * surfaces a retryable TIMEOUT ApiError instead of hanging the
 * caller forever. A request may still override it with
 * options.timeoutMs, and callers with a longer legitimate budget
 * must do so explicitly per request.
 */
export const DEFAULT_API_CLIENT_TIMEOUT_MS = 15000;

/**
 * SEAM (V3-30b): invoked once per HTTP 401 response, awaited, before
 * the ApiError is thrown. The name matches the callback type in
 * csrf.ts (V3-30b). That module's listeners receive an
 * UnauthorizedEvent, while this client delivers the ApiError
 * itself, which carries the same flat status, code, and requestId
 * fields the csrf.ts predicates read (see errors.ts); wiring code
 * forwards the error to handleUnauthorizedError(seam, error). The
 * handler must not retry the request, and any error it throws is
 * swallowed by the client. This client never navigates.
 */
export type OnUnauthorized = (error: ApiError) => void | Promise<void>;

/**
 * Former name of OnUnauthorized, kept as an alias so existing wiring
 * keeps compiling. New code uses OnUnauthorized, the V3-30b seam
 * name. Do not confuse this alias with the UnauthorizedHandler
 * interface in csrf.ts, which is the session-status holder, not a
 * callback.
 */
export type UnauthorizedHandler = OnUnauthorized;

/**
 * SEAM (V3-30b): supplies the in-memory CSRF token for one request.
 * Implemented by csrf.ts. Returning null, undefined, or an empty
 * string means "no token available"; the mutation is then sent
 * without the header. A throwing or rejecting provider fails the
 * request closed (no fetch happens) with a local SERVER_ERROR,
 * because a provider failure must never be mistaken for a token.
 */
export type CsrfTokenProvider = () => string | null | undefined | Promise<string | null | undefined>;

/** Supplies a client request id for the X-Request-Id header. */
export type RequestIdProvider = () => string;

export interface ApiClientOptions {
  /** Fetch implementation. Defaults to the global fetch, resolved per request. Injectable for tests. */
  fetchFn?: typeof fetch;
  /** SEAM (V3-30b): 401 handler. See OnUnauthorized. */
  onUnauthorized?: OnUnauthorized;
  /** SEAM (V3-30b): CSRF token provider. See CsrfTokenProvider. */
  csrfTokenProvider?: CsrfTokenProvider;
  /** Supplies X-Request-Id values. Defaults to a UUID/counter generator. */
  requestIdProvider?: RequestIdProvider;
  /**
   * Default per-request timeout in milliseconds. A request may
   * override it with options.timeoutMs. When neither is set, the
   * client applies no timeout of its own and the caller's abort
   * signal (if any) governs. A timeout produces a TIMEOUT ApiError;
   * the fetch is aborted and raced so a signal-ignoring fetch
   * implementation can never hang the caller (F1-59 lesson).
   * Production construction sites must set
   * DEFAULT_API_CLIENT_TIMEOUT_MS here (DA28-01); leaving it
   * unset is reserved for tests that inject their own fetch.
   */
  defaultTimeoutMs?: number;
}

export interface ApiRequestOptions {
  /** HTTP method. Defaults to GET. */
  method?: HttpMethod;
  /**
   * Query parameters, merged with any query string already present
   * in the path. Values of null/undefined are skipped. Keys named
   * workspaceId or workspace_id are rejected (contract 1.1).
   */
  query?: Record<string, string | number | boolean | null | undefined> | URLSearchParams | string;
  /**
   * Extra request headers. Authorization, X-CSRF-Token, and Cookie
   * are rejected here: Authorization has no MVP path, the CSRF
   * token comes only from csrfTokenProvider, and cookies come from
   * the browser. Client-controlled headers (Accept, Content-Type,
   * X-Request-Id, Idempotency-Key, X-CSRF-Token) win on conflict.
   */
  headers?: Record<string, string>;
  /** JSON body, serialized with JSON.stringify. Mutually exclusive with the other body kinds. */
  jsonBody?: unknown;
  /** Plain text body. Mutually exclusive with the other body kinds. */
  textBody?: string;
  /** Multipart body. Mutually exclusive with the other body kinds. No Content-Type is set; the browser sets the boundary. */
  formDataBody?: FormData;
  /** Raw byte body (media upload). Mutually exclusive with the other body kinds. */
  bytesBody?: ArrayBuffer | Uint8Array | Blob;
  /** Caller abort signal. Aborting produces a TIMEOUT ApiError, never a partial result. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds; overrides defaultTimeoutMs. Must be a finite number above zero when set. */
  timeoutMs?: number;
  /** Idempotency-Key header value (contract 1.6). At most 128 characters. The caller owns key lifecycle. */
  idempotencyKey?: string;
  /** X-Request-Id header value. Defaults to requestIdProvider or the built-in generator. */
  requestId?: string;
  /**
   * Skip CSRF handling for this request: the provider is not
   * consulted and no X-CSRF-Token header is sent. For pre-session
   * mutations only (login, setup), which have no session yet.
   * Has no effect on GET/HEAD, which never carry the header.
   */
  skipCsrf?: boolean;
}

/** Minimal response header access, satisfied by the Headers class. */
export interface ApiResponseHeaders {
  get(name: string): string | null;
}

/** Raw text response (contract 2.3 exception, e.g. GET file). */
export interface ApiTextResponse {
  status: number;
  /** Body text. Empty on a 304 response. */
  text: string;
  headers: ApiResponseHeaders;
}

/** Raw byte response (contract 2.3 exception, e.g. media, assets, downloads). */
export interface ApiBytesResponse {
  status: number;
  /** Body bytes. Empty on a 304 response. */
  bytes: ArrayBuffer;
  /** Response Content-Type header, or null when absent. */
  contentType: string | null;
  headers: ApiResponseHeaders;
}

/** Header-only response (204 responses and HEAD requests). */
export interface ApiEmptyResponse {
  status: number;
  headers: ApiResponseHeaders;
}

/**
 * Health response body (AD-19 shape, NOT the contract envelope).
 * Only the boolean ok field is validated by this client; the checks
 * object and the remaining fields belong to the server shape and to
 * the caller (the boot guard classifies them). Unknown fields pass
 * through untouched.
 */
export interface HealthResponseBody {
  ok: boolean;
  [key: string]: unknown;
}

/** Health probe result. A 503 ready response is returned, not thrown. */
export interface ApiHealthResponse {
  status: number;
  body: HealthResponseBody;
}

/** Internal marker: the client's own timeout budget expired. */
class ClientTimeoutError extends Error {
  constructor() {
    super("API request timed out");
    this.name = "ClientTimeoutError";
  }
}

/** Internal marker: the caller's abort signal fired. */
class ClientAbortError extends Error {
  constructor() {
    super("API request was aborted");
    this.name = "ClientAbortError";
  }
}

let requestIdCounter = 0;

/** Built-in request id generator: UUID when available, counter fallback. Never a secret. */
function defaultRequestId(): string {
  try {
    const cryptoValue = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    const uuid = cryptoValue?.randomUUID?.();
    if (typeof uuid === "string" && uuid !== "") {
      return uuid;
    }
  } catch {
    // Fall through to the counter form below.
  }
  requestIdCounter += 1;
  return `req-${Date.now()}-${requestIdCounter}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validate an API path. Returns the pathname and the raw query string
 * (without the leading "?"). Rejects absolute URLs, fragments,
 * whitespace, and versioned paths before any fetch happens. The
 * pathname is returned verbatim: segments such as fully encoded
 * asset keys must not be re-encoded by the client.
 */
function validateApiPath(path: string): { pathname: string; queryString: string } {
  if (
    typeof path !== "string" ||
    path === "" ||
    !path.startsWith("/api/") ||
    path.includes("://") ||
    path.includes("\\") ||
    path.includes("#") ||
    /[\s\u0000-\u001f\u007f]/.test(path)
  ) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  const afterPrefix = path.slice("/api/".length);
  if (
    afterPrefix === "v1" ||
    afterPrefix.startsWith("v1/") ||
    afterPrefix.startsWith("v1?")
  ) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  const queryIndex = path.indexOf("?");
  if (queryIndex === -1) {
    return { pathname: path, queryString: "" };
  }
  return { pathname: path.slice(0, queryIndex), queryString: path.slice(queryIndex + 1) };
}

/** Reject the forbidden workspace identifier keys in a query key set. */
function rejectWorkspaceQueryKey(key: string): void {
  if (key === "workspaceId" || key === "workspace_id") {
    throw createLocalApiError("VALIDATION_ERROR");
  }
}

/**
 * Merge the path query string with the options query value into one
 * serialized query string ("" when empty). Both sources are checked
 * for workspace identifier keys. Values are encoded through
 * URLSearchParams; option values are appended, never silently merged
 * over path values.
 */
function buildQueryString(
  existingQuery: string,
  queryOption: ApiRequestOptions["query"],
): string {
  const params = new URLSearchParams(existingQuery);
  params.forEach((_value, key) => {
    rejectWorkspaceQueryKey(key);
  });
  if (queryOption === undefined) {
    return params.toString();
  }
  const appendEntry = (key: string, value: string | number | boolean | null | undefined): void => {
    rejectWorkspaceQueryKey(key);
    if (value === null || value === undefined) {
      return;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw createLocalApiError("VALIDATION_ERROR");
    }
    params.append(key, String(value));
  };
  if (typeof queryOption === "string") {
    new URLSearchParams(queryOption).forEach((value, key) => {
      appendEntry(key, value);
    });
    return params.toString();
  }
  if (queryOption instanceof URLSearchParams) {
    queryOption.forEach((value, key) => {
      appendEntry(key, value);
    });
    return params.toString();
  }
  for (const [key, value] of Object.entries(queryOption)) {
    appendEntry(key, value);
  }
  return params.toString();
}

/**
 * Deep scan of a JSON body value for workspace identifier keys.
 * Plain objects and arrays are walked; other values (Date, Blob,
 * class instances) are leaves. Cycles are tolerated via a seen set;
 * JSON.stringify rejects the cycle afterwards with the same stable
 * local error, so no cycle can smuggle a forbidden key past this
 * scan and no cycle can hang it.
 */
function containsWorkspaceIdField(value: unknown, seen: WeakSet<object>): boolean {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    for (const entry of value) {
      if (containsWorkspaceIdField(entry, seen)) {
        return true;
      }
    }
    return false;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (key === "workspaceId" || key === "workspace_id") {
      return true;
    }
    if (containsWorkspaceIdField(value[key], seen)) {
      return true;
    }
  }
  return false;
}

/** Reject caller headers that must never be set directly (see ApiRequestOptions.headers). */
function validateCallerHeaders(headers: Record<string, string> | undefined): void {
  if (headers === undefined) {
    return;
  }
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "x-csrf-token" || lower === "cookie") {
      throw createLocalApiError("VALIDATION_ERROR");
    }
    if (typeof headers[name] !== "string") {
      throw createLocalApiError("VALIDATION_ERROR");
    }
  }
}

/**
 * Merge caller headers with client-controlled headers. Matching is
 * case-insensitive; client-controlled headers win, with canonical
 * casing. Caller-only headers keep their original casing.
 */
function mergeHeaders(
  caller: Record<string, string> | undefined,
  client: Record<string, string>,
): Record<string, string> {
  const merged = new Map<string, { name: string; value: string }>();
  if (caller !== undefined) {
    for (const [name, value] of Object.entries(caller)) {
      merged.set(name.toLowerCase(), { name, value });
    }
  }
  for (const [name, value] of Object.entries(client)) {
    merged.set(name.toLowerCase(), { name, value });
  }
  const result: Record<string, string> = {};
  for (const { name, value } of merged.values()) {
    result[name] = value;
  }
  return result;
}

function validateRequestId(requestId: string | undefined): void {
  if (requestId === undefined) {
    return;
  }
  if (requestId === "" || /[\r\n]/.test(requestId)) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
}

function validateIdempotencyKey(key: string | undefined): void {
  if (key === undefined) {
    return;
  }
  if (key === "" || key.length > MAX_IDEMPOTENCY_KEY_LENGTH || /[\r\n]/.test(key)) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
}

function validateTimeoutMs(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) {
    return;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
}

/** Read the X-Request-Id response header, defensively. */
function headerRequestId(response: Response): string | null {
  try {
    const value = response.headers?.get(REQUEST_ID_HEADER);
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/** Read a response body as text without ever throwing for the caller. */
async function readBodyTextLenient(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/** Parse body text as JSON without ever throwing for the caller. */
function parseJsonLenient(bodyText: string | null): unknown {
  if (bodyText === null || bodyText === "") {
    return undefined;
  }
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return undefined;
  }
}

export class ApiClient {
  private readonly options: ApiClientOptions;

  constructor(options: ApiClientOptions = {}) {
    this.options = options;
  }

  /**
   * JSON envelope request. Returns the envelope data on success and
   * throws ApiError on any failure. A 204 response returns null
   * (there is no envelope to parse); callers that expect no body
   * should prefer requestNoContent.
   */
  async requestJson<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const response = await this.send(path, options, "application/json");
    const status = response.status;
    if (status === 204) {
      return null as T;
    }
    if (status >= 200 && status < 300) {
      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch {
        throw createNetworkError();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText) as unknown;
      } catch {
        throw new ApiError({
          localCode: "SERVER_ERROR",
          wireCode: null,
          status,
          retryable: deriveRetryable(null, status),
          requestId: headerRequestId(response),
          details: {},
          wireMessage: null,
        });
      }
      const success = parseSuccessEnvelope<T>(parsed);
      if (success !== null) {
        return success.data;
      }
      const failure = parseErrorEnvelope(parsed);
      if (failure !== null) {
        throw createApiErrorFromWire({
          status,
          wireCode: failure.wireCode,
          wireMessage: failure.wireMessage,
          requestId: failure.requestId ?? headerRequestId(response),
          retryable: failure.retryable,
          details: failure.details,
        });
      }
      throw new ApiError({
        localCode: "SERVER_ERROR",
        wireCode: null,
        status,
        retryable: deriveRetryable(null, status),
        requestId: headerRequestId(response),
        details: {},
        wireMessage: null,
      });
    }
    throw await this.errorFromResponse(response);
  }

  /**
   * Raw text request (contract 2.3 exception, e.g. GET file). A 2xx
   * or 304 response returns its text with headers; any other status
   * throws the envelope ApiError, distinguished from a text body by
   * the error envelope parse, never by guessing.
   */
  async requestText(path: string, options: ApiRequestOptions = {}): Promise<ApiTextResponse> {
    const response = await this.send(path, options, "text/plain, */*");
    const status = response.status;
    if ((status >= 200 && status < 300) || status === 304) {
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw createNetworkError();
      }
      return { status, text, headers: response.headers };
    }
    throw await this.errorFromResponse(response);
  }

  /**
   * Raw byte request (contract 2.3 exception, e.g. media, assets,
   * backup downloads). A 2xx or 304 response returns its bytes with
   * headers; any other status throws the envelope ApiError.
   */
  async requestBytes(path: string, options: ApiRequestOptions = {}): Promise<ApiBytesResponse> {
    const response = await this.send(path, options, "*/*");
    const status = response.status;
    if ((status >= 200 && status < 300) || status === 304) {
      let bytes: ArrayBuffer;
      try {
        bytes = await response.arrayBuffer();
      } catch {
        throw createNetworkError();
      }
      let contentType: string | null = null;
      try {
        contentType = response.headers?.get("content-type") ?? null;
      } catch {
        contentType = null;
      }
      return { status, bytes, contentType, headers: response.headers };
    }
    throw await this.errorFromResponse(response);
  }

  /**
   * Header-only request: 204 responses (e.g. CSP reports) and HEAD
   * requests. A 2xx or 304 response returns status and headers
   * without reading a body; any other status throws the envelope
   * ApiError.
   */
  async requestNoContent(path: string, options: ApiRequestOptions = {}): Promise<ApiEmptyResponse> {
    const response = await this.send(path, options, "application/json");
    const status = response.status;
    if ((status >= 200 && status < 300) || status === 304) {
      return { status, headers: response.headers };
    }
    throw await this.errorFromResponse(response);
  }

  /**
   * Health probe (AD-19 shape, NOT the envelope). Only GET is
   * allowed. A 200 or 503 response with a parseable AD-19 body
   * (boolean ok field) is returned, including the not-ready 503,
   * because the caller classifies readiness itself. Any other
   * outcome (envelope error, malformed body, other status, network
   * failure) throws ApiError. A 401 still invokes the onUnauthorized
   * seam through send(), like every other request kind.
   */
  async requestHealth(path: string, options: ApiRequestOptions = {}): Promise<ApiHealthResponse> {
    const method = options.method ?? "GET";
    if (method !== "GET") {
      throw createLocalApiError("VALIDATION_ERROR");
    }
    const response = await this.send(path, { ...options, method: "GET" }, "application/json");
    const status = response.status;
    if (status === 200 || status === 503) {
      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch {
        throw createNetworkError();
      }
      const parsed = parseJsonLenient(bodyText);
      const failure = parseErrorEnvelope(parsed);
      if (failure !== null) {
        throw createApiErrorFromWire({
          status,
          wireCode: failure.wireCode,
          wireMessage: failure.wireMessage,
          requestId: failure.requestId ?? headerRequestId(response),
          retryable: failure.retryable,
          details: failure.details,
        });
      }
      if (isRecord(parsed) && typeof parsed.ok === "boolean") {
        return { status, body: parsed as unknown as HealthResponseBody };
      }
      throw new ApiError({
        localCode: "SERVER_ERROR",
        wireCode: null,
        status,
        retryable: deriveRetryable(null, status),
        requestId: headerRequestId(response),
        details: {},
        wireMessage: null,
      });
    }
    throw await this.errorFromResponse(response);
  }

  /** GET convenience wrapper over requestJson. */
  async getJson<T>(path: string, options: Omit<ApiRequestOptions, "method"> = {}): Promise<T> {
    return this.requestJson<T>(path, { ...options, method: "GET" });
  }

  /** POST convenience wrapper over requestJson. No body is sent when jsonBody is undefined. */
  async postJson<T>(
    path: string,
    jsonBody?: unknown,
    options: Omit<ApiRequestOptions, "method" | "jsonBody"> = {},
  ): Promise<T> {
    return this.requestJson<T>(path, { ...options, method: "POST", jsonBody });
  }

  /** PUT convenience wrapper over requestJson. No body is sent when jsonBody is undefined. */
  async putJson<T>(
    path: string,
    jsonBody?: unknown,
    options: Omit<ApiRequestOptions, "method" | "jsonBody"> = {},
  ): Promise<T> {
    return this.requestJson<T>(path, { ...options, method: "PUT", jsonBody });
  }

  /** PATCH convenience wrapper over requestJson. No body is sent when jsonBody is undefined. */
  async patchJson<T>(
    path: string,
    jsonBody?: unknown,
    options: Omit<ApiRequestOptions, "method" | "jsonBody"> = {},
  ): Promise<T> {
    return this.requestJson<T>(path, { ...options, method: "PATCH", jsonBody });
  }

  /**
   * DELETE convenience wrapper over requestJson. DELETE with a JSON
   * body exists in the contract (empty trash requires confirm), so
   * the body parameter is kept; no body is sent when it is
   * undefined.
   */
  async deleteJson<T>(
    path: string,
    jsonBody?: unknown,
    options: Omit<ApiRequestOptions, "method" | "jsonBody"> = {},
  ): Promise<T> {
    return this.requestJson<T>(path, { ...options, method: "DELETE", jsonBody });
  }

  /**
   * Build an ApiError for a non-success response: parse the error
   * envelope when present, otherwise fall back to the status
   * mapping. Body text is never kept on the error.
   */
  private async errorFromResponse(response: Response): Promise<ApiError> {
    const bodyText = await readBodyTextLenient(response);
    const parsed = parseJsonLenient(bodyText);
    const failure = parseErrorEnvelope(parsed);
    if (failure !== null) {
      return createApiErrorFromWire({
        status: response.status,
        wireCode: failure.wireCode,
        wireMessage: failure.wireMessage,
        requestId: failure.requestId ?? headerRequestId(response),
        retryable: failure.retryable,
        details: failure.details,
      });
    }
    return createApiErrorWithoutEnvelope({
      status: response.status,
      requestId: headerRequestId(response),
    });
  }

  /**
   * Handle a 401 response: build the ApiError, invoke the
   * onUnauthorized seam exactly once (awaited, errors swallowed),
   * then throw. The client itself never redirects and never retries.
   */
  private async handleUnauthorized(response: Response): Promise<never> {
    const error = await this.errorFromResponse(response);
    const handler = this.options.onUnauthorized;
    if (handler !== undefined) {
      try {
        await handler(error);
      } catch {
        // A failing 401 handler must never mask the ApiError.
      }
    }
    throw error;
  }

  /**
   * Validate, prepare, and send one request. Returns the raw
   * response for the kind-specific handler, except for 401, which
   * is handled (seam + throw) here so every request kind behaves
   * identically on session rejection. Network failures and timeouts
   * throw transport ApiErrors; nothing here retries.
   */
  private async send(
    path: string,
    options: ApiRequestOptions,
    accept: string,
  ): Promise<Response> {
    const method: HttpMethod = options.method ?? "GET";
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      method !== "POST" &&
      method !== "PUT" &&
      method !== "PATCH" &&
      method !== "DELETE"
    ) {
      throw createLocalApiError("VALIDATION_ERROR");
    }
    const { pathname, queryString } = validateApiPath(path);
    const query = buildQueryString(queryString, options.query);
    const url = query === "" ? pathname : `${pathname}?${query}`;
    validateCallerHeaders(options.headers);
    validateRequestId(options.requestId);
    validateIdempotencyKey(options.idempotencyKey);

    const hasJsonBody = options.jsonBody !== undefined;
    const hasTextBody = options.textBody !== undefined;
    const hasFormDataBody = options.formDataBody !== undefined;
    const hasBytesBody = options.bytesBody !== undefined;
    const bodyKindCount =
      (hasJsonBody ? 1 : 0) +
      (hasTextBody ? 1 : 0) +
      (hasFormDataBody ? 1 : 0) +
      (hasBytesBody ? 1 : 0);
    if (bodyKindCount > 1) {
      throw createLocalApiError("VALIDATION_ERROR");
    }
    if ((method === "GET" || method === "HEAD") && bodyKindCount > 0) {
      throw createLocalApiError("VALIDATION_ERROR");
    }

    let body: BodyInit | undefined;
    let isJsonBody = false;
    if (hasJsonBody) {
      if (containsWorkspaceIdField(options.jsonBody, new WeakSet())) {
        throw createLocalApiError("VALIDATION_ERROR");
      }
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(options.jsonBody) as string | undefined;
      } catch {
        serialized = undefined;
      }
      if (typeof serialized !== "string") {
        throw createLocalApiError("VALIDATION_ERROR");
      }
      body = serialized;
      isJsonBody = true;
    } else if (hasTextBody) {
      body = options.textBody;
    } else if (hasFormDataBody) {
      body = options.formDataBody;
    } else if (hasBytesBody) {
      body = options.bytesBody as BodyInit;
    }

    const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs;
    validateTimeoutMs(timeoutMs);
    const outerSignal = options.signal;
    if (outerSignal?.aborted) {
      throw createTimeoutError(true);
    }

    // CSRF seam (V3-30b owns the provider; see the module header).
    // Mutations only, never GET/HEAD, never when skipCsrf is set.
    let csrfToken: string | null = null;
    if (MUTATION_METHODS.has(method) && !options.skipCsrf && this.options.csrfTokenProvider) {
      let provided: string | null | undefined;
      try {
        provided = await this.options.csrfTokenProvider();
      } catch {
        throw createLocalApiError("SERVER_ERROR");
      }
      if (provided !== null && provided !== undefined) {
        if (typeof provided !== "string") {
          throw createLocalApiError("SERVER_ERROR");
        }
        if (provided !== "") {
          csrfToken = provided;
        }
      }
    }

    const requestId =
      options.requestId ?? this.options.requestIdProvider?.() ?? defaultRequestId();
    validateRequestId(requestId);

    const clientHeaders: Record<string, string> = {
      Accept: accept,
      [REQUEST_ID_HEADER]: requestId,
    };
    if (isJsonBody) {
      clientHeaders["Content-Type"] = "application/json";
    }
    if (options.idempotencyKey !== undefined) {
      clientHeaders[IDEMPOTENCY_HEADER] = options.idempotencyKey;
    }
    if (csrfToken !== null) {
      clientHeaders[CSRF_HEADER] = csrfToken;
    }
    const headers = mergeHeaders(options.headers, clientHeaders);

    const response = await this.fetchWithBudget(
      url,
      { method, headers, body, credentials: "include" },
      outerSignal,
      timeoutMs,
    );
    if (response.status === 401) {
      await this.handleUnauthorized(response);
    }
    return response;
  }

  /**
   * Run fetch with an optional timeout budget and an optional outer
   * abort signal. The fetch is raced against explicit timeout and
   * abort promises on top of the AbortSignal, so the call can never
   * hang on an implementation that ignores the signal (the same
   * pattern as the M14 session probe). Rejections are mapped to
   * transport ApiErrors; the original rejection value is never kept,
   * because it may contain the request URL.
   */
  private async fetchWithBudget(
    url: string,
    init: RequestInit,
    outerSignal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): Promise<Response> {
    const fetchFn: typeof fetch =
      this.options.fetchFn ?? ((input: RequestInfo | URL, requestInit?: RequestInit) =>
        globalThis.fetch(input, requestInit));
    if (timeoutMs === undefined && outerSignal === undefined) {
      try {
        return await fetchFn(url, init);
      } catch {
        throw createNetworkError();
      }
    }
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
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
            rejectOnTimeout?.(new ClientTimeoutError());
          }, timeoutMs);
    const onOuterAbort = (): void => {
      controller.abort();
      rejectOnAbort?.(new ClientAbortError());
    };
    if (outerSignal) {
      outerSignal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      return await Promise.race([
        fetchFn(url, { ...init, signal: controller.signal }),
        timeoutPromise,
        abortPromise,
      ]);
    } catch (error) {
      if (error instanceof ClientTimeoutError || timedOut) {
        throw createTimeoutError(false);
      }
      if (error instanceof ClientAbortError || outerSignal?.aborted) {
        throw createTimeoutError(true);
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw createTimeoutError(true);
      }
      throw createNetworkError();
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (outerSignal) {
        outerSignal.removeEventListener("abort", onOuterAbort);
      }
    }
  }
}

/** Create an ApiClient. V3-30b wires onUnauthorized and csrfTokenProvider here. */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  return new ApiClient(options);
}

/**
 * Default unwired client (global fetch, no hooks). Callers that need
 * the wired CSRF/401 behavior must use a client created by
 * createApiClient with the V3-30b seams; this instance is never
 * mutated and never gains hooks implicitly. It carries the
 * production default timeout (DA28-01): unwired must never mean
 * unbounded.
 */
export const defaultApiClient: ApiClient = new ApiClient({
  defaultTimeoutMs: DEFAULT_API_CLIENT_TIMEOUT_MS,
});
