// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-webviewwindow-static. Synthetic example.

import { platform } from '@/lib/platform';

export async function openEditorWindow(label: string): Promise<number> {
  const editor = platform.window.createWebviewWindow(label, { url: '/editor-window' });
  await editor.setTitle('Editor');
  const current = platform.window.getCurrentWebviewWindow();
  await current.setFocus();
  const found = await platform.window.getWebviewWindowByLabel(label);
  const all = await platform.window.getAllWebviewWindows();
  return all.length + (found ? 1 : 0);
}
