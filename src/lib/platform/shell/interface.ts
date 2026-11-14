// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * ShellAdapter interface (migration wave G5, lifecycle family).
 *
 * Replaces the upstream plugin-shell surface used by the codebase: the
 * open function only. Signatures mirror the installed upstream
 * declarations (plugin-shell 2.x). All 4 call sites pass a single URL
 * argument; the optional second argument is kept for pass-through
 * fidelity. The Command class is not imported from this plugin anywhere
 * in src and is excluded; terminal execution runs over Rust commands,
 * belongs to the invoke surface, and is permanently removed from the
 * web fork with no server-side shell equivalent.
 */
export interface ShellAdapter {
  open(path: string, openWith?: string): Promise<void>;
}
