// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

export function detect() {
  return '__TAURI_INTERNALS__' in globalThis
}

export function detectProp() {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__)
}
