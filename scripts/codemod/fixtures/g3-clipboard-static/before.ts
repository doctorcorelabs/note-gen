// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g3-clipboard-static. Synthetic example.

import { writeHtml, writeImage, writeText } from '@tauri-apps/plugin-clipboard-manager';

export async function copyAll(text: string, html: string, png: Uint8Array): Promise<void> {
  await writeText(text);
  await writeHtml(html, text);
  await writeImage(png);
}
