// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * ProcessAdapter interface (migration wave G5, lifecycle family).
 *
 * Replaces the upstream plugin-process surface: relaunch and exit.
 * Signatures mirror the installed upstream declarations
 * (plugin-process 2.x). The exit code argument is used at 1 call site.
 */
export interface ProcessAdapter {
  exit(code?: number): Promise<void>;
  relaunch(): Promise<void>;
}
