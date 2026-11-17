// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Record and tag seeding through the kind layer (D-3D-1).
//
// REST routes POST /api/marks and POST /api/tags EXIST on trunk
// since W4-WIRE (AD-122 S5-Q2); the kind surface remains alongside
// them. This seeder keeps using the kind layer by design: it is the
// path the shipped inbox client uses
// (src/lib/web/records-kind-client.ts), and the kind operations
// below are the ones whose affected/id semantics the fixture
// asserts. The live data path used here is POST /api/transactions
// with kind operations (kontrak-api-kanonis.md section 3.4).
// This seeder calls exactly that endpoint with exactly these kinds:
// tags.create, then marks.create. It never invents a REST route.
//
// Transport rules, all taken from the live code:
// - The request context must already hold a session cookie: the
//   caller logs in first through harness/auth.ts loginViaApi with
//   page.request, so the browser context is authenticated too.
// - POST /api/transactions is a session mutation, so it needs the
//   X-CSRF-Token header (GET /api/auth/csrf, session cookie only)
//   and an Origin header equal to the API origin, matching the
//   global auth hook (server/src/middleware/auth-hook.ts).
// - The body must be exactly { operations } with 1 to 50 entries
//   (server/src/services/db/validation.ts); the response envelope
//   carries results in request order, each { kind, affected, id? }.
// - tags.create answers affected 1 for a new tag and affected 0
//   with the existing id for a taken name
//   (server/src/services/db/tags-create.ts). On a fresh scratch
//   database affected 0 means the database was reused: the seeder
//   treats it as an isolation leak and fails with a named error
//   instead of seeding over someone else's data. marks.create
//   behaves the same way for a repeated sourceId
//   (server/src/services/db/marks-create.ts, first-write-wins).
// - marks.create needs a primary tag: mark.tagId plus tagIds. Each
//   seed record in harness/seed-data.ts carries exactly one tag
//   name, so the primary tag is unambiguous. A record with zero or
//   several tag names, or with an unknown tag name, is refused
//   here rather than guessed.
//
// LIVE STATUS: PROVEN. Live runs exercise this module at every
// merge gate on muse-2 (the @harness specs read the seeds back)
// and in every backendTest flow since; the W4-FLOWS conversion
// runs on trunk 3b9a8809 re-proved it (see
// laporan-3e-w4-flows-r12.md for tallies).

import type { APIRequestContext } from '@playwright/test'

import { apiOrigin } from './auth'
import { RECORD_SEEDS, TAG_SEEDS, type RecordSeed } from './seed-data'

const CSRF_TIMEOUT_MS = 10_000
const TRANSACTION_TIMEOUT_MS = 10_000

export interface KindOperation {
  kind: string
  [key: string]: unknown
}

export interface KindResult {
  kind: string
  affected: number
  id?: number | string
  version?: number
}

