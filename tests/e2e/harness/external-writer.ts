// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// "External process" file writer for E2E-05 (desain-pengujian 4.2).
//
// Writes files the way an outside process would: write to a temporary
// file in the same directory, then rename it into place, so a watcher
// never observes a half-written file. This is the write pattern the
// file watcher contract (C-FS-10) assumes. The helper touches only
// the workspace directory it is given and never talks to the app.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function writeFileAtomically(
  workspaceDir: string,
  relativePath: string,
  contents: string | Buffer,
): Promise<string> {
  const target = join(workspaceDir, relativePath)
  await mkdir(dirname(target), { recursive: true })
  const tempPath = `${target}.e2e-tmp-${process.pid}`
  await writeFile(tempPath, contents)
  await rename(tempPath, target)
  return target
}

export async function removeExternalFile(workspaceDir: string, relativePath: string): Promise<void> {
  await rm(join(workspaceDir, relativePath), { force: true })
}
