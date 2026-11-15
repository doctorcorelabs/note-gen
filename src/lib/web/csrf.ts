// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// CSRF token handling and session-expiry notification for the web API
// client (Fase 1, V3-30b). This module owns the client side of the
// contract in kontrak-api-kanonis.md section 3.12 and section 1.2,
// plus desain-auth.md section 5.2:
//
// - The token is fetched from GET /api/auth/csrf (session cookie only,
//   no CSRF check on GET) and sent back on every session mutation
//   (POST, PUT, PATCH, DELETE) in the X-CSRF-Token header.
// - The token lives ONLY in module memory. It is never written to
//   persistent browser storage or a cookie, and it is never logged.
//   A page reload loses the copy by design; the next mutation
//   refetches it from GET /api/auth/csrf.
// - A 403 with code csrf_invalid means the cached token is stale
//   (session rotation). The client refreshes the token ONCE and
//   retries the mutation ONCE. A second csrf_invalid fails
//   explicitly. Any other 403 (forbidden, origin_rejected,
//   step_up_required) never triggers a refresh.
// - A 401 means the session is expired. There is no refresh endpoint
//   in MVP (kontrak 3.12, K-10) and no blind retry: the caller is
//   told explicitly through the unauthorized handler, and the
//   cached token is cleared. This module never navigates and never
//   redirects; the UI layer (V3-03) decides what to show when the
//   session expires, without losing form data.
//
// Guard mapping. The boot guard contract in session-check.ts maps
// 401/403 from the GET /api/auth/me probe to "unauthenticated" and
// the BOOT_SESSION_EXPIRED screen. That rule is probe-specific: a
// GET probe has no CSRF token, so any 403 there is a session
// rejection. For general API traffic this module uses the narrower
// rule: ONLY 401 means expired. A 403 on a mutation keeps its own
// meaning (stale token, wrong origin, step-up, forbidden) and must
// not be reported as an expired session. Both rules agree on 401,
// which is the case the tests pin down.
//
// Seam for V3-30a. Branch origin/web-api-client did not exist when
// this module was written (checked with git ls-remote), so the seam
// is defined here and V3-30a adopts it instead of redefining it:
//
// - The API client holds ONE WebApiAuthSeam created by
//   createWebApiAuthSeam and shares it across all requests.
// - Mutations go through withCsrfRetry, which supplies the token
//   and performs the single refresh-and-retry on csrf_invalid.
// - Reads and other requests call handleUnauthorizedError in their
//   error path so a 401 still reaches the expiry listeners.
// - The API client error type (V3-30a errors.ts) MUST expose a
//   numeric `status` and a string `code` read from the error
//   envelope, because the predicates in this module branch on those
//   two flat fields. If errors.ts nests them, the integrator adapts
//   the predicates in one place (readErrorStatusCode) instead of
//   forking this module.
// - On successful login, step-up, or password change the caller
//   seeds the fresh token with seam.csrf.setToken(token) from the
//   response body and calls seam.resetSessionStatus(). On logout
//   the caller calls seam.csrf.clearToken().
//
// This module has no DOM, no navigation, and no import of
// session-check.ts or boot-guard.ts: it reports expiry through
// listeners, and the guard modules keep their own contract.

export const CSRF_ENDPOINT = "/api/auth/csrf";

/** Canonical header name for the CSRF token (kontrak 1.2). */
export const CSRF_HEADER_NAME = "X-CSRF-Token";

/** Wire error code for a rejected CSRF token (403, kontrak 6.2). */
export const CSRF_INVALID_CODE = "csrf_invalid";

/** Wire error code for a missing, invalid, or expired session (401). */
export const UNAUTHENTICATED_CODE = "unauthenticated";

/** Per-fetch budget for GET /api/auth/csrf, matching the session probe. */
export const CSRF_FETCH_TIMEOUT_MS = 5000;

/** HTTP methods that require the X-CSRF-Token header (kontrak 1.2). */
export function isMutationMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "POST" || upper === "PUT" || upper === "PATCH" || upper === "DELETE";
}

/** Why fetching the CSRF token failed. Local only, never sent on the wire. */
export type CsrfFetchErrorReason =
  | "unauthenticated"
  | "invalid_response"
  | "server_error"
  | "network_error"
  | "timeout";

