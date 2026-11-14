// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-event-static. Synthetic example.

import { emit, emitTo, listen, once } from '@tauri-apps/api/event';

export async function wireEvents(): Promise<() => void> {
  const unlisten = await listen<string>('note-saved', (event) => {
    void event.payload;
  });
  await once<string>('note-opened', (event) => {
    void event.payload;
  });
  await emit('note-changed', { id: 1 });
  await emitTo('main', 'note-focus', { id: 1 });
  return unlisten;
}
