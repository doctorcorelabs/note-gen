// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Central E2E locators for the NoteGen web fork UI.
//
// Every locator below was checked against the actual components in the
// reference repo (HEAD 4dcaa3f), EXCEPT the locators marked
// "[trunk 69c77dac, 3D e2e-prep]", which were checked against fork
// trunk at 69c77dac (login/setup pages from V3-03, search test ids
// from V3-28). The verification status of each locator is stated in
// its comment:
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
//   the UI owner before an E2E flow can rely on it. The original
//   scaffold added no `data-testid` attributes; W4-FLOWS added the
//   hooks its flows need (Settings opener, rename input, login/setup
//   fields) as additive attributes only, flagged in the slot report
//   as product-touching changes for the integrator to decide.
//
// Evidence summary (full table in tests/e2e/README.md; runtime
// evidence below is from the W4-FLOWS probe runs on trunk 3b9a8809,
// 17 Nov 2026, plus the conversion runs recorded in
// laporan-3e-w4-flows-r12.md):
//
// DEBT (6) RECOUNT (W4-FLOWS, tips 77f1576d/86ce4d03, 17-18 Nov
// 2026): 28 of the 70 exported selector functions were called in
// a passing live run (Tier A): fileTree, fileTreeItemByName,
// searchResult, settingsDialog, settingsOpenerButton,
// newFileMenuItem, renameInput, viewModeToggleToSource,
// viewModeToggleToVisual, editorLinkByName (resolution only;
// navigation is blocked by product defect D-LINK), webInbox,
// webInboxRecordButton, recordDetailDialog,
// recordDetailTagCheckbox, recordDetailSaveTagsButton,
// visibleVisualEditor, visibleSourceEditor, errorBoundaryText,
// loginTitleText, loginEmailInput, loginPasswordInput,
// loginSubmitButton, loginErrorByTestId, searchInputByTestId,
// searchResultsByTestId, searchEmptyStateByTestId,
// searchFuzzyStatusByTestId. Baseline at V3-41 was 2/43.
// Three more selector PATTERNS were observed live through
// equivalent raw locators in probes while the functions
// themselves were never called (Tier B): refreshButton (probe10A
// click revealed the file), newNoteButton (probe4 count 1),
// deleteMenuItem (probe9 click; deletion blocked by AD-33).
// Proven-broken or absent at recount time: loginAlertByText
// (deprecated, probe14), manageTagsButton (absent in the web
// flow, desktop-only). editorLinkByHref was proven-broken at
// recount time (href rendered empty) and functions again since
// W4-FIXLINK, because the href now renders (AD-125 item 4).
// Its Tier A reclassification awaits a live run at the next
// recount. All
// other functions rest on source evidence only; several are
// referenced only by uncalled AppPage helpers (openFileByPath,
// createNewNote, searchGlobally, expectNoSearchResults) or by
// flows with no live spec yet (TOTP, recovery, setup).
// - Test ids now exist on the search UI (V3-28), the login/setup
//   pages (W4-FLOWS), the Settings opener (W4-FLOWS, top-app-bar),
//   and the rename input (W4-FLOWS, file-item). The reference repo
//   had ZERO data-testid attributes anywhere in src/.
// - File tree: role "tree", aria-label is the TRANSLATED
//   treeLabel ("Workspace files" / "工作区文件"); the fileTree
//   locator matches the first tree role and is locale-free.
//   Tree items: role "treeitem", aria-label = file name, plus
//   data-file-manager-item-path. The tree starts COLLAPSED (only
//   the top folder renders); flows must expand folders first.
// - Sidebar tab buttons carry an accessible name in every state
//   (expandable-tabs.tsx sets aria-label + title from the tab
//   title, D-DEMO-7): tab switching uses the role-based locator
//   (sidebarTabButton; AppPage.switchToRecordsTab /
//   switchToFilesTab). The icon-class workaround is retired.
// - Tag editing in the WEB flow happens in the WebRecordDetail
//   dialog (TagChecklist + "Save tags"), NOT through the desktop
//   "Manage tags" button (MarkDetailPanel is not mounted in the
//   web inbox flow; probes confirmed the button is absent).
// - File delete menu item "Delete" (Radix menuitem, right-click
//   trigger) is VERIFIED in a live DOM; choosing it cannot
//   complete a deletion today (no dialog service wired, AD-33;
//   see notes-crud.spec.ts).
// - Login and setup pages shipped in V3-03 with label-associated
//   fields; their locators are below. Archive-download UI still
//   does not exist and is NOT VERIFIABLE: no locators for it exist
//   here by design. See archive-download.spec.ts.
// - The shell can mount MORE THAN ONE editor at once (one per open
//   tab; probe2 counted 2 .ProseMirror and 2 .cm-content). Flows
//   must use the visible-scoped editor locators
//   (visibleVisualEditor / visibleSourceEditor).
// - Rendered document links carry their relative href in the
//   live DOM since W4-FIXLINK (AD-125); locate links by href
//   (editorLinkByHref) or by visible text (editorLinkByName).

