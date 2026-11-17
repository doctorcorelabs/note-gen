// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// API-level login and setup helpers for E2E flows (desain-auth.md,
// kontrak-api-kanonis.md auth group). These helpers drive the HTTP API
// through a Playwright APIRequestContext; they do NOT drive any login
// UI. UI login is covered separately by harness/login-page.ts over
// the shipped /login page (V3-03, locators in harness/selectors.ts):
// use the page object when the flow under test IS the login UI, and
// use these helpers when a flow needs a session without driving the
// UI (for example, seeding the session before a UI flow).
//
// What is real here: POST /api/auth/setup, POST /api/auth/login, and
// GET /api/auth/me exist on the trunk server (server/src/routes/
// auth-core.ts) with the shapes asserted below (success envelope
// { ok: true, data }, login 200 session / 202 TOTP challenge, /me 200
// authenticated / 401-403 unauthenticated). The helpers assert only
// those wire shapes; they never guess UI selectors.
//
// What is NOT wired: the Playwright config serves only the static
// export, which answers no /api/* route. Against a static-only base
// URL these helpers fail honestly (404 / connection error with a
// named cause), they never pretend to log in. Authenticated flows
// activate only when a backend harness supplies a real API base URL
// through E2E_API_BASE_URL (or a proxy in front of the static
// server). Until then, specs that need a session stay pending with a
// named reason; do not weaken that.
//
// Credentials come ONLY from test-only environment variables supplied
// by the harness runner. There are no hardcoded credentials, no
// default passwords, and no value is ever logged. The helper names
// only the missing variable names when one is absent. Seed one
// account WITHOUT TOTP for the happy path; the TOTP challenge (202)
// is a named error here, not a silent fallback, because TOTP coverage
// is a separate variant. Failed-login attempts count toward the
// login rate-limit buckets and progressive lockout (desain-auth.md
// 6.3): use a fresh seeded account per run and keep failed attempts
// few and fixed, so the suite cannot lock its own test account.
//
// CSRF: public mutations (login, setup) are NOT covered by the global
// CSRF hook; a standalone Origin check applies instead
// (server/src/middleware/auth-hook.ts). Every POST here sends
// Origin: <api base origin>. Session cookies are stored in the
// request context the caller passes: pass page.request so the browser
// context receives the session cookie for UI flows that follow.
//
// Anti-flaky rules (desain-pengujian 4.3): no fixed sleeps, no
// waitForTimeout. Request timeouts below are hang bounds, not sleeps:
// a timeout produces a named error that says which call hung.

import { expect, type APIRequestContext } from '@playwright/test'

export interface TestCredentials {
  email: string
  password: string
}

export interface SetupResult {
  id: string
  email: string
  workspaceId: string
}

export interface SessionProbe {
  authenticated: boolean
  email?: string
  totpEnabled?: boolean
}

const LOGIN_TIMEOUT_MS = 10_000
const SETUP_TIMEOUT_MS = 10_000
const SESSION_TIMEOUT_MS = 10_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCodeOf(body: unknown): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string') {
    return body.error.code
  }
  return 'unknown_error'
}

/**
 * Resolve the API base URL from the environment. E2E_API_BASE_URL wins
 * when a backend harness runs the API on its own origin; otherwise
 * the E2E page base URL is used, and finally the default static
 * server origin. The `env` parameter exists so harness checks can
 * pass explicit values without mutating process.env.
 */
