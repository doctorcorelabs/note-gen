// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-window-size-value. Synthetic example.

import { platform } from '@/lib/platform';

export async function resizeWindow(): Promise<void> {
  const win = platform.window.getCurrentWindow();
  await win.setSize({ type: 'Logical', width: 800, height: 600 });
  await win.setPosition({ type: 'Physical', x: 100, y: 100 });
}
