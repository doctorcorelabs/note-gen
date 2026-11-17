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
//    locator (VERIFIED in source). TIMEOUT WARNING: the polling
//    snapshot interval defaults to 10000 ms while the tab is
//    visible (fs.web.ts watchPollIntervalMs), far above the
//    WATCHER_MAX_LATENCY_MS contract bound of 1000 ms, so a
//    conversion against the polling path must derive its timeout
//    from the polling interval actually in effect and record the
//    divergence; do not reuse the 1000 ms bound blindly. The
//    watcher replacement in the web fork is WebSocket
//    /api/workspace/events plus polling snapshot (AD-09). The
//    WebSocket route has NOT landed (no server registration, no
//    websocket dependency in server/package.json); the polling
//    snapshot fallback HAS landed (FsAdapter.watch in
//    src/lib/platform/fs/fs.web.ts plus the watcher client,
//    src/lib/web/watcher-client.ts, V3-09). The seed workspace
//    comes from the backend fixture (harness/backend-fixture.ts).
// 4. Click the file and assert its content is shown.
// 5. Assert no duplicate tree entry appears after the event is applied.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-05 @smoke external file: new file appears in the tree and opens', async () => {
  notYetLanded(
    'E2E-05',
    'the WebSocket workspace event channel (AD-09) has not landed ' +
      'and the backend harness has no live run yet; the polling ' +
      'snapshot fallback has landed, but no run has proved an ' +
      'externally written file reaches the file tree yet.',
  )
})
