// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g2-core-channel. Synthetic example.

import { Channel, invoke } from '@tauri-apps/api/core';

export async function streamEvents(): Promise<void> {
  const channel = new Channel<string>((event) => {
    void event;
  });
  await invoke('stream_command', { channel });
  channel.onmessage = (event) => {
    void event;
  };
}
