// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// PathAdapter interface (V2-11 local definition).
//
// The canonical interface definitions for all adapters are owned by V2-04
// (registry G0). This file defines the PathAdapter shape locally from the
// V1-05 inventory so the web implementation and its contract tests can land
// without waiting for that merge. The integrator reconciles this definition
// with the V2-04 canonical interface; the method names and signatures here
// follow the upstream `@tauri-apps/api/path` surface actually used by the
// codebase, verified by grep over the reference repo at HEAD 4dcaa3f.
//
// Only six functions are in the interface, per V1-05 section 1.4:
// appDataDir, appConfigDir, join, dirname, basename, normalize. The six
// other directory functions (appCacheDir, appLogDir, homeDir, tempDir,
// documentDir, downloadDir) have zero call sites and are deliberately
// excluded. resolve, extname, isAbsolute, sep and delimiter are likewise
// unused and excluded.

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

/**
 * Path operations. All methods are async to preserve the shape of the
 * upstream Tauri path API, so call sites migrate by changing only the
 * import source. The web implementation is pure string manipulation and
 * never touches the network or the filesystem.
 */
export interface PathAdapter {
  /** Virtual app-data directory. See VIRTUAL_APP_DATA_DIR. */
  appDataDir(): Promise<string>;

  /** Virtual app-config directory. See VIRTUAL_APP_CONFIG_DIR. */
  appConfigDir(): Promise<string>;

  /**
   * Join path segments with `/` and normalize the result. A later segment
   * that is absolute replaces everything before it, matching Rust
   * PathBuf push semantics used by the Tauri implementation.
   */
  join(...paths: string[]): Promise<string>;

  /**
   * Parent directory of a path, with trailing separators ignored.
   * Returns "" when the path has no parent component (for example a bare
   * file name or the root itself).
   */
  dirname(path: string): Promise<string>;

  /**
   * Last portion of a path, with trailing separators ignored. When `ext`
   * is given and the last portion ends with that extension (with or
   * without a leading dot), the extension is removed from the result.
   */
  basename(path: string, ext?: string): Promise<string>;

  /**
   * Lexical normalization: resolve `.` and `..` segments and collapse
   * duplicate separators. Unlike the Tauri implementation this does not
   * resolve symbolic links and does not require the path to exist, because
   * the browser has no filesystem access. See path.web.ts for details.
   */
  normalize(path: string): Promise<string>;
}
