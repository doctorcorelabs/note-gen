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
// /core/main and the file tree. Those need a backend harness that
// answers /api/auth/me with 200 plus healthy /api/health/* responses,
// which has not landed (wave 3 owns the backend harness and seed
// wiring). Asserting them now would fail for a harness reason, not an
// app reason, and would hide the real boot signal. When the backend
// harness lands, add an authenticated variant of this flow that uses
// AppPage.gotoHome / expectBooted; do not weaken the assertions below,
// which pin the fail-closed contract.

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

// E2E-01b: boot with a corrupt store shows an understandable error UI,
// not a blank page. This is a direct regression test for the
// unguarded Store.load in src/app/page.tsx (D1 finding).
//
// Status: SKIPPED as documented debt, not passed and not failed. The
// harness cannot corrupt the store yet: in the web fork the store is
// served by the backend settings path, and no test hook exists to
// poison it before boot. Desain-pengujian 4.2 says exactly this:
// when the variant harness cannot be built in the MVP, its absence is
// recorded as debt, not treated as a pass. Unskip this test when the
// backend harness can seed a corrupt store; the steps below are the
// intended flow.
test.skip('E2E-01b @smoke boot with corrupt store: understandable error UI, not a blank page', async () => {
  // Intended steps (harness work required before unskipping):
  // 1. Seed a corrupt store through the backend test harness.
  // 2. Open / and wait for the error UI (not the tree, not blank).
  // 3. Assert an error message is visible and the page has text.
  // 4. Assert the app does not hang: the error UI appears within the
  //    default expect timeout.
})
