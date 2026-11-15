// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-store-static. Synthetic example.

import { Store } from '@tauri-apps/plugin-store';

export async function loadSettings(): Promise<string | undefined> {
  const store = await Store.load('store.json');
  await store.set('theme', 'dark');
  const theme = await store.get<string>('theme');
  const hasTheme = await store.has('theme');
  const keys = await store.keys();
  await store.save();
  await store.reset();
  await store.clear();
  await store.delete('theme');
  await store.reload();
  const unlisten = await store.onChange((_key, _value) => undefined);
  unlisten();
  await store.close();
  return hasTheme && keys.length > 0 ? theme : undefined;
}
