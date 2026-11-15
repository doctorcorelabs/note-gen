// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g3-dialog-dynamic. Synthetic example.

import { platform } from '@/lib/platform';

export async function pickFileLater(): Promise<unknown> {
  const picked = await platform.dialog.open();
  if (!picked) {
    return null;
  }
  return platform.dialog.save();
}
