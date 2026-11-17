// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-05: file from outside. A new file appears in the tree and can be
// opened. Design: fase1/desain-pengujian.md section 4.2.
//
// Status: LIVE (converted by W4-FLOWS).
//
// Timeout derivation (recorded, not hidden): the polling snapshot
// interval defaults to 10000 ms while the tab is visible
// (fs.web.ts watchPollIntervalMs), far above the
// WATCHER_MAX_LATENCY_MS contract bound of 1000 ms. The WebSocket
// route /api/workspace/events IS registered on trunk (W4-WIRE), but
// this spec proves the arrival through the tree either way, so its
// timeout is derived from the SLOWER path: 30 seconds covers three
// polling intervals plus tree render, and the assertion is an
// observation (the treeitem becomes visible), never a sleep. The
// 1000 ms contract bound is NOT asserted here; the divergence
// between the contract bound and the polling interval stays a
// recorded contract question for the owner, and this spec must not
// be read as proving sub-second watcher latency.
//
// Steps:
// 1. Boot through the backend fixture and expand the seed folder.
//    Assert the external file is NOT in the tree yet.
// 2. Write EXTERNAL_FILE atomically into the workspace from outside
//    the browser (harness/external-writer.ts: temp file plus
//    rename, the C-FS-10 write pattern).
// 3. Wait by observation for the file to appear in the tree.
// 4. Click the file and assert its content is shown in the visible
//    editor.
// 5. Assert exactly one tree entry carries the file name: no
//    duplicate row after the event is applied.

import { backendTest, expect } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'
import { fileTreeItemByName, visibleVisualEditor } from './harness/selectors'
import { EXTERNAL_FILE } from './harness/seed-data'
import { writeFileAtomically } from './harness/external-writer'

backendTest(
  'E2E-05 @smoke external file: new file appears in the tree and opens',
  async ({ backend, page }) => {
    const app = new AppPage(page)
    await app.gotoHome(backend.pageUrl)
    await app.expectBooted()
    await app.expandFolderByName('notes')
    await expect(fileTreeItemByName(page, 'getting-started.md')).toBeVisible({
      timeout: 10_000,
    })

    const externalItem = fileTreeItemByName(page, EXTERNAL_FILE.fileName)
    await expect(externalItem).toHaveCount(0)

    await writeFileAtomically(backend.workspaceDir, EXTERNAL_FILE.relativePath, EXTERNAL_FILE.content)

    await expect(externalItem).toBeVisible({ timeout: 30_000 })
    await expect(externalItem).toHaveCount(1)

    await externalItem.click()
    await expect(visibleVisualEditor(page)).toContainText('Written from outside.', {
      timeout: 10_000,
    })
    await expect(visibleVisualEditor(page)).toContainText('quokka-external-gamma')
    await expect(fileTreeItemByName(page, EXTERNAL_FILE.fileName)).toHaveCount(1)
  },
)
