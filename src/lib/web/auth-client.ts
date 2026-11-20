// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unified auth client for the web frontend (Fase 1, V3-03).
//
// This module unions two sibling splits built against the same base
// that both added this file: the SESSION part (slot 03b: the current
// session, the session list and revocation, logout, and the CSRF
// token lifecycle) and the PAGE part (slot 03a: the calls the login
// and setup pages need, plus the shared wired session those pages
// seed on sign-in). The union keeps every export of both parts.
//
// One seam in the shared path: getSharedAuthSessionClient builds over
// the seam and wired client of getSharedAuthSession, so a token
// seeded by a login is the token later mutations send, and there is
// exactly one CSRF store. Factories called with injected deps still
// build a fresh seam per call, for tests.
//
// Shared rules: this module has no DOM, no navigation, and no React;
// it reports session expiry through the seam listeners, and the guard
// and chrome components decide what to show. The CSRF token lives
// only in module memory, through the CsrfTokenStore owned by csrf.ts
// (V3-30b); it is never written to persistent browser storage or a
// cookie, and it is never logged. A page reload loses the copy by
// design; the next mutation refetches it from GET /api/auth/csrf.
// The session cookie is HttpOnly and is never read or written by
// this code; the browser carries it, and the ApiClient sends
// credentials "include". Every request goes through ApiClient; there
// is no ad hoc fetch to /api/ here. Branching is on wire codes,
// never on message text (contract sections 1.2, 2.2, and 6; AD-39:
// this module returns stable machine codes and never calls t()).
//
// Canonical sources: desain-auth.md (session lifecycle, session
// list shape, endpoint inventory) and kontrak-api-kanonis.md
// section 3.12 (wire shapes and codes). Wire time format for auth
// is ISO 8601 UTC strings; this module keeps them as strings and
// never does epoch math on them.
//
// What this module does NOT own: step-up, password change/reset,
// TOTP enrollment, and admin calls. Those belong to the sibling
// V3-03/V3-02/V3-29 slots, which share the AuthSession seam created
// here. Do not duplicate the seam or the CSRF store.

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

/** Canonical auth endpoints (contract 3.12). No other paths are called here. */
export const LOGIN_ENDPOINT = "/api/auth/login";
export const LOGIN_TOTP_ENDPOINT = "/api/auth/login/totp";
export const SETUP_ENDPOINT = "/api/auth/setup";
export const ME_ENDPOINT = "/api/auth/me";

/** Password rule from desain-auth sections 1.8 and 3.5. The server is the authority. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** TOTP codes are 6 digits (desain-auth section 3.1). */
export const TOTP_CODE_LENGTH = 6;

/** Per-request budget for page auth calls. Matches the boot guard total budget. */
export const AUTH_REQUEST_TIMEOUT_MS = 15000;

export type AccountRole = "user" | "admin";

/** Login success data, identical for the password step and the TOTP step. */
export interface LoginSuccess {
  id: string;
  email: string;
  role: AccountRole;
  totpEnabled: boolean;
  /** Raw CSRF token for the new session. Seeded into the seam store, never stored. */
  csrfToken: string;
  sessionExpiresAt: string;
}

/** Second-step challenge. The token lives only in page component state. */
export interface LoginChallenge {
  challengeToken: string;
}

export type LoginResult =
  | { outcome: "authenticated"; session: LoginSuccess }
  | { outcome: "totp_required"; challenge: LoginChallenge };

export interface LoginCredentials {
  email: string;
  password: string;
}

/** Exactly one of code and recoveryCode, matching the server validation. */
export type TotpVerification =
  | { challengeToken: string; code: string; recoveryCode?: undefined }
  | { challengeToken: string; recoveryCode: string; code?: undefined };

export interface SetupRequest {
  setupToken: string;
  email: string;
  password: string;
  workspaceName?: string;
}

export interface SetupResult {
  id: string;
  email: string;
  workspaceId: string;
}

export interface CurrentSessionInfo {
  id: string;
  deviceLabel: string;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  stepUpAt: string | null;
}

export interface CurrentAccount {
  id: string;
  email: string;
  role: AccountRole;
  totpEnabled: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
  workspaceId: string | null;
  session: CurrentSessionInfo | null;
}

/**
 * Stable machine codes for page auth failures. The pages map these
 * to user-facing English strings; no wire message text ever reaches
 * the UI. INVALID_CREDENTIALS is deliberately the same code for a
 * missing email, a wrong password, and a disabled account
 * (anti-enumeration, desain-auth section 3.7).
 */
