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
// Status: TODO. This test fails explicitly with "fitur belum mendarat"
// until the feature lands. Do not convert it to skip/fixme and do not
// add placeholder assertions. This spec carries the @scaffold tag, not
// @smoke: it is outside the six @smoke flows of desain-pengujian
// section 4, and its justification is recorded in tests/e2e/README.md
// as section 4.4 requires.
//
// SELECTOR STATUS: mixed, see harness/selectors.ts deleteMenuItem.
// The menu text "Delete" is VERIFIED (source) in the English catalog
// (article.file.context.delete), and the deletion handler exists in
// file-item.tsx (useFileDeletion, handleDeleteFile, plus the
// 'filemanager-delete' window event). But the context menu container
// role, the menuitem role, and the trigger mechanism (right-click
// target and menu opener) were NOT traced to a component, so the
// locator is UNVERIFIED and the flow author must prove the menu opens
// and the item is clickable in a live DOM before relying on it. Do
// not drive deletion through the 'filemanager-delete' window event:
// that bypasses the UI the user actually uses.
//
// Intended steps (replace the notYetLanded call when the feature lands):
// 1. Seed the workspace (harness/seed.ts) and wire it into the app so
//    the seed entries appear in the tree. Seed wiring has NOT landed.
// 2. Open the context menu for one seeded file in the tree and choose
//    Delete (selectors.deleteMenuItem, UNVERIFIED). If the shipped UI
//    shows a confirmation dialog, confirm through its accessible
//    buttons; the confirmation texts in the catalog cover folder
//    deletion (confirmDelete) and multi-entry deletion
//    (confirmDeleteEntries), so the flow author must verify which
//    confirmation, if any, a single file deletion shows. Do not
//    assume a dialog exists.
// 3. Wait for the deletion EFFECT by observation: the treeitem for
//    the deleted path disappears (expect.poll on the treeitem count,
//    or toHaveCount(0) with the default expect timeout), never by a
//    fixed sleep.
// 4. Assert the file is gone from the tree and, through the backend
//    harness read path, gone from the workspace or present in trash
//    according to the delete semantics the web fork ships (trash vs
//    permanent delete is a UI/backend owner decision; the contract
//    exposes trash restore endpoints, so the flow must assert the
//    semantics that actually shipped, not an assumed one).
// 5. Assert no duplicate or stale tree entry remains and the other
//    seed entries are untouched.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-S2 @scaffold note CRUD delete: deleted note leaves the tree and the workspace', async () => {
  notYetLanded(
    'E2E-S2',
    'seed workspace wiring plus the workspace delete/trash API plus a ' +
      'verified context-menu delete path have not landed; no note can ' +
      'be deleted through the web UI yet.',
  )
})
