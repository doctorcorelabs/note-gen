// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g3-dialog-static. Synthetic example.

import { platform } from '@/lib/platform';

export async function pickAndConfirm(): Promise<string | null> {
  const picked = await platform.dialog.open({ multiple: false });
  await platform.dialog.message('File picked');
  const ok = await platform.dialog.confirm('Continue?');
  if (!ok) {
    return null;
  }
  const asked = await platform.dialog.ask('Save a copy?');
  if (asked) {
    return platform.dialog.save();
  }
  return Array.isArray(picked) ? picked[0] : picked;
}
