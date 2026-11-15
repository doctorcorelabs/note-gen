// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g5-autostart-multiline. Synthetic example.

import { platform } from '@/lib/platform';

export async function ensureAutostart(enabled: boolean): Promise<boolean> {
  if (enabled) {
    await platform.autostart.enable();
  } else {
    await platform.autostart.disable();
  }
  return platform.autostart.isEnabled();
}
