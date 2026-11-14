// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: edge-no-target. Synthetic example.

import { platform } from '@/lib/platform';

export async function alreadyMigrated(key: string): Promise<unknown> {
  const store = await platform.store.load('store.json');
  return store.get(key);
}

export function pureHelper(value: number): number {
  return value * 2;
}
