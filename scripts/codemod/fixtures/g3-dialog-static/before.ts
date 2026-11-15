// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g3-dialog-static. Synthetic example.

import { ask, confirm, message, open as openDialog, save } from '@tauri-apps/plugin-dialog';

export async function pickAndConfirm(): Promise<string | null> {
  const picked = await openDialog({ multiple: false });
  await message('File picked');
  const ok = await confirm('Continue?');
  if (!ok) {
    return null;
  }
  const asked = await ask('Save a copy?');
  if (asked) {
    return save();
  }
  return Array.isArray(picked) ? picked[0] : picked;
}
