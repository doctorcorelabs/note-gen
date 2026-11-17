// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-S3: record plus tag. A record is assigned an additional tag
// through the tag editor, and the assignment survives a reload.
// Design sources: fase1/desain-record-search.md (V1-14) sections 2-3
// and 5 (record representation, PUT tags, tag model),
// fase1/kontrak-api-kanonis.md sections 3.5-3.7 (records and tags),
// and fase1/inventaris-record-ui.md (contract-vs-code differences
// S-02, S-25, S-26, which the flow author must respect).
//
// Status: TODO. This test fails explicitly with "fitur belum mendarat"
// until the feature lands. Do not convert it to skip/fixme and do not
// add placeholder assertions. This spec carries the @scaffold tag, not
// @smoke: it is outside the six @smoke flows of desain-pengujian
// section 4, and its justification is recorded in tests/e2e/README.md
// as section 4.4 requires.
//
// SELECTOR STATUS: mixed, see harness/selectors.ts.
// - The "Manage tags" trigger button and dialog title are VERIFIED
//   (source): record-tag-editor.tsx renders a Button with text
//   t('manage') = "Manage tags" (record.tagging.manage) as the
//   DialogTrigger, and the DialogTitle is the same string. The
//   dialog accessible name in a live DOM is UNVERIFIED (same Radix
//   caveat as the Settings dialog).
// - Tag checkboxes are UNVERIFIED: each checkbox is labelled by the
//   tag name (plus " (primary)" for the primary tag) through htmlFor,
//   but the rendered checkbox role/label association was not checked
//   in a live DOM. The primary tag checkbox is disabled in source.
// - The record row button (data-mark-detail-trigger, aria-label = the
//   record content or type label, mark-item.tsx) is UNVERIFIED: the
//   label is content-derived, so the flow must use a seeded record
//   with a fixed, unique content string.
// - Record CREATION through the UI is out of scope for this spec:
//   upstream capture controls (control-text.tsx and siblings) are
//   desktop capture flows. The web creation dialog (WebRecordCreate,
//   V3-26a) has merged but is not mounted in any page on trunk, and
//   V3-26b merged without mounting it, so no creation path is
//   reachable through the browser until inbox mounting lands as
//   follow-up work. The record under test is seeded through the
//   backend harness, which has NOT landed. Seeding goes through the
//   kind layer (tags.create, then marks.create; D-3D-1): REST
//   marks/tags routes do not exist on trunk.
//
// Intended steps (replace the notYetLanded call when the feature lands):
// 1. Seed one record (type text, fixed unique content) and two tags
//    through the backend harness, with the record assigned only the
//    first tag. Descriptors live in harness/seed-data.ts
//    (RECORD_SEEDS, TAG_SEEDS). Backend record/tag seeding has NOT
//    landed.
// 2. Open the record list, find the seeded record (markDetailButton,
//    UNVERIFIED), and open the tag editor (AppPage.openTagEditor,
//    "Manage tags" button, VERIFIED in source). The web inbox list
//    (WebInboxList, V3-26a) is likewise unmounted: V3-26b merged
//    without mounting it, so this step waits on mounting follow-up
//    as well as seeding.
// 3. Check the second tag checkbox (tagCheckbox, UNVERIFIED) and
//    save. Do NOT touch the primary tag checkbox: it is disabled in
//    source, and the primary tag is changed through Move Tag, not
//    through this editor.
// 4. Wait for the save EFFECT by observation: the dialog closes and
//    the record shows the new tag (or the tag list count changes),
//    never by a fixed sleep. Note the contract guard: PUT tags
//    requires expectedTagIds unless force (kontrak 3.6; kind path:
//    marks.updateTags set guard); the UI sends the expectation from
//    the state it loaded, so a stale editor must fail visibly rather
//    than overwrite silently. This spec does not cover the
//    stale-editor conflict case.
// 5. Reload the page and re-open the tag editor for the same record.
// 6. Assert both tags are checked, in the order the contract defines.
//    CAUTION (inventaris-record-ui.md S-02): upstream tagIds are
//    always sorted ascending numerically and carry no position, so
//    the flow must assert SET membership plus the contract's stated
//    order, never an assumed user-chosen order. CAUTION (S-26): the
//    upstream editor can create a new tag inline while assigning;
//    the contract has no inline creation, so this spec only assigns
//    tags that already exist.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-S3 @scaffold record plus tag: assigned tag survives reload', async () => {
  notYetLanded(
    'E2E-S3',
    'backend record/tag seeding plus inbox mounting and wiring ' +
      'have not landed; no record can be tagged through the web UI yet.',
  )
})
