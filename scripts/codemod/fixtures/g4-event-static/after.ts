// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-event-static. Synthetic example.

import { platform } from '@/lib/platform';

export async function wireEvents(): Promise<() => void> {
  const unlisten = await platform.event.listen<string>('note-saved', (event) => {
    void event.payload;
  });
  await platform.event.once<string>('note-opened', (event) => {
    void event.payload;
  });
  await platform.event.emit('note-changed', { id: 1 });
  await platform.event.emitTo('main', 'note-focus', { id: 1 });
  return unlisten;
}
