// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-S3: record plus tag. A record is assigned an additional tag
// through the web record detail dialog, and the assignment survives
// a reload. Design sources: fase1/desain-record-search.md (V1-14)
// sections 2-3 and 5, fase1/kontrak-api-kanonis.md sections 3.5-3.7,
// and fase1/inventaris-record-ui.md (S-02, S-25, S-26).
//
// Status: LIVE (converted by W4-FLOWS). Tag: @scaffold. Promotion
// to @smoke is proposed to the coordinator after a green run proves
// the selectors (E2EDEBT condition); see the W4-FLOWS report.
//
// WEB FLOW CORRECTION (W4-FLOWS probes 2-6): the TODO sketch
// assumed the desktop path ("Manage tags" button in
// MarkDetailPanel / RecordTagEditor). That panel is NOT mounted in
// the web inbox flow: clicking an inbox row opens the
// WebRecordDetail DIALOG (web-record-detail.tsx), where tags are
// edited with a TagChecklist plus a "Save tags" button that renders
// only while the selection differs from the saved set. The probes
// confirmed no "Manage tags" button exists in the web flow, and
// confirmed the dialog, its checkboxes (inbox-tag-<id>, labels are
// tag names), and the primary-tag lock. This spec drives the web
// dialog, not the desktop editor. The selectors file records the
// distinction (manageTagsButton is desktop-only).
//
// Steps:
// 1. Seed five records and two tags through the backend fixture
//    (kind layer, harness/seed-records.ts). The first record
//    carries only e2e-alpha (its primary tag); the flow assigns
//    e2e-beta to it. Descriptors: RECORD_SEEDS, TAG_SEEDS.
// 2. Switch to the Record tab (icon-click workaround, D-DEMO-7:
//    collapsed tabs have no accessible name) and click the seeded
//    record row. Assert the detail dialog opens with the record
//    content, e2e-alpha checked, e2e-beta unchecked.
// 3. Check e2e-beta and save through "Save tags". Observe the PUT
//    /api/marks/:id/tags 200 response: the guard-carrying write
//    (expectedTagIds) answered.
// 4. Read back through GET /api/marks/:id and assert the tag id SET
//    contains both seed tags. CAUTION (S-02): tagIds are sorted
//    ascending numerically and carry no position, so the assertion
//    is set membership, never an assumed order. Only tags that
//    already exist are assigned (S-26: no inline creation).
// 5. Reload the page, re-open the same record, and assert both tag
//    checkboxes are checked in the dialog. The primary tag
//    checkbox is never touched: it is locked, and the primary tag
//    changes through Move Tag, not through this editor.

import type { APIRequestContext } from '@playwright/test'

import { backendTest, expect } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'
import {
  recordDetailDialog,
  recordDetailSaveTagsButton,
  recordDetailTagCheckbox,
  webInboxRecordButton,
} from './harness/selectors'
import { RECORD_SEEDS, TAG_SEEDS } from './harness/seed-data'

async function readRecordTagIds(
  request: APIRequestContext,
  apiBaseUrl: string,
  recordId: number,
): Promise<number[]> {
  const response = await request.get(`${apiBaseUrl}/api/marks/${recordId}`, { timeout: 10_000 })
  const body: unknown = await response.json().catch(() => undefined)
  if (
    response.status() !== 200 ||
    typeof body !== 'object' ||
    body === null ||
    (body as { ok?: unknown }).ok !== true
  ) {
    throw new Error(
      `e2e record read-back failed: GET /api/marks/${recordId} answered ${response.status()}; expected 200 with an ok envelope.`,
    )
  }
  const data = (body as { data?: unknown }).data
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { tagIds?: unknown }).tagIds)) {
    throw new Error(
      `e2e record read-back failed: GET /api/marks/${recordId} carries no tagIds array.`,
    )
  }
  const tagIds = (data as { tagIds: unknown[] }).tagIds
  if (!tagIds.every((entry) => typeof entry === 'number')) {
    throw new Error(
      `e2e record read-back failed: GET /api/marks/${recordId} carries a non-numeric tag id.`,
    )
  }
  return tagIds as number[]
}

backendTest(
  'E2E-S3 @scaffold record plus tag: assigned tag survives reload',
  async ({ backend, page }) => {
    const record = RECORD_SEEDS[0]
    const recordId = backend.seed.recordIds[0]
    const alphaId = backend.seed.tagIdsByName.get(TAG_SEEDS[0].name)
    const betaId = backend.seed.tagIdsByName.get(TAG_SEEDS[1].name)
    if (recordId === undefined || alphaId === undefined || betaId === undefined) {
      throw new Error('e2e seed failed: the first record or a seed tag has no id.')
    }

    const app = new AppPage(page)
    await app.gotoHome(backend.pageUrl)
    await app.expectBooted()

    await app.switchToRecordsTab()
    await webInboxRecordButton(page, record.content).click()
    const dialog = recordDetailDialog(page, record.content)
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog).toContainText(record.content)
    await expect(recordDetailTagCheckbox(page, TAG_SEEDS[0].name)).toBeChecked()
    await expect(recordDetailTagCheckbox(page, TAG_SEEDS[1].name)).not.toBeChecked()

    const putResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/marks/${recordId}/tags`) && response.status() === 200,
      { timeout: 30_000 },
    )
    await recordDetailTagCheckbox(page, TAG_SEEDS[1].name).check()
    await recordDetailSaveTagsButton(page).click()
    await putResponse
    await expect(recordDetailSaveTagsButton(page)).toHaveCount(0)

    const tagIds = await readRecordTagIds(page.request, backend.apiBaseUrl, recordId)
    expect(tagIds, 'saved tag set must contain the primary tag').toContain(alphaId)
    expect(tagIds, 'saved tag set must contain the assigned tag').toContain(betaId)

    await page.keyboard.press('Escape')
    await app.reloadHome()
    await app.expectBooted()
    await app.switchToRecordsTab()
    await webInboxRecordButton(page, record.content).click()
    await expect(recordDetailDialog(page, record.content)).toBeVisible({ timeout: 10_000 })
    await expect(recordDetailTagCheckbox(page, TAG_SEEDS[0].name)).toBeChecked()
    await expect(recordDetailTagCheckbox(page, TAG_SEEDS[1].name)).toBeChecked()
  },
)
