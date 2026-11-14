// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import { Store } from '@tauri-apps/plugin-store'

export async function loadIt() {
  const store = await Store.load('store.json')
  return store.get('k')
}
