// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g3-dialog-dynamic. Synthetic example.

export async function pickFileLater(): Promise<unknown> {
  const { open, save } = await import('@tauri-apps/plugin-dialog');
  const picked = await open();
  if (!picked) {
    return null;
  }
  return save();
}
