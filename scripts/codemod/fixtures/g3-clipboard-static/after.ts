// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g3-clipboard-static. Synthetic example.

import { platform } from '@/lib/platform';

export async function copyAll(text: string, html: string, png: Uint8Array): Promise<void> {
  await platform.clipboard.writeText(text);
  await platform.clipboard.writeHtml(html, text);
  await platform.clipboard.writeImage(png);
}