import type { Locator, Page } from '@playwright/test'

/** VERIFIED (source). File tree container. */
/**
 * The workspace file tree. Locale-independent on purpose: the
 * tree's aria-label is the translated `article.file.treeLabel`
 * ("Workspace files" in en, "工作区文件" in zh; proven by the
 * I18N-9.5-ZH run, whose snapshot shows the zh tree while the
 * en-named locator found nothing). The shell renders exactly one
 * tree in the Files tab state all tree specs run in, so the
 * first tree role is the workspace tree; scoping treeitem
 * lookups inside it keeps them out of dialogs.
 */
export function fileTree(page: Page): Locator {
  return page.getByRole('tree').first()
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
 * VERIFIED (source + W4-FLOWS product hook). Settings dialog. The
 * dialog title "Settings" is VERIFIED (source) via settings-dialog.tsx
 * (sr-only DialogTitle from settings.title), but whether Radix exposes
 * it as the dialog accessible name in the live DOM was not checked.
 * The opener hook that was missing at scaffold time (register R3 /
 * finding T-5) landed in W4-FLOWS: the shipped web opener in
 * top-app-bar.tsx carries aria-label (the tooltip string) plus
 * data-testid "settings-open" (see settingsOpenerButton below). The
 * title-bar and app-sidebar openers are unmounted legacy chrome in
 * the web fork (0 importers) and carry no hook.
 */
export function settingsDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Settings' })
}

/**
 * VERIFIED (source + W4-FLOWS product hook). The button that opens
 * Settings, by test id. Locale-independent: prefer this over the
 * role/name form in any flow that runs in more than one locale,
 * because the accessible name is the translated tooltip string.
 * Exactly one opener renders in the web shell (top-app-bar.tsx).
 */
export function settingsOpenerButton(page: Page): Locator {
  return page.getByTestId('settings-open')
}

/**
 * VERIFIED (source + W4-FLOWS product hook). The button that opens
 * Settings, by accessible name, in the default locale only
 * ("Settings" from common.settings). Use settingsOpenerButton for
 * locale-independent flows.
 */
export function settingsOpenerByRole(page: Page): Locator {
  return page.getByRole('button', { name: 'Settings', exact: true })
}

/**
 * VERIFIED (source). One tab inside the Settings dialog, by its
 * visible tab name (for example "Editor Settings"). The dialog must
 * already be open; scope to settingsDialog.
 */
export function settingsTab(page: Page, tabName: string): Locator {
  return settingsDialog(page).getByRole('tab', { name: tabName, exact: true })
}

