// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-path-static. Synthetic example.

import { platform } from '@/lib/platform';

export async function workspacePaths(name: string): Promise<string> {
  const dataDir = await platform.path.appDataDir();
  const configDir = await platform.path.appConfigDir();
  const joined = await platform.path.join(dataDir, 'notes', name);
  const dir = await platform.path.dirname(joined);
  const base = await platform.path.basename(joined);
  const clean = await platform.path.normalize(`${dir}/${base}`);
  return `${configDir}:${clean}`;
}
