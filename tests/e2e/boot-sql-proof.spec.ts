// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-BOOT-SQL-PROOF: boot proof over a live backend, on the
// pre-V3-12 tree. V3-12 removes the POC store shim and its alias;
// a green boot run before that removal is what lets a later boot
// regression be attributed to the removal instead of to an
// earlier broken state (rencana-v312 section 4 item 4, and the
// K6 prerequisite (7) in the V3-12 readiness report: boot code
// calls initializeWebPlatform, and boot E2E is proven green on
// the pre-V3-12 tree).
//
// What this spec proves, on one real backend plus one real
// browser through the backendTest fixture:
//   1. The shell boots: / redirects to /core/main, the file tree
//      element is mounted, the page is not blank, and no error
//      boundary text appears. Visibility of the tree is NOT
//      asserted: on an empty workspace the tree div renders at
//      height 0px with no children (observed live at the merge
//      gate), and population needs files-index seeding, a
//      separate E2E concern.
//   2. The SQL health probe runs: the page issues a second
//      GET /api/health/ready after navigation to /core/main.
//      Only two fetchers of that path exist in shipped browser
//      code: the boot guard (src/lib/web/boot-guard.ts) on /,
//      and probeSqlHealth (src/lib/platform/wiring.ts) through
//      adapter ready(), reached from initAllDatabases in the
//      core layout effect (src/app/core/layout.tsx). A ready
//      request observed from the /core/main frame can only be
//      the probe. The probe response body answering ok true,
//      plus the deterministic probe mapping pinned by the
//      wiring spec, is what ready() reports; the return value
//      itself has no browser surface and is not read directly.
//   3. The store load runs: the page issues GET /api/settings
//      (the only fetcher is the store transport in
//      src/lib/platform/store/store.web.ts, through
//      handle initialize on platform.store.load), and the
//      guard redirect itself proves loadStore resolved, since
//      the guard fails closed with BOOT_STORE_UNAVAILABLE
//      instead of redirecting when the store cannot load.
//   4. The kind layer round-trips against the live backend:
//      a fresh tag and record written through POST
//      /api/transactions read back through POST /api/db/batch
//      with kind marks.list.
//
// What is deliberately NOT claimed here:
//   - No browser adapter transaction is observed. No shipped UI
//     calls the SQL adapter transaction or query path:
//     getSqlAdapter has no production caller outside
//     src/db/index.ts itself (readiness only),
//     src/lib/web/records-kind-client.ts has no importer, and
//     the inbox components have no mounting. Step 4 therefore
//     drives the same endpoints, the same CSRF header, and the
//     same envelope through page.request, reusing the harness
//     helpers and the read-back shape proven by the @harness
//     spec. It proves the server kind layer and the live
//     database, not a browser adapter call. A browser
//     adapter-issued request carrying the CSRF header needs a
//     production hook or a mounted inbox driver; that gap is
//     recorded in the slot report, not papered over here.
//   - No PATCH /api/settings is asserted. On a fresh settings
//     document the guard has nothing to persist (no rewrite),
//     and the shell save paths run on user or tray events,
//     not on boot. A browser CSRF header on a store flush is
//     therefore not observable in this flow either.
//   - No specific setting key or value is asserted: the E2E-06
//     settings choice is still pending with the coordinator,
//     and no key is baked in here.
//   - Console errors other than the registry text are not
//     asserted. Legacy database paths may log failures during
//     shell init; only the exact "not registered" text fails
//     this spec, because only that text names a registration
//     failure (src/lib/platform/registry.ts).
//
// Tag @harness, NOT @smoke: like backend-harness.spec.ts, this
// spec proves the ground the user flows stand on, not one of
// the six user flows, and it must never count toward the 6/6
// smoke gate. Run it only where the harness prerequisites
// exist (built server, server dependencies, E2E_PG_ADMIN_URL,
// reachable scratch cluster); without them the fixture fails
// honestly with a named error. See tests/e2e/README.md,
// section "Backend harness".
//
// Every wait below is an observation: a URL changing, an
// element being attached, or a recorded network response
// arriving. No wait stands in for a condition, and no fixed
// sleep bounds a check; timeouts only bound a hung boot.

