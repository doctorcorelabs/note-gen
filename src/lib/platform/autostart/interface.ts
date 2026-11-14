// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * AutostartAdapter interface (migration wave G5, lifecycle family).
 *
 * Replaces the upstream plugin-autostart surface: enable, disable,
 * isEnabled. Only 1 file imports this module, under local aliases.
 * Signatures mirror the installed upstream declarations
 * (plugin-autostart 2.x).
 */
export interface AutostartAdapter {
  enable(): Promise<void>;
  disable(): Promise<void>;
  isEnabled(): Promise<boolean>;
}
