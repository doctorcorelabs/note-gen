// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-fs-type-only. Synthetic example.

import type { BaseDirectory, DirEntry, WatchEvent, WriteFileOptions } from '@/lib/platform';

export function describeEntry(entry: DirEntry): string {
  return entry.name;
}

export function watchDirLabel(baseDir: BaseDirectory): string {
  return String(baseDir);
}

export function countWatchPaths(event: WatchEvent): number {
  return event.paths.length;
}

export function writeOptions(): WriteFileOptions {
  return { append: true };
}
