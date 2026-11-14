// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Local opener adapter interface for the web fork (worker V2-12).
 *
 * Follows the OpenerAdapter inventory in the V1-05 registry design
 * (`openUrl`, `openPath`, `revealItemInDir` from
 * `@tauri-apps/plugin-opener`), with the following binding decisions for
 * the web implementation, to be reconciled by the integrator against the
 * canonical interfaces owned by V2-04:
 *
 * 1. `openUrl` opens only `http:` and `https:` URLs, in a new tab. Every
 *    other scheme, relative URL, and embedded-credential URL is rejected
 *    with a `PlatformCapabilityError`. Note that V1-05 also listed
 *    `mailto:`; this worker follows the stricter wave 2 brief (http(s)
 *    only) and the integrator must decide whether `mailto:` is restored.
 *    The `openWith` argument is accepted for signature compatibility and
 *    ignored: a browser cannot choose the application that opens a URL.
 * 2. `openPath` and `revealItemInDir` have no browser equivalent and always
 *    throw a `PlatformCapabilityError` in the web implementation. Local
 *    paths are never opened, revealed, or echoed in error messages. Call
 *    sites that need to hand a workspace file to the user must use the
 *    download methods below once they hold file content or a file URL.
 * 3. `downloadUrl` and `downloadBlob` are web-only additions beyond the
 *    Tauri surface. They trigger an anchor download and are the web
 *    replacement for "open a workspace file" at call sites that already
 *    have the content or an HTTP(S) URL for it.
 */

export interface OpenerAdapter {
  /**
   * Open an http(s) URL in a new tab. Rejects any other URL shape with a
   * `PlatformCapabilityError`.
   */
  openUrl(url: string | URL, openWith?: string): Promise<void>;
  /**
   * Always throws a `PlatformCapabilityError` on the web: browsers cannot
   * open local paths with a system application.
   */
  openPath(path: string, openWith?: string): Promise<void>;
  /**
   * Always throws a `PlatformCapabilityError` on the web: browsers cannot
   * reveal a local path in a file manager.
   */
  revealItemInDir(path: string): Promise<void>;
  /**
   * Download the resource at an http(s) URL through an anchor element.
   * The file name defaults to the last path segment of the URL.
   */
  downloadUrl(url: string | URL, filename?: string): Promise<void>;
  /**
   * Download a blob through an anchor element backed by an object URL.
   */
  downloadBlob(blob: Blob, filename: string): Promise<void>;
}
