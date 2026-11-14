// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import { getPlatformMode } from '@/lib/platform'
import type { StoreOptions } from '@/lib/platform'
import { Store } from '@tauri-apps/plugin-store'
import { readDir, DirEntry } from '@tauri-apps/plugin-fs'

export async function m(o: StoreOptions, d: DirEntry) {
  void getPlatformMode()
  return readDir('x')
}