export type AuthClientErrorCode =
  | "INVALID_CREDENTIALS"
  | "INVALID_VERIFICATION_CODE"
  | "INVALID_SETUP_TOKEN"
  | "SETUP_CLOSED"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "SESSION_EXPIRED"
  | "REQUEST_REJECTED"
  | "STEP_UP_REQUIRED"
  | "NETWORK_ERROR"
  | "SERVER_ERROR";

export class AuthClientError extends Error {
  readonly code: AuthClientErrorCode;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(
    code: AuthClientErrorCode,
    options: { status?: number | null; requestId?: string | null; retryable?: boolean } = {},
  ) {
    super(`Auth request failed (${code})`);
    this.name = "AuthClientError";
    this.code = code;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.retryable = options.retryable ?? false;
  }
}

type ErrorContext = "login" | "totp" | "setup" | "me";

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseRole(value: unknown): AccountRole | null {
  return value === "user" || value === "admin" ? value : null;
}

/** Parse the 200 login success shape. Returns null for anything else. */
export function parseLoginSuccess(data: unknown): LoginSuccess | null {
  if (!isRecord(data)) {
    return null;
  }
  const role = parseRole(data.role);
  const csrfToken = data.csrfToken;
  if (
    !nonEmptyString(data.id) ||
    !nonEmptyString(data.email) ||
    role === null ||
    typeof data.totpEnabled !== "boolean" ||
    !nonEmptyString(csrfToken) ||
    /\s/.test(csrfToken) ||
    !nonEmptyString(data.sessionExpiresAt)
  ) {
    return null;
  }
  return {
    id: data.id,
    email: data.email,
    role,
    totpEnabled: data.totpEnabled,
    csrfToken,
    sessionExpiresAt: data.sessionExpiresAt,
  };
}

/**
 * Tell the two login outcomes apart by shape: a 202 challenge
 * carries challengeToken plus step "totp" and no session fields; a
 * 200 success carries the session fields. Anything else is null so
 * the caller fails closed instead of guessing.
 */
export function parseLoginResponse(data: unknown): LoginResult | null {
  if (isRecord(data) && nonEmptyString(data.challengeToken) && data.step === "totp") {
    return { outcome: "totp_required", challenge: { challengeToken: data.challengeToken } };
  }
  const session = parseLoginSuccess(data);
  if (session !== null) {
    return { outcome: "authenticated", session };
  }
  return null;
}

/** Parse the 201 setup shape. Returns null for anything else. */
export function parseSetupResult(data: unknown): SetupResult | null {
  if (
    !isRecord(data) ||
    !nonEmptyString(data.id) ||
    !nonEmptyString(data.email) ||
    !nonEmptyString(data.workspaceId)
  ) {
    return null;
  }
  return { id: data.id, email: data.email, workspaceId: data.workspaceId };
}

function parseSessionInfo(data: unknown): CurrentSessionInfo | null {
  if (!isRecord(data)) {
    return null;
  }
  if (
    !nonEmptyString(data.id) ||
    !nonEmptyString(data.deviceLabel) ||
    !nonEmptyString(data.createdAt) ||
    !nonEmptyString(data.lastSeenAt) ||
    !nonEmptyString(data.absoluteExpiresAt) ||
    !(data.stepUpAt === null || typeof data.stepUpAt === "string")
  ) {
    return null;
  }
  return {
    id: data.id,
    deviceLabel: data.deviceLabel,
    createdAt: data.createdAt,
    lastSeenAt: data.lastSeenAt,
    absoluteExpiresAt: data.absoluteExpiresAt,
    stepUpAt: data.stepUpAt,
  };
}

/**
 * Parse the GET /api/auth/me shape. The required account fields are
 * strict; the metadata and session fields are optional so the probe
 * stays tolerant of the exact shape, mirroring session-check.ts.
 */
