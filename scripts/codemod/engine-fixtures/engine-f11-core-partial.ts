// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import { invoke, convertFileSrc, isTauri } from '@tauri-apps/api/core'

export async function mixed() {
  const url = convertFileSrc('/x.png')
  const t = isTauri()
  await invoke('cmd', {})
  return [url, t]
}
