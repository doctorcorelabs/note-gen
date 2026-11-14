// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-fs-static. Synthetic example.

import { BaseDirectory, copyFile, exists, mkdir, readDir, readTextFile, remove, rename as fsRename, stat, writeTextFile } from '@tauri-apps/plugin-fs';

export async function moveNote(oldPath: string, newPath: string): Promise<boolean> {
  const found = await exists(oldPath, { baseDir: BaseDirectory.AppData });
  if (!found) {
    return false;
  }
  await mkdir('notes', { baseDir: BaseDirectory.AppData, recursive: true });
  const text = await readTextFile(oldPath, { baseDir: BaseDirectory.AppData });
  await writeTextFile(newPath, text, { baseDir: BaseDirectory.AppData });
  await copyFile(oldPath, 'notes/backup.md');
  await fsRename(oldPath, 'notes/archived.md');
  const entries = await readDir('notes', { baseDir: BaseDirectory.AppData });
  const info = await stat(newPath, { baseDir: BaseDirectory.AppData });
  await remove('notes/backup.md', { baseDir: BaseDirectory.AppData });
  return entries.length > 0 && info.size >= 0;
}
