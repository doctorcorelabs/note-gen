// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import type { UnlistenFn } from '@tauri-apps/api/event'
import { listen, type UnlistenFn as UL2 } from '@tauri-apps/api/event'
import { readDir, BaseDirectory, DirEntry } from "@tauri-apps/plugin-fs";

export async function watchIt(cb: (d: DirEntry) => void): Promise<UnlistenFn> {
  const entries = await readDir('x', { baseDir: BaseDirectory.AppData })
  void entries
  return listen('evt', () => cb(entries[0]))
}
export type Alias = UL2
