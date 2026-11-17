// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-04: search. Results point at the right file; a term that exists
// nowhere yields an explicit empty state. Design:
// fase1/desain-pengujian.md section 4.2.
//
// Status: TODO. This test fails explicitly with "fitur belum mendarat"
// until the feature lands. Do not convert it to skip/fixme and do not
// add placeholder assertions.
//
// Intended steps (replace the notYetLanded call when the feature lands):
// 1. Seed the workspace through the backend fixture and wait for
//    the index-ready observation (poll until searching a seed term
//    returns results, with a timeout from the stated index bound).
//    Index delay is expected behavior: never assert instant
//    results. The fixture has no live run yet, and the search
//    backend itself has NOT landed: the search route registrar
//    (server/src/routes/search.ts) has no caller in server/src,
//    and the search port is interfaces plus a fake only, with the
//    index-backed implementation waiting for V3-06/V3-25
//    (server/src/services/search/port.ts). The UI side is wired
//    (sidebar-search.tsx via search-client.ts), but the route it
//    calls answers 404 from the app today.
// 2. Search a term that exists in exactly one file
//    (SEARCH_TERMS.uniqueTerm in harness/seed-data.ts, in
//    SEARCH_TERMS.uniqueTermFile; AppPage.searchGlobally, input
//    locator VERIFIED in source, or searchInputByTestId).
// 3. Assert the result points at the right file: result title and
//    snippet match (selectors.searchResult, VERIFIED via cmdk).
// 4. Search a term that exists nowhere in the corpus
//    (SEARCH_TERMS.absentTerm in harness/seed-data.ts).
// 5. Assert the explicit empty state appears
//    (AppPage.expectNoSearchResults, "No search results", VERIFIED
//    in source, or searchEmptyStateByTestId), not an endless spinner.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-04 @smoke search: results point at the right file, unknown term is empty', async () => {
  notYetLanded(
    'E2E-04',
    'the search route is not registered in the app and the ' +
      'index-backed search implementation has not landed (port ' +
      'plus fake only); searching cannot return seeded results ' +
      'through the web UI yet, and the backend harness has no live ' +
      'run yet either.',
  )
})
