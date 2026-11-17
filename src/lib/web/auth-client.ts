// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Auth session client for the web frontend (Fase 1, V3-03 slot 03b).
// This module owns the SESSION part of the auth client only:
//
// - The current session: GET /api/auth/me, with strict shape parsing.
// - The session list and revocation: GET/DELETE /api/auth/sessions.
// - Logout: POST /api/auth/logout and POST /api/auth/logout-all.
// - The in-memory CSRF token lifecycle: seed on login, refetch after
//   a reload, clear on logout, and the single refresh-and-retry on a
//   stale token. The token lives only in module memory, through the
//   CsrfTokenStore owned by csrf.ts (V3-30b). It is never written to
//   persistent browser storage or a cookie, and it is never logged. A page reload loses the copy by design; the next
//   mutation refetches it from GET /api/auth/csrf.
//
// What this module does NOT own: login, setup, step-up, password
// change/reset, TOTP, and admin calls. Those belong to the sibling
// V3-03/V3-02 slots. If the integrator unions several auth-client
// branches into one file, keep every export of this module and add
// the sibling exports beside them, sharing the one seam and the one
// ApiClient created here; do not fork a second CSRF store.
//
// Canonical sources: desain-auth.md sections 3 and 12 (session
// lifecycle, session list shape, endpoint inventory) and
// kontrak-api-kanonis.md section 3.12 (wire shapes and codes).
// Wire time format for auth is ISO 8601 UTC strings (server
// server/src/auth/service.ts); this module keeps them as strings
// and never does epoch math on them.
//
// This module has no DOM, no navigation, and no React: it reports
// session expiry through the seam listeners, and the guard and
// chrome components decide what to show. It never reads the cookie
// jar and never sends a session id: the browser carries
// the HttpOnly cookie, and the ApiClient sends credentials "include"
// on every request.

import {
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
} from "./api-client";
import {
  createWebApiAuthSeam,
  CsrfTokenError,
  handleUnauthorizedError,
  withCsrfRetry,
  type ApiClientSessionStatus,
  type CsrfTokenStoreDeps,
  type OnUnauthorized,
  type WebApiAuthSeam,
} from "./csrf";
import { ApiError, createLocalApiError } from "./errors";

/** GET /api/auth/me: account metadata plus current session info. */
export const AUTH_ME_ENDPOINT = "/api/auth/me";

/** GET/DELETE /api/auth/sessions: the requester's own sessions. */
export const AUTH_SESSIONS_ENDPOINT = "/api/auth/sessions";

/** POST /api/auth/logout: delete the current session. */
export const AUTH_LOGOUT_ENDPOINT = "/api/auth/logout";

/** POST /api/auth/logout-all: delete every session of the account. */
export const AUTH_LOGOUT_ALL_ENDPOINT = "/api/auth/logout-all";

/** Login page path. Guards navigate here; this module never navigates. */
export const SESSION_LOGIN_PATH = "/login";

/**
 * Login page path for session expiry. Expiry redirects (a rejected
 * guard probe, a mid-session 401) navigate here so the login page
 * (slot 03a) shows its expiry notice for ?expired=1. Deliberate
 * logout navigates to SESSION_LOGIN_PATH instead: signing out is
 * not an expiry and must not show the notice.
 */
export const SESSION_EXPIRED_LOGIN_PATH = "/login?expired=1";

/** Account role, as returned by GET /api/auth/me. */
export type AuthUserRole = "user" | "admin";

/** Current session info inside the GET /api/auth/me data. */
export interface AuthCurrentSession {
  id: string;
  deviceLabel: string;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  stepUpAt: string | null;
}

/**
 * GET /api/auth/me data (server MeData). No secret fields: the
 * server never returns a session id, a hash, or a CSRF token here.
 * The workspaceId is echoed metadata only; callers must never use
 * it to build paths or authorization decisions (kontrak 1.1).
 */
export interface AuthMeData {
  id: string;
  email: string;
  role: AuthUserRole;
  totpEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  workspaceId: string | null;
  session: AuthCurrentSession;
}

/**
 * One entry of GET /api/auth/sessions (server SessionListEntry).
 * The id is the session row id, never the opaque session id.
 */
