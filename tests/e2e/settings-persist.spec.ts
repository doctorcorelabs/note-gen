// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-06: settings persist. Change one setting through the settings
// API, reload, read it back through the settings API: the value
// survives. Design: fase1/desain-pengujian.md section 4.2; the
// setting under test is darkMode (AD-113), recorded in
// harness/seed-data.ts SETTINGS_SEED.
//
// Status: LIVE (converted by W4-FLOWS).
//
// Why the flow is programmatic, not UI-driven (AD-123 (11)): no UI
// control references the darkMode key, the zustand setter is
// synchronous and non-persisting, and the visible theme comes from
// next-themes. Driving a nonexistent control would test nothing, so
// this spec drives the shipped persistence path (GET/PATCH
// /api/settings, kontrak-api-kanonis.md 3.2) and asserts persistence
// only: the written value, the revision advance, and the read-back
// after a full browser reload. It claims NO UI read-back of
// darkMode and NO visible theme effect. The Settings dialog opener
// hook (register R3, finding T-5) is covered separately: the
// i18n-profile spec opens the dialog through the test-id opener and
// the E2EDEBT evidence recount.
//
// Steps:
// 1. Boot the shell through the backend fixture (session established).
// 2. Read the settings document (GET /api/settings) through
//    page.request: record the revision and the current darkMode
//    value (the zustand default is 'system'; the document value on
//    a fresh install may be absent or 'system', either is fine, the
//    assertion is on the written value, not the starting value).
// 3. PATCH { baseRevision, settings: { darkMode: 'dark' } } with a
//    fresh CSRF token. Assert the response revision advanced by
//    exactly one, darkMode is in the applied list, and the rejected
//    list is empty.
// 4. Reload the shell in the browser (AppPage.reloadHome) and read
//    the document again. Assert darkMode is 'dark' and the revision
//    did not go BACKWARDS. The revision is NOT asserted stable:
//    the browser writes settings during boot (the first conversion
//    run observed the revision advance from 7 to 9 across one
//    reload), so revision stability is false for the shipped app
//    and asserting it would pin a non-contract. The persistence
//    contract is the value plus monotonic revision, never a
//    rewrite-free boot.
// 5. Assert the settings read observed in the browser during boot
//    carried the written value: after reload the browser re-reads
//    settings (GET /api/settings 200), so a second read through
//    page.request after the reload observes the same document the
//    browser loaded. The spec does not parse browser storage: the
//    settings document is the persistence surface.

import { backendTest, expect } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'
import { fetchCsrfToken } from './harness/seed-records'
import { getSettingsDocument, patchSettingsDocument } from './harness/settings-api'
import { SETTINGS_SEED } from './harness/seed-data'

backendTest(
  'E2E-06-darkMode @smoke settings persist: darkMode written through the API survives reload',
  async ({ backend, page }) => {
    const app = new AppPage(page)
    await app.gotoHome(backend.pageUrl)
    await app.expectBooted()

    const before = await getSettingsDocument(page.request, backend.apiBaseUrl)
    const csrfToken = await fetchCsrfToken(page.request, backend.apiBaseUrl)
    const patched = await patchSettingsDocument(
      page.request,
      backend.apiBaseUrl,
      csrfToken,
      before.revision,
      { [SETTINGS_SEED.key]: SETTINGS_SEED.value },
    )
    expect(patched.revision, 'PATCH must advance the revision by exactly one').toBe(
      before.revision + 1,
    )
    expect(patched.applied, 'darkMode must be in the applied list').toContain(SETTINGS_SEED.key)
    expect(patched.rejected, 'no key may be rejected').toEqual([])

    await app.reloadHome()
    await app.expectBooted()

    const after = await getSettingsDocument(page.request, backend.apiBaseUrl)
    expect(
      after.revision,
      'reload must not roll the settings revision backwards (boot writes are allowed to advance it)',
    ).toBeGreaterThanOrEqual(patched.revision)
    expect(after.settings[SETTINGS_SEED.key], 'darkMode must read back the written value').toBe(
      SETTINGS_SEED.value,
    )
  },
)
