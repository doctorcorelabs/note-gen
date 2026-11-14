// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Playwright configuration for the web fork E2E suite (tests/e2e).
//
// Design source: fase1/desain-pengujian.md section 4 (V1-15). The suite
// targets a production static export (`pnpm build`, output directory
// `out/`) served over plain HTTP, not `next dev` and not `next start`:
// the fork build uses `output: "export"` (see next.config.ts), so there
// is no Next.js server to start. The static server is the dependency-free
// harness script tests/e2e/harness/static-server.mjs.
//
// Backend, database, and auth wiring for per-test isolation has NOT
// landed yet (wave 2 backend work). Until it lands, the suite runs with
// a single worker against one shared static server, and only the boot
// flow (E2E-01) is a real test. The other five flows fail explicitly
// with "fitur belum mendarat" instead of passing falsely. See
// tests/e2e/README.md for the full status table.
//
// To run against an already running server (CI deploy preview, local
// manual server), set E2E_BASE_URL. In that mode no webServer is
// started and the preflight bundle checks still run over HTTP.

import { defineConfig, devices } from '@playwright/test'

const e2ePort = Number(process.env.E2E_PORT ?? 4173)
const externalBaseUrl = process.env.E2E_BASE_URL
const baseURL = externalBaseUrl ?? `http://127.0.0.1:${e2ePort}`

export default defineConfig({
  testDir: './tests/e2e',
  // Boot includes client hydration plus the redirect from / to
  // /core/main. 60s bounds a hung boot instead of hanging CI forever.
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  // One worker until per-test workspace/database isolation lands.
  // Parallel workers would share one static server and one workspace.
  workers: 1,
  // Desain-pengujian 4.3: at most 1 retry in CI, and a retry that
  // succeeds is still reported as flaky by the list reporter. No
  // retries locally, so the first failure is always investigated.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'node tests/e2e/harness/static-server.mjs',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          E2E_PORT: String(e2ePort),
        },
      },
})