export function parseCurrentAccount(data: unknown): CurrentAccount | null {
  if (!isRecord(data)) {
    return null;
  }
  const role = parseRole(data.role);
  if (
    !nonEmptyString(data.id) ||
    !nonEmptyString(data.email) ||
    role === null ||
    typeof data.totpEnabled !== "boolean"
  ) {
    return null;
  }
  const createdAt = data.createdAt;
  const lastLoginAt = data.lastLoginAt;
  const workspaceId = data.workspaceId;
  if (
    !(createdAt === undefined || createdAt === null || typeof createdAt === "string") ||
    !(lastLoginAt === undefined || lastLoginAt === null || typeof lastLoginAt === "string") ||
    !(workspaceId === undefined || workspaceId === null || typeof workspaceId === "string")
  ) {
    return null;
  }
  let session: CurrentSessionInfo | null = null;
  if (data.session !== undefined && data.session !== null) {
    session = parseSessionInfo(data.session);
    if (session === null) {
      return null;
    }
  }
  return {
    id: data.id,
    email: data.email,
    role,
    totpEnabled: data.totpEnabled,
    createdAt: typeof createdAt === "string" ? createdAt : null,
    lastLoginAt: typeof lastLoginAt === "string" ? lastLoginAt : null,
    workspaceId: typeof workspaceId === "string" ? workspaceId : null,
    session,
  };
}

/** Email normalization, mirroring the server (desain-auth section 3.1 step 2). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True when the value is a 6-digit TOTP code (whitespace around it is ignored). */
export function isValidTotpCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}

