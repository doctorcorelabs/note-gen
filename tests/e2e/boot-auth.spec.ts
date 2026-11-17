// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-01-auth: authenticated boot. The app opens at /, redirects to
// /core/main, and shows the file tree with seed entries, a non-blank
// page, and no error boundary text. Design: fase1/desain-pengujian.md
// section 4.2 (E2E-01), as split by the 3D e2e-prep extension: the
// no-backend fail-closed boot stays pinned in boot.spec.ts (E2E-01),
// and this spec is the authenticated half of the same flow, which is
// the boot gate A3 actually needs (rencana-gelombang3 4.3).
//
// Status: TODO. This test fails explicitly with "fitur belum mendarat"
// until the backend harness proves a live run. Do not convert it to
// skip/fixme and do not add placeholder assertions. Do not weaken
// boot.spec.ts E2E-01 to make this spec pass: the two specs pin
// opposite, complementary contracts (unknown session blocks visibly;
// known session boots). The boot guard and the /login page have
// shipped on trunk (V3-03); the harness code has landed
// (harness/backend-fixture.ts) but has no live run yet, so this spec
// waits only on that proof, not on app UI.
//
// Intended steps (replace the notYetLanded call after the first live
// harness run proves the fixture):
// 1. Use the backend fixture (harness/backend-fixture.ts): a fresh
//    workspace and database for this test, seeded with
//    harness/seed.ts entries, plus an authenticated session.
// 2. The fixture already establishes the session through the API
//    helpers in harness/auth.ts (setupFirstAccount once per fresh
//    install, then loginViaApi with page.request, then fetchSession
//    to prove the session). Credentials are generated per backend
//    by the fixture and live in memory only.
// 3. Open / through AppPage.gotoHome and wait for the redirect to
//    /core/main by URL observation, never by a fixed sleep.
// 4. Assert AppPage.expectBooted: the file tree is visible, at least
//    one seed entry shows (SEARCH_TERMS.uniqueTermFileName,
//    getting-started.md, via fileTreeItemByName), the page has
//    visible text, and no error boundary text appears.
// 5. Assert no Next.js error overlay text appears.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-01-auth @smoke authenticated boot: redirect to /core/main with the file tree visible', async () => {
  notYetLanded(
    'E2E-01-auth',
    'the backend test harness has no live run yet (code landed in ' +
      'harness/backend-fixture.ts, unproven against Postgres); no ' +
      'authenticated session has reached /core/main through the ' +
      'browser yet.',
  )
})
