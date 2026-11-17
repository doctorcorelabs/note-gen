// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-05: file from outside. A new file appears in the tree and can be
// opened. Design: fase1/desain-pengujian.md section 4.2.
//
// Status: TODO. This test fails explicitly with "fitur belum mendarat"
// until the feature lands. Do not convert it to skip/fixme and do not
// add placeholder assertions.
//
// Intended steps (replace the notYetLanded call when the feature lands):
// 1. Open the app and record the tree contents.
// 2. An external process writes a new .md file atomically into the
//    workspace (EXTERNAL_FILE in harness/seed-data.ts, written with
//    harness/external-writer.ts writeFileAtomically: temp file plus
//    rename).
// 3. Wait for the file to appear in the tree by polling the treeitem
//    locator (VERIFIED in source), with a timeout equal to
//    WATCHER_MAX_LATENCY_MS. The watcher replacement in the web fork
//    is WebSocket /api/workspace/events plus polling snapshot
//    (AD-09); neither has landed.
// 4. Click the file and assert its content is shown.
// 5. Assert no duplicate tree entry appears after the event is applied.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-05 @smoke external file: new file appears in the tree and opens', async () => {
  notYetLanded(
    'E2E-05',
    'seed workspace wiring plus the WebSocket/polling workspace event ' +
      'channel (AD-09) have not landed; an externally written file cannot ' +
      'reach the file tree yet.',
  )
})
