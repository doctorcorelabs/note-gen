// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-fs-static. Synthetic example.

import { BaseDirectory, platform } from '@/lib/platform';

export async function moveNote(oldPath: string, newPath: string): Promise<boolean> {
  const found = await platform.fs.exists(oldPath, { baseDir: BaseDirectory.AppData });
  if (!found) {
    return false;
  }
  await platform.fs.mkdir('notes', { baseDir: BaseDirectory.AppData, recursive: true });
  const text = await platform.fs.readTextFile(oldPath, { baseDir: BaseDirectory.AppData });
  await platform.fs.writeTextFile(newPath, text, { baseDir: BaseDirectory.AppData });
  await platform.fs.copyFile(oldPath, 'notes/backup.md');
  await platform.fs.rename(oldPath, 'notes/archived.md');
  const entries = await platform.fs.readDir('notes', { baseDir: BaseDirectory.AppData });
  const info = await platform.fs.stat(newPath, { baseDir: BaseDirectory.AppData });
  await platform.fs.remove('notes/backup.md', { baseDir: BaseDirectory.AppData });
  return entries.length > 0 && info.size >= 0;
}
