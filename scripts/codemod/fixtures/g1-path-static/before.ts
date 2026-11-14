// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-path-static. Synthetic example.

import { appConfigDir, appDataDir, basename, dirname, join, normalize } from '@tauri-apps/api/path';

export async function workspacePaths(name: string): Promise<string> {
  const dataDir = await appDataDir();
  const configDir = await appConfigDir();
  const joined = await join(dataDir, 'notes', name);
  const dir = await dirname(joined);
  const base = await basename(joined);
  const clean = await normalize(`${dir}/${base}`);
  return `${configDir}:${clean}`;
}
