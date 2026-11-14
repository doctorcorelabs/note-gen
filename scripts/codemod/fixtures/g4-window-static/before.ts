// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-window-static. Synthetic example.

import { getCurrentWindow } from '@tauri-apps/api/window';

export async function focusAndTitle(title: string): Promise<boolean> {
  const win = getCurrentWindow();
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
