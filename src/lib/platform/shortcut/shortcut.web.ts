// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web ShortcutAdapter (V2-13): in-app shortcut registry.
 *
 * Shortcuts live only inside the tab. A single document `keydown` listener
 * matches events against registered combos; when a binding matches, the
 * adapter prevents the browser default and runs the handler. Combos that
 * are not registered are never touched, so normal browser behavior is
 * preserved.
 *
 * The browser is never robbed of its reserved combos: the blocked list in
 * `conflicts.ts` is always refused, and the 8 high-risk editor combos from
 * audit V1-13 are refused unless the caller passes `allowBrowserConflict`
 * with browser probe evidence. Global shortcuts do not exist on the web:
 * `registerGlobal` throws `PlatformCapabilityError`.
 *
 * This file must never import `@tauri-apps/*`.
 */

import { capabilityError } from "../errors";
import {
  canonicalShortcut,
  checkBrowserConflict,
  detectMac,
  matchesKeyEvent,
  parseShortcut,
  type ParsedShortcut,
} from "./conflicts";
import type {
  ShortcutAdapter,
  ShortcutBinding,
  ShortcutConflict,
  ShortcutHandler,
  ShortcutRegisterOptions,
  ShortcutRegistration,
  ShortcutRegistrationResult,
} from "./interface";

interface KeyListenerEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

interface DocumentLike {
  addEventListener(type: string, listener: (event: KeyListenerEvent) => void): void;
  removeEventListener(type: string, listener: (event: KeyListenerEvent) => void): void;
}

interface StoredBinding {
  id: string;
  shortcut: string;
  parsed: ParsedShortcut;
  handler: ShortcutHandler;
  description?: string;
}

export interface WebShortcutAdapterOptions {
  /** Key event source. Defaults to the browser document when available. */
  documentLike?: DocumentLike | null;
  /** True on macOS, where `Mod` means Cmd. Defaults to detecting the platform. */
  isMac?: boolean;
  /** Called when a handler throws or rejects. Defaults to rethrowing asynchronously. */
  onHandlerError?: (error: unknown, id: string) => void;
}

