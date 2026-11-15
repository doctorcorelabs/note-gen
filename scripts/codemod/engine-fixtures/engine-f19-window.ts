// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import { getCurrentWindow } from '@tauri-apps/api/window'

export function label() {
  return getCurrentWindow().label
}
