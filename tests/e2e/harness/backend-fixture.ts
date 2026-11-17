// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Playwright fixture: one isolated backend per test.
//
// Each test that uses `backendTest` gets, in setup order:
//   1. A seed workspace directory (harness/seed.ts) with the
//      deterministic seed files on disk.
//   2. A backend process booted against a fresh scratch database
//      with that directory as WORKSPACE_ROOT (harness/backend.ts).
//   3. A gateway process (harness/static-server.mjs in proxy mode)
//      serving the production static export on a loopback origin
//      and forwarding /api/* to that backend, so browser traffic,
//      session cookies, and Origin checks all see one origin.
//   4. A seeded account (setup + login through the gateway, with
//      page.request, so the browser context holds the session)
//      and the seed tags/records through the kind layer
//      (harness/seed-records.ts).
// Teardown stops the gateway, stops the backend and drops its
// scratch database, then removes the workspace directory. Nothing
// survives into the next test.
//
// This fixture does NOT use the Playwright config webServer: that
// server is static-only on purpose, because E2E-01 pins the
// fail-closed boot guard in the no-backend condition. Tests that
// need a backend go through backend.pageUrl explicitly; tests
// that use the config baseURL keep the static-only behavior.
//
// Prerequisites and failure honesty come from harness/backend.ts:
// the built server, the server dependencies, E2E_PG_ADMIN_URL, and
// a reachable scratch cluster. A missing prerequisite fails setup
// with a named error; there is no skip and no fallback to a shared
// backend.
//
// LIVE STATUS: UNPROVEN. No live run has exercised this fixture
// yet (see harness/backend.ts). The first live run is the merge
// gate on muse-2, through tests/e2e/backend-harness.spec.ts.

import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { test as base, type Page } from '@playwright/test'

import {
  allocateFreePort,
  readPgAdminUrl,
  startBackend,
  waitForCondition,
  type StartedBackend,
} from './backend'
import { fetchSession, loginViaApi, setupFirstAccount } from './auth'
import { prepareSeedWorkspace, removeSeedWorkspace, type SeedWorkspace } from './seed'
import { seedTagsAndRecords, type SeededTagsAndRecords } from './seed-records'

export { expect } from '@playwright/test'

const GATEWAY_READY_TIMEOUT_MS = 10_000
const GATEWAY_STOP_TIMEOUT_MS = 5_000

export interface BackendContext {
  /** Gateway origin: the single origin for browser pages and API calls. */
  pageUrl: string
  /** Same as pageUrl: API calls go through the gateway, same-origin. */
  apiBaseUrl: string
  /** Direct backend origin, for diagnostics only; the browser never uses it. */
  backendUrl: string
  /** Scratch database name (name only; the URL is never exposed). */
  databaseName: string
  /** Seed workspace directory on disk (the backend WORKSPACE_ROOT). */
  workspaceDir: string
  /** Ids created by the kind-layer seed (tags and records). */
  seed: SeededTagsAndRecords
  /** Read a workspace file as UTF-8; rejects path traversal out of the workspace. */
  readWorkspaceFile(relativePath: string): Promise<string>
  /** Wait by observation until a workspace file holds the expected content. */
  waitForWorkspaceFileContent(
    relativePath: string,
    expectedContent: string,
    timeoutMs: number,
  ): Promise<void>
}

interface StartedGateway {
  stop(): Promise<void>
}

function resolveInsideWorkspace(workspaceDir: string, relativePath: string): string {
  const resolved = resolve(workspaceDir, relativePath)
  if (resolved !== workspaceDir && !resolved.startsWith(workspaceDir + sep)) {
    throw new Error(
      `e2e workspace read refused: "${relativePath}" escapes the test workspace directory.`,
    )
  }
  return resolved
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true
  }
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise(true)
    })
  })
}