export function createWebShortcutAdapter(
  options: WebShortcutAdapterOptions = {},
): ShortcutAdapter {
  const documentLike =
    options.documentLike !== undefined
      ? options.documentLike
      : typeof document !== "undefined"
        ? (document as unknown as DocumentLike)
        : null;
  const isMac = options.isMac ?? detectMac();
  const byId = new Map<string, StoredBinding>();
  const byShortcut = new Map<string, StoredBinding>();
  let enabled = true;
  let listening = false;

  function reportHandlerError(error: unknown, id: string): void {
    if (options.onHandlerError !== undefined) {
      options.onHandlerError(error, id);
      return;
    }
    queueMicrotask(() => {
      throw error;
    });
  }

  function onKeyDown(event: KeyListenerEvent): void {
    if (!enabled) return;
    if (event.isComposing === true) return;
    for (const binding of byId.values()) {
      if (!matchesKeyEvent(binding.parsed, event, isMac)) continue;
      event.preventDefault();
      event.stopPropagation();
      try {
        const result = binding.handler();
        if (result !== undefined && typeof (result as PromiseLike<void>).then === "function") {
          (result as Promise<void>).catch((error: unknown) => reportHandlerError(error, binding.id));
        }
      } catch (error) {
        reportHandlerError(error, binding.id);
      }
      return;
    }
  }

  function ensureListening(): void {
    if (listening || documentLike === null) return;
    documentLike.addEventListener("keydown", onKeyDown);
    listening = true;
  }

  function checkDuplicate(canonical: string, id: string): ShortcutConflict | null {
    const existing = byShortcut.get(canonical);
    if (existing === undefined || existing.id === id) return null;
    return {
      kind: "duplicate",
      shortcut: canonical,
      detail: `Shortcut ${canonical} is already registered by "${existing.id}".`,
      blocking: true,
    };
  }

  return {
    async register(
      binding: ShortcutBinding,
      registerOptions: ShortcutRegisterOptions = {},
    ): Promise<ShortcutRegistrationResult> {
      const parsed = parseShortcut(binding.shortcut);
      if (parsed === null) {
        return {
          ok: false,
          id: binding.id,
          shortcut: binding.shortcut,
          conflict: {
            kind: "invalid",
            shortcut: binding.shortcut,
            detail: `Shortcut "${binding.shortcut}" cannot be parsed. Use modifiers and one key joined by "+", for example "Mod+Shift+O".`,
            blocking: true,
          },
        };
      }
      const canonical = canonicalShortcut(parsed);

      const browserConflict = checkBrowserConflict(canonical);
      if (browserConflict !== null) {
        if (browserConflict.kind === "browser-reserved") {
          return { ok: false, id: binding.id, shortcut: canonical, conflict: browserConflict };
        }
        if (registerOptions.allowBrowserConflict !== true) {
          return { ok: false, id: binding.id, shortcut: canonical, conflict: browserConflict };
        }
      }

      const duplicate = checkDuplicate(canonical, binding.id);
      if (duplicate !== null && registerOptions.replaceExisting !== true) {
        return { ok: false, id: binding.id, shortcut: canonical, conflict: duplicate };
      }

      const previous = byId.get(binding.id);
      if (previous !== undefined) byShortcut.delete(previous.shortcut);
      if (duplicate !== null && registerOptions.replaceExisting === true) {
        const replaced = byShortcut.get(canonical);
        if (replaced !== undefined) byId.delete(replaced.id);
      }
      const stored: StoredBinding = {
        id: binding.id,
        shortcut: canonical,
        parsed,
        handler: binding.handler,
        description: binding.description,
      };
      byId.set(binding.id, stored);
      byShortcut.set(canonical, stored);
      ensureListening();

      const recordedConflict =
        browserConflict !== null
          ? { ...browserConflict, blocking: false }
          : duplicate !== null
            ? { ...duplicate, blocking: false }
            : undefined;
      const result: ShortcutRegistrationResult = { ok: true, id: binding.id, shortcut: canonical };
      if (recordedConflict !== undefined) result.conflict = recordedConflict;
      return result;
    },

    async unregister(id: string): Promise<boolean> {
      const stored = byId.get(id);
      if (stored === undefined) return false;
      byId.delete(id);
      if (byShortcut.get(stored.shortcut)?.id === id) byShortcut.delete(stored.shortcut);
      return true;
    },

    async unregisterShortcut(shortcut: string): Promise<boolean> {
      const parsed = parseShortcut(shortcut);
      if (parsed === null) return false;
      const canonical = canonicalShortcut(parsed);
      const stored = byShortcut.get(canonical);
      if (stored === undefined) return false;
      byShortcut.delete(canonical);
      byId.delete(stored.id);
      return true;
    },

    async isRegistered(shortcut: string): Promise<boolean> {
      const parsed = parseShortcut(shortcut);
      if (parsed === null) return false;
      const canonical = canonicalShortcut(parsed);
      return byShortcut.has(canonical);
    },

    async registerGlobal(): Promise<ShortcutRegistrationResult> {
      throw capabilityError(
        "unsupported",
        "shortcut",
        "shortcut.registerGlobal",
        "web",
        "global shortcuts do not exist in a browser; register an in-app shortcut with register() instead",
      );
    },

    supportsGlobalShortcuts(): boolean {
      return false;
    },

    checkConflict(shortcut: string): ShortcutConflict | null {
      const parsed = parseShortcut(shortcut);
      if (parsed === null) {
        return {
          kind: "invalid",
          shortcut,
          detail: `Shortcut "${shortcut}" cannot be parsed. Use modifiers and one key joined by "+", for example "Mod+Shift+O".`,
          blocking: true,
        };
      }
      const canonical = canonicalShortcut(parsed);
      return checkBrowserConflict(canonical) ?? checkDuplicate(canonical, "");
    },

    list(): readonly ShortcutRegistration[] {
      return [...byId.values()].map((binding) => ({
        id: binding.id,
        shortcut: binding.shortcut,
        description: binding.description,
      }));
    },

    setEnabled(next: boolean): void {
      enabled = next;
    },

    isEnabled(): boolean {
      return enabled;
    },

    dispose(): void {
      byId.clear();
      byShortcut.clear();
      if (listening && documentLike !== null) {
        documentLike.removeEventListener("keydown", onKeyDown);
      }
      listening = false;
    },
  };
}
