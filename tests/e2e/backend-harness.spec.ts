// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-HARNESS: backend harness smoke check. Proves, end to end on a
// machine with Postgres, that one test gets an isolated backend, a
// gateway, a session, and the seed data: the gateway serves the
// static export, proxies /api/* to the test backend, the session
// probe reports authenticated, the seed files are on disk in the
// test workspace, and the seeded records read back through the kind
// layer with their sourceIds intact.
//
// Tag @harness, NOT @smoke: this spec checks the harness itself, not
// one of the six user flows in desain-pengujian 4.2, and it must
// never count toward the 6/6 smoke gate. Run it only where the
// harness prerequisites exist (built server, server dependencies,
// E2E_PG_ADMIN_URL, reachable scratch cluster); without them the
// fixture fails honestly with a named error. See
// tests/e2e/README.md, section "Backend harness".
//
// Deliberately NOT asserted here: any user-flow UI behavior (tree,
// editor, search). Those assertions belong to the six @smoke flows
// once they convert to real steps; this spec only proves the ground
// they will stand on. The single browser step below asserts only
// that the page loads with visible content at the gateway origin.

import { expect } from '@playwright/test'

import { fetchSession } from './harness/auth'
import { backendTest as test } from './harness/backend-fixture'
import { SEED_CONTENTS } from './harness/seed'
import { RECORD_SEEDS, SEARCH_TERMS } from './harness/seed-data'
import { fetchCsrfToken } from './harness/seed-records'

test('E2E-HARNESS @harness backend harness: gateway, session, seed files, and kind seed read back', async ({
  backend,
  page,
}) => {
  await test.step('gateway serves the static export and proxies the API', async () => {
    const bundle = await page.request.get(`${backend.pageUrl}/markdown-lexer.js?v=4`)
    expect(bundle.ok()).toBe(true)
    const live = await page.request.get(`${backend.pageUrl}/api/health/live`)
    expect(live.status()).toBe(200)
    const ready = await page.request.get(`${backend.pageUrl}/api/health/ready`)
    expect(ready.status()).toBe(200)
    const readyBody: unknown = await ready.json().catch(() => undefined)
    expect(
      typeof readyBody === 'object' && readyBody !== null && (readyBody as { ok?: unknown }).ok,
    ).toBe(true)
  })

  await test.step('session probe reports authenticated', async () => {
    const probe = await fetchSession(page.request, backend.pageUrl)
    expect(probe.authenticated).toBe(true)
    expect(probe.totpEnabled).not.toBe(true)
  })

  await test.step('seed files are on disk in the test workspace', async () => {
    const content = await backend.readWorkspaceFile(SEARCH_TERMS.uniqueTermFile)
    expect(content).toBe(SEED_CONTENTS.gettingStarted)
  })

  await test.step('seeded records read back through the kind layer', async () => {
    const csrfToken = await fetchCsrfToken(page.request, backend.pageUrl)
    const response = await page.request.post(`${backend.pageUrl}/api/db/batch`, {
      data: { operations: [{ kind: 'marks.list' }] },
      headers: {
        Origin: backend.pageUrl,
        'X-CSRF-Token': csrfToken,
      },
    })
    expect(response.status()).toBe(200)
    const body: unknown = await response.json().catch(() => undefined)
    const results =
      typeof body === 'object' && body !== null && typeof (body as { data?: unknown }).data === 'object'
        ? ((body as { data: { results?: unknown } }).data.results as unknown)
        : undefined
    expect(Array.isArray(results)).toBe(true)
    const rows = (results as Array<{ rows?: unknown }>)[0]?.rows
    expect(Array.isArray(rows)).toBe(true)
    const foundSourceIds = new Set(
      (rows as Array<{ sourceId?: unknown }>).map((row) => row.sourceId),
    )
    for (const seed of RECORD_SEEDS) {
      expect(foundSourceIds.has(seed.sourceId)).toBe(true)
    }
    expect((rows as unknown[]).length).toBe(RECORD_SEEDS.length)
  })

  await test.step('browser loads the app at the gateway origin', async () => {
    await page.goto(`${backend.pageUrl}/`)
    await expect(page.locator('body')).not.toBeEmpty()
  })
})
