// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Shared deterministic seed data for the six E2E flows (desain-pengujian
// 4.2) and the A10 demo walkthrough (rencana-gelombang3 4.3).
//
// DATA ONLY. This module performs no I/O, no HTTP, and no waiting: it
// only fixes the exact contents, names, and terms every flow asserts
// against, so flows cannot drift apart by inventing their own fixtures.
// Disk creation still lives in ./seed.ts (prepareSeedWorkspace); API
// seeding lives in ./seed-records.ts (kind layer, through the backend
// fixture), live-unproven until the merge gate runs it. Nothing here
// claims a flow already uses this data through the app.
//
// Anti-flaky rules (desain-pengujian 4.3): every value below is a fixed
// constant. No Math.random, no Date.now, no timers. The only uniqueness
// in a run comes from the temporary directory name in seed.ts, which no
// assertion depends on.
//
// Search terms use the "quokka-" prefix so a term can only match seed
// content, never real UI text. The absent term is checked by
// assertSeedTermsConsistent below: it must not occur in any seed
// content, fixture, or record below. Run that check before trusting a
// new term.
//
// Record descriptors use the field names of the live record-creation
// path: buildTextCreateBody in src/lib/web/record-inputs.ts (type,
// content, desc, url, tagIds, sourceId), executed through the
// marks.create / tags.create kinds of the SqlAdapter kind layer
// (D-3D-1, src/lib/web/records-kind-client.ts). REST routes
// POST /api/marks and POST /api/tags do NOT exist on trunk: there is
// no marks.ts/tags.ts route file and nothing registers those paths,
// so a seeder must not assume them. The descriptors below stay
// transport-neutral on purpose: the 3E seeder resolves tag names to
// ids after creating the tags, then creates each record with its
// resolved tag ids. Tags are referenced by NAME here because tag ids
// do not exist until the tags are created. Each seed record carries
// exactly one tag, so the primary tag (first tag id on the kind
// path) is unambiguous. Fixed sourceId values assume one fresh
// workspace and database per test (desain-pengujian 4.1): replaying
// the same sourceId in a reused database answers duplicate instead
// of creating a fresh row, by contract design.
//
// Settings seed: DELIBERATELY ABSENT. No setting key or value is fixed
// here. E2E-06 and the A10 demo step "ubah 2 pengaturan" still wait
// for the settings choice (an observable setting with a verified
// read-back path). V3-29 settings UI has merged (29a gating, 29b
// TOTP/sessions) without recording such a choice, so the choice is
// still pending with the coordinator/3E; inventing a key now would
// bake a guess into every flow. The choice is recorded as pending in
// settings-persist.spec.ts and demo.spec.ts instead. The inventory
// recommends theme as the strongest candidate (inventaris-selector-e2e
// 7.3), but a recommendation is not a choice: do not bake it in here
// until the owner decides.
//
// Relative paths below resolve against the seed layout in ./seed.ts:
// seed notes live under notes/, the pixel image at
// notes/assets/pixel.png. A flow that creates a note elsewhere must
// adjust the relative references, not reuse these constants blindly.

import { SEED_CONTENTS } from './seed'

// E2E-02: the note created through the UI. The fixture exercises every
// construction desain-pengujian 4.2 names: heading, list, code block,
// table, relative image, relative link. The note is created under
// notes/ so both relative references resolve against the seed layout.
export const CREATE_NOTE_RELATIVE_PATH = 'notes/e2e-created-note.md'

export const CREATE_NOTE_FIXTURE =
  '# Created note\n\nUnique term: quokka-created-delta.\n\n' +
  '- first item\n- second item\n\n' +
  '```text\ncode block stays literal\n```\n\n' +
  '| col one | col two |\n| --- | --- |\n| a | b |\n\n' +
  '![pixel](assets/pixel.png)\n\n' +
  'See [linked note](linked-note.md).\n'

// E2E-03: the edit applied to the seed deep note. The heading is
// replaced and one paragraph is appended; everything else must survive
// byte-for-byte. applyEditToDeepNote fails with a named error when the
// input does not contain the expected anchors, so a changed seed cannot
// silently produce a wrong "edited" expectation.
export const EDIT_DEEP_NOTE_HEADING = '# Deep note (edited)'

export const EDIT_DEEP_NOTE_PARAGRAPH =
  'Edited paragraph. Unique term: quokka-seed-beta-edited.\n'

export function applyEditToDeepNote(original: string): string {
  if (!original.includes('# Deep note\n')) {
    throw new Error(
      'seed-data edit failed: deep note content lacks the expected heading "# Deep note".',
    )
  }
  if (!original.includes('quokka-seed-beta')) {
    throw new Error(
      'seed-data edit failed: deep note content lacks the expected term "quokka-seed-beta".',
    )
  }
  const replaced = original.replace('# Deep note\n', `${EDIT_DEEP_NOTE_HEADING}\n`)
  return `${replaced}\n${EDIT_DEEP_NOTE_PARAGRAPH}`
}

// E2E-04: search terms. The unique term occurs in exactly one seed file
// (notes/getting-started.md); the absent term occurs nowhere.
export const SEARCH_TERMS = {
  uniqueTerm: 'quokka-seed-alpha',
  uniqueTermFile: 'notes/getting-started.md',
  uniqueTermFileName: 'getting-started.md',
  absentTerm: 'quokka-absent-zz9',
} as const

