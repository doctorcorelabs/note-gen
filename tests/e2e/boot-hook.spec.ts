// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Browser evidence for hook H1 (W4-HOOK, AD-112): the flag-gated
// boot proof hook in src/app/core/layout.tsx. This spec proves the
// hook IN THE BROWSER, not only by unit test:
//
// - With the flag, the hook writes window.__notegenBootProof
//   ({ ok: true, rows: N } on success, { ok: false } on failure),
//   and the browser issues a POST /api/db/batch carrying the
//   X-CSRF-Token header with a marks.list operation in its body.
// - Without the flag, the hook value is undefined after boot
//   settles: the hook block does nothing and boot is unchanged.
//
// Canonical invocation (W4-FLOWS finding, proposed to the
// integrator): the flagged DEEP LINK `/core/main?e2e-boot-proof=1`.
// The boot guard redirect from `/` to `/core/main` is path-only
// (resolveRedirectTarget in src/lib/web/boot-guard.ts returns a bare
// path), so a flag carried on `/?e2e-boot-proof=1` is LOST before
// the core layout mounts and the hook never fires. A spec that
// navigates through `/` with the flag proves nothing about the
// hook; it proves only that the redirect strips the query. This
// spec therefore navigates directly to the flagged deep link, with
// an authenticated session already established by the fixture, so
// no guard redirect intervenes. No product change is proposed: the
// deep-link form is the test invocation, and the redirect behavior
// is the shipped guard design.
//
// Tag: @harness. The hook proof belongs with the harness specs
// (backend-harness, boot-sql-proof) because it pins a harness-only
// test path, not a user flow.

import { backendTest, expect } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'

interface BootProofValue {
  ok: boolean
  rows?: number
}

async function readBootProof(page: import('@playwright/test').Page): Promise<BootProofValue | undefined> {
  return page.evaluate(() => {
    const target = window as unknown as { __notegenBootProof?: BootProofValue }
    return target.__notegenBootProof
  })
}

backendTest(
  'E2E-HOOK @harness boot proof hook: flagged deep link writes the proof value and issues a CSRF-carrying batch POST',
  async ({ backend, page }) => {
    const batchRequests: Array<{ hasCsrf: boolean; body: string }> = []
    page.on('request', (request) => {
      if (request.url().endsWith('/api/db/batch') && request.method() === 'POST') {
        batchRequests.push({
          hasCsrf: request.headers()['x-csrf-token'] !== undefined,
          body: request.postData() ?? '',
        })
      }
    })

    await page.goto(`${backend.pageUrl}/core/main?e2e-boot-proof=1`)
    await page.waitForURL((url) => url.pathname === '/core/main', { timeout: 30_000 })
    await new AppPage(page).expectBooted()

    await expect
      .poll(async () => readBootProof(page), {
        timeout: 30_000,
        message: 'window.__notegenBootProof was never written after the flagged boot.',
      })
      .toEqual({ ok: true, rows: 1 })

    const csrfBatch = batchRequests.find((entry) => entry.hasCsrf)
    expect(csrfBatch, 'no browser POST /api/db/batch carried an X-CSRF-Token header').toBeDefined()
    const marksListBatch = batchRequests.find((entry) => entry.body.includes('marks.list'))
    expect(
      marksListBatch,
      'no browser POST /api/db/batch carried a marks.list operation in its body',
    ).toBeDefined()
  },
)

backendTest(
  'E2E-HOOK-NOFLAG @harness boot proof hook: unflagged boot leaves the proof value undefined',
  async ({ backend, page }) => {
    const app = new AppPage(page)
    const settingsResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/settings') && response.status() === 200,
      { timeout: 30_000 },
    )
    await app.gotoHome(backend.pageUrl)
    await settingsResponse
    await app.expectBooted()

    // A single read after boot settles: the hook must never fire
    // without the flag, so polling for a value would be wrong.
    // Settling is defined by the observations above (shell URL,
    // settings 200, tree visible), not by a sleep.
    const proof = await readBootProof(page)
    expect(proof, 'the boot proof hook fired without the flag').toBeUndefined()
  },
)
