// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-window-size-value. Synthetic example.

import { LogicalSize, PhysicalPosition, getCurrentWindow } from '@tauri-apps/api/window';

export async function resizeWindow(): Promise<void> {
  const win = getCurrentWindow();
  await win.setSize(new LogicalSize(800, 600));
  await win.setPosition(new PhysicalPosition(100, 100));
}