/**
 * Thrown when GET /api/auth/csrf does not yield a usable token. The
 * message never contains the token value. Callers branch on
 * `sessionExpired` (true only for HTTP 401) and `reason`, never on
 * the message text.
 */
export class CsrfTokenError extends Error {
  readonly status?: number;
  readonly wireCode?: string;
  readonly reason: CsrfFetchErrorReason;
  readonly sessionExpired: boolean;

  constructor(
    message: string,
    options: { status?: number; wireCode?: string; reason: CsrfFetchErrorReason },
  ) {
    super(message);
    this.name = "CsrfTokenError";
    this.status = options.status;
    this.wireCode = options.wireCode;
    this.reason = options.reason;
    this.sessionExpired = options.reason === "unauthenticated";
  }
}

/**
 * Parse a GET /api/auth/csrf response body and return the token, or
 * null when the body is not a usable success envelope. The canonical
 * shape is the envelope { ok: true, data: { csrfToken } } (kontrak
 * 2.1 and 3.12). A body without an `ok` field is accepted when it
 * carries the token, mirroring the tolerance of the session probe;
 * a body with ok false is never accepted. This function never throws
 * and never logs the token.
 */
export function parseCsrfTokenBody(bodyText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const body = parsed as Record<string, unknown>;
  if ("ok" in body && body.ok !== true) {
    return null;
  }
  const data = body.data;
  let candidate: unknown;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    candidate = (data as Record<string, unknown>).csrfToken;
  } else if (data === undefined) {
    candidate = body.csrfToken;
  } else {
    return null;
  }
  if (typeof candidate !== "string" || candidate.length === 0) {
    return null;
  }
  if (!/^\S+$/.test(candidate)) {
    return null;
  }
  return candidate;
}

/** Leniently read code/requestId from an error envelope body. Never throws. */
function parseErrorEnvelopeBody(bodyText: string): { code?: string; requestId?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const error = (parsed as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return {};
  }
  const record = error as Record<string, unknown>;
  const code = record.code;
  const requestId = record.requestId;
  return {
    code: typeof code === "string" ? code : undefined,
    requestId: typeof requestId === "string" ? requestId : undefined,
  };
}

/** A token is valid only when it is a non-empty string without whitespace. */
function assertUsableToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || token.length === 0 || !/^\S+$/.test(token)) {
    throw new TypeError("CSRF token must be a non-empty string without whitespace");
  }
}

/**
 * Headers carrying the CSRF token, for merging into a mutation
 * request. The caller owns the rest of the headers; this helper only
 * guarantees the canonical header name. The returned object is fresh
 * on every call.
 */
export function buildCsrfHeaders(token: string): Record<string, string> {
  assertUsableToken(token);
  return { [CSRF_HEADER_NAME]: token };
}

export interface CsrfTokenStoreDeps {
  /** Fetch implementation. Defaults to the global fetch. Injectable for tests. */
  fetchFn?: typeof fetch;
  /** CSRF endpoint. Defaults to CSRF_ENDPOINT. Injectable for tests. */
  endpoint?: string;
  /**
   * Per-fetch timeout in milliseconds. Defaults to
   * CSRF_FETCH_TIMEOUT_MS. A value of 0 disables the timeout; the
   * fetch is then bounded only by the platform. Negative values are
   * treated as 0.
   */
  timeoutMs?: number;
}

/**
 * Memory-only CSRF token store. Exactly one instance must be shared
 * by all mutations of one API client (see createWebApiAuthSeam).
 * Concurrent getToken calls share one in-flight fetch; concurrent
 * refreshToken calls share one fresh fetch. A fetch that fails never
 * poisons the cache: the next call fetches again.
 */
export interface CsrfTokenStore {
  /** Return the cached token, fetching it once when absent. */
  getToken(): Promise<string>;
  /**
   * Discard the cached token and fetch a fresh one, even when a
   * fetch is already in flight. The in-flight result is discarded
   * from the cache so a refresh can never return the stale token
   * that a csrf_invalid rejection just proved wrong.
   */
  refreshToken(): Promise<string>;
  /**
   * Seed the store with a token from a login, step-up, or
   * password-change response body. Replaces the cached token and
   * discards any in-flight fetch result from the cache. Throws
   * TypeError for an unusable token. The caller must pass the token
   * from the response body, never from storage.
   */
  setToken(token: string): void;
  /** Discard the cached token. The next getToken fetches again. */
  clearToken(): void;
  /** Whether a token is cached. Never exposes the token value. */
  hasToken(): boolean;
}

