// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-S2: note CRUD, delete leg. The full CRUD mapping across specs:
// Create is E2E-02 (create-save.spec.ts), Read and Update are E2E-03
// (edit-existing.spec.ts: open a seeded article, change it, re-read
// it), and Delete is this spec. This spec exists because no
// desain-pengujian section 4 flow covers deleting a note, and the
// recovery brief lists note CRUD as one critical flow. Design
// sources: fase1/desain-pengujian.md section 4.2 (E2E-02/E2E-03),
// fase1/kontrak-api-kanonis.md workspace/files group (trash and
// restore endpoints).
//
// Status: TODO, BLOCKED BY A PRODUCT GAP (W4-FLOWS finding, probes
// 8-9, 17 Nov 2026). This test fails explicitly with "fitur belum
// mendarat" until the gap is wired. Do not convert it to skip/fixme
// and do not add placeholder assertions. This spec carries the
// @scaffold tag, not @smoke.
//
// THE BLOCKER: file deletion cannot complete in web mode because
// the confirmation step has no dialog service. Deletion runs
// through use-file-deletion.ts, which awaits platform.dialog.ask()
// before deleting anything. In web mode the dialog adapter is
// registered with NO dialog service (src/lib/platform/wiring.ts
// header: "confirm/ask/message/prompt methods throw the documented
// unavailable error until the service wiring lands"; AD-33), and no
// production code installs one (installHostDialogService has no
// production caller; the mounted WebDialogHost is a generic info
// dialog, not wired to the adapter seam). The ask() call therefore
// throws, the deletion catch shows a failure toast, and the file
// stays. W4-FLOWS probes confirmed the live behavior: right-click
// Delete on a seed file produced 0 alertdialogs and 0 dialogs, the
// file stayed on disk (70 bytes, unchanged), and the treeitem
// stayed. The context menu itself WORKS (11 items including
// "Delete", probe4/7/9) and the trash routes ARE registered
// (W4-WIRE wired registerWorkspaceTrashRoutes; the earlier comment
// claiming otherwise was stale and is corrected here). What is
// missing is purely the DialogService wiring. Pinning the current
// blocked behavior as a passing test would enshrine a broken flow,
// so this spec stays TODO until the wiring lands; the wiring is
// proposed to the integrator as a numbered follow-up in the
// W4-FLOWS report (AD-33 / dialog-wiring precedent).
//
// SELECTOR STATUS: the menu path is PROVEN in a live DOM
// (selectors.deleteMenuItem: Radix menuitem, right-click trigger,
// non-exact name match because the item carries the "Del" hint).
// The confirmation dialog has NO locator: no dialog renders until
// the service wiring lands, so no dialog text or button can be
// pinned yet. Do not drive deletion through the
// 'filemanager-delete' window event: that bypasses the UI the user
// actually uses.
//
// Intended steps (replace the notYetLanded call when the dialog
// service wiring lands):
// 1. Seed the workspace through the backend fixture. The trash
//    routes are registered (W4-WIRE); the delete leg waits only
//    on the confirmation dialog wiring.
// 2. Open the context menu for one seeded file in the tree and
//    choose Delete (selectors.deleteMenuItem). Confirm through
//    the confirmation dialog's accessible buttons (texts and
//    roles to be pinned from the live dialog once it renders;
//    the catalog confirmDeleteEntries text is the message).
// 3. Wait for the deletion EFFECT by observation: the treeitem for
//    the deleted path disappears (toHaveCount(0) with the default
//    expect timeout), never by a fixed sleep.
// 4. Assert the file is gone from the tree and, through the backend
//    harness read path, gone from the workspace or present in trash
//    according to the delete semantics the web fork ships (the
//    contract exposes trash restore endpoints, so the flow must
//    assert the semantics that actually shipped, not an assumed
//    one).
// 5. Assert no duplicate or stale tree entry remains and the other
//    seed entries are untouched.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-S2 @scaffold note CRUD delete: deleted note leaves the tree and the workspace', async () => {
  notYetLanded(
    'E2E-S2',
    'the web dialog service is not wired (AD-33): ' +
      'platform.dialog.ask() throws, so the delete confirmation ' +
      'never renders and deletion cannot complete through the web ' +
      'UI; the context menu and trash routes work, only the ' +
      'confirmation wiring is missing.',
  )
})
