// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-RELOAD: seed-reload persistence. A full browser reload keeps
// the seeded workspace file, the seeded record, and the settings
// document intact. Design: AD-111/G9 seed-reload pattern, read by
// the E2EDEBT batch (section 4.4) as reload-persistence coverage
// across the seed surfaces: one file, one kind record, one settings
// document.
//
// Status: LIVE (added by W4-FLOWS). Tag: @smoke. This spec adds one
// test to the @smoke gate count; the count change is stated in the
// W4-FLOWS report and in tests/e2e/README.md.
//
// Steps:
// 1. Boot through the backend fixture. Open the seed file and assert
//    the visible editor shows the seed term; open the Record tab and
//    assert the inbox shows the first seed record; read the settings
//    document through the API and record its revision and content.
// 2. Reload the shell in the browser (AppPage.reloadHome) and wait
//    for the shell URL by observation.
// 3. Re-assert all three surfaces: the seed file reopens with the
//    same content, the inbox still lists the seed record, and the
//    settings document reads back with the same content and a
//    revision that did not go backwards. The revision is not
//    asserted stable: the browser writes settings during boot
//    (observed +2 across one reload in the first conversion run),
//    so only value persistence plus monotonic revision is the
//    contract.

import { backendTest, expect } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'
import {
  fileTreeItemByName,
  visibleVisualEditor,
  webInbox,
} from './harness/selectors'
import { getSettingsDocument } from './harness/settings-api'
import { RECORD_SEEDS, SEARCH_TERMS } from './harness/seed-data'

backendTest(
  'E2E-RELOAD @smoke seed reload: file, record, and settings survive a full page reload',
  async ({ backend, page }, testInfo) => {
    testInfo.setTimeout(120_000)
    const app = new AppPage(page)
    await app.gotoHome(backend.pageUrl)
    await app.expectBooted()

    await app.expandFolderByName('notes')
    await fileTreeItemByName(page, SEARCH_TERMS.uniqueTermFileName).click()
    await expect(visibleVisualEditor(page)).toContainText(SEARCH_TERMS.uniqueTerm, {
      timeout: 10_000,
    })

    await app.switchToRecordsTab()
    await expect(webInbox(page)).toContainText(RECORD_SEEDS[0].content, { timeout: 10_000 })

    const before = await getSettingsDocument(page.request, backend.apiBaseUrl)

    await app.reloadHome()
    await app.expectBooted()

    await app.expandFolderByName('notes')
    await fileTreeItemByName(page, SEARCH_TERMS.uniqueTermFileName).click()
    await expect(visibleVisualEditor(page)).toContainText(SEARCH_TERMS.uniqueTerm, {
      timeout: 10_000,
    })

    await app.switchToRecordsTab()
    await expect(webInbox(page)).toContainText(RECORD_SEEDS[0].content, { timeout: 10_000 })

    const after = await getSettingsDocument(page.request, backend.apiBaseUrl)
    expect(
      after.revision,
      'reload must not roll the settings revision backwards (boot writes are allowed to advance it)',
    ).toBeGreaterThanOrEqual(before.revision)
    expect(after.settings, 'settings content must be identical after reload').toEqual(
      before.settings,
    )
  },
)