/**
 * VERIFIED (source) for the DESKTOP detail panel only. "Manage tags"
 * trigger button for the record tag editor (record-tag-editor.tsx
 * DialogTrigger Button, text record.tagging.manage = "Manage tags"),
 * rendered by MarkDetailPanel. The web inbox flow does NOT mount
 * that panel: clicking an inbox row opens the WebRecordDetail
 * dialog instead (recordDetailDialog), where tags are edited with
 * TagChecklist plus "Save tags". W4-FLOWS probes confirmed no
 * "Manage tags" button exists in the web inbox flow. Do not use
 * this locator in a web flow; it is kept for the desktop panel
 * surface only.
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
 * VERIFIED (live DOM, W4-FLOWS probes 4/7). "Delete" entry of the
 * file tree context menu. The menu is a Radix menu (role menuitem),
 * opened by right-clicking a treeitem; the item text is "Delete"
 * plus the "Del" shortcut hint, so the name match is deliberately
 * NOT exact. Do not drive deletion through the 'filemanager-delete'
 * window event: that bypasses the UI the user actually uses.
 * NOTE: choosing Delete cannot complete a deletion in web mode
 * today (no dialog service is wired, so the confirmation throws;
 * AD-33). See notes-crud.spec.ts for the blocker and evidence.
 */
export function deleteMenuItem(page: Page): Locator {
  return page.getByRole('menuitem', { name: 'Delete' })
}

/**
 * VERIFIED (live DOM, W4-FLOWS probe7). "New File" entry of a
 * FOLDER context menu (right-click a folder row). Creates the new
 * file INSIDE that folder, unlike the toolbar "New Note" button,
 * which creates at the workspace root (probe6). E2E-02 uses this
 * entry to place the created note under notes/.
 */
export function newFileMenuItem(page: Page): Locator {
  return page.getByRole('menuitem', { name: 'New File', exact: true })
}

/**
 * VERIFIED (source + W4-FLOWS product hook). File rename input, by
 * test id. Register R1 is closed by the hook in file-item.tsx
 * (data-testid "file-rename-input" plus aria-label from
 * article.file.context.rename = "Rename"). The input exists only
 * while a row is being renamed or a new file/folder is being named;
 * a flow must trigger rename mode first and wait for this locator.
 */
export function renameInput(page: Page): Locator {
  return page.getByTestId('file-rename-input')
}

/**
 * Fallback for the rename input, scoped to the visible input inside
 * the file tree (the pattern proven by the W4-DEMO rerun). Prefer
 * renameInput; use this only to cross-check the hook in a live DOM.
 */
export function renameInputInTree(page: Page): Locator {
  return fileTree(page).locator('input:visible').first()
}

/**
 * VERIFIED (source). Editor view-mode toggle button in the editor
 * footer, in its visual state: the button carries the CURRENT mode
 * as its accessible name ("WYSIWYG" while visual, footer-bar
 * index.tsx), so clicking it switches to source mode. Only rendered
 * when the editor exposes the toggle.
 */
export function viewModeToggleToSource(page: Page): Locator {
  return page.getByRole('button', { name: 'WYSIWYG', exact: true })
}

/**
 * VERIFIED (source). Editor view-mode toggle button in the editor
 * footer, in its source state ("Source mode" while source). Clicking
 * it switches back to visual mode. Distinct from sourceEditor: this
 * is the footer button (role button), not the CodeMirror content.
 */
export function viewModeToggleToVisual(page: Page): Locator {
  return page.getByRole('button', { name: 'Source mode', exact: true })
}

/**
 * UNVERIFIED. A link inside the visual editor, by its href as
 * written in the document (for example "nested/deep-note.md"). The
 * rendered href in the live DOM may be resolved or rewritten by
 * Tiptap, so a flow must prove the match in a live DOM before
 * relying on it; prefer editorLinkByName when the link text is
 * unique.
 */
export function editorLinkByHref(page: Page, href: string): Locator {
  return visualEditor(page).locator(`a[href="${href}"]`)
}

/**
 * UNVERIFIED. A link inside the visual editor, by its visible link
 * text. Tiptap renders document links as anchors; the accessible
 * name is the link text.
 */
