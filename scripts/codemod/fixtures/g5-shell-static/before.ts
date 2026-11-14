// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g5-shell-static. Synthetic example.

import { open } from '@tauri-apps/plugin-shell';

export async function openInSystemApp(path: string): Promise<void> {
  await open(path);
}
