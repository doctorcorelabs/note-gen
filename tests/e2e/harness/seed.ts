// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Deterministic seed workspace for E2E flows (desain-pengujian 4.1).
//
// One seed per test: nested .md files, one relative image, one
// relative link, and hidden entries that the file tree must filter
// out. Names and contents are fixed constants, never random, so
// assertions are reproducible across runs. Only the temporary parent
// directory name is unique per call.
//
// WIRING STATUS: WIRED, LIVE-PROVEN. The backend fixture
// (harness/backend-fixture.ts) passes the directory returned here
// as WORKSPACE_ROOT to a per-test backend, and live runs prove the
// seed entries appear in the tree (merge gates plus the W4-FLOWS
// conversion runs; see laporan-3e-w4-flows-r12.md).

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const SEED_FILES = {
  gettingStarted: 'notes/getting-started.md',
  deepNote: 'notes/nested/deep-note.md',
  linkedNote: 'notes/linked-note.md',
  image: 'notes/assets/pixel.png',
  hiddenFile: '.hidden.md',
  hiddenFolderFile: '.git/keep.md',
} as const

export const SEED_CONTENTS = {
  gettingStarted:
    '# Getting started\n\nSeed note for E2E. Unique term: quokka-seed-alpha.\n',
  deepNote:
    '# Deep note\n\nNested seed note. Unique term: quokka-seed-beta.\n\n' +
    '![pixel](../assets/pixel.png)\n',
  linkedNote:
    '# Linked note\n\nLinks to [deep note](nested/deep-note.md).\n',
} as const

// 1x1 transparent PNG. Written as bytes, not fetched from anywhere.
const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII='

export interface SeedWorkspace {
  dir: string
  files: typeof SEED_FILES
}

async function writeSeedFile(root: string, relativePath: string, contents: string | Buffer): Promise<void> {
  const target = join(root, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

export async function prepareSeedWorkspace(): Promise<SeedWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'notegen-e2e-seed-'))
  await writeSeedFile(dir, SEED_FILES.gettingStarted, SEED_CONTENTS.gettingStarted)
  await writeSeedFile(dir, SEED_FILES.deepNote, SEED_CONTENTS.deepNote)
  await writeSeedFile(dir, SEED_FILES.linkedNote, SEED_CONTENTS.linkedNote)
  await writeSeedFile(dir, SEED_FILES.image, Buffer.from(PIXEL_PNG_BASE64, 'base64'))
  await writeSeedFile(dir, SEED_FILES.hiddenFile, '# Hidden\n')
  await writeSeedFile(dir, SEED_FILES.hiddenFolderFile, '# Hidden folder\n')
  return { dir, files: SEED_FILES }
}

export async function removeSeedWorkspace(seed: SeedWorkspace): Promise<void> {
  await rm(seed.dir, { recursive: true, force: true })
}