// E2E-05: the file an external process writes atomically into the
// workspace (see ./external-writer.ts). One unique term, fixed content.
export const EXTERNAL_FILE = {
  relativePath: 'notes/external-note.md',
  fileName: 'external-note.md',
  content: '# External note\n\nWritten from outside. Unique term: quokka-external-gamma.\n',
} as const

// Record and tag seeds for E2E-S3 and the A10 demo (5 records, 2 tags).
// Tag names follow the tag model (name, 1-100 characters, trimmed by
// the server; contract 3.6), created through the tags.create kind
// (D-3D-1). Record contents are text records; desc equals content,
// matching the text-flow default in buildTextCreateBody.
export const TAG_SEEDS = [{ name: 'e2e-alpha' }, { name: 'e2e-beta' }] as const

export interface RecordSeed {
  content: string
  desc: string
  sourceId: string
  tagNames: readonly string[]
}

export const RECORD_SEEDS: readonly RecordSeed[] = [
  {
    content: 'Seed record one. Unique term: quokka-record-1.',
    desc: 'Seed record one. Unique term: quokka-record-1.',
    sourceId: 'e2e:seed:record-1',
    tagNames: ['e2e-alpha'],
  },
  {
    content: 'Seed record two. Unique term: quokka-record-2.',
    desc: 'Seed record two. Unique term: quokka-record-2.',
    sourceId: 'e2e:seed:record-2',
    tagNames: ['e2e-alpha'],
  },
  {
    content: 'Seed record three. Unique term: quokka-record-3.',
    desc: 'Seed record three. Unique term: quokka-record-3.',
    sourceId: 'e2e:seed:record-3',
    tagNames: ['e2e-alpha'],
  },
  {
    content: 'Seed record four. Unique term: quokka-record-4.',
    desc: 'Seed record four. Unique term: quokka-record-4.',
    sourceId: 'e2e:seed:record-4',
    tagNames: ['e2e-beta'],
  },
  {
    content: 'Seed record five. Unique term: quokka-record-5.',
    desc: 'Seed record five. Unique term: quokka-record-5.',
    sourceId: 'e2e:seed:record-5',
    tagNames: ['e2e-beta'],
  },
]

// A10 demo: one folder with three notes (text, image, relative link).
// Paths resolve against the seed layout: from e2e-demo/ the image is
// ../notes/assets/pixel.png and the link target is
// ../notes/getting-started.md.
export const DEMO_FOLDER = 'e2e-demo'

export const DEMO_NOTES = [
  {
    fileName: 'text-note.md',
    relativePath: 'e2e-demo/text-note.md',
    content: '# Demo text note\n\nPlain text note. Unique term: quokka-demo-text.\n',
  },
  {
    fileName: 'image-note.md',
    relativePath: 'e2e-demo/image-note.md',
    content:
      '# Demo image note\n\nImage note. Unique term: quokka-demo-image.\n\n' +
      '![pixel](../notes/assets/pixel.png)\n',
  },
  {
    fileName: 'link-note.md',
    relativePath: 'e2e-demo/link-note.md',
    content:
      '# Demo link note\n\nLink note. Unique term: quokka-demo-link.\n\n' +
      'See [getting started](../notes/getting-started.md).\n',
  },
] as const

// Guard for the search-term invariants: the absent search term must
// not occur in any seed content, fixture, external file, record, or
// demo note, and the unique term must occur in exactly one seed file
// (the getting-started note). Pure and synchronous; call it from a
// flow setup step or a 3E harness check, never as a substitute for a
// real search assertion.
export function assertSeedTermsConsistent(): void {
  const haystacks: Array<{ label: string; text: string }> = [
    { label: 'seed gettingStarted', text: SEED_CONTENTS.gettingStarted },
    { label: 'seed deepNote', text: SEED_CONTENTS.deepNote },
    { label: 'seed linkedNote', text: SEED_CONTENTS.linkedNote },
    { label: 'create fixture', text: CREATE_NOTE_FIXTURE },
    { label: 'edit paragraph', text: EDIT_DEEP_NOTE_PARAGRAPH },
    { label: 'external file', text: EXTERNAL_FILE.content },
    ...RECORD_SEEDS.map((record) => ({ label: `record ${record.sourceId}`, text: record.content })),
    ...DEMO_NOTES.map((note) => ({ label: `demo ${note.fileName}`, text: note.content })),
  ]
  for (const haystack of haystacks) {
    if (haystack.text.includes(SEARCH_TERMS.absentTerm)) {
      throw new Error(
        `seed-data inconsistent: absent term "${SEARCH_TERMS.absentTerm}" ` +
          `occurs in ${haystack.label}; E2E-04 empty-state assertions would be meaningless.`,
      )
    }
  }
  if (!SEED_CONTENTS.gettingStarted.includes(SEARCH_TERMS.uniqueTerm)) {
    throw new Error(
      `seed-data inconsistent: unique term "${SEARCH_TERMS.uniqueTerm}" ` +
        'is missing from the seed getting-started note; E2E-04 has no file to find.',
    )
  }
  for (const other of [
    { label: 'seed deepNote', text: SEED_CONTENTS.deepNote },
    { label: 'seed linkedNote', text: SEED_CONTENTS.linkedNote },
  ]) {
    if (other.text.includes(SEARCH_TERMS.uniqueTerm)) {
      throw new Error(
        `seed-data inconsistent: unique term "${SEARCH_TERMS.uniqueTerm}" ` +
          `also occurs in ${other.label}; E2E-04 would find more than one file.`,
      )
    }
  }
}
