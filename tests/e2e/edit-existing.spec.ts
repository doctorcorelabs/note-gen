// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-03: open and edit an existing article. Relative images and
// relative links work. Design: fase1/desain-pengujian.md section 4.2.
//
// Status: LIVE (converted by W4-FLOWS). The media read route IS
// registered on trunk (W4-WIRE wired workspace-media-read), and the
// W4-FLOWS probe observed GET /api/workspace/media/.../pixel.png
// answer 200 with the image rendering at natural size 1x1 in the
// visual editor.
//
// Editing contract (read carefully): the edit is performed in the
// VISUAL editor, as the design intends, and the disk assertions are
// containment plus preservation, NOT byte equality. A visual
// (Tiptap) round-trip is allowed to re-serialize whitespace and
// block order, so asserting byte equality after a visual edit
// would pin a serialization detail, not user-visible behavior.
// Byte equality belongs to E2E-02, which types in source mode. Here
// the disk must contain the edited heading, the appended paragraph,
// the original seed term, and the image line: the changes landed
// and nothing else was lost. The heading and paragraph constants
// (EDIT_DEEP_NOTE_HEADING, EDIT_DEEP_NOTE_PARAGRAPH) come from
// harness/seed-data.ts; applyEditToDeepNote is NOT used, because
// its exact-output contract does not apply to a visual edit.
//
// Link contract: the rendered link carries its relative href in
// the live DOM (W4-FIXLINK: a custom isAllowedUri allows
// scheme-less references, so the anchor renders the full
// "nested/deep-note.md" href; probe hrefAttr confirmed). The flow
// locates the link by its visible text (editorLinkByName) and
// modifier-clicks it (Control on Linux, matching the openLink
// handler in tiptap-editor.tsx: button 0 plus metaKey or ctrlKey).
// A plain click opens the link editor instead. Navigation is
// asserted BY OBSERVATION: the target note's content must appear
// in the visible editor within 30 seconds.
//
// D-LINK FIXED (W4-FIXLINK, AD-125): the link leg used to fail
// because the default Tiptap Link validator rejected
// multi-segment relative references (a character-range quirk in
// the bundled dist regex), so renderHTML emptied the href and
// both click handlers returned early before reaching openLink.
// The fix keeps every schemed URL on the default validator and
// only newly allows scheme-less references. The assertion is kept
// as written: weakening it to accept an inert link would enshrine
// a defect.
//
// Steps:
// 1. Boot through the backend fixture. Observe a 200 response from
//    GET /api/workspace/media for the seed pixel image.
// 2. Open notes/nested/deep-note.md. Assert the relative image
//    renders in the visible editor with a non-zero natural size.
// 3. In the visual editor, replace the heading text and append the
//    edit paragraph. Wait for the save effect by polling disk
//    content (no save indicator exists in the UI).
// 4. Assert disk containment plus preservation (see above).
// 5. Open notes/linked-note.md, modifier-click the "deep note"
//    link, and assert the deep note opens by observation.

import { backendTest, expect } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'
import {
  editorLinkByName,
  fileTreeItemByName,
  visibleVisualEditor,
} from './harness/selectors'
import { EDIT_DEEP_NOTE_HEADING, EDIT_DEEP_NOTE_PARAGRAPH } from './harness/seed-data'

const DEEP_NOTE_PATH = 'notes/nested/deep-note.md'

backendTest(
  'E2E-03 @smoke edit existing article: relative image and link work',
  async ({ backend, page }, testInfo) => {
    testInfo.setTimeout(120_000)
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

    await app.expandFolderByName('notes')
    await app.expandFolderByName('nested')
    await fileTreeItemByName(page, 'deep-note.md').click()
    await expect(visibleVisualEditor(page)).toContainText('Deep note', { timeout: 10_000 })
    await mediaResponse

    const imageSize = await page.evaluate(() => {
      const editors = Array.from(document.querySelectorAll('.ProseMirror'))
      const visible = editors.find((editor) => (editor as HTMLElement).offsetParent !== null)
      if (visible === undefined) return null
      const image = visible.querySelector('img[src*="/api/workspace/media/"]')
      if (image === null) return null
      const element = image as HTMLImageElement
      return { naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight, complete: element.complete }
    })
    expect(imageSize, 'no media-served image rendered in the visible editor').not.toBeNull()
    expect(imageSize?.naturalWidth, 'rendered image has zero natural width').toBeGreaterThan(0)
    expect(imageSize?.complete, 'rendered image did not finish loading').toBe(true)

    const editor = visibleVisualEditor(page)
    await editor.locator('h1').first().click({ clickCount: 3 })
    await page.keyboard.type('Deep note (edited)')
    await editor.getByText('Nested seed note.').first().click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type(EDIT_DEEP_NOTE_PARAGRAPH.trim())

    // Wait for the save effect by polling disk content by
    // observation (no save indicator exists in the UI). Exact
    // equality does not apply to a visual edit, so the poll waits
    // for containment of both changes, then the preservation
    // assertions below read the settled content once.
    await expect
      .poll(
        async () => {
          const content = await backend.readWorkspaceFile(DEEP_NOTE_PATH).catch(() => '')
          return content.includes(EDIT_DEEP_NOTE_HEADING) && content.includes(EDIT_DEEP_NOTE_PARAGRAPH.trim())
        },
        {
          timeout: 30_000,
          message:
            'disk content never contained the edited heading and paragraph within 30 s of the visual edit; the autosave effect was not observed.',
        },
      )
      .toBe(true)
    const disk = await backend.readWorkspaceFile(DEEP_NOTE_PATH)
    expect(disk, 'disk must keep the original seed term').toContain('quokka-seed-beta')
    expect(disk, 'disk must keep the relative image line').toContain('![pixel](../assets/pixel.png)')

    await fileTreeItemByName(page, 'linked-note.md').click()
    await expect(visibleVisualEditor(page)).toContainText('Linked note', { timeout: 10_000 })
    await page.keyboard.down('Control')
    try {
      await editorLinkByName(page, 'deep note').click()
    } finally {
      await page.keyboard.up('Control')
    }
    await expect(visibleVisualEditor(page)).toContainText('Deep note (edited)', {
      timeout: 30_000,
    })
  },
)
