// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import { check, Update } from '@tauri-apps/plugin-updater'

export async function upd(u: Update | null) {
  const found = await check()
  return [found, u?.version]
}
