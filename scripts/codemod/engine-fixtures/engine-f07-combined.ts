// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import { Store } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import { invoke as invoke2 } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'

export async function combo() {
  const s = await Store.load('store.json')
  await invoke('cmd', {})
  await invoke2('cmd2', {})
  await emit('e')
  return s
}
