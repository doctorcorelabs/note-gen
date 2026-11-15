// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import { platform, version } from '@tauri-apps/plugin-os'

export function info() {
  return [platform(), version()]
}
