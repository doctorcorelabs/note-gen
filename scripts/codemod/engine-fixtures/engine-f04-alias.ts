// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { fetch as httpFetch } from '@tauri-apps/plugin-http'
import { platform as getRuntimePlatform } from '@tauri-apps/plugin-os'

export async function go() {
  const picked = await openDialog()
  const res = await httpFetch('https://example.test')
  const plat = getRuntimePlatform()
  return [picked, res, plat]
}