export interface AuthSessionEntry {
  id: string;
  deviceLabel: string;
  userAgent: string | null;
  createdIp: string | null;
  lastSeenIp: string | null;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  isCurrent: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Parse GET /api/auth/me data strictly. Returns null for any shape
 * that does not match the server MeData, including an unknown role:
 * a corrupted role must fail closed, never invent a privilege.
 * Unknown extra fields are ignored. Never throws, never logs.
 */
export function parseAuthMeData(data: unknown): AuthMeData | null {
  if (!isRecord(data)) {
    return null;
  }
  const role = data.role;
  if (role !== "user" && role !== "admin") {
    return null;
  }
  const session = data.session;
  if (!isRecord(session)) {
    return null;
  }
  if (
    !isNonEmptyString(data.id) ||
    !isNonEmptyString(data.email) ||
    typeof data.totpEnabled !== "boolean" ||
    !isNonEmptyString(data.createdAt) ||
    !isNullableString(data.lastLoginAt) ||
    !isNullableString(data.workspaceId) ||
    !isNonEmptyString(session.id) ||
    !isNonEmptyString(session.deviceLabel) ||
    !isNonEmptyString(session.createdAt) ||
    !isNonEmptyString(session.lastSeenAt) ||
    !isNonEmptyString(session.absoluteExpiresAt) ||
    !isNullableString(session.stepUpAt)
  ) {
    return null;
  }
  return {
    id: data.id,
    email: data.email,
    role,
    totpEnabled: data.totpEnabled,
    createdAt: data.createdAt,
    lastLoginAt: data.lastLoginAt,
    workspaceId: data.workspaceId,
    session: {
      id: session.id,
      deviceLabel: session.deviceLabel,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      stepUpAt: session.stepUpAt,
    },
  };
}

function parseAuthSessionEntry(value: unknown): AuthSessionEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.deviceLabel) ||
    !isNullableString(value.userAgent) ||
    !isNullableString(value.createdIp) ||
    !isNullableString(value.lastSeenIp) ||
    !isNonEmptyString(value.createdAt) ||
    !isNonEmptyString(value.lastSeenAt) ||
    !isNonEmptyString(value.absoluteExpiresAt) ||
    typeof value.isCurrent !== "boolean"
  ) {
    return null;
  }
  return {
    id: value.id,
    deviceLabel: value.deviceLabel,
    userAgent: value.userAgent,
    createdIp: value.createdIp,
    lastSeenIp: value.lastSeenIp,
    createdAt: value.createdAt,
    lastSeenAt: value.lastSeenAt,
    absoluteExpiresAt: value.absoluteExpiresAt,
    isCurrent: value.isCurrent,
  };
}

/**
 * Parse GET /api/auth/sessions data strictly. The server returns
 * the list newest-first; this function keeps the server order and
 * rejects the whole list when any entry is malformed, so the UI
 * never shows a partial session list as if it were complete.
 * Never throws, never logs.
 */