export function editorLinkByName(page: Page, linkText: string): Locator {
  return visualEditor(page).getByRole('link', { name: linkText, exact: true })
}

/**
 * VERIFIED (source). One sidebar tab button, by its accessible
 * name (for example "Record", "Notes", or "Canvas" in the en
 * locale). ExpandableTabs sets aria-label + title from the tab
 * title, so the name resolves whether the tab is selected or
 * collapsed (D-DEMO-7). Names are locale-dependent: the en names
 * are the harness default, matching the other pinned en strings
 * here. Prefer this over buttonWithIcon for tab switching.
 * CAUTION: do not use this helper for "Canvas": the shell top
 * bar carries a second, pre-existing button named "Canvas", so
 * an unscoped "Canvas" role query resolves to two buttons (see
 * sidebar-tabs-a11y.spec.ts for the scoped form). "Record" and
 * "Notes" resolve uniquely shell-wide.
 */
export function sidebarTabButton(page: Page, tabName: string): Locator {
  return page.getByRole('button', { name: tabName, exact: true })
}

/**
 * Legacy workaround locator (D-DEMO-7, retired for tab
 * switching): a button identified by the Lucide icon class of
 * the svg it contains (for example "lucide-highlighter" for the
 * Record tab, "lucide-files" for the Files tab). Sidebar tabs
 * now carry accessible names (sidebarTabButton), so flows must
 * not use this locator to switch tabs. No live flow calls it
 * since the fix; it stays exported pending an E2EDEBT census
 * decision on removal. Pass the bare icon class without the
 * leading dot.
 */
export function buttonWithIcon(page: Page, iconClass: string): Locator {
  return page.locator(`button:has(svg.${iconClass})`)
}

/** VERIFIED (source). The mounted web inbox list container. */
export function webInbox(page: Page): Locator {
  return page.locator('#web-inbox')
}

/**
 * VERIFIED (source + W4-FLOWS probe6). One record row button inside
 * the web inbox list, by the record title text it displays. The row
 * button is the direct `button.min-w-0` child of the row `li`
 * (web-inbox-list.tsx); the selector pins that structure so the
 * selection checkbox (also a button, aria-label set to the same
 * title) can never match. Clicking the row opens the
 * WebRecordDetail dialog (recordDetailDialog), NOT the desktop
 * mark detail panel.
 */
export function webInboxRecordButton(page: Page, titleText: string): Locator {
  return webInbox(page).locator('li button.min-w-0', { hasText: titleText }).first()
}

/**
 * VERIFIED (source + W4-FLOWS probe6). The web record detail dialog
 * (WebRecordDetail), by the record title it carries as its dialog
 * title. The dialog opens when an inbox row is clicked. Tag editing
 * in the web flow happens inside this dialog (TagChecklist plus
 * "Save tags"), not through the desktop "Manage tags" button.
 */
export function recordDetailDialog(page: Page, titleText: string): Locator {
  return page.getByRole('dialog', { name: titleText })
}

/**
 * VERIFIED (source + W4-FLOWS probe6). One tag checkbox inside the
 * record detail dialog, by tag name. The checkbox label is the tag
 * name (TagChecklist, web-inbox-shared.tsx); the primary tag's
 * checkbox is locked (disabled) and checked.
 */
export function recordDetailTagCheckbox(page: Page, tagName: string): Locator {
  return page.getByRole('dialog').first().getByRole('checkbox', { name: tagName, exact: true })
}

/**
 * VERIFIED (source + W4-FLOWS probe6). The "Save tags" button inside
 * the record detail dialog. It renders ONLY while the tag selection
 * differs from the saved set (tagsChanged), so a flow must change a
 * checkbox first and wait for this button by observation.
 */
export function recordDetailSaveTagsButton(page: Page): Locator {
  return page.getByRole('dialog').first().getByRole('button', { name: 'Save tags', exact: true })
}

