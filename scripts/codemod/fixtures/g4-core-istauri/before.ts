// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-core-istauri. Synthetic example.

import { isTauri } from '@tauri-apps/api/core';

export function runtimeLabel(): string {
  return isTauri() ? 'desktop' : 'web';
}
