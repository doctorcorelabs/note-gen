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

/**
 * Test-only seam for simulating the Tauri shell: sets or clears the
 * internals marker exactly as the shell would, so specs exercise
 * the real isTauri() read without naming the marker outside this
 * file (platform-guard check 2 enforces an empty allowlist).
 * Production code must never call this function.
 */
export function __setTauriInternalsForTests(present: boolean): void {
  const g = globalThis as Record<string, unknown>;
  if (present) {
    g["__TAURI_INTERNALS__"] = {};
  } else {
    delete g["__TAURI_INTERNALS__"];
  }
}

export function getPlatformMode(): PlatformMode {
  return isTauri() ? "tauri" : "web";
}

/**
 * Narrow seam for the Tauri callback registry (AD-89, 3D consolidation).
 *
 * This file is the only module that may read the Tauri internals
 * object. The relocated event listener (event-listener.tauri.ts)
 * needs unregisterCallback for the Tauri 2.11 listen() race
 * workaround; it reaches the registry only through this accessor,
 * never by naming the marker itself. Returns undefined outside the
 * Tauri shell or when the registry shape is absent, so callers keep
 * working in web mode without a marker read of their own.
 */
export interface TauriCallbackRegistry {
  unregisterCallback: (id: number) => void;
}

export function getTauriCallbackRegistry():
  | TauriCallbackRegistry
  | undefined {
  const internals = (globalThis as Record<string, unknown>)[
    "__TAURI_INTERNALS__"
  ] as Partial<TauriCallbackRegistry> | undefined;
  if (!internals || typeof internals.unregisterCallback !== "function") {
    return undefined;
  }
  return internals as TauriCallbackRegistry;
}
