// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g3-clipboard-api-static. Synthetic example.

import { platform } from '@/lib/platform';

export async function clipboardStatus(): Promise<string> {
  if (await platform.clipboard.hasText()) {
    return platform.clipboard.readText();
  }
  if (await platform.clipboard.hasImage()) {
    return platform.clipboard.readImageBase64();
  }
  await platform.clipboard.clear();
  return "";
}

export async function copyNote(text: string): Promise<void> {
  await platform.clipboard.writeText(text);
}
