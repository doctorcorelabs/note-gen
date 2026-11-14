// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR2). Not part of the app bundle; never imported by src/.

import { type LogicalSize, getCurrentWindow } from '@tauri-apps/api/window'

export function area(size: LogicalSize): number {
  void getCurrentWindow()
  return size.width * size.height
}
