// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g2-core-istauri. Synthetic example.

import { isTauriRuntime } from '@/lib/platform';

export function runtimeLabel(): string {
  return isTauriRuntime() ? 'desktop' : 'web';
}
