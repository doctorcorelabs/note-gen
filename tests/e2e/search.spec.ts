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
// 1. Seed the workspace and wait for the index-ready observation
//    (poll until searching a seed term returns results, with a
//    timeout from the stated index bound). Index delay is expected
//    behavior: never assert instant results. Seed wiring and the
//    search backend have NOT landed.
// 2. Search a term that exists in exactly one file
//    (AppPage.searchGlobally, input locator VERIFIED in source).
// 3. Assert the result points at the right file: result title and
//    snippet match (selectors.searchResult, VERIFIED via cmdk).
// 4. Search a term that exists nowhere in the corpus.
// 5. Assert the explicit empty state appears
//    (AppPage.expectNoSearchResults, "No search results", VERIFIED
//    in source), not an endless spinner.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-04 @smoke search: results point at the right file, unknown term is empty', async () => {
  notYetLanded(
    'E2E-04',
    'seed workspace wiring plus the search backend/index have not ' +
      'landed; searching cannot return seeded results through the web UI yet.',
  )
})
