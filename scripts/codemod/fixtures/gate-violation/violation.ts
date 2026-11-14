// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Gate-violation fixture (V3-16c for V3-16b). INTENTIONAL VIOLATION.
// Synthetic example. Never commit under src/. See README.md here.

// Violation 1: unmigrated Tauri specifier import (gate layer 1).
import { Store } from '@tauri-apps/plugin-store';

export async function readUnmigrated(key: string): Promise<unknown> {
  // Violation 2: raw Store.load derivative pattern (gate layer 2).
  const store = await Store.load('store.json');
  return store.get(key);
}

export function detectUnmigrated(): boolean {
  // Violation 3: __TAURI_INTERNALS__ outside detect.ts (gate layer 2).
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
