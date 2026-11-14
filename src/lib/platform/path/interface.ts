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
 *
 * Merge M8 reconciliation (audit V2-40): the two virtual-root
 * constants from V2-11 are added; the six method signatures
 * are unchanged from G0.
 */
/**
 * Virtual app-data root returned by the web PathAdapter.
 *
 * This is a key, not an operating system path. It only ever appears in
 * strings built by path operations inside the browser; the FsAdapter strips
 * it before any request reaches the server, and the server is authoritative
 * for path validation. The leading slash keeps desktop-shaped checks (for
 * example `isAbsoluteFsPath` in workspace helpers) behaving the same way in
 * web mode as they do on desktop.
 */
export const VIRTUAL_APP_DATA_DIR = "/appdata";

/**
 * Virtual app-config root returned by the web PathAdapter.
 *
 * Like VIRTUAL_APP_DATA_DIR this is a key, not an OS path. Configuration
 * files live outside the workspace API, so FsAdapter rejects paths under
 * this prefix with a capability error in web mode.
 */
export const VIRTUAL_APP_CONFIG_DIR = "/appconfig";

export interface PathAdapter {
  appDataDir(): Promise<string>;
  appConfigDir(): Promise<string>;
  join(...paths: string[]): Promise<string>;
  dirname(path: string): Promise<string>;
  basename(path: string, ext?: string): Promise<string>;
  normalize(path: string): Promise<string>;
}