/**
 * VERIFIED (live DOM, W4-FLOWS probe2). The VISIBLE Tiptap editor.
 * The shell can mount more than one .ProseMirror at once (probe2
 * counted 2 after opening two notes: one per open tab), so an
 * unscoped visualEditor match can read the WRONG tab. Flows that
 * assert editor content after opening a note must use this
 * visible-scoped form.
 */
export function visibleVisualEditor(page: Page): Locator {
  return page.locator('.ProseMirror:visible')
}

/**
 * VERIFIED (live DOM, W4-FLOWS probe2). The VISIBLE CodeMirror
 * source editor. Same multi-instance warning as
 * visibleVisualEditor: probe2 counted 2 .cm-content after a
 * view-mode toggle with two tabs open. Flows that type or read in
 * source mode must use this visible-scoped form.
 */
export function visibleSourceEditor(page: Page): Locator {
  return page.locator('.cm-content[aria-label="Source mode"]:visible')
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

// ---------------------------------------------------------------------------
// Login (/login) and setup (/setup) pages [trunk 69c77dac, 3D e2e-prep].
//
// Shipped in V3-03 (src/app/login/page.tsx, src/app/setup/page.tsx).
// Strings are hardcoded English in the page source (boot-guard
// precedent; no `auth` catalog namespace exists yet), and every field
// below is label-associated through htmlFor plus a fixed id, so the
// label locators are VERIFIED (source). Runtime behavior is still
// unverified until a green run. Neither page carries a `data-testid`
// (verified by grep on trunk): the auth-* test ids the selector
// inventory asked for (inventaris-selector-e2e.md 3.3/10.1) were not
// added by V3-03, so these locators use labels and roles; asking the
// UI owner for test ids remains open, and no flow may invent one.
//
// CardTitle renders a plain <div>, NOT a heading element
// (src/components/ui/card.tsx), so the page titles below are text
// locators, never getByRole('heading'). The submit buttons change
// text while busy ("Signing in...", "Verifying...",
// "Creating account..."), so exact-name matching is what makes a
// locator wait for the idle state instead of matching mid-request.
// ---------------------------------------------------------------------------

/**
 * VERIFIED (source) [trunk 69c77dac]. Login page title text
 * ("Sign in to NoteGen"). Text locator, not a heading: CardTitle
 * renders a div. Visible only after the session probe finishes, so
 * waiting for it also waits out the "Checking your session..." state.
 */
export function loginTitleText(page: Page): Locator {
  return page.getByText('Sign in to NoteGen', { exact: true })
}

/** VERIFIED (source) [trunk 69c77dac]. Login email field (label "Email", id login-email). */
export function loginEmailInput(page: Page): Locator {
  return page.getByLabel('Email', { exact: true })
}

/** VERIFIED (source) [trunk 69c77dac]. Login password field (label "Password", id login-password). */
export function loginPasswordInput(page: Page): Locator {
  return page.getByLabel('Password', { exact: true })
}

/**
 * VERIFIED (source) [trunk 69c77dac]. Login submit button ("Sign
 * in"; "Signing in..." while busy, which the exact match excludes).
 */
export function loginSubmitButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Sign in', exact: true })
}

/**
 * VERIFIED (source) [trunk 69c77dac]. Second-step title text
 * ("Two-step verification"), shown when the server answers the
 * first step with a 202 TOTP challenge. Text locator, not a heading
 * (CardTitle renders a div).
 */
export function loginTotpTitleText(page: Page): Locator {
  return page.getByText('Two-step verification', { exact: true })
}

/** VERIFIED (source) [trunk 69c77dac]. TOTP code field (label "Verification code", id login-code). */
export function loginTotpCodeInput(page: Page): Locator {
  return page.getByLabel('Verification code', { exact: true })
}

/** VERIFIED (source) [trunk 69c77dac]. Recovery code field (label "Recovery code", id login-recovery-code). */
export function loginRecoveryCodeInput(page: Page): Locator {
  return page.getByLabel('Recovery code', { exact: true })
}

