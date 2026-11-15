// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g5-shortcut-static. Synthetic example.

import { platform } from '@/lib/platform';

export async function bindShortcut(shortcut: string, handler: () => void): Promise<boolean> {
  const already = await platform.shortcut.isRegistered(shortcut);
  if (already) {
    await platform.shortcut.unregister(shortcut);
  }
  await platform.shortcut.register(shortcut, handler);
  return platform.shortcut.isRegistered(shortcut);
}
