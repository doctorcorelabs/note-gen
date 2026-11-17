// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-D-A11Y: accessible names on the sidebar tab buttons
// (D-DEMO-7, W5-DEMOCODE). ExpandableTabs rendered the tab title
// text only for the selected tab, so a collapsed tab was an
// icon-only button with no accessible name: the W4-DEMO run-1
// step `getByRole('button', { name: 'Record', exact: true })`
// timed out, the gate-closure re-measurement reproduced the
// failure, and both runs fell back to an icon-class DOM click.
// The fix (src/components/ui/expandable-tabs.tsx) sets
// aria-label + title from the tab title on every tab button, so
// the accessible name is identical in the selected and collapsed
// states, and marks the decorative icon aria-hidden.
//
// Applicable rule: WCAG 2.1 success criterion 4.1.2 Name, Role,
// Value. For all user interface components, the name and role
// must be programmatically determinable. An icon-only button
// with no accessible name exposes a role (button) but no name,
// so assistive technology and role-based automation cannot
// identify it. This spec measures exactly that: role-plus-name
// resolution per tab, in the state where two of the three tabs
// are collapsed, plus the tab-switch behavior the demo step
// needs. No axe run is claimed: axe-core is not a dependency of
// this repo, and adding a dependency for one check would be
// disproportionate. The measured check is the role/name
// resolution itself, which is the same accessible-name
// computation assistive technology uses.
//
// Scoping note (probe-measured, W5-DEMOCODE): the shell carries
// a second, pre-existing button named "Canvas" in the fixed top
// bar (aria-label "Canvas", no title attribute), unrelated to
// the sidebar tabs. The tab counts below therefore intersect
// the role query with the title attribute the fix sets, so each
// count measures the TAB button only; the name resolution
// itself is still proven by the role query (aria-label), while
// the title only disambiguates which button is counted. The
// behavior clicks stay unscoped on purpose: they are the
// verbatim W4-DEMO locator, and strict mode enforces the
// uniqueness of "Record" and "Notes" (each resolves to exactly
// one button shell-wide, as the probe confirmed).
//
// Before/after: this spec file is intentionally free of any
// harness helper added by W5-DEMOCODE (it uses page.getByRole
// directly, plus a local title intersection for the tab scope;
// sidebarTabButton in harness/selectors.ts is the harness
// spelling of the same role locator), so the identical file
// runs against the trunk tree and the fixed tree. On trunk the
// Record and Canvas counts resolve to 0 and the spec fails at
// the first count assertion; on the fixed tree all three counts
// resolve to 1 and both role-based clicks switch tabs. The
// W5-DEMOCODE report records both runs.
//
// What this does NOT prove: a full-page accessibility audit
// (no other component is checked); tablist semantics
// (ExpandableTabs keeps plain button semantics by design; no
// tab/tablist roles and no arrow-key pattern are added here,
// and adding tab roles without the keyboard pattern would be a
// new defect, not a fix); non-en locales (names are the
// translated tab titles; this spec runs the en default).
//
// Tag @demo (not @smoke): the subject is the S4 demo step (the
// Record tab switch), following the @demo precedent in
// tests/e2e/README.md. The e2e-smoke gate definition is
// unchanged; the AppPage migration to role-based tab switching
// is additionally proven by the @smoke reruns of E2E-S3 and
// E2E-RELOAD. Run by file until E2E-D1/E2E-D2 land (see
// demo-boot.spec.ts).
//
// Anti-flaky rules (desain-pengujian 4.3) apply: no fixed
// sleeps. Counts are read from the settled shell (expectBooted
// first); tab switches wait for the target surface by
// observation.

import type { Locator, Page } from '@playwright/test'

import { backendTest, expect } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'
import { fileTree } from './harness/selectors'

/**
 * The sidebar TAB button with the given accessible name: the
 * role query (proving the accessible name resolves) intersected
 * with the title attribute the D-DEMO-7 fix sets (excluding the
 * pre-existing top-bar button also named "Canvas"). See the
 * scoping note in the header.
 */
function tabButtonByName(page: Page, tabName: string): Locator {
  return page
    .getByRole('button', { name: tabName, exact: true })
    .and(page.locator(`button[title="${tabName}"]`))
}

backendTest(
  'E2E-D-A11Y @demo sidebar tabs: collapsed tabs expose accessible names and switch by role',
  async ({ backend, page }) => {
    const app = new AppPage(page)
    await app.gotoHome(backend.pageUrl)
    await app.expectBooted()

    // Measurement, in the Files-selected state: Notes is
    // selected (title text rendered), Record and Canvas are
    // collapsed (icon only). Each tab button must expose
    // exactly one role-plus-name match.
    const notesCount = await tabButtonByName(page, 'Notes').count()
    const recordCount = await tabButtonByName(page, 'Record').count()
    const canvasCount = await tabButtonByName(page, 'Canvas').count()
    expect(notesCount, 'exactly one tab button must expose the accessible name "Notes"').toBe(1)
    expect(recordCount, 'exactly one tab button must expose the accessible name "Record"').toBe(1)
    expect(canvasCount, 'exactly one tab button must expose the accessible name "Canvas"').toBe(1)

    // Behavior: the exact W4-DEMO run-1 step that timed out,
    // then the return switch. Both clicks are role-based; no
    // icon-class workaround is used anywhere in this spec.
    await page.getByRole('button', { name: 'Record', exact: true }).click()
    await expect(page.locator('#web-inbox')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    await expect(fileTree(page)).toBeVisible()
  },
)
