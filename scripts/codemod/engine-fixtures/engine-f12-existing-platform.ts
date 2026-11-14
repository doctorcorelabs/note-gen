// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import { platform } from '@/lib/platform'
import { Store } from '@tauri-apps/plugin-store'

export async function again() {
  const s = await Store.load('store.json')
  void platform
  return s
}
