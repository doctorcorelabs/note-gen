// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * OpenerAdapter interface (migration wave G3).
 *
 * Replaces the upstream plugin-opener surface: openUrl, openPath,
 * revealItemInDir. Signatures mirror the installed upstream declarations
 * (plugin-opener 2.x). All call sites pass a single argument; the
 * optional second argument is kept for pass-through fidelity.
 */
export interface OpenerAdapter {
  openUrl(url: string | URL, openWith?: "inAppBrowser" | string): Promise<void>;
  openPath(path: string, openWith?: string): Promise<void>;
  revealItemInDir(path: string): Promise<unknown>;
}
