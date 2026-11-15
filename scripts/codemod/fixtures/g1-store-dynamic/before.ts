// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-store-dynamic. Synthetic example.

export async function readFlag(key: string): Promise<unknown> {
  const { Store } = await import('@tauri-apps/plugin-store');
  const store = await Store.load('store.json');
  return store.get(key);
}
