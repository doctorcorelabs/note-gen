// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: edge-quote-variants. Synthetic example.

import { Store } from "@tauri-apps/plugin-store"

export async function loadFlag(): Promise<unknown> {
  const store = await Store.load('store.json');
  return store.get('flag');
}
