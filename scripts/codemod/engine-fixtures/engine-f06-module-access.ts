// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import { getDb } from './db'

export async function sync() {
  const module = await import('@tauri-apps/plugin-store')
  const store = await module.Store.load('store.json')
  return store
}
