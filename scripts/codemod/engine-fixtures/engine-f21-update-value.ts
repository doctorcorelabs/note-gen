// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR2). Not part of the app bundle; never imported by src/.

import { check, Update } from '@tauri-apps/plugin-updater'

export function make() {
  const u = new Update()
  void check
  return u
}
