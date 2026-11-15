// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: edge-multi-specifier-staged. Synthetic example.

import { platform } from '@/lib/platform';
import { listen } from '@tauri-apps/api/event';

export async function combined(): Promise<() => void> {
  const store = await platform.store.load('store.json');
  await store.set('lastCommand', 'ping');
  await platform.invoke.invoke('ping', {});
  const unlisten = await listen('pong', () => undefined);
  return unlisten;
}
