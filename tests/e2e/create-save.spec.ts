// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-02: create an article and save it. Content survives reload
// byte-for-byte. Design: fase1/desain-pengujian.md section 4.2.
//
// Status: LIVE (converted by W4-FLOWS).
//
// Placement (W4-FLOWS probes 6/7): the toolbar "New Note" button
// creates at the workspace ROOT even after the target folder row
// was clicked (probe6: disk notes/ MISSING, root file created).
// The folder context menu "New File" entry creates INSIDE the
// folder (probe7: disk notes/probe-folder-note.md created, root
// MISSING). This spec therefore creates through the folder menu,
// and the created path is CREATE_NOTE_RELATIVE_PATH
// (notes/e2e-created-note.md) from harness/seed-data.ts. Do not
// switch this flow to the toolbar button without re-proving
// placement: the two entries have different parents.
//
// Editing mode: the fixture is entered in SOURCE mode (CodeMirror),
// because the contract is byte-for-byte persistence and a visual
// (Tiptap) round-trip is allowed to re-serialize the document. The
// content is inserted with keyboard.insertText (a single input
// insertion, the paste-equivalent path), not keystroke-by-keystroke
// typing: per-key typing would exercise CodeMirror list
// auto-continuation instead of the save path under test, and the
// keystroke path is covered by E2E-03's visual editing. The save
// under test is the real autosave chain (editor plus article store
// debounce, 500 ms plus 500 ms); the spec waits for its EFFECT on
// disk, never for a timer.
//
// Steps:
// 1. Boot through the backend fixture. Right-click the notes folder
//    and choose "New File". Name the file e2e-created-note.md
//    through the rename input (register R1 hook: data-testid
//    "file-rename-input") and confirm with Enter.
// 2. Switch the new file's editor to source mode and insert
//    CREATE_NOTE_FIXTURE (heading, list, code block, table,
//    relative image, relative link).
// 3. Wait for the autosave effect by polling disk content until it
//    equals the fixture byte-for-byte (timeout 30 s, covering the
//    debounce chain several times over). There is no "Saved"
//    indicator in the UI, so disk polling is the only honest
//    signal.
// 4. Switch back to visual mode and assert the editor shows the
//    heading and the unique term.
// 5. Reload the page, reopen the file, and assert disk content
//    still equals the fixture byte-for-byte, the editor shows the
//    same content, and the file appears in the tree under the
//    created name.

import { backendTest, expect } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'
import {
  fileTreeItemByName,
  newFileMenuItem,
  renameInput,
  viewModeToggleToSource,
  viewModeToggleToVisual,
  visibleSourceEditor,
  visibleVisualEditor,
} from './harness/selectors'
import { CREATE_NOTE_FIXTURE, CREATE_NOTE_RELATIVE_PATH } from './harness/seed-data'

backendTest(
  'E2E-02 @smoke create and save: content survives reload byte-for-byte',
  async ({ backend, page }, testInfo) => {
    testInfo.setTimeout(120_000)
    const app = new AppPage(page)
    await app.gotoHome(backend.pageUrl)
    await app.expectBooted()

    await fileTreeItemByName(page, 'notes').click({ button: 'right' })
    await newFileMenuItem(page).click()
    await renameInput(page).fill('e2e-created-note.md')
    await renameInput(page).press('Enter')
    await expect(visibleVisualEditor(page)).toBeVisible({ timeout: 10_000 })

    await viewModeToggleToSource(page).click()
    await expect(visibleSourceEditor(page)).toBeVisible({ timeout: 10_000 })
    await visibleSourceEditor(page).click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.insertText(CREATE_NOTE_FIXTURE)

    await backend.waitForWorkspaceFileContent(CREATE_NOTE_RELATIVE_PATH, CREATE_NOTE_FIXTURE, 30_000)

    await viewModeToggleToVisual(page).click()
    await expect(visibleVisualEditor(page)).toContainText('Created note', { timeout: 10_000 })
    await expect(visibleVisualEditor(page)).toContainText('quokka-created-delta')

    await app.reloadHome()
    await app.expectBooted()
    await app.ensureFolderExpanded('notes', 'e2e-created-note.md')
    await fileTreeItemByName(page, 'e2e-created-note.md').click()
    await expect(visibleVisualEditor(page)).toContainText('Created note', { timeout: 10_000 })
    await expect(visibleVisualEditor(page)).toContainText('quokka-created-delta')
    const disk = await backend.readWorkspaceFile(CREATE_NOTE_RELATIVE_PATH)
    expect(disk, 'disk content must equal the fixture byte-for-byte after reload').toBe(
      CREATE_NOTE_FIXTURE,
    )
    await expect(fileTreeItemByName(page, 'e2e-created-note.md')).toHaveCount(1)
  },
)
