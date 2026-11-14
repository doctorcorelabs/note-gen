// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g5-updater-static. Synthetic example.

import { check } from '@tauri-apps/plugin-updater';
import type { Update } from '@tauri-apps/plugin-updater';

export async function checkForUpdates(): Promise<string | null> {
  const update: Update | null = await check();
  if (!update) {
    return null;
  }
  return update.version;
}

export async function installUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
}
