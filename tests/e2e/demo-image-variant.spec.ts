// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-D-IMG: the clean S3 image variant of the A10 demo sequence
// (D-DEMO-6, W5-DEMOCODE). The W4-DEMO probe typed the markdown
// image reference into the visual (Tiptap) editor and retried on
// failure; the retry retyped while the cursor sat inside a URL
// the image input rule had partly converted, producing the
// double-nested form
// "![pixel](notes/assets/![pixel](notes/assets/pixel.png).png)"
// on disk. Both the W4-DEMO run and the gate-closure
// re-measurement reproduced that exact artifact, including the
// file md5, and AD-123 item 6 accepted the variant as PARSIAL
// (reference present, format broken by the probe method).
//
// This spec replaces the probe METHOD, not the claim. The demo
// image note is seeded through the shipped write API (PUT
// /api/workspace/file, create guard If-None-Match: *, session +
// CSRF, 201 for a new file per kontrak-api-kanonis.md section
// 3), exactly the "seed API + render check" follow-up AD-123
// named. The spec then opens the note in the visual editor,
// observes the media 200, and asserts the image renders with a
// non-zero natural size; after a reload it asserts the content
// still carries exactly one clean image line and never the
// nested defect form.
//
// What this proves, with fresh observations from this spec's own
// run: the API-seeded demo image note holds byte-exact content
// at seed time; the reference resolves through the media route
// (200) and renders in the visible editor; a reload leaves one
// clean image line and no nested form.
//
// What this does NOT prove: typing a markdown image reference
// into the visual editor (that path stays unproven and is known
// to mangle input through the image input rule; the demo
// procedure no longer uses it for this variant); the seed
// article render already covered by E2E-03 (this spec makes no
// claim about notes/nested/deep-note.md and does not re-cite
// E2E-03 as its evidence: every assertion here is observed
// fresh on the demo note). Pasting an image is likewise not
// covered.
//
// Assertion shape: byte equality applies ONLY to the seeded
// content read before the editor opens (no editor round-trip
// has touched it yet). After the editor opens and the page
// reloads, the disk assertions are containment plus
// single-occurrence plus absence of the nested form, following
// the E2E-03 editing contract: a visual round-trip may
// re-serialize whitespace, so byte equality after a visual open
// would pin a serialization detail. The nested-form absence is
// the assertion that pins the D-DEMO-6 defect signature.
//
// Tag @demo (not @smoke): the variant composes the demo
// sequence, following the @demo precedent in
// tests/e2e/README.md. The e2e-smoke gate definition is
// unchanged. Run by file until E2E-D1/E2E-D2 land (see
// demo-boot.spec.ts).
//
// Anti-flaky rules (desain-pengujian 4.3) apply: no fixed
// sleeps. Seeding happens before the first page load, so the
// tree lists the note from the server on first render and no
// watcher wait is needed.

import type { APIRequestContext, Page } from '@playwright/test'

import { backendTest, expect } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'
import { apiOrigin } from './harness/auth'
import { fetchCsrfToken } from './harness/seed-records'
import { fileTreeItemByName, visibleVisualEditor } from './harness/selectors'

const IMAGE_NOTE_PATH = 'demo-image-note.md'
const IMAGE_NOTE_CONTENT = '# Demo image\n\n![pixel](notes/assets/pixel.png)\n'
const IMAGE_LINE = '![pixel](notes/assets/pixel.png)'
const NESTED_DEFECT_FORM = '![pixel](notes/assets/![pixel]'

/**
 * Seed one workspace file through the shipped write API: PUT
 * /api/workspace/file with the create guard, the session CSRF
 * token, and an Origin header, mirroring the fs.web.ts putText
 * call shape (text/plain body, exactly one guard header). A new
 * file must answer 201 with an ok envelope; anything else is a
 * named error with status and wire code, never a silent pass.
 */
