// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Page object for the main NoteGen web UI (/core/main).
//
// Locators live in ./selectors.ts; this class only composes them into
// the reusable actions the six E2E flows need. Methods that no landed
// flow uses yet are still wired to verified locators and are kept
// small so a flow author can call them without re-deriving selectors.
//
// Anti-flaky rules (desain-pengujian 4.3) apply to every method here:
// no fixed sleeps, no waitForTimeout. Every wait is an observation:
// an element becoming visible, a URL changing, or a response
// arriving. Debounces (editor autosave, watcher) are waited out
// through their effects, never through timers.

import { expect, type Page } from '@playwright/test'

import {
  errorBoundaryText,
  fileTree,
  fileTreeItemByName,
  fileTreeItemByPath,
  globalSearchInput,
  manageTagsButton,
  newNoteButton,
  searchNoResults,
  searchResult,
} from './selectors'

/**
 * Validate a gateway origin passed to a navigation method. Only an
 * absolute http(s) URL is accepted, and a trailing slash is removed
 * so callers can append paths without producing a double slash. A
 * relative path or an unparseable value fails here, at the call
 * site, instead of navigating to the wrong origin.
 */
export function assertGatewayOrigin(pageUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(pageUrl)
  } catch {
    throw new Error(
      'e2e navigation failed: the gateway origin does not parse as a URL. ' +
        'Pass backend.pageUrl from the backend fixture, never a relative path.',
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      'e2e navigation failed: the gateway origin must use http or https. ' +
        'Pass backend.pageUrl from the backend fixture.',
    )
  }
  return parsed.origin
}

export class AppPage {
  constructor(private readonly page: Page) {}

  /**
   * Open / at the given gateway origin and follow the boot redirect
   * to /core/main.
   *
   * The origin is a REQUIRED parameter and must be the backend
   * fixture gateway origin (`backend.pageUrl`). It must never be
   * left to the Playwright config baseURL: the config webServer is
   * static-only on purpose (it serves no /api/* route, so the boot
   * guard blocks there by design), while the fixture gateway is a
   * separate per-test origin that proxies /api/* to the test
   * backend and holds the session cookie. Navigating to `/` without
   * an origin resolves against the config baseURL and always lands
   * on the guard screen; that exact mistake blocked the W4-I18N
   * authenticated profile runs (finding T-8) and was reproduced
   * verbatim by W4-FLOWS before this signature change. The required
   * parameter makes the mistake a compile error instead of a
   * 30-second timeout.
   *
   * Precondition: an authenticated backend that answers /api/auth/me
   * with 200 plus healthy /api/health/* responses. Without a backend
   * the boot guard blocks at / (BOOT_SESSION_UNKNOWN) and this wait
   * times out by design; the no-backend path is covered by
   * boot.spec.ts E2E-01, not by this method.
   */
  async gotoHome(pageUrl: string): Promise<void> {
    await this.page.goto(`${assertGatewayOrigin(pageUrl)}/`)
    await this.awaitHome()
  }

  /** Wait for the URL to reach /core/main (boot redirect or reload). */
  async awaitHome(): Promise<void> {
    await this.page.waitForURL('**/core/main', {
      timeout: 30_000,
    })
  }

  /**
   * Reload the current page and wait for the shell URL again. The
   * reload stays on the current origin, so no origin parameter is
   * needed: the caller must already be on the gateway origin.
   */
  async reloadHome(): Promise<void> {
    await this.page.reload()
    await this.awaitHome()
  }

  /** Wait until the file tree is rendered and visible. */
  async waitForFileTree(): Promise<void> {
    await expect(fileTree(this.page)).toBeVisible()
  }

  /** Boot assertion set: tree visible, page non-blank, no error text. */
  async expectBooted(): Promise<void> {
    await this.waitForFileTree()
    await expect(errorBoundaryText(this.page)).toHaveCount(0)
    const bodyText = await this.page.locator('body').innerText()
    expect(
      bodyText.trim().length,
      'Boot produced a blank page: <body> has no visible text.',
    ).toBeGreaterThan(0)
  }

  /** Open a file from the tree by its displayed file name. */
  async openFileByName(fileName: string): Promise<void> {
    await fileTreeItemByName(this.page, fileName).click()
  }

  /**
   * Click a folder row in the tree to expand it. The caller waits
   * for the child row it needs afterwards by observation; this
   * method only performs the click, because expansion state is not
   * exposed as a stable attribute to wait on. WARNING: the click
   * TOGGLES. After a reload the tree can start EXPANDED (W4-FLOWS
   * probe10B: all children visible without any click), so an
   * unconditional click after reload COLLAPSES the folder. Use
   * ensureFolderExpanded for post-reload flows.
   */
  async expandFolderByName(folderName: string): Promise<void> {
    await fileTreeItemByName(this.page, folderName).click()
  }

