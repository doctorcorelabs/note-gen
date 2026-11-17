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
//   the UI owner before an E2E flow can rely on it. This scaffold adds
//   no `data-testid` attributes: UI changes belong to the UI owners,
//   not to the test scaffold.
//
// Evidence summary (full table in tests/e2e/README.md):
// - The reference repo had ZERO `data-testid` attributes anywhere in
//   src/. On trunk 69c77dac the search UI has test ids (see the search
//   test-id locators below); the login and setup pages have none.
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
// - Login and setup pages shipped in V3-03 (src/app/login/page.tsx,
//   src/app/setup/page.tsx, trunk 69c77dac) with label-associated
//   fields; their locators are below. Archive-download UI still does
//   not exist and is NOT VERIFIABLE: no locators for it exist here by
//   design. See archive-download.spec.ts.

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
 * VERIFIED (source) [trunk 69c77dac]. A login page alert carrying
 * the given text. The page renders two possible role="alert"
 * elements (request error and field error); the caller asserts by
 * exact text, for example "Email or password is incorrect." for a
 * failed login (ERROR_MESSAGES in the page source). The generic
 * failure text is the anti-enumeration behavior: the same message
 * covers unknown and known emails.
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
