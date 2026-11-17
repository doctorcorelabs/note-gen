// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// BOOT-STALL: boot stall proofs for gate A5 (wave 4, mitigations M1/M2
// for F1-59). Before this spec, no test in the tree delayed, hung, or
// failed any boot wait: the timeout paths existed only as code, never
// observed in a browser (gate A5 CELAH-1, CELAH-2, CELAH-3). Each test
// below stalls exactly one boot wait with Playwright route
// interception and asserts the visible failure screen the app must
// show when its budget expires:
//
//   1. SESSION: a hung GET /api/auth/me must surface as
//      BOOT_SESSION_UNKNOWN with the SESSION_TIMEOUT detail (probe
//      budget 5s, src/lib/web/session-check.ts).
//   2. GUARD: a hung GET /api/health/live after a healthy session
//      probe must surface as BOOT_TIMEOUT with GUARD_TIMEOUT (guard
//      budget 15s, src/lib/web/boot-guard.ts).
//   3. I18N-HANG: hung message catalog chunks must surface as
//      BOOT_I18N_TIMEOUT (catalog budget 15s, mitigation M1 in
//      src/components/providers/NextIntlProvider.tsx).
//   4. I18N-ABORT: failed message catalog chunks must surface as
//      BOOT_I18N_FAILED (same provider, rejection path).
//   5. NAV: a hung /core/main RSC payload after a passing guard must
//      surface as BOOT_NAVIGATION_TIMEOUT (navigation budget 30s,
//      mitigation M2 in src/app/page.tsx).
//
// Honesty notes, read before trusting a green run:
//
// - Route interception simulates a hung or failing server; the app
//   code under test is unmodified production code from the static
//   export. Only the network behavior is controlled, which is
//   exactly the variable a stall proof must control.
// - The faked API answers in the GUARD and NAV cases use the shapes
//   the shipped clients require (session envelope ok true, health
//   envelopes ok true, settings envelope with a numeric revision
//   and a settings record). They prove the app waits visibly, not
//   that a real backend answers: backend behavior is proven by the
//   @harness specs over a live backend.
// - The catalog chunk scan reads the built export on disk and finds
//   the chunks carrying catalog values (a distinctive en value and
//   its zh counterpart). Chunk file names are build hashes and are
//   never hardcoded. If no catalog chunk is found, the spec fails
//   with a named error instead of passing vacuously. The scan
//   honors E2E_STATIC_DIR when set, matching the static server.
// - Every stall test also asserts the stalled request was actually
//   observed (or, for the probe/guard cases, the detail code that
//   only the timeout path produces), so a green run cannot come
//   from interception that never engaged.
// - Timeouts in this file only bound a hung run; the assertions are
//   the visible screens and the stable detail codes, never elapsed
//   time. The NAV case sets a 120 second test timeout because its
//   30 second app budget runs after hydration and the guard on a
//   loaded machine.
//
// Tag @stall, NOT @smoke and NOT @harness: these specs prove boot
// failure visibility, not a user flow and not backend ground, and
// must never count toward the 6/6 smoke gate. Run them with:
//
//   pnpm exec playwright test tests/e2e/boot-stall.spec.ts --grep @stall
//
// Prerequisites are the static-export prerequisites (a full
// `pnpm build` first; the config webServer serves out/). No
// backend, database, or session fixture is needed.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type Page, type Route } from '@playwright/test'

import { assertWorkerBundlesServed } from './harness/preflight'

// Distinctive catalog VALUES (not key names: key names also appear
// in code chunks). Verified against the trunk build: each value
// appears in exactly one chunk, the pure catalog chunk for its
// locale. The fallback load always fetches the zh catalog first,
// so stalling the zh chunk alone stalls the gate; both chunks are
// stalled so the proof does not depend on load order.
const EN_CATALOG_MARKER = 'Agent change navigation'
const ZH_CATALOG_MARKER = 'Agent 改动导航'

let cachedCatalogChunkNames: string[] | null = null

function findCatalogChunkNames(): string[] {
  if (cachedCatalogChunkNames !== null) {
    return cachedCatalogChunkNames
  }
  const staticDir = process.env.E2E_STATIC_DIR ?? join(process.cwd(), 'out')
  const chunkDir = join(staticDir, '_next', 'static', 'chunks')
  if (!existsSync(chunkDir)) {
    throw new Error(
      'stall spec: chunk directory not found at ' +
        `${chunkDir}. Run a full "pnpm build" first so the static export exists.`,
    )
  }
  const names: string[] = []
  for (const entry of readdirSync(chunkDir)) {
    if (!entry.endsWith('.js')) {
      continue
    }
    const text = readFileSync(join(chunkDir, entry), 'utf8')
    if (text.includes(EN_CATALOG_MARKER) || text.includes(ZH_CATALOG_MARKER)) {
      names.push(entry)
    }
  }
  if (names.length === 0) {
    throw new Error(
      'stall spec: no message catalog chunk found in ' +
        `${chunkDir}. The catalog markers no longer match the built ` +
        'chunks; update the markers, do not skip this spec.',
    )
  }
  cachedCatalogChunkNames = names
  return names
}

