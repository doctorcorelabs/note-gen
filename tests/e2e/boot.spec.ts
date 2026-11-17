// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-01: boot without a backend. The boot guard blocks with an
// understandable error, not a blank page and not a blind redirect.
// Design: fase1/desain-pengujian.md section 4.2, as adapted in M16 to
// the boot guard contract (M14, src/lib/web/boot-guard.ts).
//
// The static harness server answers no /api/* route, so the session
// probe GET /api/auth/me returns 404 and the guard must report
// BOOT_SESSION_UNKNOWN: the session state is unknown, entry is
// blocked, and the screen offers a retry. This is the only E2E flow
// intended to pass against the current web build. It asserts, in
// order:
// 1. The two worker bundles are served with HTTP 200 (preflight).
// 2. Opening / does NOT navigate away: the URL stays at /.
// 3. The guard error screen is visible: role "alert", the
//    "Could not verify your session." heading, the BOOT_SESSION_UNKNOWN
//    detail code, and a "Try again" button. No "Sign in" button: the
//    unknown state offers retry only, never a sign-in claim.
// 4. The page has visible text and no error boundary text.
//
// Deliberately NOT asserted here: the authenticated redirect to
// /core/main and the file tree. Those live in boot-auth.spec.ts
// (E2E-01-auth), which uses the backend harness. Do not weaken the
// assertions below, which pin the fail-closed contract.

import { expect, test } from '@playwright/test'

import { assertWorkerBundlesServed } from './harness/preflight'
import { errorBoundaryText } from './harness/selectors'

test('E2E-01 @smoke boot without a backend: guard blocks with an understandable error, not a blank page', async ({
  page,
  request,
}) => {
  await test.step('worker bundles are served', async () => {
    await assertWorkerBundlesServed(request)
  })

  await test.step('open / and stay on the guard screen', async () => {
    await page.goto('/')
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(
      alert.getByRole('heading', { name: 'Could not verify your session.' }),
    ).toBeVisible()
    await expect(alert.getByText(/BOOT_SESSION_UNKNOWN/)).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Sign in' })).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
  })

  await test.step('page is not blank and has no error boundary text', async () => {
    await expect(errorBoundaryText(page)).toHaveCount(0)
    const bodyText = await page.locator('body').innerText()
    expect(
      bodyText.trim().length,
      'Boot produced a blank page: <body> has no visible text.',
    ).toBeGreaterThan(0)
  })
})

// E2E-01b: boot with a failing store endpoint shows an understandable
// error UI, not a blank page. This is a direct regression test for the
// unguarded Store.load in src/app/page.tsx (D1 finding).
//
// Status: LIVE (unskipped by W4-FLOWS). The variant pins the guard
// store-failure branch with Playwright route interception, following
// the boot-stall.spec.ts precedent: the session probe and both health
// probes answer healthy, and GET /api/settings answers 200 with a
// body that fails envelope/shape validation (a non-numeric
// revision), so the store loader throws and the guard must surface
// BOOT_STORE_UNAVAILABLE with the STORE_LOAD_FAILED detail. The app
// code under test is unmodified production code; only the network
// behavior is controlled.
//
// Precision note: this pins the guard branch for a FAILING STORE
// ENDPOINT (a corrupt wire response). True database-document
// corruption has no poison hook in the harness, and this spec does
// not claim to cover it. The distinction is recorded here so a green
// run is never read as proving more than the stubbed failure.
test('E2E-01b @smoke boot with corrupt store: understandable error UI, not a blank page', async ({
  page,
  request,
}) => {
  await test.step('worker bundles are served', async () => {
    await assertWorkerBundlesServed(request)
  })

  await test.step('corrupt settings response surfaces the store failure screen', async () => {
    let settingsObserved = false
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
    })
    await page.route('**/api/health/live', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
    })
    await page.route('**/api/health/ready', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
    })
    await page.route('**/api/settings', async (route) => {
      settingsObserved = true
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { revision: 'corrupt', settings: {} } }),
      })
    })

    await page.goto('/')
    const alert = page.locator('main [role="alert"]')
    await expect(alert).toBeVisible({ timeout: 30_000 })
    await expect(
      alert.getByRole('heading', { name: 'Could not load your settings.' }),
    ).toBeVisible()
    await expect(alert.getByText(/BOOT_STORE_UNAVAILABLE/)).toBeVisible()
    await expect(alert.getByText(/STORE_LOAD_FAILED/)).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
    expect(settingsObserved, 'the corrupt /api/settings stub never engaged').toBe(true)
  })

  await test.step('page is not blank and has no error boundary text', async () => {
    await expect(errorBoundaryText(page)).toHaveCount(0)
    const bodyText = await page.locator('body').innerText()
    expect(
      bodyText.trim().length,
      'Boot produced a blank page: <body> has no visible text.',
    ).toBeGreaterThan(0)
  })
})