import { expect, type ConsoleMessage, type Request, type Response } from '@playwright/test'

import { backendTest as test } from './harness/backend-fixture'
import { fetchCsrfToken, runKindTransaction, type KindResult } from './harness/seed-records'
import { RECORD_SEEDS } from './harness/seed-data'
import { errorBoundaryText, fileTree } from './harness/selectors'

const READY_PATH = '/api/health/ready'
const SETTINGS_PATH = '/api/settings'
const SHELL_PATH = '/core/main'
const REGISTRATION_ERROR_TEXT = 'not registered'

// The URL bound mirrors AppPage.gotoHome (30 seconds for the
// boot redirect). The network observation bound mirrors the boot
// guard budget (BOOT_GUARD_TIMEOUT_MS, 15 seconds): the probe and
// settings requests arrive during boot, long before the bound,
// and the bound only names a hung boot.
const BOOT_URL_TIMEOUT_MS = 30_000
const OBSERVATION_TIMEOUT_MS = 15_000

// Fixed proof values, distinct from the fixture seeds. They rely
// on the same fresh-database-per-test guarantee the seeds rely
// on (harness/seed-data.ts): on a fresh scratch database the tag
// name is untaken and the sourceId is unseen, so both writes
// answer affected 1. A reused database would answer affected 0
// and fail the write step with a named error instead of proving
// a round-trip over someone else's row.
const BOOT_PROOF_TAG_NAME = 'e2e-boot-proof'
const BOOT_PROOF_SOURCE_ID = 'e2e:boot-proof:record-1'
const BOOT_PROOF_CONTENT = 'Boot proof record. Unique term: quokka-boot-proof-1.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pathnameOf(url: string): string | undefined {
  try {
    return new URL(url).pathname
  } catch {
    return undefined
  }
}

/** Frame URL at event time, or empty when the request has no frame. */
function frameUrlOf(request: Request): string {
  return request.frame()?.url() ?? ''
}

interface ObservedResponse {
  frameUrl: string
  status: number
  ok: boolean | undefined
}

/**
 * Integer id of a kind write that created exactly one row. Mirrors
 * the createdId rule in harness/seed-records.ts: affected 0 on a
 * fresh database means the database was reused or the write ran
 * twice, and is refused instead of read back as a success.
 */
function createdIdOf(result: KindResult | undefined, what: string): number {
  if (result === undefined) {
    throw new Error(`e2e boot proof failed: ${what} returned no result.`)
  }
  if (result.affected !== 1) {
    throw new Error(
      `e2e boot proof isolation leak: ${what} answered affected ${result.affected} on a fresh ` +
        'scratch database; the database was reused or the write ran twice.',
    )
  }
  const id = typeof result.id === 'string' ? Number(result.id) : result.id
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error(`e2e boot proof failed: ${what} did not return an integer id.`)
  }
  return id
}