export function resolveApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = Number(env.E2E_PORT ?? 4173)
  return env.E2E_API_BASE_URL ?? env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`
}

/**
 * Read test-only credentials from the environment. Throws a named
 * error listing the missing variable NAMES (never values) when any
 * is absent or blank. The `env` parameter exists for harness checks.
 */
export function readTestCredentials(env: NodeJS.ProcessEnv = process.env): TestCredentials {
  const missing: string[] = []
  const email = env.E2E_TEST_EMAIL
  const password = env.E2E_TEST_PASSWORD
  if (email === undefined || email === '') missing.push('E2E_TEST_EMAIL')
  if (password === undefined || password === '') missing.push('E2E_TEST_PASSWORD')
  if (missing.length > 0) {
    throw new Error(
      `e2e auth setup missing: ${missing.join(', ')} not set. ` +
        'Supply test-only credentials through the harness environment; ' +
        'never hardcode credentials in a spec.',
    )
  }
  return { email: email as string, password: password as string }
}

/**
 * Read the first-install setup token from the environment. Throws a
 * named error when it is absent or blank. The token value is never
 * logged and never appears in any error message.
 */
export function readSetupToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.E2E_SETUP_TOKEN
  if (token === undefined || token === '') {
    throw new Error(
      'e2e auth setup missing: E2E_SETUP_TOKEN not set. ' +
        'Supply the test-only setup token through the harness environment.',
    )
  }
  return token
}

/** Origin header value for public mutations: the API base origin. */
export function apiOrigin(apiBaseUrl: string): string {
  return new URL(apiBaseUrl).origin
}

/**
 * Create the first account (POST /api/auth/setup). Only valid while
 * the installation is open; a completed installation answers 404 by
 * design. No session is created: the caller logs in afterwards
 * through loginViaApi. Throws a named error with status and error
 * code on any non-201 response.
 */
export async function setupFirstAccount(
  request: APIRequestContext,
  apiBaseUrl: string,
  credentials: TestCredentials,
  setupToken: string,
  workspaceName?: string,
): Promise<SetupResult> {
  let response
  try {
    response = await request.post(`${apiBaseUrl}/api/auth/setup`, {
      data: {
        setupToken,
        email: credentials.email,
        password: credentials.password,
        ...(workspaceName === undefined ? {} : { workspaceName }),
      },
      headers: { Origin: apiOrigin(apiBaseUrl) },
      timeout: SETUP_TIMEOUT_MS,
    })
  } catch (error) {
    throw new Error(
      `e2e auth setup failed: POST /api/auth/setup to ${apiBaseUrl} did not complete ` +
        `(backend unreachable or hung): ${(error as Error).message}`,
    )
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (response.status() !== 201 || !isRecord(body) || body.ok !== true || !isRecord(body.data)) {
    throw new Error(
      `e2e auth setup failed: POST /api/auth/setup answered ${response.status()} ` +
        `(${errorCodeOf(body)}); expected 201 with an ok envelope. ` +
        'A 404 means the installation is already completed; a 403 means the Origin check rejected the call.',
    )
  }
  const data = body.data
  if (typeof data.id !== 'string' || typeof data.email !== 'string' || typeof data.workspaceId !== 'string') {
    throw new Error('e2e auth setup failed: 201 response is missing id, email, or workspaceId.')
  }
  return { id: data.id, email: data.email, workspaceId: data.workspaceId }
}

/**
 * Log in through step 1 of the API login flow (POST /api/auth/login).
 * On 200 the session cookie is stored in the passed request context;
 * pass page.request so the browser context is authenticated. On 202
 * the account has TOTP enabled and this helper throws a named error:
 * seed an account without TOTP for the happy path. On any other
 * status it throws with status and error code. The password value
 * never appears in any message.
 */
export async function loginViaApi(
  request: APIRequestContext,
  apiBaseUrl: string,
  credentials: TestCredentials,
): Promise<void> {
  let response
  try {
    response = await request.post(`${apiBaseUrl}/api/auth/login`, {
      data: { email: credentials.email, password: credentials.password },
      headers: { Origin: apiOrigin(apiBaseUrl) },
      timeout: LOGIN_TIMEOUT_MS,
    })
  } catch (error) {
    throw new Error(
      `e2e auth login failed: POST /api/auth/login to ${apiBaseUrl} did not complete ` +
        `(backend unreachable or hung): ${(error as Error).message}`,
    )
  }
  if (response.status() === 202) {
    throw new Error(
      'e2e auth login blocked: account requires TOTP (202 challenge). ' +
        'Seed a test account without TOTP for the happy path; TOTP coverage is a separate variant.',
    )
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (response.status() !== 200 || !isRecord(body) || body.ok !== true) {
    throw new Error(
      `e2e auth login failed: POST /api/auth/login answered ${response.status()} ` +
        `(${errorCodeOf(body)}); expected 200 with an ok envelope. ` +
        'A 401 means invalid credentials; a 429 means the login buckets or lockout engaged.',
    )
  }
}

/**
 * Probe the current session (GET /api/auth/me). 200 means
 * authenticated; 401/403 means unauthenticated (the same reading the
 * boot guard uses). Any other status throws a named error, because
 * the session state is then unknown rather than unauthenticated.
 */
export async function fetchSession(
  request: APIRequestContext,
  apiBaseUrl: string,
): Promise<SessionProbe> {
  let response
  try {
    response = await request.get(`${apiBaseUrl}/api/auth/me`, { timeout: SESSION_TIMEOUT_MS })
  } catch (error) {
    throw new Error(
      `e2e auth session probe failed: GET /api/auth/me to ${apiBaseUrl} did not complete ` +
        `(backend unreachable or hung): ${(error as Error).message}`,
    )
  }
  if (response.status() === 401 || response.status() === 403) {
    return { authenticated: false }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (response.status() !== 200 || !isRecord(body) || body.ok !== true || !isRecord(body.data)) {
    throw new Error(
      `e2e auth session probe failed: GET /api/auth/me answered ${response.status()} ` +
        `(${errorCodeOf(body)}); expected 200, 401, or 403. The session state is unknown.`,
    )
  }
  const data = body.data
  return {
    authenticated: true,
    email: typeof data.email === 'string' ? data.email : undefined,
    totpEnabled: typeof data.totpEnabled === 'boolean' ? data.totpEnabled : undefined,
  }
}

/**
 * Wait until the session probe reports authenticated, by observation
 * (expect.poll), never by a fixed sleep. The timeout bounds the wait;
 * expiry names the condition that was waited for.
 */
export async function waitForAuthenticatedSession(
  request: APIRequestContext,
  apiBaseUrl: string,
  timeoutMs = 10_000,
): Promise<void> {
  await expect
    .poll(async () => (await fetchSession(request, apiBaseUrl)).authenticated, {
      timeout: timeoutMs,
      message: `Waited for GET /api/auth/me at ${apiBaseUrl} to report an authenticated session.`,
    })
    .toBe(true)
}
