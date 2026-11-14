// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Tauri shortcut registry (V2-13) and thin global ShortcutAdapter.
 *
 * The registry maps bindings to global shortcuts, delegating to
 * `@tauri-apps/plugin-global-shortcut` with no new logic.
 *
 * On desktop, `register` is the global shortcut registration the upstream
 * store used: it delegates to `@tauri-apps/plugin-global-shortcut` and
 * fires handlers only on the `Pressed` state, exactly like
 * `registerShortcut` in `src/stores/shortcut.ts`. Browser conflict tables
 * do not apply on desktop; `checkConflict` covers duplicates only.
 *
 * This file is the only file in this adapter family allowed to import
 * `@tauri-apps/*`, and only the global-shortcut specifier.
 */

import {
  isRegistered as isTauriRegistered,
  register as registerTauri,
  unregister as unregisterTauri,
} from "@tauri-apps/plugin-global-shortcut";
import { canonicalShortcut, parseShortcut, type ParsedShortcut } from "./conflicts";
import type { ShortcutAdapter, ShortcutHandler } from "./interface";
import type {
  ShortcutBinding,
  ShortcutConflict,
  ShortcutRegisterOptions,
  ShortcutRegistration,
  ShortcutRegistrationResult,
  ShortcutRegistry,
  ShortcutRegistryHandler,
} from "./registry";

interface StoredBinding {
  id: string;
  shortcut: string;
  raw: string;
  parsed: ParsedShortcut;
  handler: ShortcutRegistryHandler;
  description?: string;
}

export interface TauriShortcutRegistryOptions {
  /** Called when a handler throws or rejects. Defaults to rethrowing asynchronously. */
  onHandlerError?: (error: unknown, id: string) => void;
}

export function createTauriShortcutRegistry(
  options: TauriShortcutRegistryOptions = {},
): ShortcutRegistry {
  const byId = new Map<string, StoredBinding>();
  const byShortcut = new Map<string, StoredBinding>();
  let enabled = true;

  function reportHandlerError(error: unknown, id: string): void {
    if (options.onHandlerError !== undefined) {
      options.onHandlerError(error, id);
      return;
    }
    queueMicrotask(() => {
      throw error;
    });
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

  async function registerGlobalShortcut(
    binding: ShortcutBinding,
    registerOptions: ShortcutRegisterOptions,
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
          detail: `Shortcut "${binding.shortcut}" cannot be parsed. Use modifiers and one key joined by "+", for example "CommandOrControl+Shift+W".`,
          blocking: true,
        },
      };
    }
    const canonical = canonicalShortcut(parsed);
    const duplicate = checkDuplicate(canonical, binding.id);
    if (duplicate !== null && registerOptions.replaceExisting !== true) {
      return { ok: false, id: binding.id, shortcut: canonical, conflict: duplicate };
    }

    const previous = byId.get(binding.id);
    // A replaced binding on the same combo must be released before the new
    // registration, because one combo cannot be registered twice. If the new
    // registration then fails, that replaced binding is lost; this matches
    // the replace contract (the caller asked to replace it).
    if (duplicate !== null && registerOptions.replaceExisting === true) {
      const replaced = byShortcut.get(canonical);
      if (replaced !== undefined) {
        await unregisterTauri(replaced.raw).catch(() => undefined);
        byId.delete(replaced.id);
      }
    }

    try {
      await registerTauri(binding.shortcut, (event) => {
        if (event.state !== "Pressed") return;
        if (!enabled) return;
        const stored = byId.get(binding.id);
        if (stored === undefined) return;
        try {
          const result = stored.handler();
          if (result !== undefined && typeof (result as PromiseLike<void>).then === "function") {
            (result as Promise<void>).catch((error: unknown) =>
              reportHandlerError(error, binding.id),
            );
          }
        } catch (error) {
          reportHandlerError(error, binding.id);
        }
      });
    } catch (error) {
      return {
        ok: false,
        id: binding.id,
        shortcut: canonical,
        conflict: {
          kind: "unavailable",
          shortcut: canonical,
          detail: `The operating system refused shortcut ${canonical}: ${error instanceof Error ? error.message : String(error)}`,
          blocking: true,
        },
      };
    }

    // Only release the previous binding for this id after the replacement
    // was accepted, so a refused shortcut never leaves the caller with no
    // binding at all. This follows the upstream store, which keeps the old
    // binding active until the replacement is accepted by the OS.
    if (previous !== undefined && previous.raw !== binding.shortcut) {
      await unregisterTauri(previous.raw).catch(() => undefined);
      byShortcut.delete(previous.shortcut);
    }

    const stored: StoredBinding = {
      id: binding.id,
      shortcut: canonical,
      raw: binding.shortcut,
      parsed,
      handler: binding.handler,
      description: binding.description,
    };
    byId.set(binding.id, stored);
    byShortcut.set(canonical, stored);
    const result: ShortcutRegistrationResult = { ok: true, id: binding.id, shortcut: canonical };
    if (duplicate !== null) result.conflict = { ...duplicate, blocking: false };
    return result;
  }

  return {
    register(binding: ShortcutBinding, registerOptions: ShortcutRegisterOptions = {}) {
      return registerGlobalShortcut(binding, registerOptions);
    },

    async unregister(id: string): Promise<boolean> {
      const stored = byId.get(id);
      if (stored === undefined) return false;
      await unregisterTauri(stored.raw).catch(() => undefined);
      byId.delete(id);
      if (byShortcut.get(stored.shortcut)?.id === id) byShortcut.delete(stored.shortcut);
      return true;
    },

    async unregisterShortcut(shortcut: string): Promise<boolean> {
      const parsed = parseShortcut(shortcut);
      if (parsed === null) return false;
      const stored = byShortcut.get(canonicalShortcut(parsed));
      if (stored === undefined) return false;
      await unregisterTauri(stored.raw).catch(() => undefined);
      byShortcut.delete(stored.shortcut);
      byId.delete(stored.id);
      return true;
    },

    async isRegistered(shortcut: string): Promise<boolean> {
      return isTauriRegistered(shortcut);
    },

    registerGlobal(binding: ShortcutBinding, registerOptions: ShortcutRegisterOptions = {}) {
      return registerGlobalShortcut(binding, registerOptions);
    },

    supportsGlobalShortcuts(): boolean {
      return true;
    },

    checkConflict(shortcut: string): ShortcutConflict | null {
      const parsed = parseShortcut(shortcut);
      if (parsed === null) {
        return {
          kind: "invalid",
          shortcut,
          detail: `Shortcut "${shortcut}" cannot be parsed. Use modifiers and one key joined by "+", for example "CommandOrControl+Shift+W".`,
          blocking: true,
        };
      }
      return checkDuplicate(canonicalShortcut(parsed), "");
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
      const raws = [...byId.values()].map((binding) => binding.raw);
      byId.clear();
      byShortcut.clear();
      if (raws.length > 0) {
        void unregisterTauri(raws).catch(() => undefined);
      }
    },
  };
}

/**
 * Thin global ShortcutAdapter for desktop: direct delegation to the
 * plugin. The canonical ShortcutEvent shape is identical to the plugin
 * event, so no mapping is needed.
 */
export function createTauriShortcutAdapter(): ShortcutAdapter {
  return {
    async register(
      shortcuts: string | string[],
      handler: ShortcutHandler,
    ): Promise<void> {
      await registerTauri(shortcuts, handler);
    },

    async unregister(shortcuts: string | string[]): Promise<void> {
      await unregisterTauri(shortcuts);
    },

    async isRegistered(shortcut: string): Promise<boolean> {
      return isTauriRegistered(shortcut);
    },
  };
}
