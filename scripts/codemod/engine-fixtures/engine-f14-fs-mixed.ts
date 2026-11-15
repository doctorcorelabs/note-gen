// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import { readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'

export async function readIt() {
  return readTextFile('a.txt', { baseDir: BaseDirectory.AppData })
}
