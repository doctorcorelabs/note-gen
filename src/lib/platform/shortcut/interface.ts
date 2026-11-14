// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * ShortcutAdapter interface (V2-13).
 *
 * Local interface definition for this adapter family, following the V1-05
 * inventory (desain-registry-shim.md section 1.13). V2-04 owns the canonical
 * interfaces; the integrator reconciles this definition with the canonical
 * one. Callers must use the adapter through the platform registry, never by
 * importing an implementation file directly.
 *
 * Upstream surface replaced: `register`, `unregister`, `isRegistered` from
 * `@tauri-apps/plugin-global-shortcut` (1 importing file upstream,
 * `src/stores/shortcut.ts`, reached through `initShortcut()` on the boot
 * path and through `src/lib/global-shortcut.ts`).
 *
 * Web behavior: there is no global shortcut in a browser. The web adapter
 * provides in-app shortcuts (a document `keydown` listener) for combos that
 * are meaningful inside the tab. Registering a global shortcut throws
 * `PlatformCapabilityError`. Browser-reserved combos are never stolen: the
 * blocked list in `conflicts.ts` is always refused, and the 8 high-risk
 * editor combos from audit V1-13 are refused by default and need an
 * explicit `allowBrowserConflict` opt-in backed by browser probe evidence
 * (audit section 5.5). The 3 desktop global shortcuts (`openWindow`,
 * `screenshotRecord`, `quickRecordText`) have no web equivalent.
 *
 * Shortcut syntax: modifiers and a key joined by `+`, for example
 * `Mod+Shift+O`, `CommandOrControl+Shift+W`, `Ctrl+Alt+1`. `Mod` means Cmd
 * on macOS and Ctrl on Windows/Linux (ProseMirror/Tiptap convention, same
 * as the editor shortcut config).
 */

export type ShortcutHandler = () => void | Promise<void>;

export interface ShortcutBinding {
  /** Stable caller-chosen id, for example `openWindow` or `toggleBold`. */
  id: string;
  /** Shortcut combo, for example `Mod+Shift+O`. */
  shortcut: string;
  handler: ShortcutHandler;
  description?: string;
}

export interface ShortcutRegistration {
  id: string;
  /** Canonical combo form, for example `Mod+Shift+O`. */
  shortcut: string;
  description?: string;
}

export type ShortcutConflictKind =
  | "browser-reserved"
  | "browser-high-risk"
  | "duplicate"
  | "invalid"
  | "unavailable";

export interface ShortcutConflict {
  kind: ShortcutConflictKind;
  /** Canonical combo form that conflicts, or the raw input when unparsable. */
  shortcut: string;
  /** What the browser does with this combo, when the conflict is browser-related. */
  browserAction?: string;
  /** Human-readable detail, safe to show in settings UI. */
  detail: string;
  /**
   * True when this conflict blocked registration. False when registration
   * succeeded despite a recorded conflict (explicit override or replace).
   */
  blocking: boolean;
}

export interface ShortcutRegistrationResult {
  ok: boolean;
  id: string;
  /** Canonical combo form, or the raw input when unparsable. */
  shortcut: string;
  /** Present whenever a conflict was detected, even when registration succeeded. */
  conflict?: ShortcutConflict;
}

export interface ShortcutRegisterOptions {
  /**
   * Allow a high-risk browser combo (audit V1-13 list) when browser probe
   * evidence shows the page override works. This never bypasses the blocked
   * browser-reserved list.
   */
  allowBrowserConflict?: boolean;
  /** Replace an existing binding that uses the same combo under another id. */
  replaceExisting?: boolean;
}

export interface ShortcutAdapter {
  /**
   * Register an in-app shortcut (web) or a global shortcut (desktop).
   * Returns a result object; it does not throw for conflicts or invalid
   * combos. On the web, browser-reserved combos are always refused.
   */
  register(
    binding: ShortcutBinding,
    options?: ShortcutRegisterOptions,
  ): Promise<ShortcutRegistrationResult>;

  /** Remove a binding by id. Returns true when a binding was removed. */
  unregister(id: string): Promise<boolean>;

  /** Remove all bindings using a combo. Returns true when any was removed. */
  unregisterShortcut(shortcut: string): Promise<boolean>;

  /** True when a combo is currently registered by this adapter. */
  isRegistered(shortcut: string): Promise<boolean>;

  /** Register a shortcut that fires outside the app. Web: always throws `PlatformCapabilityError`. */
  registerGlobal(
    binding: ShortcutBinding,
    options?: ShortcutRegisterOptions,
  ): Promise<ShortcutRegistrationResult>;

  /** False on the web, true on desktop. Settings UI must use this. */
  supportsGlobalShortcuts(): boolean;

  /**
   * Check a combo for conflicts without registering it. On the web this
   * covers browser reservations, high-risk combos, and duplicates. On
   * desktop it covers duplicates only. Returns null when there is no
   * conflict.
   */
  checkConflict(shortcut: string): ShortcutConflict | null;

  /** Current bindings, without handlers. */
  list(): readonly ShortcutRegistration[];

  /** Temporarily stop all handlers from firing without unregistering. */
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;

  /** Remove all bindings and release the key listener. */
  dispose(): void;
}
