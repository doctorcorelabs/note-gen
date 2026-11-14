// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

export type PlatformMode = "web" | "tauri";

/**
 * True when running inside the Tauri desktop shell. The web build must never
 * see this as true; the check reads only the Tauri internals marker.
 */
export function isTauri(): boolean {
  const g = globalThis as Record<string, unknown>;
  return g["__TAURI_INTERNALS__"] !== undefined;
}

export function getPlatformMode(): PlatformMode {
  return isTauri() ? "tauri" : "web";
}
