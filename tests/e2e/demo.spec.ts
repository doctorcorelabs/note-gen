// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-D1/D2: A10 demo walkthrough skeletons (rencana-gelombang3 4.3,
// gate A10: demo parsial MVP lewat browser di lingkungan dev). These
// specs compose the six @smoke flows plus login (E2E-S1) and record
// plus tag (E2E-S3) into the exact demo sequence A10 names; they add
// no new flow family. Tag @demo (not @smoke, not @scaffold) keeps the
// e2e-smoke gate definition unchanged, following the @scaffold
// precedent in tests/e2e/README.md. Run with:
// pnpm exec playwright test --grep @demo
//
// Status: TODO. Both tests fail explicitly with "fitur belum mendarat"
// until the demo prerequisites land. Do not convert them to skip/fixme
// and do not add placeholder assertions. Do not claim demo readiness
// from these skeletons: each step below names the feature or harness
// piece it waits for.
//
// E2E-D1 intended steps (the A10 sequence, verbatim order):
// 1. Login through the shipped login UI at /login (E2E-S1; page
//    shipped in V3-03, locators in harness/selectors.ts, page object
//    in harness/login-page.ts) or, only if the demo protocol allows
//    it, an API-seeded session via harness/auth.ts. The demo protocol
//    choice belongs to the coordinator; this spec does not choose
//    silently. The harness path past the Cloudflare Access perimeter
//    is the loopback test-only bypass in harness/backend.ts
//    (CF_ACCESS_ENABLED=false, development, loopback origin); it
//    has no live run yet.
// 2. Create a folder and 3 notes: text, image, relative link
//    (harness/seed-data.ts DEMO_FOLDER and DEMO_NOTES; folder creation
//    uses the "New Folder" button, locator VERIFIED in source).
//    CAVEAT: creating a folder/note enters rename mode, and the rename
//    input has no accessible name (inventory register R1); the flow
//    must scope to the renaming row and prove the input in a live DOM.
// 3. Edit and save one note (E2E-03), then reload the page.
// 4. Create 5 records with 2 tags (harness/seed-data.ts RECORD_SEEDS
//    and TAG_SEEDS; the WebRecordCreate dialog merged in V3-26a but
//    is not mounted in any page on trunk, and V3-26b merged tag
//    sidebar/validation work without mounting it, so no creation
//    path is reachable through the browser until inbox mounting
//    lands as follow-up work; creation goes through the kind-backed
//    client, D-3D-1).
// 5. Search a word and open the result (E2E-04).
// 6. Change 2 settings and reload (E2E-06; the 2 settings are NOT
//    chosen yet: V3-29 UI merged without recording a choice, see
//    seed-data.ts header).
// 7. Assert every created item is still present with the same content
//    after the reloads.
//
// E2E-D2 intended steps (A10 data check):
// 1. Run the E2E-D1 sequence against a backend test harness backed by
//    a persistent test database (not an in-memory store).
// 2. Restart the local backend through the harness restart control.
//    No restart control exists yet; restarting by hand and re-running
//    the spec is not the same evidence.
// 3. Reopen the app, log in again, and assert the folder, notes,
//    records, tags, search results, and settings from step 1 are all
//    intact. Data loss, duplication, or a changed setting fails.
// Out of scope here by A10 itself: archive download and suspend/resume
// resilience on muse-2 (gates 4-5, not claimed in this spec).

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-D1 @demo A10 walkthrough: login, folder plus 3 notes, edit, records plus tags, search, 2 settings', async () => {
  notYetLanded(
    'E2E-D1',
    'record creation mounting (inbox follow-up) plus the E2E-06 ' +
      'settings choice have not landed, and the backend test ' +
      'harness has no live run yet; the A10 demo sequence cannot ' +
      'run through the browser yet.',
  )
})

test('E2E-D2 @demo A10 data check: demo data intact after a backend restart', async () => {
  notYetLanded(
    'E2E-D2',
    'the backend restart control plus a persistent test database ' +
      'harness have not landed; data survival across a restart cannot ' +
      'be observed yet.',
  )
})
