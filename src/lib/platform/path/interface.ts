// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * PathAdapter interface (migration wave G1, FS support).
 *
 * Replaces the upstream api/path surface used by the codebase:
 * appDataDir, join, dirname, basename, normalize, appConfigDir.
 * Signatures mirror the installed upstream declarations (api 2.11.1).
 * All six functions are async upstream, including the pure string
 * operations; call sites await all of them.
 *
 * The six other directory functions (appCacheDir, appLogDir, homeDir,
 * tempDir, documentDir, downloadDir) and the remaining path helpers
 * (resolve, extname, isAbsolute, sep, delimiter, resolveResource) have
 * no call sites and are excluded.
 */
export interface PathAdapter {
  appDataDir(): Promise<string>;
  appConfigDir(): Promise<string>;
  join(...paths: string[]): Promise<string>;
  dirname(path: string): Promise<string>;
  basename(path: string, ext?: string): Promise<string>;
  normalize(path: string): Promise<string>;
}
