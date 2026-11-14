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
  newNoteButton,
  searchNoResults,
  searchResult,
} from './selectors'

export class AppPage {
  constructor(private readonly page: Page) {}

  /** Open / and follow the boot redirect to /core/main. */
  async gotoHome(): Promise<void> {
    await this.page.goto('/')
    await this.page.waitForURL('**/core/main', {
      timeout: 30_000,
    })
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

  /** Open a file from the tree by workspace-relative path. */
  async openFileByPath(relativePath: string): Promise<void> {
    await fileTreeItemByPath(this.page, relativePath).click()
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
}
