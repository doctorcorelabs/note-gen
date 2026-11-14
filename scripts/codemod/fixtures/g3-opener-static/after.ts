// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g3-opener-static. Synthetic example.

import { platform } from '@/lib/platform';

export async function openTargets(url: string, path: string): Promise<void> {
  await platform.opener.openUrl(url);
  await platform.opener.openPath(path);
  await platform.opener.revealItemInDir(path);
}
