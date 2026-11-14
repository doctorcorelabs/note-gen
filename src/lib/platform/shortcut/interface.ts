// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * ShortcutAdapter interface (migration wave G5).
 *
 * Replaces the upstream plugin-global-shortcut surface: register,
 * unregister, isRegistered. Only src/stores/shortcut.ts imports this
 * module, but initShortcut sits on the boot chain, so the interface is
 * defined here at G0 like every other adapter. Signatures mirror the
 * installed upstream declarations (plugin-global-shortcut 2.x).
 * unregisterAll is not imported anywhere and is excluded.
 */
export interface ShortcutEvent {
  shortcut: string;
  id: number;
  state: "Released" | "Pressed";
}

export type ShortcutHandler = (event: ShortcutEvent) => void;

export interface ShortcutAdapter {
  register(
    shortcuts: string | string[],
    handler: ShortcutHandler,
  ): Promise<void>;
  unregister(shortcuts: string | string[]): Promise<void>;
  isRegistered(shortcut: string): Promise<boolean>;
}
