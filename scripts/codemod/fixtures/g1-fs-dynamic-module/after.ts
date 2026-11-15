// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-fs-dynamic-module. Synthetic example.

import { platform } from '@/lib/platform';

export async function readViaModule(path: string): Promise<string> {
  return platform.fs.readTextFile(path);
}

export async function readViaAwait(path: string): Promise<string> {
  return platform.fs.readTextFile(path);
}
