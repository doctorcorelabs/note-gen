// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-store-type-only. Synthetic example.

import type { StoreHandle } from '@/lib/platform';

export async function restoreSettings(store: StoreHandle): Promise<void> {
  await store.set('restored', true);
  await store.save();
}
