// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g5-image-static. Synthetic example.

import { Image as TauriImage } from '@tauri-apps/api/image';
import { writeImage } from '@tauri-apps/plugin-clipboard-manager';

export async function copyScreenshot(png: Uint8Array): Promise<void> {
  const image = await TauriImage.fromBytes(png);
  try {
    await writeImage(image);
  } finally {
    await image.close();
  }
}
