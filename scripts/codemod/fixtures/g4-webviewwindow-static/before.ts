// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-webviewwindow-static. Synthetic example.

import { WebviewWindow, getAllWebviewWindows, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export async function openEditorWindow(label: string): Promise<number> {
  const editor = new WebviewWindow(label, { url: '/editor-window' });
  await editor.setTitle('Editor');
  const current = getCurrentWebviewWindow();
  await current.setFocus();
  const found = await WebviewWindow.getByLabel(label);
  const all = await getAllWebviewWindows();
  return all.length + (found ? 1 : 0);
}
