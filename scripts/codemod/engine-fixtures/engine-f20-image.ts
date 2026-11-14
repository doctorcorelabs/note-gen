// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR2). Not part of the app bundle; never imported by src/.

import { Image as TauriImage } from '@tauri-apps/api/image'

export async function imageFromBytes(png: Uint8Array) {
  const image = await TauriImage.fromBytes(png)
  return image
}
