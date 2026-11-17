// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-04: search. Results point at the right file; a term that exists
// nowhere yields an explicit empty state; activating a result opens
// the file. Design: fase1/desain-pengujian.md section 4.2.
//
// Status: LIVE (converted by W4-FLOWS). The search route is
// registered on trunk (W4-WIRE) and the W4-FLOWS probe observed a
// live result for the seed term (1 option, "Exact results" section,
// snippet carrying the seed term) plus the fuzzy-status notice
// ("Fuzzy matching is not available in this version. Results below
// are keyword matches only."). The fuzzy notice is asserted as a
// visible fact, not as a defect: keyword matching is the shipped
// behavior.
//
// Activation (finding D-DEMO-8): the DEMO rerun clicked a search
// option and observed no URL change and no editor content after a
// fixed 2-second wait, which is INCONCLUSIVE, not a failure: the
// handler (sidebar-search.tsx handleSelect) calls router.push to the
// URL the shell already has, so no URL change is expected, and a
// fixed wait cannot prove a missing effect. This spec asserts
// activation BY OBSERVATION: after clicking the option, the visible
// editor must contain the seed note heading within 30 seconds, and
// the query input must clear. If activation genuinely fails, this
// spec fails honestly and the failure is reported as a product
// defect; it is not weakened to accept a no-op click.
//
// Steps:
// 1. Boot through the backend fixture. Observe a 200 response from
//    GET /api/search while searching: the route answers, it is not
//    a stale client cache.
// 2. Search SEARCH_TERMS.uniqueTerm (in exactly one seed file).
//    Assert the results container lists the seed file with a
//    snippet carrying the term, and the fuzzy-status notice is
//    visible.
// 3. Click the result option. Assert by observation that the editor
//    shows the seed note and the search input clears.
// 4. Search SEARCH_TERMS.absentTerm. Assert the explicit empty
//    state appears (test-id search-empty), not an endless spinner
//    and not stale results from the previous query.

import { backendTest, expect } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'
import {
  searchEmptyStateByTestId,
  searchFuzzyStatusByTestId,
  searchInputByTestId,
  searchResultsByTestId,
  visibleVisualEditor,
} from './harness/selectors'
import { SEARCH_TERMS } from './harness/seed-data'

backendTest(
  'E2E-04 @smoke search: results point at the right file, unknown term is empty',
  async ({ backend, page }) => {
    const app = new AppPage(page)
    await app.gotoHome(backend.pageUrl)
    await app.expectBooted()

    const searchResponse = page.waitForResponse(
      (response) => response.url().includes('/api/search') && response.status() === 200,
      { timeout: 30_000 },
    )
    await searchInputByTestId(page).fill(SEARCH_TERMS.uniqueTerm)
    await searchResponse

    const results = searchResultsByTestId(page)
    await expect(results).toBeVisible({ timeout: 10_000 })
    await expect(results).toContainText(SEARCH_TERMS.uniqueTermFileName)
    await expect(results).toContainText(SEARCH_TERMS.uniqueTerm)
    await expect(searchFuzzyStatusByTestId(page)).toContainText('Fuzzy matching is not available')

    await results.getByRole('option').first().click()
    await expect(visibleVisualEditor(page)).toContainText('Getting started', { timeout: 30_000 })
    await expect(searchInputByTestId(page)).toHaveValue('')

    await searchInputByTestId(page).fill(SEARCH_TERMS.absentTerm)
    await expect(searchEmptyStateByTestId(page)).toBeVisible({ timeout: 10_000 })
    await expect(results).not.toContainText(SEARCH_TERMS.uniqueTermFileName)
  },
)
