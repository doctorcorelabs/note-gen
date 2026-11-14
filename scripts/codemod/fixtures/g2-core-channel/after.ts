// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g2-core-channel. Synthetic example.

import { platform } from '@/lib/platform';

export async function streamEvents(): Promise<void> {
  const channel = platform.channel.createChannel<string>((event) => {
    void event;
  });
  await platform.invoke.invoke('stream_command', { channel });
  channel.onmessage = (event) => {
    void event;
  };
}
