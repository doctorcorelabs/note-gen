// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-03: open and edit an existing article. Relative images and
// relative links work. Design: fase1/desain-pengujian.md section 4.2.
//
// Status: TODO. This test fails explicitly with "fitur belum mendarat"
// until the feature lands. Do not convert it to skip/fixme and do not
// add placeholder assertions.
//
// Intended steps (replace the notYetLanded call when the feature lands):
// 1. Seed the workspace (harness/seed.ts) and wire it into the app so
//    the seed entries appear in the tree. Seed wiring has NOT landed.
// 2. Open the seed .md file (AppPage.openFileByPath, locator VERIFIED
//    in source).
// 3. Change one paragraph and one heading in the visual editor.
// 4. Wait for the save effect by polling disk content (see E2E-02:
//    no save indicator exists in the UI).
// 5. Assert disk content contains the changes and preserves the
//    untouched parts.
// 6. Assert the relative image is visible (selectors.editorImages,
//    UNVERIFIED) and its natural size is not zero, or that the media
//    response returns 200. Media serving (endpoint /api/workspace/media
//    per audit-editor-web.md E1) has NOT landed.
// 7. Click the relative link and assert the target file opens with
//    the target title/content visible. Link click handling in the web
//    fork (SmartFileLink mapping to web routes) has NOT landed.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-03 @smoke edit existing article: relative image and link work', async () => {
  notYetLanded(
    'E2E-03',
    'seed workspace wiring plus workspace read/write API plus media ' +
      'serving plus relative-link navigation have not landed; a seeded ' +
      'article cannot be opened, edited, or re-read through the web UI yet.',
  )
})