export function parseAuthSessionList(data: unknown): AuthSessionEntry[] | null {
  if (!Array.isArray(data)) {
    return null;
  }
  const entries: AuthSessionEntry[] = [];
  for (const value of data) {
    const entry = parseAuthSessionEntry(value);
    if (entry === null) {
      return null;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * A session row id is safe to place in the DELETE path only when it
 * is a non-empty string without whitespace or a path separator.
 * This check is path safety only: the server enforces the UUID
 * shape and answers 404 for any other id, which this client
 * surfaces unchanged. A crafted id can never escape the path
 * segment because the check runs before any fetch happens.
 */
export function isSafeSessionRowId(id: unknown): id is string {
  return (
    isNonEmptyString(id) && !/[\s/?#]/.test(id)
  );
}

export interface AuthSessionClientDeps {
  /**
   * Fetch implementation, shared by the CSRF store and the API
   * client. Defaults to the global fetch. Injectable for tests.
   */
  fetchFn?: typeof fetch;
  /** CSRF endpoint override, passed to the CSRF store. Test only. */
  csrfEndpoint?: string;
  /** Per-fetch CSRF timeout in milliseconds. Test only. */
  csrfTimeoutMs?: number;
  /** Default per-request timeout for the API client. */
  defaultTimeoutMs?: number;
}

/**
 * Session operations over one shared auth seam and one ApiClient.
 * Mutations run through withCsrfRetry (csrf.ts): the token is
 * fetched from memory or from GET /api/auth/csrf, refreshed once
 * on a 403 csrf_invalid, and a 401 notifies the expiry listeners
 * once and clears the token. Reads report a 401 through the same
 * seam via the ApiClient onUnauthorized hook.
 */
export interface AuthSessionClient {
  /** The shared seam. Exposed so login wiring can seed and reset it. */
  readonly seam: WebApiAuthSeam;
  /** The wired ApiClient. Exposed so sibling auth calls share it. */
  readonly apiClient: ApiClient;

  /**
   * Fetch GET /api/auth/me and return the parsed metadata. Throws
   * ApiError on a 401 (session expired, listeners notified), on
   * any other wire failure, and a local SERVER_ERROR ApiError when
   * the 200 body does not match the MeData shape.
   */
  getMe(): Promise<AuthMeData>;

  /**
   * Fetch GET /api/auth/sessions and return the parsed list,
   * newest activity first. Throws like getMe on failure or on a
   * malformed list.
   */
  listSessions(): Promise<AuthSessionEntry[]>;

  /**
   * Revoke one own session (DELETE /api/auth/sessions/:id).
   * A missing id and an id owned by another account share one 404
   * from the server; this method surfaces it unchanged. Pass
   * isCurrent true when revoking the current session: the server
   * clears the cookie in that case, so the cached CSRF token is
   * cleared here too and the caller must navigate to the login
   * page. Throws a local VALIDATION_ERROR ApiError for an unsafe
   * id, before any fetch happens.
   */
  revokeSession(id: string, options?: { isCurrent?: boolean }): Promise<void>;

  /**
   * Log out (POST /api/auth/logout). On success the cached CSRF
   * token is cleared and the caller navigates to the login page.
   * A 401 during logout means the session is already dead, so it
   * is treated as success: the token is cleared and the promise
   * resolves. Any other failure propagates with the token kept,
   * so the user can retry without losing the session.
   */
  logout(): Promise<void>;

  /**
   * Log out of every device (POST /api/auth/logout-all). Requires
   * a fresh step-up: a 403 with code step_up_required propagates
   * unchanged for the caller to run the step-up flow. Success and
   * 401 behave like logout.
   */
  logoutAll(): Promise<void>;

  /**
   * Fetch a fresh CSRF token from GET /api/auth/csrf and cache it
   * in memory. Use after a reload, when the memory copy is gone.
   * Returns the token for callers that must forward it; most
   * callers only need the cache refill and ignore the value.
   * A 401 throws CsrfTokenError with sessionExpired true and
   * notifies the expiry listeners.
   */
  refreshCsrfToken(): Promise<string>;

  /**
   * Return the cached CSRF token, fetching it once when absent
   * (for example after a reload). Same failure behavior as
   * refreshCsrfToken.
   */
  ensureCsrfToken(): Promise<string>;

  /**
   * Seed the in-memory token from a login, step-up, or
   * password-change response body, and reset the session status
   * so a previous expiry does not linger into the new session.
   * The token must come from the response body, never from
   * storage. Throws TypeError for an unusable token.
   */
  seedCsrfToken(token: string): void;

  /** Discard the cached CSRF token. The next mutation fetches again. */
  clearCsrfToken(): void;

  /** Whether a CSRF token is cached. Never exposes the value. */
  hasCsrfToken(): boolean;

  /** Current session status from the seam (unknown, active, expired). */
  getSessionStatus(): ApiClientSessionStatus;

  /** Subscribe to the session-expiry transition. Returns unsubscribe. */
  subscribeToSessionExpiry(listener: OnUnauthorized): () => void;

  /**
   * Return the session status to unknown, for example after the
   * boot guard proves the session is alive again. Only an explicit
   * call leaves the expired state.
   */
  resetSessionStatus(): void;
}

export function createAuthSessionClient(
  deps: AuthSessionClientDeps = {},
): AuthSessionClient {
  const csrfDeps: CsrfTokenStoreDeps = {};
  if (deps.fetchFn !== undefined) {
    csrfDeps.fetchFn = deps.fetchFn;
  }
  if (deps.csrfEndpoint !== undefined) {
    csrfDeps.endpoint = deps.csrfEndpoint;
  }
  if (deps.csrfTimeoutMs !== undefined) {
    csrfDeps.timeoutMs = deps.csrfTimeoutMs;
  }
  const seam = createWebApiAuthSeam(csrfDeps);

  const clientOptions: ApiClientOptions = {
    onUnauthorized: (error: ApiError) => {
      handleUnauthorizedError(seam, error);
    },
    csrfTokenProvider: () => seam.csrf.getToken(),
  };
  if (deps.fetchFn !== undefined) {
    clientOptions.fetchFn = deps.fetchFn;
  }
  if (deps.defaultTimeoutMs !== undefined) {
    clientOptions.defaultTimeoutMs = deps.defaultTimeoutMs;
  }
  const apiClient = createApiClient(clientOptions);

  async function mutate(path: string, method: "POST" | "DELETE"): Promise<void> {
    // The attempt callback intentionally ignores the token argument:
    // the ApiClient reads the same shared store through its
    // csrfTokenProvider, so the retried attempt after a refresh
    // picks up the fresh cached token. withCsrfRetry still owns
    // the fetch-before-attempt and the single refresh-and-retry.
    await withCsrfRetry(
      seam,
      async () => {
        await apiClient.requestJson<unknown>(path, { method });
      },
      { path },
    );
  }

  function isAlreadyLoggedOut(error: unknown): boolean {
    if (error instanceof ApiError) {
      return error.status === 401;
    }
    return error instanceof CsrfTokenError && error.sessionExpired;
  }

  async function logoutLike(path: string): Promise<void> {
    try {
      await mutate(path, "POST");
    } catch (error) {
      if (isAlreadyLoggedOut(error)) {
        seam.csrf.clearToken();
        return;
      }
      throw error;
    }
    seam.csrf.clearToken();
  }

  return {
    seam,
    apiClient,

    async getMe(): Promise<AuthMeData> {
      const data = await apiClient.requestJson<unknown>(AUTH_ME_ENDPOINT, {
        method: "GET",
      });
      const parsed = parseAuthMeData(data);
      if (parsed === null) {
        throw createLocalApiError("SERVER_ERROR");
      }
      return parsed;
    },

    async listSessions(): Promise<AuthSessionEntry[]> {
      const data = await apiClient.requestJson<unknown>(AUTH_SESSIONS_ENDPOINT, {
        method: "GET",
      });
      const parsed = parseAuthSessionList(data);
      if (parsed === null) {
        throw createLocalApiError("SERVER_ERROR");
      }
      return parsed;
    },

    async revokeSession(id: string, options: { isCurrent?: boolean } = {}): Promise<void> {
      if (!isSafeSessionRowId(id)) {
        throw createLocalApiError("VALIDATION_ERROR");
      }
      await mutate(`${AUTH_SESSIONS_ENDPOINT}/${encodeURIComponent(id)}`, "DELETE");
      if (options.isCurrent === true) {
        seam.csrf.clearToken();
      }
    },

    async logout(): Promise<void> {
      await logoutLike(AUTH_LOGOUT_ENDPOINT);
    },

    async logoutAll(): Promise<void> {
      await logoutLike(AUTH_LOGOUT_ALL_ENDPOINT);
    },

    async refreshCsrfToken(): Promise<string> {
      return seam.csrf.refreshToken();
    },

    async ensureCsrfToken(): Promise<string> {
      return seam.csrf.getToken();
    },

    seedCsrfToken(token: string): void {
      seam.csrf.setToken(token);
      seam.resetSessionStatus();
    },

    clearCsrfToken(): void {
      seam.csrf.clearToken();
    },

    hasCsrfToken(): boolean {
      return seam.csrf.hasToken();
    },

    getSessionStatus(): ApiClientSessionStatus {
      return seam.getSessionStatus();
    },

    subscribeToSessionExpiry(listener: OnUnauthorized): () => void {
      return seam.subscribeToSessionExpiry(listener);
    },

    resetSessionStatus(): void {
      seam.resetSessionStatus();
    },
  };
}

/**
 * The one shared session client for the browser UI. Created lazily
 * on first use and held in module memory only, like the CSRF token
 * it guards. Tests must use createAuthSessionClient with an
 * injected fetch instead of this singleton.
 */
let sharedClient: AuthSessionClient | null = null;

export function getSharedAuthSessionClient(): AuthSessionClient {
  if (sharedClient === null) {
    sharedClient = createAuthSessionClient();
  }
  return sharedClient;
}
