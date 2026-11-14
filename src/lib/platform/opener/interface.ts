// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * OpenerAdapter interface (migration wave G3).
 *
 * Replaces the upstream plugin-opener surface: openUrl, openPath,
 * revealItemInDir. Signatures mirror the installed upstream declarations
 * (plugin-opener 2.x). All call sites pass a single argument; the
 * optional second argument is kept for pass-through fidelity.
 *
 * Merge M10 reconciliation (audit V2-40): G0 as the basis,
 * plus downloadUrl/downloadBlob as documented web extensions
 * (the web replacement for handing a workspace file to the
 * user). Coordinator decision: openUrl stays http(s)-only;
 * mailto: is NOT restored (the stricter wave-2 brief wins
 * over the V1-05 listing).
 */
export interface OpenerAdapter {
  openUrl(url: string | URL, openWith?: "inAppBrowser" | string): Promise<void>;
  openPath(path: string, openWith?: string): Promise<void>;
  revealItemInDir(path: string): Promise<unknown>;
  /**
   * Download the resource at an http(s) URL through an anchor element.
   * The file name defaults to the last path segment of the URL.
   * Web extension: no Tauri equivalent.
   */
  downloadUrl(url: string | URL, filename?: string): Promise<void>;
  /**
   * Download a blob through an anchor element backed by an object URL.
   * Web extension: no Tauri equivalent.
   */
  downloadBlob(blob: Blob, filename: string): Promise<void>;
}
