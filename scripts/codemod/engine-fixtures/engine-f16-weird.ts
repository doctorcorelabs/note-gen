// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import * as fs from '@tauri-apps/plugin-fs'
import '@tauri-apps/plugin-store'
export { Store } from '@tauri-apps/plugin-store'

export async function w() {
  return fs.exists('x')
}
