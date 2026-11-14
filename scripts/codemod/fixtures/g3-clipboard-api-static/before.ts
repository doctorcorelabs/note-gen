// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g3-clipboard-api-static. Synthetic example.

import { clear, hasImage, hasText, readImageBase64, readText, writeText } from "tauri-plugin-clipboard-api";

export async function clipboardStatus(): Promise<string> {
  if (await hasText()) {
    return readText();
  }
  if (await hasImage()) {
    return readImageBase64();
  }
  await clear();
  return "";
}

export async function copyNote(text: string): Promise<void> {
  await writeText(text);
}
