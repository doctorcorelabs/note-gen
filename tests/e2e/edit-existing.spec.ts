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
// 1. Seed the workspace through the backend fixture
//    (harness/backend-fixture.ts: WORKSPACE_ROOT per test) so the
//    seed entries appear in the tree. The fixture has no live run
//    yet; do not convert this flow until one proves the seed
//    appears.
// 2. Open the seed .md file (AppPage.openFileByPath, locator VERIFIED
//    in source).
// 3. Change one paragraph and one heading in the visual editor. The
//    edit is applyEditToDeepNote over SEED_CONTENTS.deepNote
//    (harness/seed-data.ts): heading EDIT_DEEP_NOTE_HEADING plus
//    paragraph EDIT_DEEP_NOTE_PARAGRAPH; everything else must survive
//    byte-for-byte.
// 4. Wait for the save effect by polling disk content (see E2E-02:
//    no save indicator exists in the UI).
// 5. Assert disk content contains the changes and preserves the
//    untouched parts.
// 6. Assert the relative image is visible (selectors.editorImages,
//    UNVERIFIED) and its natural size is not zero, or that the media
//    response returns 200. Media serving is SPLIT on trunk: media
//    write routes are registered, but the media read module
//    (server/src/routes/workspace-media-read.ts) has no caller in
//    server/src, so GET /api/workspace/media is unregistered and
//    answers 404 from the app until its registrar is wired in.
// 7. Click the relative link with a modifier key and assert the
//    target file opens with the target title/content visible.
//    Relative-link opening exists in tiptap-editor.tsx (openLink,
//    via resolveLocalLinkPath plus openFileInApp) but needs a
//    modifier click on desktop: a plain click opens the link
//    editor instead. Runtime behavior is unproven.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-03 @smoke edit existing article: relative image and link work', async () => {
  notYetLanded(
    'E2E-03',
    'the media read route is not registered (module exists, no ' +
      'caller in server/src), relative-link navigation is unproven ' +
      'at runtime and needs a modifier click on desktop, and the ' +
      'backend harness has no live run yet; a seeded article cannot ' +
      'be opened, edited, and re-read with its image and link ' +
      'through the web UI yet.',
  )
})
