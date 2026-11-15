// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g3-opener-static. Synthetic example.

import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';

export async function openTargets(url: string, path: string): Promise<void> {
  await openUrl(url);
  await openPath(path);
  await revealItemInDir(path);
}
