// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: edge-promise-all-batch. Synthetic example.

export async function openEditorTab(label: string): Promise<void> {
  const [windowMod, webviewMod] = await Promise.all([
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/webviewWindow'),
  ]);
  const win = windowMod.getCurrentWindow();
  await win.setFocus();
  const editor = new webviewMod.WebviewWindow(label, { url: '/editor-window' });
  await editor.setTitle('Editor');
}
