// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-01: boot. The application opens and is not a blank page.
// Design: fase1/desain-pengujian.md section 4.2.
//
// This is the only E2E flow intended to pass against the current web
// build. It asserts, in order:
// 1. The two worker bundles are served with HTTP 200 (preflight).
// 2. Opening / redirects to /core/main (the redirect target in
//    src/app/page.tsx for desktop, via the Store shim).
// 3. The file tree (role "tree", name "Workspace files") is visible.
// 4. The page has visible text and no error boundary text.
//
// Deliberately NOT asserted here: a specific seed entry in the tree.
// Seed wiring (telling the app which directory is the workspace for a
// test run) has not landed, so no seed entry can be expected yet.
// See tests/e2e/harness/seed.ts and tests/e2e/README.md. Asserting a
// seed entry now would fail for a harness reason, not an app reason,
// and would hide the real boot signal.

import { expect, test } from '@playwright/test'

import { AppPage } from './harness/app-page'
import { assertWorkerBundlesServed } from './harness/preflight'
import { fileTree } from './harness/selectors'

test('E2E-01 @smoke boot: app opens at /core/main with the file tree visible', async ({
  page,
  request,
}) => {
  const app = new AppPage(page)

  await test.step('worker bundles are served', async () => {
    await assertWorkerBundlesServed(request)
  })

  await test.step('open / and follow the boot redirect', async () => {
    await app.gotoHome()
    await expect(page).toHaveURL(/\/core\/main/)
  })

  await test.step('file tree is visible and page is not blank', async () => {
    await expect(fileTree(page)).toBeVisible()
    await app.expectBooted()
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
