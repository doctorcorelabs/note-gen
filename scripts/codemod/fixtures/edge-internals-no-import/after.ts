// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: edge-internals-no-import. Synthetic example.

import { isTauriRuntime } from '@/lib/platform';

export function isDesktopShell(): boolean {
  return isTauriRuntime();
}

export function isDesktopGlobal(): boolean {
  return isTauriRuntime();
}
