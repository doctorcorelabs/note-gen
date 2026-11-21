// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-2 (F-03): recursive folder duplication on workspace-relative
// paths. The previous implementation copied every file through
// readTextFile + writeTextFile, which silently corrupted binary
// files (lossy UTF-8 decode in web mode) and still showed a
// success toast. This module copies bytes with copyFile (the
// paste-into-folder pattern), resolves path options per entry
// instead of hardcoding BaseDirectory.AppData, counts failures,
// and lets the caller report honestly.

import type { BaseDirectory } from "@/lib/platform";

export interface DuplicateFolderTreeDeps {
  readDir: (
    path: string,
    options?: { baseDir?: BaseDirectory },
  ) => Promise<Array<{ name: string; isDirectory: boolean }>>;
  mkdir: (path: string, options?: { baseDir?: BaseDirectory }) => Promise<void>;
  copyFile: (
    fromPath: string,
    toPath: string,
    options?: { fromPathBaseDir?: BaseDirectory; toPathBaseDir?: BaseDirectory },
  ) => Promise<void>;
  getFilePathOptions: (
    relativePath: string,
  ) => Promise<{ path: string; baseDir?: BaseDirectory }>;
}

export interface DuplicateFolderTreeResult {
  copied: number;
  failed: string[];
}

export async function duplicateFolderTree(
  deps: DuplicateFolderTreeDeps,
  sourceRelative: string,
  targetRelative: string,
): Promise<DuplicateFolderTreeResult> {
  const result: DuplicateFolderTreeResult = { copied: 0, failed: [] };

  const copyDir = async (srcRelative: string, destRelative: string): Promise<void> => {
    const srcOptions = await deps.getFilePathOptions(srcRelative);
    const entries = await deps.readDir(
      srcOptions.path,
      srcOptions.baseDir ? { baseDir: srcOptions.baseDir } : undefined,
    );

    for (const entry of entries) {
      const srcEntryRelative = `${srcRelative}/${entry.name}`;
      const destEntryRelative = `${destRelative}/${entry.name}`;

      if (entry.isDirectory) {
        try {
          const destOptions = await deps.getFilePathOptions(destEntryRelative);
          await deps.mkdir(
            destOptions.path,
            destOptions.baseDir ? { baseDir: destOptions.baseDir } : undefined,
          );
          await copyDir(srcEntryRelative, destEntryRelative);
        } catch (error) {
          console.error(`Error copying folder ${srcEntryRelative}:`, error);
          result.failed.push(srcEntryRelative);
        }
        continue;
      }

      try {
        const fromOptions = await deps.getFilePathOptions(srcEntryRelative);
        const toOptions = await deps.getFilePathOptions(destEntryRelative);
        await deps.copyFile(fromOptions.path, toOptions.path, {
          fromPathBaseDir: fromOptions.baseDir,
          toPathBaseDir: toOptions.baseDir,
        });
        result.copied++;
      } catch (error) {
        console.error(`Error copying file ${srcEntryRelative}:`, error);
        result.failed.push(srcEntryRelative);
      }
    }
  };

  await copyDir(sourceRelative, targetRelative);
  return result;
}
