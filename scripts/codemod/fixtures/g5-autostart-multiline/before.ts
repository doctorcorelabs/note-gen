// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g5-autostart-multiline. Synthetic example.

import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart';

export async function ensureAutostart(enabled: boolean): Promise<boolean> {
  if (enabled) {
    await enableAutostart();
  } else {
    await disableAutostart();
  }
  return isAutostartEnabled();
}