async function seedFileViaApi(
  request: APIRequestContext,
  apiBaseUrl: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const csrfToken = await fetchCsrfToken(request, apiBaseUrl)
  let response
  try {
    response = await request.put(
      `${apiBaseUrl}/api/workspace/file?path=${encodeURIComponent(relativePath)}`,
      {
        headers: {
          Origin: apiOrigin(apiBaseUrl),
          'X-CSRF-Token': csrfToken,
          'Content-Type': 'text/plain; charset=utf-8',
          'If-None-Match': '*',
        },
        data: content,
        timeout: 10_000,
      },
    )
  } catch (error) {
    throw new Error(
      `e2e image-variant seed failed: PUT /api/workspace/file for "${relativePath}" did not complete ` +
        `(backend unreachable or hung): ${(error as Error).message}`,
    )
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (response.status() !== 201 || typeof body !== 'object' || body === null || (body as { ok?: unknown }).ok !== true) {
    throw new Error(
      `e2e image-variant seed failed: PUT /api/workspace/file for "${relativePath}" answered ${response.status()}; ` +
        'expected 201 with an ok envelope for a new file.',
    )
  }
}

/** Rendered size of the media-served image in the visible editor (E2E-03 pattern). */
async function renderedImageSize(page: Page): Promise<{
  naturalWidth: number
  naturalHeight: number
  complete: boolean
} | null> {
  return page.evaluate(() => {
    const editors = Array.from(document.querySelectorAll('.ProseMirror'))
    const visible = editors.find((editor) => (editor as HTMLElement).offsetParent !== null)
    if (visible === undefined) return null
    const image = visible.querySelector('img[src*="/api/workspace/media/"]')
    if (image === null) return null
    const element = image as HTMLImageElement
    return { naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight, complete: element.complete }
  })
}

backendTest(
  'E2E-D-IMG @demo S3 image variant (clean): API-seeded image note renders, content stays exact',
  async ({ backend, page }, testInfo) => {
    testInfo.setTimeout(120_000)

    // Seed before the first page load: the note is server state
    // when the tree first renders, so no watcher wait is needed.
    await seedFileViaApi(page.request, backend.apiBaseUrl, IMAGE_NOTE_PATH, IMAGE_NOTE_CONTENT)
    const seeded = await backend.readWorkspaceFile(IMAGE_NOTE_PATH)
    expect(seeded, 'seeded demo image note must hold byte-exact content').toBe(IMAGE_NOTE_CONTENT)

    const mediaResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/api/workspace/media/') &&
        response.url().endsWith('pixel.png') &&
        response.status() === 200,
      { timeout: 30_000 },
    )

    const app = new AppPage(page)
    await app.gotoHome(backend.pageUrl)
    await app.expectBooted()
    await expect(fileTreeItemByName(page, 'demo-image-note.md')).toBeVisible({ timeout: 10_000 })
    await fileTreeItemByName(page, 'demo-image-note.md').click()
    await expect(visibleVisualEditor(page)).toContainText('Demo image', { timeout: 10_000 })
    await mediaResponse

    const firstRender = await renderedImageSize(page)
    expect(firstRender, 'no media-served image rendered in the visible editor').not.toBeNull()
    expect(firstRender?.naturalWidth, 'rendered image has zero natural width').toBeGreaterThan(0)
    expect(firstRender?.complete, 'rendered image did not finish loading').toBe(true)

    // Reload: the note reopens from disk, and the content must
    // still carry exactly one clean image line, never the nested
    // defect form the typed variant produced.
    await app.reloadHome()
    await app.switchToFilesTab()
    await expect(fileTreeItemByName(page, 'demo-image-note.md')).toBeVisible({ timeout: 10_000 })
    await fileTreeItemByName(page, 'demo-image-note.md').click()
    await expect(visibleVisualEditor(page)).toContainText('Demo image', { timeout: 10_000 })
    const secondRender = await renderedImageSize(page)
    expect(secondRender, 'no media-served image rendered after reload').not.toBeNull()
    expect(secondRender?.naturalWidth, 'rendered image has zero natural width after reload').toBeGreaterThan(0)

    const settled = await backend.readWorkspaceFile(IMAGE_NOTE_PATH)
    expect(settled, 'disk must keep the clean image line after reload').toContain(IMAGE_LINE)
    expect(settled, 'disk must never hold the nested defect form').not.toContain(NESTED_DEFECT_FORM)
    expect(
      settled.split(IMAGE_LINE).length - 1,
      'disk must hold exactly one image line after reload',
    ).toBe(1)
  },
)
