// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g5-image-static. Synthetic example.

import { Image as TauriImage } from '@tauri-apps/api/image';

export async function imageFromBytes(png: Uint8Array): Promise<unknown> {
  const image = await TauriImage.fromBytes(png);
  return image;
}
