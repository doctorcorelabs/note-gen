// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Central E2E locators for the NoteGen web fork UI.
//
// Every locator below was checked against the actual components in the
// reference repo (HEAD 4dcaa3f). The verification status of each
// locator is stated in its comment:
//
// - VERIFIED (source): the rendered role, accessible name, or attribute
//   follows from component source plus the English message catalog
//   (messages/en.json, default locale `en`). Runtime behavior in a
//   real browser is still unverified until the boot flow runs green.
// - UNVERIFIED: the locator follows a library convention or a
//   reasonable inference, but no component source in the repo pins it
//   down. Do not trust it until a passing run proves it.
// - NOT VERIFIABLE: the UI exposes no stable hook for this element in
//   source. A `data-testid` (or an accessible name) must be added by
//   the UI owner before an E2E flow can rely on it. This scaffold adds
//   no `data-testid` attributes: UI changes belong to the UI owners,
//   not to the test scaffold.
//
// Evidence summary (full table in tests/e2e/README.md):
// - There are ZERO `data-testid` attributes anywhere in src/.
// - File tree: role "tree", aria-label "Workspace files"
//   (file-manager.tsx getContainerProps + messages/en.json
//   article.file.treeLabel + @headless-tree/core container props).
// - Tree items: role "treeitem", aria-label = file name
//   (@headless-tree/core item props + use-file-tree getItemName),
//   plus data-file-manager-item-path = workspace-relative path
//   (file-tree-row.tsx + lib/path.ts computedParentPath).
// - Sidebar tab buttons render their title text ONLY when selected
//   (expandable-tabs.tsx), so unselected tabs have no accessible
//   name: tab switching by role/name is NOT VERIFIABLE.
// - Tag editor: trigger button and dialog title "Manage tags"
//   (record-tag-editor.tsx + record.tagging.manage). The trigger is
//   VERIFIED (source); the dialog name and the tag checkboxes are
//   UNVERIFIED (Radix live-DOM exposure not checked).
// - File delete menu item text "Delete" is VERIFIED (source) in the
//   catalog, but the menu role and trigger are NOT traced: the
//   deleteMenuItem locator is UNVERIFIED.
// - Login and archive-download UI do not exist in the reference repo
//   and are NOT VERIFIABLE: no locators for them exist here by
//   design. See login.spec.ts and archive-download.spec.ts.

import type { Locator, Page } from '@playwright/test'

/** VERIFIED (source). File tree container. */
export function fileTree(page: Page): Locator {
  return page.getByRole('tree', { name: 'Workspace files' })
}

/**
 * VERIFIED (source). One tree row by file name (aria-label of the
 * treeitem). Names are unique only within a folder; for nested files
 * prefer fileTreeItemByPath.
 *
 * VIRTUALIZATION CAVEAT: the tree renders only visible rows
 * (rowVirtualizer in file-manager.tsx). A row that is scrolled out
 * of view, or inside a collapsed folder, is not in the DOM at all,
 * so this locator cannot find it until the flow scrolls it into
 * view or narrows the tree with the filter input.
 */
export function fileTreeItemByName(page: Page, fileName: string): Locator {
  return fileTree(page).getByRole('treeitem', { name: fileName, exact: true })
}

/**
 * VERIFIED (source). One tree row by workspace-relative path, for
 * example "notes/getting-started.md". The attribute value is built by
 * computedParentPath from parent folder names, so it never contains
 * the absolute workspace root. Same virtualization caveat as
 * fileTreeItemByName: only rendered rows are in the DOM.
 */
export function fileTreeItemByPath(page: Page, relativePath: string): Locator {
  return fileTree(page).locator(`[data-file-manager-item-path="${relativePath}"]`)
}

/** VERIFIED (source). File tree filter input in the file panel. */
export function fileFilterInput(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Search files' })
}

/** VERIFIED (source). Global sidebar search input (always visible). */
export function globalSearchInput(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Search notes, records, and canvases...' })
}

/** VERIFIED (source). Sidebar search empty state heading. */
export function searchNoResults(page: Page): Locator {
  return page.getByText('No search results', { exact: true })
}

/**
 * VERIFIED (source, via cmdk). One sidebar search result. CommandItem
 * renders role "option"; the accessible name is the result title plus
 * its highlight snippet text.
 */
export function searchResult(page: Page, title: string): Locator {
  return page.getByRole('option', { name: title })
}

/** VERIFIED (source). "New Note" toolbar button (TooltipButton aria-label). */
export function newNoteButton(page: Page): Locator {
  return page.getByRole('button', { name: 'New Note', exact: true })
}

/** VERIFIED (source). "New Folder" toolbar button. */
export function newFolderButton(page: Page): Locator {
  return page.getByRole('button', { name: 'New Folder', exact: true })
}

/** VERIFIED (source). "Refresh" toolbar button for the file tree. */
export function refreshButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Refresh', exact: true })
}

