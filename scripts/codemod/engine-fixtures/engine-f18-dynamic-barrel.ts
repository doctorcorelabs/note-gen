// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

export async function dynBarrel() {
  const { BaseDirectory } = await import('@tauri-apps/plugin-fs')
  return BaseDirectory.AppData
}
