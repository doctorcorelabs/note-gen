// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-store-dynamic-module. Synthetic example.

export async function readViaModule(key: string): Promise<unknown> {
  return import('@tauri-apps/plugin-store').then((module) => module.Store.load('store.json')).then((store) => store.get(key));
}

export async function readViaAwait(key: string): Promise<unknown> {
  const module = await import('@tauri-apps/plugin-store');
  const store = await module.Store.load('store.json');
  return store.get(key);
}
