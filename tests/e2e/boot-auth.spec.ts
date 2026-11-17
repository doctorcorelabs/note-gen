// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-01-auth: authenticated boot. The app opens at /, redirects to
// /core/main, and shows the file tree with seed entries, a non-blank
// page, and no error boundary text. Design: fase1/desain-pengujian.md
// section 4.2 (E2E-01), as split by the 3D e2e-prep extension: the
// no-backend fail-closed boot stays pinned in boot.spec.ts (E2E-01),
// and this spec is the authenticated half of the same flow, which is
// the boot gate A3 actually needs (rencana-gelombang3 4.3). This
// spec closes CELAH-4 (A5 sub-criterion 2) under AD-113.
//
// Status: LIVE (converted by W4-FLOWS). The backend harness proved
// live runs at the merge gates (2 @harness specs green) and in the
// W4-FLOWS conversion runs; see laporan-3e-w4-flows-r12.md.
//
// Steps:
// 1. The backend fixture (harness/backend-fixture.ts) boots a fresh
//    backend + gateway per test, seeds the workspace
//    (harness/seed.ts) and the tags/records (harness/seed-records.ts),
//    and establishes the session through the API (harness/auth.ts).
//    Credentials are generated per backend and live in memory only.
// 2. Open / at the fixture gateway origin through AppPage.gotoHome
//    and wait for the redirect to /core/main by URL observation,
//    never by a fixed sleep. The gateway origin is a required
//    parameter: navigating to a bare `/` resolves against the
//    static-only config baseURL and always lands on the guard
//    screen (finding T-8).
// 3. Assert AppPage.expectBooted: the file tree is visible, the page
//    has visible text, and no error boundary text appears.
// 4. Expand the seed folder and assert the seed entry
//    (getting-started.md) appears in the tree. The tree starts
//    collapsed (W4-FLOWS probe: only the "notes" folder row renders
//    before expansion), so the seed assertion needs the expansion
//    click plus an observation wait for the child row.
// 5. Assert the session endpoint answered 200 from the browser: the
//    boot guard probes /api/auth/me before redirecting, so reaching
//    /core/main already proves it, and the explicit response
//    observation makes the proof readable in the trace.

import { backendTest, expect } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'
import { fileTreeItemByName } from './harness/selectors'
import { SEARCH_TERMS } from './harness/seed-data'

backendTest(
  'E2E-01-auth @smoke authenticated boot: redirect to /core/main with the file tree visible',
  async ({ backend, page }) => {
    const authMeResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/auth/me') && response.status() === 200,
      { timeout: 30_000 },
    )
    const app = new AppPage(page)
    await app.gotoHome(backend.pageUrl)
    await authMeResponse
    await app.expectBooted()

    await app.expandFolderByName('notes')
    await expect(fileTreeItemByName(page, SEARCH_TERMS.uniqueTermFileName)).toBeVisible({
      timeout: 10_000,
    })
    expect(page.url(), 'boot must land on the shell URL').toContain('/core/main')
  },
)
