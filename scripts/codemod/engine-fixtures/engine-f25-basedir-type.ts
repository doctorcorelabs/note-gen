// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR2). Not part of the app bundle; never imported by src/.
// Value-kind barrel export (BaseDirectory, an enum) used ONLY in type
// positions: the engine must keep a type import (pattern 3). Mirrors
// the V3-16c fixture g1-fs-type-only, which caught the value-bucketing
// gap in the R2 compatibility run.

import type { BaseDirectory, DirEntry } from '@tauri-apps/plugin-fs';

export function describeEntry(entry: DirEntry, baseDir: BaseDirectory): string {
  return `${entry.name}:${String(baseDir)}`;
}
