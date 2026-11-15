// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import { fetch, Proxy } from '@tauri-apps/plugin-http'

export function mk() {
  const p = new Proxy('http://x.test')
  return [fetch, p]
}
