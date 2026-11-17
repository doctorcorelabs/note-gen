// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-02: create an article and save it. Content survives reload
// byte-for-byte. Design: fase1/desain-pengujian.md section 4.2.
//
// Status: TODO. This test fails explicitly with "fitur belum mendarat"
// until the feature lands. Do not convert it to skip/fixme and do not
// add placeholder assertions.
//
// Intended steps (replace the notYetLanded call when the feature lands):
// 1. Create a new file through the UI (AppPage.createNewNote, "New
//    Note" button; locator VERIFIED in source).
// 2. Type the fixture content (heading, list, code block, table,
//    relative image, relative link) into the visual editor
//    (selectors.visualEditor, UNVERIFIED until a run proves it).
//    The fixture is CREATE_NOTE_FIXTURE at CREATE_NOTE_RELATIVE_PATH
//    in harness/seed-data.ts; do not invent a second fixture.
// 3. Wait for the autosave EFFECT, never a fixed sleep: poll the file
//    on disk through the backend fixture
//    (backend.waitForWorkspaceFileContent in
//    harness/backend-fixture.ts) until its content equals the
//    fixture, with a timeout derived from the autosave debounce.
//    There is no "Saved" indicator text in the editor UI (verified by
//    grep: no save-status string exists), so disk polling is the only
//    honest signal. The debounce chain is 500 ms in the editor plus
//    500 ms in the article store (audit-editor-web.md 2.1).
// 4. Reload the page and open the same file.
// 5. Assert disk content equals the fixture byte-for-byte and the
//    editor shows the same content; assert the file appears in the
//    tree under the created name.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-02 @smoke create and save: content survives reload byte-for-byte', async () => {
  notYetLanded(
    'E2E-02',
    'the backend harness (harness/backend-fixture.ts) has no live ' +
      'run yet: the workspace write API is registered and the web ' +
      'FsAdapter is wired, but no run has proved create plus autosave ' +
      'through the browser, the visual editor selector is unverified, ' +
      'and the rename input has no stable hook.',
  )
})
