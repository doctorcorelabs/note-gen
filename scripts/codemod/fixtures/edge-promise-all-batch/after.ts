// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: edge-promise-all-batch. Synthetic example.

import { platform } from '@/lib/platform';

export async function openEditorTab(label: string): Promise<void> {
  const win = platform.window.getCurrentWindow();
  await win.setFocus();
  const editor = platform.window.createWebviewWindow(label, { url: '/editor-window' });
  await editor.setTitle('Editor');
}