/** True when the password meets the length rule the server enforces. */
export function isValidSetupPassword(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

function defaultCodeForStatus(status: number | null, context: ErrorContext): AuthClientErrorCode {
  if (status === 401) {
    if (context === "login") {
      return "INVALID_CREDENTIALS";
    }
    if (context === "totp") {
      return "INVALID_VERIFICATION_CODE";
    }
    if (context === "setup") {
      return "INVALID_SETUP_TOKEN";
    }
    return "SESSION_EXPIRED";
  }
  if (status === 403) {
    return "REQUEST_REJECTED";
  }
  if (status === 404 && context === "setup") {
    return "SETUP_CLOSED";
  }
  if (status === 429) {
    return "RATE_LIMITED";
  }
  return "SERVER_ERROR";
}

/**
 * Map any failure from the centralized client to a page error code.
 * Branching is on the wire code first, then on the HTTP status; the
 * wire message text is never read. Transport failures (no response)
 * become NETWORK_ERROR.
 */
export function toAuthClientError(error: unknown, context: ErrorContext): AuthClientError {
  if (error instanceof AuthClientError) {
    return error;
  }
  if (error instanceof ApiError) {
    if (error.status === null && (error.localCode === "NETWORK_ERROR" || error.localCode === "TIMEOUT")) {
      return new AuthClientError("NETWORK_ERROR", {
        status: null,
        requestId: error.requestId,
        retryable: error.retryable,
      });
    }
    const wireCode = error.wireCode;
    let code: AuthClientErrorCode | null = null;
    if (wireCode === "invalid_credentials") {
      code = "INVALID_CREDENTIALS";
    } else if (wireCode === "invalid_verification_code") {
      code = "INVALID_VERIFICATION_CODE";
    } else if (wireCode === "invalid_setup_token") {
      code = "INVALID_SETUP_TOKEN";
    } else if (wireCode === "not_found" && context === "setup") {
      code = "SETUP_CLOSED";
    } else if (wireCode === "validation_failed") {
      code = "VALIDATION_FAILED";
    } else if (wireCode === "rate_limited") {
      code = "RATE_LIMITED";
    } else if (wireCode === "unauthenticated") {
      code = context === "me" ? "SESSION_EXPIRED" : defaultCodeForStatus(error.status, context);
    } else if (wireCode === "csrf_invalid" || wireCode === "origin_rejected" || wireCode === "forbidden") {
      code = "REQUEST_REJECTED";
    } else if (wireCode === "step_up_required") {
      code = "STEP_UP_REQUIRED";
    }
    return new AuthClientError(code ?? defaultCodeForStatus(error.status, context), {
      status: error.status,
      requestId: error.requestId,
      retryable: error.retryable,
    });
  }
  return new AuthClientError("SERVER_ERROR");
}

/**
 * Accept only internal post-login targets. Absolute URLs,
 * protocol-relative values, backslashes, and whitespace fall back
 * to "/". The login and setup pages themselves are rejected so a
 * crafted next value can never loop the user back to the form.
 * Legitimate internal paths (including query strings and hashes)
 * pass through unchanged.
 */
export function resolvePostLoginTarget(next: string | null | undefined): string {
  if (!next) {
    return "/";
  }
  const raw = next.trim();
  if (
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    /[\s<>]/.test(raw)
  ) {
    return "/";
  }
  const path = raw.split(/[?#]/)[0];
  if (path === "/login" || path === "/setup") {
    return "/";
  }
  return raw;
}

export interface AuthSessionDeps {
  /** Fetch implementation. Defaults to the global fetch. Injectable for tests. */
  fetchFn?: typeof fetch;
  /** CSRF endpoint override for the seam store. Defaults to /api/auth/csrf. */
  csrfEndpoint?: string;
  /** CSRF fetch timeout. Defaults to the seam store default. */
  csrfTimeoutMs?: number;
  /** Per-request timeout for auth calls. Defaults to AUTH_REQUEST_TIMEOUT_MS. */
  defaultTimeoutMs?: number;
}

/**
 * One wired auth session: the CSRF seam plus two API clients that
 * share it. `client` is the session client (CSRF provider plus the
 * 401 seam notification, for calls made with a session). `preSession`
 * is the pre-session client (no CSRF provider, no 401 notification)
 * for login, TOTP, and setup, where a 401 is an ordinary failed
 * attempt, not a session expiry. Both clients share the one seam
 * store, so a token seeded by a login is the token later mutations
 * send.
 */
export interface AuthSession {
  seam: WebApiAuthSeam;
  client: ApiClient;
  preSession: ApiClient;
}

export function createAuthSession(deps: AuthSessionDeps = {}): AuthSession {
  const seam = createWebApiAuthSeam({
    fetchFn: deps.fetchFn,
    endpoint: deps.csrfEndpoint,
    timeoutMs: deps.csrfTimeoutMs,
  });
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? AUTH_REQUEST_TIMEOUT_MS;
  const client = createApiClient({
    fetchFn: deps.fetchFn,
    csrfTokenProvider: () => seam.csrf.getToken(),
    onUnauthorized: (error) => {
      handleUnauthorizedError(seam, error);
    },
    defaultTimeoutMs,
  });
  const preSession = createApiClient({ fetchFn: deps.fetchFn, defaultTimeoutMs });
  return { seam, client, preSession };
}

let sharedSession: AuthSession | null = null;

/**
 * The app-wide auth session for the pages. Created lazily on first
 * use; the seam and its in-memory token are module state, so they
 * survive navigation within the page lifetime and vanish on reload
 * by design. Tests use createAuthSession with an injected fetch.
 */
export function getSharedAuthSession(): AuthSession {
  if (sharedSession === null) {
    sharedSession = createAuthSession();
  }
  return sharedSession;
}

function seedSessionAfterLogin(seam: WebApiAuthSeam, session: LoginSuccess): void {
  seam.csrf.setToken(session.csrfToken);
  seam.resetSessionStatus();
  seam.markSessionActive();
}

export interface AuthCallOptions {
  /** Caller abort signal. Aborting produces a NETWORK_ERROR. */
  signal?: AbortSignal;
}

/**
 * Login step 1: email plus password. Returns the session when TOTP
 * is off, or the in-memory challenge when the server answers 202.
 * Throws AuthClientError on any failure; the 401 case is the
 * generic INVALID_CREDENTIALS for every cause.
 */
export async function loginWithPassword(
  session: AuthSession,
  credentials: LoginCredentials,
  options: AuthCallOptions = {},
): Promise<LoginResult> {
  const email = normalizeEmail(credentials.email);
  if (email === "" || credentials.password === "") {
    throw new AuthClientError("VALIDATION_FAILED");
  }
  let data: unknown;
  try {
    data = await session.preSession.postJson<unknown>(
      LOGIN_ENDPOINT,
      { email, password: credentials.password },
      { skipCsrf: true, signal: options.signal },
    );
  } catch (error) {
    throw toAuthClientError(error, "login");
  }
  const parsed = parseLoginResponse(data);
  if (parsed === null) {
    throw new AuthClientError("SERVER_ERROR");
  }
  if (parsed.outcome === "authenticated") {
    seedSessionAfterLogin(session.seam, parsed.session);
  }
  return parsed;
}

/**
 * Login step 2: the challenge token plus a TOTP code or a recovery
 * code. The challenge token comes from step 1 and is held only in
 * page state. Returns the session; throws AuthClientError otherwise.
 */
export async function loginWithTotp(
  session: AuthSession,
  verification: TotpVerification,
  options: AuthCallOptions = {},
): Promise<LoginSuccess> {
  if (verification.challengeToken === "") {
    throw new AuthClientError("VALIDATION_FAILED");
  }
  let body: Record<string, string>;
  if (verification.code !== undefined) {
    const code = verification.code.trim();
    if (!isValidTotpCode(code)) {
      throw new AuthClientError("VALIDATION_FAILED");
    }
    body = { challengeToken: verification.challengeToken, code };
  } else {
    const recoveryCode = verification.recoveryCode.trim();
    if (recoveryCode === "") {
      throw new AuthClientError("VALIDATION_FAILED");
    }
    body = { challengeToken: verification.challengeToken, recoveryCode };
  }
  let data: unknown;
  try {
    data = await session.preSession.postJson<unknown>(LOGIN_TOTP_ENDPOINT, body, {
      skipCsrf: true,
      signal: options.signal,
    });
  } catch (error) {
    throw toAuthClientError(error, "totp");
  }
  const parsed = parseLoginSuccess(data);
  if (parsed === null) {
    throw new AuthClientError("SERVER_ERROR");
  }
  seedSessionAfterLogin(session.seam, parsed);
  return parsed;
}

/**
 * First-account setup. Creates the admin account and its workspace
 * but NO session: the operator signs in through the normal login
 * flow afterwards. Throws SETUP_CLOSED when the server answers 404
 * (installation already finished).
 */
export async function createFirstAccount(
  session: AuthSession,
  request: SetupRequest,
  options: AuthCallOptions = {},
): Promise<SetupResult> {
  const setupToken = request.setupToken.trim();
  const email = normalizeEmail(request.email);
  if (setupToken === "" || email === "" || !isValidSetupPassword(request.password)) {
    throw new AuthClientError("VALIDATION_FAILED");
  }
  const workspaceName = request.workspaceName?.trim();
  const body: Record<string, string> = {
    setupToken,
    email,
    password: request.password,
  };
  if (workspaceName !== undefined && workspaceName !== "") {
    body.workspaceName = workspaceName;
  }
  let data: unknown;
  try {
    data = await session.preSession.postJson<unknown>(SETUP_ENDPOINT, body, {
      skipCsrf: true,
      signal: options.signal,
    });
  } catch (error) {
    throw toAuthClientError(error, "setup");
  }
  const parsed = parseSetupResult(data);
  if (parsed === null) {
    throw new AuthClientError("SERVER_ERROR");
  }
  return parsed;
}

/**
 * Read the current account, or null when there is no valid session.
 * A 401 is an expected outcome here (the login page shows its form),
 * not an error; every other failure throws AuthClientError. A 200
 * with an unparseable body fails closed with SERVER_ERROR.
 */
export async function fetchCurrentAccount(
  session: AuthSession,
  options: AuthCallOptions = {},
): Promise<CurrentAccount | null> {
  let data: unknown;
  try {
    data = await session.client.getJson<unknown>(ME_ENDPOINT, { signal: options.signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw toAuthClientError(error, "me");
  }
  const parsed = parseCurrentAccount(data);
  if (parsed === null) {
    throw new AuthClientError("SERVER_ERROR");
  }
  session.seam.markSessionActive();
  return parsed;
}

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
    // Same budget as createAuthSession (DA28-01): a session client
    // without a timeout hangs on a stalled API like any other.
    defaultTimeoutMs: deps.defaultTimeoutMs ?? AUTH_REQUEST_TIMEOUT_MS,
  };
  if (deps.fetchFn !== undefined) {
    clientOptions.fetchFn = deps.fetchFn;
  }
  const apiClient = createApiClient(clientOptions);

  return buildAuthSessionClient(seam, apiClient);
}

/**
 * Build the session operations over an existing seam and wired
 * ApiClient. Shared by createAuthSessionClient (fresh seam per
 * call, for tests with an injected fetch) and by
 * getSharedAuthSessionClient (the one shared seam, through
 * getSharedAuthSession, so the session surface and the pages
 * never fork a second CSRF store).
 */
function buildAuthSessionClient(
  seam: WebApiAuthSeam,
  apiClient: ApiClient,
): AuthSessionClient {
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
 * on first use over the shared auth session (getSharedAuthSession),
 * so the session surface and the login/setup pages share one seam
 * and one CSRF store, held in module memory only. Tests must use
 * createAuthSessionClient with an injected fetch instead of this
 * singleton.
 */
let sharedClient: AuthSessionClient | null = null;

export function getSharedAuthSessionClient(): AuthSessionClient {
  if (sharedClient === null) {
    const shared = getSharedAuthSession();
    sharedClient = buildAuthSessionClient(shared.seam, shared.client);
  }
  return sharedClient;
}
