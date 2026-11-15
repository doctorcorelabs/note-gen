// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

export async function dyn() {
  const { Store } = await import('@tauri-apps/plugin-store')
  const store = await Store.load('store.json')
  const mod = await import('@tauri-apps/plugin-fs')
  const ok = await mod.exists('x')
  await import('@tauri-apps/plugin-fs').then((m) => m.exists('y'))
  return [store, ok]
}
export async function batch() {
  const [{ getAllWebviewWindows }, { Store }] = await Promise.all([
    import('@tauri-apps/api/webviewWindow'),
    import('@tauri-apps/plugin-store'),
  ])
  return [getAllWebviewWindows, Store]
}
