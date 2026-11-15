// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g5-updater-static. Synthetic example.

import { platform } from '@/lib/platform';
import type { UpdateInfo } from '@/lib/platform';

export async function checkForUpdates(): Promise<string | null> {
  const update: UpdateInfo | null = await platform.updater.check();
  if (!update) {
    return null;
  }
  return update.version;
}

export async function installUpdate(update: UpdateInfo): Promise<void> {
  await update.downloadAndInstall();
}
