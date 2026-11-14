// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g5-image-static. Synthetic example.

import { platform } from '@/lib/platform';

export async function copyScreenshot(png: Uint8Array): Promise<void> {
  await platform.clipboard.writeImage(png);
}
