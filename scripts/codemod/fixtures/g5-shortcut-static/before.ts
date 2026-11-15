// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g5-shortcut-static. Synthetic example.

import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut';

export async function bindShortcut(shortcut: string, handler: () => void): Promise<boolean> {
  const already = await isRegistered(shortcut);
  if (already) {
    await unregister(shortcut);
  }
  await register(shortcut, handler);
  return isRegistered(shortcut);
}