test('E2E-BOOT-SQL-PROOF @harness boot proof: shell, SQL probe, store load, and kind round-trip over a live backend', async ({
  backend,
  page,
}) => {
  // Listeners are installed before the first navigation, so no
  // boot request or console error can arrive unrecorded. Network
  // observations record the frame URL at event time: the boot
  // guard request is observed from the / frame, the SQL probe
  // request from the /core/main frame. Requests driven through
  // page.request carry no frame, so they can never satisfy a
  // browser partition below.
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const readyResponses: ObservedResponse[] = []
  const settingsResponses: ObservedResponse[] = []

  const recordResponse = (response: Response, pathname: string): void => {
    const target = pathname === READY_PATH ? readyResponses : settingsResponses
    const frameUrl = frameUrlOf(response.request())
    const status = response.status()
    void (async () => {
      const text = await response.text().catch(() => '')
      let ok: boolean | undefined
      try {
        const body: unknown = JSON.parse(text)
        if (isRecord(body)) {
          ok = body.ok === true
        }
      } catch {
        ok = undefined
      }
      target.push({ frameUrl, status, ok })
    })()
  }

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error: Error) => {
    pageErrors.push(error.stack ?? error.message)
  })
  page.on('response', (response: Response) => {
    if (response.request().method() !== 'GET') {
      return
    }
    const pathname = pathnameOf(response.url())
    if (pathname === READY_PATH || pathname === SETTINGS_PATH) {
      recordResponse(response, pathname)
    }
  })

  await test.step('shell boots to /core/main with visible content', async () => {
    await page.goto(`${backend.pageUrl}/`)
    await page.waitForURL(`**${SHELL_PATH}`, { timeout: BOOT_URL_TIMEOUT_MS })
    // Attached, not visible: on an empty workspace the mounted
    // tree div has height 0px and no children (observed live
    // 17 Nov 2026 at the merge gate: role=tree div, inline
    // style height 0px, empty). Visibility would assert tree
    // population, which needs files-index seeding and belongs
    // to the record/file flows, not to this boot proof.
    await expect(fileTree(page)).toHaveCount(1)
    await expect(errorBoundaryText(page)).toHaveCount(0)
    const bodyText = await page.locator('body').innerText()
    expect(
      bodyText.trim().length,
      'Boot produced a blank page: <body> has no visible text.',
    ).toBeGreaterThan(0)
  })

  await test.step('SQL health probe runs after navigation to the shell', async () => {
    // Guard partition: a ready request from a frame that is not
    // the shell (the boot guard on /). Probe partition: a ready
    // request from the shell frame (initAllDatabases in the core
    // layout effect, through adapter ready() and probeSqlHealth).
    await expect
      .poll(
        () =>
          readyResponses.filter(
            (entry) => entry.frameUrl !== '' && !entry.frameUrl.includes(SHELL_PATH),
          ).length,
        {
          timeout: OBSERVATION_TIMEOUT_MS,
          message:
            'Waited for a GET /api/health/ready response from the boot guard frame (/); ' +
            'none was observed. The guard fetch in src/lib/web/boot-guard.ts never ran.',
        },
      )
      .toBeGreaterThanOrEqual(1)
    await expect
      .poll(
        () => readyResponses.filter((entry) => entry.frameUrl.includes(SHELL_PATH)).length,
        {
          timeout: OBSERVATION_TIMEOUT_MS,
          message:
            'Waited for a GET /api/health/ready response from the shell frame (/core/main); ' +
            'none was observed. The SQL probe in src/lib/platform/wiring.ts, reached through ' +
            'initAllDatabases in src/app/core/layout.tsx, never ran.',
        },
      )
      .toBeGreaterThanOrEqual(1)
    expect(readyResponses.length).toBeGreaterThanOrEqual(2)
    expect(
      readyResponses.some(
        (entry) =>
          entry.frameUrl !== '' && !entry.frameUrl.includes(SHELL_PATH) && entry.status === 200 && entry.ok === true,
      ),
      'The boot guard ready response never answered 200 with ok true.',
    ).toBe(true)
    expect(
      readyResponses.some(
        (entry) => entry.frameUrl.includes(SHELL_PATH) && entry.status === 200 && entry.ok === true,
      ),
      'The SQL probe ready response never answered 200 with ok true, so ready() cannot report ok.',
    ).toBe(true)
  })

  await test.step('store load runs through GET /api/settings', async () => {
    await expect
      .poll(
        () =>
          settingsResponses.filter(
            (entry) => entry.frameUrl !== '' && entry.status === 200 && entry.ok === true,
          ).length,
        {
          timeout: OBSERVATION_TIMEOUT_MS,
          message:
            'Waited for a GET /api/settings response from the page; none was observed. ' +
            'The store load in src/lib/platform/store/store.web.ts never ran.',
        },
      )
      .toBeGreaterThanOrEqual(1)
    // Shape-only read-back through the same endpoint the adapter
    // reads. No setting key is asserted: the E2E-06 settings
    // choice is still pending, and no key is baked in here.
    const settingsReadBack = await page.request.get(`${backend.pageUrl}/api/settings`)
    expect(settingsReadBack.status()).toBe(200)
    const settingsBody: unknown = await settingsReadBack.json().catch(() => undefined)
    expect(
      isRecord(settingsBody) &&
        settingsBody.ok === true &&
        isRecord(settingsBody.data) &&
        typeof settingsBody.data.revision === 'number' &&
        isRecord(settingsBody.data.settings),
      'GET /api/settings did not answer a settings envelope with a numeric revision and a settings record.',
    ).toBe(true)
  })

  await test.step('kind write reads back through the kind layer', async () => {
    // Server kind layer through page.request, reusing the harness
    // helpers and the read-back shape of backend-harness.spec.ts.
    // This step does not claim a browser adapter call: no shipped
    // UI drives the adapter transaction path (see the header).
    const csrfToken = await fetchCsrfToken(page.request, backend.pageUrl)
    const tagResults = await runKindTransaction(page.request, backend.pageUrl, csrfToken, [
      { kind: 'tags.create', name: BOOT_PROOF_TAG_NAME },
    ])
    const tagId = createdIdOf(tagResults[0], `tags.create for "${BOOT_PROOF_TAG_NAME}"`)
    const markResults = await runKindTransaction(page.request, backend.pageUrl, csrfToken, [
      {
        kind: 'marks.create',
        mark: {
          tagId,
          type: 'text',
          content: BOOT_PROOF_CONTENT,
          desc: BOOT_PROOF_CONTENT,
          url: '',
          sourceId: BOOT_PROOF_SOURCE_ID,
        },
        tagIds: [tagId],
      },
    ])
    const markId = createdIdOf(markResults[0], `marks.create for ${BOOT_PROOF_SOURCE_ID}`)
    const batchResponse = await page.request.post(`${backend.pageUrl}/api/db/batch`, {
      data: { operations: [{ kind: 'marks.list' }] },
      headers: {
        Origin: backend.pageUrl,
        'X-CSRF-Token': csrfToken,
      },
    })
    expect(batchResponse.status()).toBe(200)
    const body: unknown = await batchResponse.json().catch(() => undefined)
    const results =
      typeof body === 'object' && body !== null && typeof (body as { data?: unknown }).data === 'object'
        ? ((body as { data: { results?: unknown } }).data.results as unknown)
        : undefined
    expect(Array.isArray(results)).toBe(true)
    const rows = (results as Array<{ rows?: unknown }>)[0]?.rows
    expect(Array.isArray(rows)).toBe(true)
    const typedRows = rows as Array<{ id?: unknown; content?: unknown; sourceId?: unknown }>
    expect(typedRows.length).toBe(RECORD_SEEDS.length + 1)
    const foundSourceIds = new Set(typedRows.map((row) => row.sourceId))
    for (const seed of RECORD_SEEDS) {
      expect(foundSourceIds.has(seed.sourceId)).toBe(true)
    }
    const proofRow = typedRows.find((row) => row.sourceId === BOOT_PROOF_SOURCE_ID)
    expect(proofRow).toBeDefined()
    expect(proofRow?.content).toBe(BOOT_PROOF_CONTENT)
    expect(proofRow?.id).toBe(markId)
  })

  await test.step('no registration error reached the console or the page', async () => {
    // Checked last, so console and page errors from the whole
    // browser lifetime of this test are covered, including late
    // shell init errors. Only the exact registry text fails;
    // other console errors are legacy noise, not registration
    // failures, and are not asserted here (see the header).
    const registrationErrors = [...consoleErrors, ...pageErrors].filter((text) =>
      text.includes(REGISTRATION_ERROR_TEXT),
    )
    expect(
      registrationErrors,
      `Registration errors were observed: ${registrationErrors
        .map((text) => text.slice(0, 500))
        .join(' | ')}`,
    ).toHaveLength(0)
  })
})
