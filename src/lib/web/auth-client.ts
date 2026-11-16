// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Page-facing auth client (Fase 1, V3-03a, wave 3D).
//
// This is the PAGE part of the auth client: the calls the login and
// setup pages need, plus the shared wired session (CSRF seam plus
// API client) those pages seed on sign-in. It is a thin layer over
// the centralized client (V3-30): every request goes through
// ApiClient, there is no ad hoc fetch to /api/ here, and branching
// is on wire codes, never on message text (contract sections 1.2,
// 2.2, and 6; AD-39: this module returns stable machine codes and
// never calls t()).
//
// Scope boundary: logout, the session list, session revocation,
// step-up, password change, TOTP enrollment, and password reset are
// NOT in this file. They belong to the sibling V3-03 split that owns
// the chrome and session surface (and to V3-29 for settings), which
// shares the AuthSession seam created here. Do not duplicate the
// seam or the CSRF store; one seam per client, shared by all
// requests (csrf.ts).
//
// Memory-only rules (desain-auth sections 4.3 and 5.2): the CSRF
// token lives only in the seam store, the login challengeToken lives
// only in the login page component state, and nothing here touches
// persistent browser storage, cookies, or the URL. The session cookie is HttpOnly and is never read or written
// by this code; the browser carries it. After a reload the CSRF
// token is refetched through GET /api/auth/csrf by the seam store,
// never restored from storage.
//
// Wire shapes (kontrak-api-kanonis.md section 3.12, verified against
// server/src/routes/auth-core.ts):
// - POST /api/auth/login: 200 { id, email, role, totpEnabled,
//   csrfToken, sessionExpiresAt } plus a session cookie when TOTP
//   is off; 202 { challengeToken, step: "totp" } with NO cookie
//   when TOTP is on. ApiClient returns only the envelope data, so
//   the two outcomes are told apart by shape, not by status.
// - POST /api/auth/login/totp: body { challengeToken, code } or
//   { challengeToken, recoveryCode }, exactly one of the two codes.
//   200 with the same success shape as login.
// - POST /api/auth/setup: body { setupToken, email, password,
//   workspaceName? }. 201 { id, email, workspaceId }. No session
//   is created: setup is not a login.
// - GET /api/auth/me: account metadata plus current session info,
//   no secrets. The login page uses it only to skip the form when a
//   session already exists.
// Pre-session mutations send skipCsrf: true (no session exists yet,
// so there is no token to send; contract 3.12). The 401 seam
// notification is wired only on the session client, so a failed
// login attempt is never reported as a session expiry.

import { createApiClient, type ApiClient } from "./api-client";
import {
  createWebApiAuthSeam,
  handleUnauthorizedError,
  type WebApiAuthSeam,
} from "./csrf";
import { ApiError } from "./errors";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