async function startGateway(
  repoRoot: string,
  gatewayPort: number,
  backendApiBaseUrl: string,
): Promise<StartedGateway> {
  const script = join(repoRoot, 'tests', 'e2e', 'harness', 'static-server.mjs')
  const child = spawn('node', [script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      E2E_PORT: String(gatewayPort),
      E2E_API_BASE_URL: backendApiBaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrTail = ''
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  child.stdout?.on('data', () => undefined)
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096)
  })
  child.once('error', () => {
    exited = true
  })
  const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`
  try {
    await waitForCondition(
      async () => {
        if (exited) {
          throw new Error(
            'e2e gateway exited during startup. ' +
              `Gateway stderr tail: ${stderrTail.trim().slice(-2000) || '(empty)'}`,
          )
        }
        try {
          const response = await fetch(gatewayOrigin, { signal: AbortSignal.timeout(2000) })
          return response.status < 600
        } catch {
          return false
        }
      },
      {
        timeoutMs: GATEWAY_READY_TIMEOUT_MS,
        onExhausted: () =>
          `e2e gateway did not start listening at the gateway origin within ` +
          `${GATEWAY_READY_TIMEOUT_MS} ms. ` +
          `Gateway stderr tail: ${stderrTail.trim().slice(-2000) || '(empty)'}`,
      },
    )
  } catch (error) {
    child.kill('SIGKILL')
    await waitForChildExit(child, GATEWAY_STOP_TIMEOUT_MS)
    throw error
  }
  let stopped = false
  return {
    stop: async (): Promise<void> => {
      if (stopped) {
        return
      }
      stopped = true
      child.kill('SIGTERM')
      const exitedCleanly = await waitForChildExit(child, GATEWAY_STOP_TIMEOUT_MS)
      if (!exitedCleanly) {
        child.kill('SIGKILL')
        await waitForChildExit(child, GATEWAY_STOP_TIMEOUT_MS)
      }
    },
  }
}

async function establishSession(page: Page, pageUrl: string, backend: StartedBackend): Promise<void> {
  await setupFirstAccount(page.request, pageUrl, backend.credentials, backend.setupToken)
  await loginViaApi(page.request, pageUrl, backend.credentials)
  const probe = await fetchSession(page.request, pageUrl)
  if (!probe.authenticated) {
    throw new Error(
      'e2e backend fixture failed: the session probe reports unauthenticated ' +
        'right after login through the gateway; the browser context holds no session.',
    )
  }
}

export const backendTest = base.extend<{ backend: BackendContext }>({
  // The second fixture argument is named runTest (not the usual
  // Playwright `use`) so the React Hooks lint rule does not mistake
  // the fixture callback for a Hook; the behavior is identical.
  backend: async ({ page }, runTest, testInfo) => {
    const repoRoot = process.cwd()
    const adminUrl = readPgAdminUrl()
    const seed: SeedWorkspace = await prepareSeedWorkspace()
    const gatewayPort = await allocateFreePort()
    const pageUrl = `http://127.0.0.1:${gatewayPort}`
    let backend: StartedBackend | undefined
    let gateway: StartedGateway | undefined
    const teardownProblems: string[] = []
    try {
      backend = await startBackend({
        repoRoot,
        workerIndex: testInfo.workerIndex,
        workspaceDir: seed.dir,
        gatewayOrigin: pageUrl,
        adminUrl,
      })
      gateway = await startGateway(repoRoot, gatewayPort, backend.apiBaseUrl)
      await establishSession(page, pageUrl, backend)
      const seeded = await seedTagsAndRecords(page.request, pageUrl)
      const context: BackendContext = {
        pageUrl,
        apiBaseUrl: pageUrl,
        backendUrl: backend.apiBaseUrl,
        databaseName: backend.databaseName,
        workspaceDir: seed.dir,
        seed: seeded,
        readWorkspaceFile: async (relativePath: string): Promise<string> => {
          const target = resolveInsideWorkspace(seed.dir, relativePath)
          try {
            return await readFile(target, 'utf8')
          } catch {
            throw new Error(
              `e2e workspace read failed: "${relativePath}" could not be read from the test workspace.`,
            )
          }
        },
        waitForWorkspaceFileContent: async (
          relativePath: string,
          expectedContent: string,
          timeoutMs: number,
        ): Promise<void> => {
          const target = resolveInsideWorkspace(seed.dir, relativePath)
          await waitForCondition(
            async () => {
              try {
                return (await readFile(target, 'utf8')) === expectedContent
              } catch {
                return false
              }
            },
            {
              timeoutMs,
              onExhausted: () =>
                `Waited ${timeoutMs} ms for workspace file "${relativePath}" to hold the expected content; ` +
                'it never did. The save effect was not observed on disk.',
            },
          )
        },
      }
      await runTest(context)
    } finally {
      if (gateway !== undefined) {
        try {
          await gateway.stop()
        } catch (error) {
          teardownProblems.push((error as Error).message)
        }
      }
      if (backend !== undefined) {
        try {
          await backend.stop()
        } catch (error) {
          teardownProblems.push((error as Error).message)
        }
      }
      try {
        await removeSeedWorkspace(seed)
      } catch (error) {
        teardownProblems.push((error as Error).message)
      }
      if (teardownProblems.length > 0) {
        throw new Error(`e2e backend fixture teardown failed: ${teardownProblems.join('; ')}`)
      }
    }
  },
})