/** A route handler that never answers: the request hangs in the browser. */
async function hangForever(): Promise<never> {
  return new Promise<never>(() => {})
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function stallCatalogChunks(page: Page, mode: 'hang' | 'abort'): Promise<string[]> {
  const names = findCatalogChunkNames()
  for (const name of names) {
    if (mode === 'hang') {
      await page.route(`**/_next/static/chunks/${name}`, hangForever)
    } else {
      await page.route(`**/_next/static/chunks/${name}`, async (route) => {
        await route.abort('failed')
      })
    }
  }
  return names
}

function watchRequestsFor(page: Page, names: string[]): Set<string> {
  const seen = new Set<string>()
  page.on('request', (request) => {
    const url = request.url()
    for (const name of names) {
      if (url.includes(name)) {
        seen.add(name)
      }
    }
  })
  return seen
}

test('BOOT-STALL-SESSION @stall stalled session probe: visible BOOT_SESSION_UNKNOWN with SESSION_TIMEOUT', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  await test.step('worker bundles are served', async () => {
    await assertWorkerBundlesServed(request)
  })

  await test.step('stall the session probe and observe the visible timeout failure', async () => {
    await page.route('**/api/auth/me', hangForever)
    await page.goto('/')
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible({ timeout: 30_000 })
    await expect(
      alert.getByRole('heading', { name: 'Could not verify your session.' }),
    ).toBeVisible()
    // SESSION_TIMEOUT is the detail only the probe timeout path
    // produces: a fast 404 would carry SESSION_ENDPOINT_MISSING
    // instead, so this assertion proves the timeout ran.
    await expect(alert.getByText(/SESSION_TIMEOUT/)).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
  })
})

test('BOOT-STALL-GUARD @stall stalled health probe after a healthy session: visible BOOT_TIMEOUT', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  await test.step('worker bundles are served', async () => {
    await assertWorkerBundlesServed(request)
  })

  await test.step('stall the liveness probe and observe the visible guard timeout', async () => {
    await page.route('**/api/auth/me', async (route) => {
      await fulfillJson(route, 200, { ok: true })
    })
    await page.route('**/api/health/live', hangForever)
    await page.goto('/')
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible({ timeout: 30_000 })
    await expect(
      alert.getByRole('heading', { name: 'NoteGen is taking too long to start.' }),
    ).toBeVisible()
    await expect(alert.getByText(/BOOT_TIMEOUT/)).toBeVisible()
    await expect(alert.getByText(/GUARD_TIMEOUT/)).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
  })
})

test('BOOT-STALL-I18N-HANG @stall hung catalog chunks: visible BOOT_I18N_TIMEOUT, never a blank page', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  await test.step('worker bundles are served', async () => {
    await assertWorkerBundlesServed(request)
  })

  await test.step('stall the catalog chunks and observe the visible catalog timeout', async () => {
    const names = await stallCatalogChunks(page, 'hang')
    const seen = watchRequestsFor(page, names)
    await page.goto('/')
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible({ timeout: 30_000 })
    await expect(
      alert.getByRole('heading', { name: 'Could not load the language.' }),
    ).toBeVisible()
    await expect(alert.getByText(/BOOT_I18N_TIMEOUT/)).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
    expect(
      seen.size,
      'No catalog chunk was ever requested: the stall never engaged, so the error screen proves nothing.',
    ).toBeGreaterThanOrEqual(1)
  })
})

test('BOOT-STALL-I18N-ABORT @stall failed catalog chunks: visible BOOT_I18N_FAILED', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  await test.step('worker bundles are served', async () => {
    await assertWorkerBundlesServed(request)
  })

  await test.step('fail the catalog chunks and observe the visible catalog failure', async () => {
    const names = await stallCatalogChunks(page, 'abort')
    const seen = watchRequestsFor(page, names)
    await page.goto('/')
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible({ timeout: 30_000 })
    await expect(
      alert.getByRole('heading', { name: 'Could not load the language.' }),
    ).toBeVisible()
    await expect(alert.getByText(/BOOT_I18N_FAILED/)).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
    expect(
      seen.size,
      'No catalog chunk was ever requested: the failure never engaged, so the error screen proves nothing.',
    ).toBeGreaterThanOrEqual(1)
  })
})

test('BOOT-STALL-NAV @stall hung navigation payload after a passing guard: visible BOOT_NAVIGATION_TIMEOUT', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  await test.step('worker bundles are served', async () => {
    await assertWorkerBundlesServed(request)
  })

  await test.step('pass the guard, stall the navigation, and observe the visible navigation timeout', async () => {
    await page.route('**/api/auth/me', async (route) => {
      await fulfillJson(route, 200, { ok: true })
    })
    await page.route('**/api/health/live', async (route) => {
      await fulfillJson(route, 200, { ok: true })
    })
    await page.route('**/api/health/ready', async (route) => {
      await fulfillJson(route, 200, { ok: true })
    })
    await page.route('**/api/settings', async (route) => {
      await fulfillJson(route, 200, { ok: true, data: { revision: 1, settings: {} } })
    })
    const rscRequests: string[] = []
    page.on('request', (requestEvent) => {
      if (new URL(requestEvent.url()).pathname === '/core/main.txt') {
        rscRequests.push(requestEvent.url())
      }
    })
    await page.route(
      (url) => url.pathname === '/core/main.txt',
      hangForever,
    )
    await page.goto('/')
    // The redirecting label proves the guard passed and the
    // navigation started; without it, a later error screen could
    // be mistaken for a guard failure.
    await expect(page.getByText('Opening your workspace...')).toBeVisible({ timeout: 30_000 })
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible({ timeout: 45_000 })
    await expect(
      alert.getByRole('heading', { name: 'NoteGen is taking too long to open your workspace.' }),
    ).toBeVisible()
    await expect(alert.getByText(/BOOT_NAVIGATION_TIMEOUT/)).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
    expect(
      rscRequests.length,
      'No /core/main.txt request was ever observed: the navigation stall never engaged.',
    ).toBeGreaterThanOrEqual(1)
  })
})