class CsrfFetchTimeoutError extends Error {
  constructor() {
    super("CSRF token fetch timed out");
    this.name = "CsrfFetchTimeoutError";
  }
}

export function createCsrfTokenStore(deps: CsrfTokenStoreDeps = {}): CsrfTokenStore {
  const fetchFn = deps.fetchFn ?? fetch;
  const endpoint = deps.endpoint ?? CSRF_ENDPOINT;
  const timeoutMs = deps.timeoutMs ?? CSRF_FETCH_TIMEOUT_MS;

  let cached: string | null = null;
  let generation = 0;
  let pending: { generation: number; isRefresh: boolean; promise: Promise<string> } | null = null;

  async function fetchTokenFromServer(): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectOnTimeout: ((error: Error) => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectOnTimeout = reject;
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        rejectOnTimeout?.(new CsrfFetchTimeoutError());
      }, timeoutMs);
    }
    try {
      const response = await Promise.race([
        fetchFn(endpoint, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
      const bodyText = await Promise.race([response.text(), timeoutPromise]);
      if (response.status === 401) {
        const envelope = parseErrorEnvelopeBody(bodyText);
        throw new CsrfTokenError("Session expired while fetching the CSRF token", {
          status: response.status,
          wireCode: envelope.code ?? UNAUTHENTICATED_CODE,
          reason: "unauthenticated",
        });
      }
      if (response.status !== 200) {
        const envelope = parseErrorEnvelopeBody(bodyText);
        throw new CsrfTokenError("CSRF token endpoint returned an unexpected status", {
          status: response.status,
          wireCode: envelope.code,
          reason: response.status >= 500 ? "server_error" : "invalid_response",
        });
      }
      const token = parseCsrfTokenBody(bodyText);
      if (token === null) {
        throw new CsrfTokenError("CSRF token endpoint returned an unusable response", {
          status: response.status,
          reason: "invalid_response",
        });
      }
      return token;
    } catch (error) {
      if (error instanceof CsrfTokenError) {
        throw error;
      }
      if (error instanceof CsrfFetchTimeoutError || timedOut) {
        throw new CsrfTokenError("CSRF token fetch timed out", { reason: "timeout" });
      }
      throw new CsrfTokenError("CSRF token fetch failed", { reason: "network_error" });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  function startFetch(isRefresh: boolean): Promise<string> {
    const fetchGeneration = generation;
    const promise = fetchTokenFromServer().then((token) => {
      if (fetchGeneration === generation) {
        cached = token;
      }
      return token;
    });
    const tracked = promise.then(
      (token) => {
        if (pending?.promise === tracked) {
          pending = null;
        }
        return token;
      },
      (error: unknown) => {
        if (pending?.promise === tracked) {
          pending = null;
        }
        throw error;
      },
    );
    pending = { generation: fetchGeneration, isRefresh, promise: tracked };
    return tracked;
  }

  return {
    getToken(): Promise<string> {
      if (cached !== null) {
        return Promise.resolve(cached);
      }
      if (pending !== null && pending.generation === generation) {
        return pending.promise;
      }
      return startFetch(false);
    },
    refreshToken(): Promise<string> {
      if (pending !== null && pending.isRefresh && pending.generation === generation) {
        return pending.promise;
      }
      generation += 1;
      cached = null;
      return startFetch(true);
    },
    setToken(token: string): void {
      assertUsableToken(token);
      generation += 1;
      cached = token;
    },
    clearToken(): void {
      generation += 1;
      cached = null;
    },
    hasToken(): boolean {
      return cached !== null;
    },
  };
}

/** Read flat status/code/requestId fields from an API error. Never throws. */
function readErrorStatusCode(error: unknown): {
  status?: number;
  code?: string;
  requestId?: string;
} {
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const record = error as Record<string, unknown>;
  const status = record.status;
  const code = record.code;
  const requestId = record.requestId;
  return {
    status: typeof status === "number" ? status : undefined,
    code: typeof code === "string" ? code : undefined,
    requestId: typeof requestId === "string" ? requestId : undefined,
  };
}

/**
 * True only for HTTP 401. A 403 is never an expired session for API
 * traffic: see the guard mapping note at the top of this file.
 */
export function isUnauthorizedStatus(status: number): boolean {
  return status === 401;
}

/** True when an API error carries HTTP 401, whatever its code. */
export function isUnauthorizedError(error: unknown): boolean {
  const { status } = readErrorStatusCode(error);
  return status !== undefined && isUnauthorizedStatus(status);
}

/**
 * True only for HTTP 403 with code csrf_invalid. A bare 403, or a
 * 403 with any other code, must not trigger a token refresh.
 */
export function shouldRefreshCsrf(status: number, code?: string): boolean {
  return status === 403 && code === CSRF_INVALID_CODE;
}

/** True when an API error is a 403 with code csrf_invalid. */
export function isCsrfInvalidError(error: unknown): boolean {
  const { status, code } = readErrorStatusCode(error);
  return status !== undefined && shouldRefreshCsrf(status, code);
}

/** Auth failure classes an API client branches on. Local only. */
export type AuthFailureKind = "session_expired" | "csrf_invalid" | "other";

/**
 * Classify an API failure by status and wire code. 401 is always
 * session_expired; 403 is csrf_invalid only with that exact code;
 * everything else is other. Callers must not map other 403 codes to
 * session_expired.
 */
export function classifyAuthFailure(status: number, code?: string): AuthFailureKind {
  if (isUnauthorizedStatus(status)) {
    return "session_expired";
  }
  if (shouldRefreshCsrf(status, code)) {
    return "csrf_invalid";
  }
  return "other";
}

/**
 * What the API client knows about the session. Starts unknown: no
 * request has proven anything yet. A successful authenticated
 * request marks it active. A 401 marks it expired, and only an
 * explicit reset (after a fresh sign-in) leaves the expired state.
 */
export type ApiClientSessionStatus = "unknown" | "active" | "expired";

/** Information about a 401, without any secret value. */
export interface UnauthorizedNotification {
  code?: string;
  requestId?: string;
  /** Request path that received the 401, when the caller knows it. */
  path?: string;
}

/** A 401 event delivered to expiry listeners. */
export interface UnauthorizedEvent extends UnauthorizedNotification {
  status: 401;
  /** Unix timestamp in milliseconds when the 401 was observed. */
  at: number;
}

export type OnUnauthorized = (event: UnauthorizedEvent) => void;

/**
 * Session-expiry handler: holds the session status and notifies
 * listeners exactly once per transition into expired. Listeners
 * decide what to show; this handler never navigates. A listener
 * that throws does not mask the original 401: its error is
 * swallowed so the caller's error reaches the caller unchanged.
 * Subscribing after expiry does not replay the event; late
 * subscribers must read getSessionStatus when they mount.
 */
export interface UnauthorizedHandler {
  getSessionStatus(): ApiClientSessionStatus;
  /**
   * Mark the session active, but only from unknown. An expired
   * session is never resurrected by a stray success; only
   * resetSessionStatus leaves the expired state.
   */
  markSessionActive(): void;
  /** Record a 401: transition to expired and notify listeners once. */
  onUnauthorized(notification: UnauthorizedNotification): void;
  /** Subscribe to the expiry transition. Returns an unsubscribe function. */
  subscribe(listener: OnUnauthorized): () => void;
  /** Return to unknown, for example after a fresh sign-in. */
  resetSessionStatus(): void;
}

export function createUnauthorizedHandler(): UnauthorizedHandler {
  let status: ApiClientSessionStatus = "unknown";
  const listeners = new Set<OnUnauthorized>();

  return {
    getSessionStatus(): ApiClientSessionStatus {
      return status;
    },
    markSessionActive(): void {
      if (status === "unknown") {
        status = "active";
      }
    },
    onUnauthorized(notification: UnauthorizedNotification): void {
      if (status === "expired") {
        return;
      }
      status = "expired";
      const event: UnauthorizedEvent = {
        status: 401,
        code: notification.code,
        requestId: notification.requestId,
        path: notification.path,
        at: Date.now(),
      };
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // A failing listener must not mask the original 401.
        }
      }
    },
    subscribe(listener: OnUnauthorized): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    resetSessionStatus(): void {
      status = "unknown";
    },
  };
}

/**
 * The minimal auth seam V3-30a adopts (see the header note). One
 * instance per API client, shared by all requests. onUnauthorized
 * clears the cached CSRF token before notifying listeners, because
 * a dead session makes the token useless; the next mutation after
 * a fresh sign-in fetches or is seeded with a new token.
 */
export interface WebApiAuthSeam {
  csrf: CsrfTokenStore;
  getSessionStatus(): ApiClientSessionStatus;
  markSessionActive(): void;
  onUnauthorized(notification: UnauthorizedNotification): void;
  subscribeToSessionExpiry(listener: OnUnauthorized): () => void;
  resetSessionStatus(): void;
}

export function createWebApiAuthSeam(deps: CsrfTokenStoreDeps = {}): WebApiAuthSeam {
  const csrf = createCsrfTokenStore(deps);
  const handler = createUnauthorizedHandler();
  return {
    csrf,
    getSessionStatus: () => handler.getSessionStatus(),
    markSessionActive: () => handler.markSessionActive(),
    onUnauthorized: (notification: UnauthorizedNotification) => {
      csrf.clearToken();
      handler.onUnauthorized(notification);
    },
    subscribeToSessionExpiry: (listener: OnUnauthorized) => handler.subscribe(listener),
    resetSessionStatus: () => handler.resetSessionStatus(),
  };
}

/**
 * Report an API error to the seam when it is a 401. Returns true
 * when the error was a 401 and the seam was notified, false
 * otherwise. Reads (GET/HEAD) and other non-mutation requests call
 * this in their error path; mutations use withCsrfRetry, which
 * calls the seam itself. Never retries, never navigates.
 */
export function handleUnauthorizedError(
  seam: WebApiAuthSeam,
  error: unknown,
  extra?: { path?: string },
): boolean {
  if (!isUnauthorizedError(error)) {
    return false;
  }
  const { code, requestId } = readErrorStatusCode(error);
  seam.onUnauthorized({ code, requestId, path: extra?.path });
  return true;
}

export interface CsrfRetryOptions {
  /** Request path, attached to the 401 event when one occurs. */
  path?: string;
}

/**
 * Run a mutation with the CSRF token, refreshing once on
 * csrf_invalid. The attempt callback receives the token and must
 * send it in the X-CSRF-Token header (see buildCsrfHeaders) and
 * throw an error carrying numeric `status` and string `code` on
 * failure, as V3-30a errors.ts provides.
 *
 * Exactly two attempts at most: the first with the cached or freshly
 * fetched token, the second (only after a 403 csrf_invalid) with a
 * refreshed token. A second csrf_invalid clears the token and
 * rethrows the second error unchanged: an explicit failure, never
 * a loop. A 401 at any point notifies the seam once, clears the
 * token, and rethrows without retrying. A failed token fetch
 * (including a 401 from GET /api/auth/csrf) never reaches the
 * attempt callback. A successful attempt marks the session active.
 */
export async function withCsrfRetry<T>(
  seam: WebApiAuthSeam,
  attempt: (token: string) => Promise<T>,
  options: CsrfRetryOptions = {},
): Promise<T> {
  async function fetchTokenOrNotify(refresh: boolean): Promise<string> {
    try {
      return refresh ? await seam.csrf.refreshToken() : await seam.csrf.getToken();
    } catch (error) {
      if (error instanceof CsrfTokenError && error.sessionExpired) {
        seam.onUnauthorized({ code: error.wireCode, path: options.path });
      }
      throw error;
    }
  }

  let refreshed = false;
  let token = await fetchTokenOrNotify(false);
  for (;;) {
    try {
      const value = await attempt(token);
      seam.markSessionActive();
      return value;
    } catch (error) {
      if (isUnauthorizedError(error)) {
        const { code, requestId } = readErrorStatusCode(error);
        seam.onUnauthorized({ code, requestId, path: options.path });
        throw error;
      }
      if (!refreshed && isCsrfInvalidError(error)) {
        refreshed = true;
        token = await fetchTokenOrNotify(true);
        continue;
      }
      if (isCsrfInvalidError(error)) {
        seam.csrf.clearToken();
      }
      throw error;
    }
  }
}