/**
 * VERIFIED (source) [trunk 69c77dac]. Second-step submit button
 * ("Verify"; "Verifying..." while busy).
 */
export function loginVerifyButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Verify', exact: true })
}

/**
 * VERIFIED (source) [trunk 69c77dac]. Toggle from the authenticator
 * step to the recovery-code step ("Use a recovery code instead").
 */
export function loginUseRecoveryCodeButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Use a recovery code instead', exact: true })
}

/**
 * DEPRECATED (W4-FLOWS probe14): do not use for the login error
 * alert. The exact-name role query resolves ZERO elements even
 * while the alert is rendered with exactly the queried text
 * (two role="alert" nodes exist; the accessible-name computation
 * does not yield the visible text). Use loginErrorByTestId plus
 * text containment instead (LoginPage.expectAlert does this).
 * Kept exported only so existing imports keep compiling; new
 * specs must not call it.
 */
export function loginAlertByText(page: Page, text: string): Locator {
  return page.getByRole('alert', { name: text, exact: true })
}

/**
 * VERIFIED (source) [trunk 69c77dac]. Session-expired notice on the
 * login page (role="status", shown when ?expired=1). Text locator:
 * the page also renders a "Checking your session..." status while
 * probing, so a bare status locator would be ambiguous.
 */
export function loginExpiredNotice(page: Page): Locator {
  return page.getByText('Your session has expired. Sign in again to continue.', { exact: true })
}

/**
 * VERIFIED (source) [trunk 69c77dac]. Setup page title text
 * ("Set up NoteGen"). Text locator, not a heading (CardTitle
 * renders a div).
 */
export function setupTitleText(page: Page): Locator {
  return page.getByText('Set up NoteGen', { exact: true })
}

/** VERIFIED (source) [trunk 69c77dac]. Setup token field (label "Setup token", id setup-token). */
export function setupTokenInput(page: Page): Locator {
  return page.getByLabel('Setup token', { exact: true })
}

/** VERIFIED (source) [trunk 69c77dac]. Setup email field (label "Email", id setup-email). */
export function setupEmailInput(page: Page): Locator {
  return page.getByLabel('Email', { exact: true })
}

/**
 * VERIFIED (source) [trunk 69c77dac]. Setup password field (label
 * "Password", id setup-password). Exact matching matters here: the
 * same form also has "Confirm password", which a substring match
 * would also match.
 */
export function setupPasswordInput(page: Page): Locator {
  return page.getByLabel('Password', { exact: true })
}

/** VERIFIED (source) [trunk 69c77dac]. Setup confirm-password field (label "Confirm password", id setup-confirm-password). */
export function setupConfirmPasswordInput(page: Page): Locator {
  return page.getByLabel('Confirm password', { exact: true })
}

/** VERIFIED (source) [trunk 69c77dac]. Setup workspace name field (label "Workspace name (optional)", id setup-workspace-name). */
export function setupWorkspaceNameInput(page: Page): Locator {
  return page.getByLabel('Workspace name (optional)', { exact: true })
}

/**
 * VERIFIED (source) [trunk 69c77dac]. Setup submit button ("Create
 * first account"; "Creating account..." while busy).
 */
export function setupSubmitButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Create first account', exact: true })
}

// ---------------------------------------------------------------------------
// Login (/login) and setup (/setup) pages: test-id hooks [W4-FLOWS].
//
// Added by W4-FLOWS (register item test-id, utang E2E (4)), matching
// the test ids the selector inventory proposed
// (inventaris-selector-e2e.md 3.3/10.1). The label/role locators
// above remain the primary hooks (they assert the visible form);
// the test-id locators below are the stable secondary hooks, and
// E2E-S1 proves both families in a live DOM. The recovery-mode
// toggle button carries data-testid "auth-use-recovery-code"
// (inventory names only the recovery input); the TOTP Verify button
// keeps its role/name locator (no inventory id was proposed).
// ---------------------------------------------------------------------------