  /**
   * Ensure a folder is expanded WITHOUT toggling it closed: click
   * the folder row only when the named child row is absent, then
   * wait for the child row by observation. Required after reloads,
   * where the tree may restore expanded (probe10B). On a fresh
   * boot the tree starts collapsed, so the click always runs
   * there; the conditional form is still safe and is preferred
   * wherever the prior expansion state is unknown.
   */
  async ensureFolderExpanded(folderName: string, childFileName: string): Promise<void> {
    if ((await fileTreeItemByName(this.page, childFileName).count()) === 0) {
      await fileTreeItemByName(this.page, folderName).click()
    }
    await expect(fileTreeItemByName(this.page, childFileName)).toBeVisible({ timeout: 30_000 })
  }

  /** Open a file from the tree by workspace-relative path. */
  async openFileByPath(relativePath: string): Promise<void> {
    await fileTreeItemByPath(this.page, relativePath).click()
  }

  /**
   * Switch the sidebar to the Record (inbox) tab and wait for the
   * inbox list to render. The collapsed sidebar tabs have no
   * accessible name (ExpandableTabs renders the title text only for
   * the selected tab; finding D-DEMO-7), so the switch uses the
   * icon-click workaround proven by W4-DEMO: a DOM click on the
   * button containing the lucide-highlighter svg, followed by an
   * observation wait for #web-inbox. The accessibility fix
   * (accessible names on collapsed tabs) is follow-up UI work.
   * Idempotent: when the inbox is already rendered, no click is
   * performed (a click on the selected tab may toggle the
   * sidebar closed, and the tab state survives reloads).
   */
  async switchToRecordsTab(): Promise<void> {
    // Visibility, not presence: #web-inbox stays mounted (hidden)
    // while the Files tab is selected, so a count check would skip
    // the click and then time out waiting for a hidden element.
    if (await this.page.locator('#web-inbox').isVisible()) {
      return
    }
    // Wait for the tab bar to exist before evaluating: right
    // after a reload the shell may still be mounting, and an
    // immediate evaluate finds no icon button at all (E2E-RELOAD
    // rerun-3: "no button contains the lucide-files icon").
    await this.page
      .locator('button:has(svg.lucide-highlighter)')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
    const clicked = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const visible = buttons.filter(
        (button) => button.querySelector('svg.lucide-highlighter') !== null && button.offsetParent !== null,
      )
      if (visible.length === 0) return false
      visible[0].click()
      return true
    })
    if (!clicked) {
      throw new Error('e2e tab switch failed: no button contains the lucide-highlighter icon.')
    }
    await expect(this.page.locator('#web-inbox')).toBeVisible({ timeout: 10_000 })
  }

  /**
   * Switch the sidebar to the Files (notes tree) tab and wait for
   * the file tree to render. Same icon-click workaround as
   * switchToRecordsTab (lucide-files), for the same D-DEMO-7
   * reason. Idempotent: when the tree is already rendered, no
   * click is performed.
   */
  async switchToFilesTab(): Promise<void> {
    // Visibility, not presence: the tree stays mounted (hidden)
    // while the Record tab is selected (same trap as #web-inbox).
    if (await fileTree(this.page).isVisible()) {
      return
    }
    // Wait for the tab bar to exist before evaluating (see
    // switchToRecordsTab: post-reload the shell may still be
    // mounting when this runs).
    await this.page
      .locator('button:has(svg.lucide-files)')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
    const clicked = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const visible = buttons.filter(
        (button) => button.querySelector('svg.lucide-files') !== null && button.offsetParent !== null,
      )
      if (visible.length === 0) return false
      visible[0].click()
      return true
    })
    if (!clicked) {
      throw new Error('e2e tab switch failed: no button contains the lucide-files icon.')
    }
    await this.waitForFileTree()
  }

  /** Start a new note through the toolbar button. */
  async createNewNote(): Promise<void> {
    await newNoteButton(this.page).click()
  }

  /** Type a query into the global sidebar search input. */
  async searchGlobally(query: string): Promise<void> {
    await globalSearchInput(this.page).fill(query)
  }

  /** Assert the sidebar search shows the empty state. */
  async expectNoSearchResults(): Promise<void> {
    await expect(searchNoResults(this.page)).toBeVisible()
  }

  /** Open a sidebar search result by its title. */
  async openSearchResult(title: string): Promise<void> {
    await searchResult(this.page, title).click()
  }

  /**
   * Open the tag editor for the record under test ("Manage tags"
   * button). DESKTOP detail panel surface only: the web inbox flow
   * opens the WebRecordDetail dialog instead, where tags are edited
   * with TagChecklist plus "Save tags" (see selectors
   * recordDetailDialog / recordDetailTagCheckbox). Kept for the
   * desktop panel; web flows must not call it.
   */
  async openTagEditor(): Promise<void> {
    await manageTagsButton(this.page).click()
  }
}
