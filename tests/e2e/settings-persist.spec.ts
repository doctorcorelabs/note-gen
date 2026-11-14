// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-06: settings persist. Change one setting, reload, it stays.
// Design: fase1/desain-pengujian.md section 4.2.
//
// Status: TODO. This test fails explicitly with "fitur belum mendarat"
// until the feature lands. Do not convert it to skip/fixme and do not
// add placeholder assertions.
//
// Intended steps (replace the notYetLanded call when the feature lands):
// 1. Open settings. BLOCKER, NOT VERIFIABLE: the buttons that open
//    settings (title bar, app sidebar) have NO aria-label in source,
//    only tooltip text. The flow author must either add an accessible
//    name or a data-testid to the opener (UI owner decision), or
//    drive the settings dialog through a documented test hook. Do
//    not guess a click target.
// 2. Change ONE setting whose effect is observable and which does not
//    depend on any upstream service. The setting is NOT chosen yet:
//    desain-pengujian leaves the choice to the scaffold, and no
//    candidate was verified against the web settings backend because
//    that backend has not landed. Pick a display preference with a
//    visible UI effect, or a value readable through the settings API.
// 3. Reload the page and read the setting back.
// 4. Assert the value after reload equals the changed value, and the
//    observable effect (if any) still applies.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-06 @smoke settings persist: changed setting survives reload', async () => {
  notYetLanded(
    'E2E-06',
    'the settings persistence backend plus an accessible settings ' +
      'opener plus the chosen observable setting have not landed; no ' +
      'setting can be changed and re-read through the web UI yet.',
  )
})
