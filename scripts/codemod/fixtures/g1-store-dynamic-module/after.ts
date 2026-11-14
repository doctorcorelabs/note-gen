// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-store-dynamic-module. Synthetic example.

import { platform } from '@/lib/platform';

export async function readViaModule(key: string): Promise<unknown> {
  return platform.store.load('store.json').then((store) => store.get(key));
}

export async function readViaAwait(key: string): Promise<unknown> {
  const store = await platform.store.load('store.json');
  return store.get(key);
}
