// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: edge-other-wave-only. Synthetic example.

import { open } from '@tauri-apps/plugin-shell';

export async function openLater(path: string): Promise<void> {
  await open(path);
}
