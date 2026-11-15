// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR2). Not part of the app bundle; never imported by src/.

import type { Store } from '@tauri-apps/plugin-store'

export async function restoreSettings(store: Store): Promise<void> {
  await store.set('restored', true)
  await store.save()
}