/** VERIFIED (source + W4-FLOWS hook). Login email field, by test id. */
export function loginEmailByTestId(page: Page): Locator {
  return page.getByTestId('auth-email')
}

/** VERIFIED (source + W4-FLOWS hook). Login password field, by test id. */
export function loginPasswordByTestId(page: Page): Locator {
  return page.getByTestId('auth-password')
}

/** VERIFIED (source + W4-FLOWS hook). Login submit button, by test id. */
export function loginSubmitByTestId(page: Page): Locator {
  return page.getByTestId('auth-submit')
}

/** VERIFIED (source + W4-FLOWS hook). TOTP code field, by test id. */
export function loginTotpCodeByTestId(page: Page): Locator {
  return page.getByTestId('auth-totp-code')
}

/** VERIFIED (source + W4-FLOWS hook). Recovery code field, by test id. */
export function loginRecoveryCodeByTestId(page: Page): Locator {
  return page.getByTestId('auth-recovery-code')
}

/** VERIFIED (source + W4-FLOWS hook). Generic login error alert, by test id. */
export function loginErrorByTestId(page: Page): Locator {
  return page.getByTestId('auth-error')
}

/** VERIFIED (source + W4-FLOWS hook). Setup email field, by test id. */
export function setupEmailByTestId(page: Page): Locator {
  return page.getByTestId('auth-setup-email')
}

/** VERIFIED (source + W4-FLOWS hook). Setup password field, by test id. */
export function setupPasswordByTestId(page: Page): Locator {
  return page.getByTestId('auth-setup-password')
}

/** VERIFIED (source + W4-FLOWS hook). Setup submit button, by test id. */
export function setupSubmitByTestId(page: Page): Locator {
  return page.getByTestId('auth-setup-submit')
}

// ---------------------------------------------------------------------------
// Sidebar search, test-id hooks [trunk 69c77dac, 3D e2e-prep].
//
// Added by V3-28 (src/app/core/main/sidebar-search.tsx), matching the
// test ids the selector inventory proposed (inventaris-selector-e2e.md
// 10.4). These are the primary stable hooks for E2E-04; the older
// role/text locators above (globalSearchInput, searchNoResults,
// searchResult) are kept as fallback and for flows that assert the
// visible text itself. All five below are VERIFIED (source): the
// data-testid attributes are literal in component source.
// ---------------------------------------------------------------------------

/** VERIFIED (source) [trunk 69c77dac]. Sidebar search input, by test id. The same input carries the placeholder/aria-label text. */
export function searchInputByTestId(page: Page): Locator {
  return page.getByTestId('search-input')
}

/** VERIFIED (source) [trunk 69c77dac]. Sidebar search clear button, by test id. Rendered only while a query is present. */
export function searchClearButtonByTestId(page: Page): Locator {
  return page.getByTestId('search-clear')
}

/** VERIFIED (source) [trunk 69c77dac]. Sidebar search results list (CommandList), by test id. Scope result assertions to it. */
export function searchResultsByTestId(page: Page): Locator {
  return page.getByTestId('search-results')
}

/**
 * VERIFIED (source) [trunk 69c77dac]. Sidebar search empty state,
 * by test id. Contains the "No search results" title plus the
 * "Try using different keywords" description.
 */
export function searchEmptyStateByTestId(page: Page): Locator {
  return page.getByTestId('search-empty')
}

/**
 * VERIFIED (source) [trunk 69c77dac]. Fuzzy-status line (role
 * "status"), by test id. Only its presence and role are pinned
 * here: the exact wording comes from the search client, so a flow
 * must read the text and assert the contract meaning (fuzzy
 * unavailable in MVP) rather than an exact string fixed here.
 */
export function searchFuzzyStatusByTestId(page: Page): Locator {
  return page.getByTestId('search-fuzzy-status')
}
