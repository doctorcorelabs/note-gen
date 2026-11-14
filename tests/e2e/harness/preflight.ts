// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Preflight checks for the E2E harness (desain-pengujian 4.1).
//
// Before a flow runs, the harness proves that the two esbuild bundles
// the app loads from absolute root paths are actually served with
// HTTP 200: /markdown-lexer.js (worker, version pinned by
// MARKDOWN_LEXER_VERSION = 4) and /plugin-runtime.js. A silent 404
// here would make every document open fall back to synchronous
// parsing, or break plugin runtime loading, while the editor still
// appears to render. Checking over HTTP (not just "file exists on
// disk") is what the editor audit requires, because the failure mode
// is a serving-path problem, not a build-output problem.
//
// These checks use the Playwright APIRequestContext, so they work
// identically against the local static server and against an external
// E2E_BASE_URL.

import { expect, type APIRequestContext } from '@playwright/test'

const WORKER_BUNDLES = [
  {
    path: '/markdown-lexer.js?v=4',
    label: 'markdown lexer worker bundle (/markdown-lexer.js?v=4)',
  },
  {
    path: '/plugin-runtime.js',
    label: 'plugin runtime bundle (/plugin-runtime.js)',
  },
] as const

export async function assertWorkerBundlesServed(request: APIRequestContext): Promise<void> {
  for (const bundle of WORKER_BUNDLES) {
    const response = await request.get(bundle.path)
    expect(
      response.ok(),
      `Preflight failed: ${bundle.label} did not return HTTP 200 ` +
        `(got ${response.status()}). Run a full "pnpm build" so both ` +
        'esbuild bundles are generated into the static export, then ' +
        'run the E2E suite again.',
    ).toBe(true)
  }
}
