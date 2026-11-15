// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g5-process-static. Synthetic example.

import { exit, relaunch } from '@tauri-apps/plugin-process';

export async function restartApp(): Promise<void> {
  await relaunch();
}

export async function quitApp(code?: number): Promise<void> {
  await exit(code);
}
