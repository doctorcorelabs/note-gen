// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Settings API helpers for E2E flows (kontrak-api-kanonis.md
// section 3.2): GET /api/settings and PATCH /api/settings through a
// Playwright APIRequestContext. These helpers drive the HTTP API
// only; they never drive the Settings UI. Use them when the flow
// under test IS settings persistence itself (E2E-06) and the
// setting has no UI control, as darkMode does (AD-113, AD-123
// (11)): the flow writes through the API, reloads the browser, and
// reads back through the API. No helper here claims a UI read-back.
//
// Wire shapes (server/src/routes/settings.ts,
// server/src/services/settings/validation.ts):
// - GET answers the success envelope { ok: true, data: { revision,
//   settings } }; revision is a number, settings is a record.
// - PATCH requires a body { baseRevision, settings }; a stale
//   baseRevision answers 409 revision_conflict. The success data
//   carries { revision, applied, rejected }; applied/rejected are
//   arrays. PATCH is a session mutation, so it needs the
//   X-CSRF-Token header (GET /api/auth/csrf) and an Origin header
//   equal to the API origin, matching the global auth hook.
// - Values are never logged. Errors name the status and wire code
//   only, never a settings value.
//
// Anti-flaky rules (desain-pengujian 4.3): request timeouts below
// are hang bounds, not sleeps; a timeout produces a named error
// that says which call hung.

import type { APIRequestContext } from '@playwright/test'

import { apiOrigin } from './auth'

const SETTINGS_TIMEOUT_MS = 10_000

export interface SettingsDocument {
  revision: number
  settings: Record<string, unknown>
}

export interface PatchSettingsResult {
  revision: number
  applied: string[]
  rejected: Array<{ key: string; reason: string }>
}

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
 * Read the settings document (GET /api/settings). The request
 * context must already hold a session cookie. Throws a named error
 * on any non-200 response or a malformed envelope.
 */
export async function getSettingsDocument(
  request: APIRequestContext,
  apiBaseUrl: string,
): Promise<SettingsDocument> {
  let response
  try {
    response = await request.get(`${apiBaseUrl}/api/settings`, { timeout: SETTINGS_TIMEOUT_MS })
  } catch (error) {
    throw new Error(
      `e2e settings read failed: GET /api/settings to ${apiBaseUrl} did not complete ` +
        `(backend unreachable or hung): ${(error as Error).message}`,
    )
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (response.status() !== 200 || !isRecord(body) || body.ok !== true || !isRecord(body.data)) {
    throw new Error(
      `e2e settings read failed: GET /api/settings answered ${response.status()} ` +
        `(${errorCodeOf(body)}); expected 200 with an ok envelope.`,
    )
  }
  const data = body.data
  if (typeof data.revision !== 'number' || !isRecord(data.settings)) {
    throw new Error(
      'e2e settings read failed: 200 response carries no numeric revision and settings record.',
    )
  }
  return { revision: data.revision, settings: data.settings }
}

/**
 * Patch settings (PATCH /api/settings) with the baseRevision guard.
 * The caller supplies a fresh CSRF token (fetchCsrfToken in
 * ./seed-records.ts) and the baseRevision read from the document
 * being patched. Throws a named error on any non-200 response,
 * including 409 revision_conflict: a stale guard is a test failure
 * here, not a retry, because the flow owns the document.
 */
export async function patchSettingsDocument(
  request: APIRequestContext,
  apiBaseUrl: string,
  csrfToken: string,
  baseRevision: number,
  settings: Record<string, unknown>,
): Promise<PatchSettingsResult> {
  let response
  try {
    response = await request.patch(`${apiBaseUrl}/api/settings`, {
      data: { baseRevision, settings },
      headers: {
        Origin: apiOrigin(apiBaseUrl),
        'X-CSRF-Token': csrfToken,
      },
      timeout: SETTINGS_TIMEOUT_MS,
    })
  } catch (error) {
    throw new Error(
      `e2e settings patch failed: PATCH /api/settings to ${apiBaseUrl} did not complete ` +
        `(backend unreachable or hung): ${(error as Error).message}`,
    )
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (response.status() !== 200 || !isRecord(body) || body.ok !== true || !isRecord(body.data)) {
    throw new Error(
      `e2e settings patch failed: PATCH /api/settings answered ${response.status()} ` +
        `(${errorCodeOf(body)}); expected 200 with an ok envelope. ` +
        'A 409 means the baseRevision guard fired on a stale revision.',
    )
  }
  const data = body.data
  if (
    typeof data.revision !== 'number' ||
    !Array.isArray(data.applied) ||
    !Array.isArray(data.rejected)
  ) {
    throw new Error(
      'e2e settings patch failed: 200 response carries no revision plus applied/rejected arrays.',
    )
  }
  const applied = data.applied.filter((entry): entry is string => typeof entry === 'string')
  if (applied.length !== data.applied.length) {
    throw new Error('e2e settings patch failed: applied array carries a non-string entry.')
  }
  const rejected: Array<{ key: string; reason: string }> = []
  for (const entry of data.rejected) {
    if (isRecord(entry) && typeof entry.key === 'string' && typeof entry.reason === 'string') {
      rejected.push({ key: entry.key, reason: entry.reason })
    } else {
      throw new Error('e2e settings patch failed: rejected array carries a malformed entry.')
    }
  }
  return { revision: data.revision, applied, rejected }
}