export interface SeededTagsAndRecords {
  tagIdsByName: Map<string, number>
  recordIds: number[]
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

/** Pure builder: one tags.create operation per seed tag, in order. */
export function buildTagOperations(): KindOperation[] {
  return TAG_SEEDS.map((tag) => ({ kind: 'tags.create', name: tag.name }))
}

/**
 * Pure builder: one marks.create operation per seed record. Tag
 * names must already be resolved to ids; the single tag of each
 * record becomes both the primary tag and the full tag set.
 * Throws a named error on an ambiguous or unresolvable record
 * instead of guessing a primary tag.
 */
export function buildMarkOperations(tagIdsByName: Map<string, number>): KindOperation[] {
  return RECORD_SEEDS.map((record: RecordSeed) => {
    if (record.tagNames.length !== 1) {
      throw new Error(
        `e2e seed record is not valid: record ${record.sourceId} must carry exactly one tag name ` +
          'so its primary tag is unambiguous.',
      )
    }
    const tagName = record.tagNames[0]
    const tagId = tagIdsByName.get(tagName)
    if (tagId === undefined) {
      throw new Error(
        `e2e seed record is not valid: record ${record.sourceId} names unknown tag "${tagName}".`,
      )
    }
    return {
      kind: 'marks.create',
      mark: {
        tagId,
        type: 'text',
        content: record.content,
        desc: record.desc,
        url: '',
        sourceId: record.sourceId,
      },
      tagIds: [tagId],
    }
  })
}

/**
 * Fetch the CSRF token for the current session (GET /api/auth/csrf).
 * The token lives only in memory; it is never logged. Throws a named
 * error on any non-200 response or a malformed body.
 */
export async function fetchCsrfToken(
  request: APIRequestContext,
  apiBaseUrl: string,
): Promise<string> {
  let response
  try {
    response = await request.get(`${apiBaseUrl}/api/auth/csrf`, { timeout: CSRF_TIMEOUT_MS })
  } catch (error) {
    throw new Error(
      `e2e seed CSRF fetch failed: GET /api/auth/csrf to ${apiBaseUrl} did not complete ` +
        `(backend unreachable or hung): ${(error as Error).message}`,
    )
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (response.status() !== 200 || !isRecord(body) || body.ok !== true || !isRecord(body.data)) {
    throw new Error(
      `e2e seed CSRF fetch failed: GET /api/auth/csrf answered ${response.status()} ` +
        `(${errorCodeOf(body)}); expected 200 with an ok envelope. A 401 means the session is missing.`,
    )
  }
  const token = body.data.csrfToken
  if (typeof token !== 'string' || token === '') {
    throw new Error('e2e seed CSRF fetch failed: 200 response carries no csrfToken string.')
  }
  return token
}

/**
 * Run one kind transaction (POST /api/transactions) and return the
 * results in request order. Asserts the success envelope and the
 * result shape; any other answer is a named error with status and
 * wire code.
 */
export async function runKindTransaction(
  request: APIRequestContext,
  apiBaseUrl: string,
  csrfToken: string,
  operations: KindOperation[],
): Promise<KindResult[]> {
  if (operations.length === 0 || operations.length > 50) {
    throw new Error('e2e seed transaction is not valid: operations must number 1 to 50.')
  }
  let response
  try {
    response = await request.post(`${apiBaseUrl}/api/transactions`, {
      data: { operations },
      headers: {
        Origin: apiOrigin(apiBaseUrl),
        'X-CSRF-Token': csrfToken,
      },
      timeout: TRANSACTION_TIMEOUT_MS,
    })
  } catch (error) {
    throw new Error(
      `e2e seed transaction failed: POST /api/transactions to ${apiBaseUrl} did not complete ` +
        `(backend unreachable or hung): ${(error as Error).message}`,
    )
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (response.status() !== 200 || !isRecord(body) || body.ok !== true || !isRecord(body.data)) {
    throw new Error(
      `e2e seed transaction failed: POST /api/transactions answered ${response.status()} ` +
        `(${errorCodeOf(body)}); expected 200 with an ok envelope.`,
    )
  }
  const results = body.data.results
  if (!Array.isArray(results) || results.length !== operations.length) {
    throw new Error(
      'e2e seed transaction failed: 200 response carries no results array matching the operations.',
    )
  }
  return results.map((entry, index) => {
    if (
      !isRecord(entry) ||
      entry.kind !== operations[index]?.kind ||
      typeof entry.affected !== 'number'
    ) {
      throw new Error(
        `e2e seed transaction failed: result ${index} does not match operation kind ` +
          `${operations[index]?.kind} with a numeric affected count.`,
      )
    }
    return {
      kind: entry.kind as string,
      affected: entry.affected,
      ...(typeof entry.id === 'number' || typeof entry.id === 'string' ? { id: entry.id } : {}),
      ...(typeof entry.version === 'number' ? { version: entry.version } : {}),
    }
  })
}

function createdId(result: KindResult, what: string): number {
  if (result.affected !== 1) {
    throw new Error(
      `e2e seed isolation leak: ${what} answered affected ${result.affected} on a fresh scratch ` +
        'database; the database was reused or the seed ran twice. Seeding refuses to continue.',
    )
  }
  const id = typeof result.id === 'string' ? Number(result.id) : result.id
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error(`e2e seed failed: ${what} did not return an integer id.`)
  }
  return id
}

/**
 * Seed the 2 tags and 5 records from harness/seed-data.ts through
 * the kind layer: tags first (one transaction), then records (one
 * transaction, after resolving tag names to ids). The request
 * context must already be authenticated; pass page.request so the
 * browser context keeps the session.
 */
export async function seedTagsAndRecords(
  request: APIRequestContext,
  apiBaseUrl: string,
): Promise<SeededTagsAndRecords> {
  const csrfToken = await fetchCsrfToken(request, apiBaseUrl)
  const tagResults = await runKindTransaction(request, apiBaseUrl, csrfToken, buildTagOperations())
  const tagIdsByName = new Map<string, number>()
  tagResults.forEach((result, index) => {
    const name = TAG_SEEDS[index]?.name
    if (name === undefined) {
      throw new Error('e2e seed failed: tag result has no matching seed tag.')
    }
    tagIdsByName.set(name, createdId(result, `tags.create for "${name}"`))
  })
  const markResults = await runKindTransaction(
    request,
    apiBaseUrl,
    csrfToken,
    buildMarkOperations(tagIdsByName),
  )
  const recordIds = markResults.map((result, index) =>
    createdId(result, `marks.create for ${RECORD_SEEDS[index]?.sourceId ?? `record ${index}`}`),
  )
  return { tagIdsByName, recordIds }
}
