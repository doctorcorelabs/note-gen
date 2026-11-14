// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR2). Not part of the app bundle; never imported by src/.

import { openPath, revealItemInDir, openUrl } from '@tauri-apps/plugin-opener'

export async function reveal(path: string) {
  await openPath(path)
  await revealItemInDir(path)
  await openUrl('https://example.test')
}