/**
 * UNVERIFIED. Tiptap visual editor surface. Tiptap/ProseMirror renders
 * a `.ProseMirror` element with contenteditable inside EditorContent
 * (tiptap-editor.tsx), but no repo source pins the class name, so a
 * Tiptap upgrade could change it. Prove by a passing run before
 * relying on it.
 */
export function visualEditor(page: Page): Locator {
  return page.locator('.ProseMirror')
}

/**
 * UNVERIFIED. CodeMirror source editor content element. The aria-label
 * "Source mode" is VERIFIED (source) via settings.editor.sourceMode in
 * messages/en.json and the ariaLabel prop in tiptap-editor.tsx, but
 * the `.cm-content` class and its textbox role come from CodeMirror
 * internals, not from repo source.
 */
export function sourceEditor(page: Page): Locator {
  return page.locator('.cm-content[aria-label="Source mode"]')
}

/**
 * UNVERIFIED. Images rendered inside the visual editor. The image node
 * keeps `data-relative-src` as the markdown source of truth
 * (tiptap-editor.tsx Image extension), but the rendered <img> markup
 * is produced by Tiptap and was not checked in a live DOM.
 */
export function editorImages(page: Page): Locator {
  return visualEditor(page).locator('img')
}

/**
 * UNVERIFIED. Settings dialog. The dialog title "Settings" is
 * VERIFIED (source) via settings-dialog.tsx (sr-only DialogTitle
 * from settings.title), but whether Radix exposes it as the dialog
 * accessible name in the live DOM was not checked. The buttons that
 * OPEN settings (title bar, app sidebar) have NO aria-label in source,
 * only tooltip text, so there is deliberately no opener locator here:
 * opening settings by role/name is NOT VERIFIABLE until the UI owner
 * adds an accessible name or a test id.
 */
export function settingsDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Settings' })
}

/**
 * VERIFIED (source). "Manage tags" trigger button for the record tag
 * editor (record-tag-editor.tsx DialogTrigger Button, text
 * record.tagging.manage = "Manage tags"). One button exists per
 * record row that renders the editor, so a flow must scope this
 * locator to the record under test instead of matching page-wide.
 */
export function manageTagsButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Manage tags', exact: true })
}

/**
 * UNVERIFIED. Tag editor dialog. The title "Manage tags" is VERIFIED
 * (source) via record-tag-editor.tsx (DialogTitle from
 * record.tagging.manage), but whether Radix exposes it as the dialog
 * accessible name in the live DOM was not checked.
 */
export function tagEditorDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Manage tags' })
}

/**
 * UNVERIFIED. One tag checkbox inside the tag editor, by tag name.
 * The checkbox is labelled by the tag name through htmlFor
 * (record-tag-editor.tsx); the primary tag label carries a
 * " (primary)" suffix and its checkbox is disabled in source. The
 * rendered checkbox role and label association were not checked in
 * a live DOM. Pass the bare tag name; for the primary tag the flow
 * must assert the disabled state instead of clicking.
 */
export function tagCheckbox(page: Page, tagName: string): Locator {
  return tagEditorDialog(page).getByRole('checkbox', { name: tagName })
}

/**
 * UNVERIFIED. Record row detail button, by its accessible label. The
 * button carries data-mark-detail-trigger="true" and aria-label equal
 * to the record content or, when empty, the type label (mark-item.tsx:
 * label = content || t(mark.type)). The label is content-derived, so
 * a flow must use a seeded record with a fixed unique content string,
 * and must prove the label in a live DOM before relying on it.
 */
export function markDetailButton(page: Page, label: string): Locator {
  // The button has no text content; its accessible name is the label
  // alone (aria-label in mark-item.tsx), so role/name is the hook.
  // The data-mark-detail-trigger attribute exists in source but is
  // not combined here: combining it with an aria-label match would
  // need manual attribute escaping for arbitrary content strings.
  return page.getByRole('button', { name: label, exact: true })
}

/**
 * UNVERIFIED. "Delete" entry of the file tree context menu. The text
 * "Delete" is VERIFIED (source) in the English catalog
 * (article.file.context.delete) and the deletion handler exists
 * (file-item.tsx useFileDeletion). The menu container role, the
 * menuitem role, and the trigger mechanism were NOT traced to a
 * component, so this locator must be proven in a live DOM (menu
 * opens, item clickable) before any flow relies on it. Do not drive
 * deletion through the 'filemanager-delete' window event instead:
 * that bypasses the UI the user actually uses.
 */
export function deleteMenuItem(page: Page): Locator {
  return page.getByRole('menuitem', { name: 'Delete', exact: true })
}

/**
 * Best-effort error surface check. A production static export has no
 * Next.js dev overlay; a failed boot shows either a blank page or an
 * error boundary message. This locator covers the common boundary
 * texts only. It is UNVERIFIED and must never be the sole boot
 * assertion: the boot spec asserts the tree is visible, which fails
 * on a blank page regardless of this locator.
 */
export function errorBoundaryText(page: Page): Locator {
  return page.getByText(/Application error|Something went wrong/)
}
