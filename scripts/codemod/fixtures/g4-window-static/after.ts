// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-window-static. Synthetic example.

import { platform } from '@/lib/platform';

export async function focusAndTitle(title: string): Promise<boolean> {
  const win = platform.window.getCurrentWindow();
  await win.setTitle(title);
  await win.setFocus();
  await win.show();
  const maximized = await win.isMaximized();
  await win.minimize();
  await win.toggleMaximize();
  await win.hide();
  await win.close();
  return maximized;
}
