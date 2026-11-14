// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-store-type-only. Synthetic example.

import type { Store } from '@tauri-apps/plugin-store';

export async function restoreSettings(store: Store): Promise<void> {
  await store.set('restored', true);
  await store.save();
}
