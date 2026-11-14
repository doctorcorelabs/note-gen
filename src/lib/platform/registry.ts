// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { getPlatformMode, type PlatformMode } from "./detect";
import type { AssetUrlAdapter } from "./asset/interface";
import type { AutostartAdapter } from "./autostart/interface";
import type { ChannelAdapter, InvokeAdapter } from "./invoke/interface";
import type { ClipboardAdapter } from "./clipboard/interface";
import type { DialogAdapter } from "./dialog/interface";
import type { EventAdapter } from "./event/interface";
import type { FsAdapter } from "./fs/interface";
import type { HttpAdapter } from "./http/interface";
import type { NotificationAdapter } from "./notification/interface";
import type { OpenerAdapter } from "./opener/interface";
import type { OsAdapter } from "./os/interface";
import type { PathAdapter } from "./path/interface";
import type { ProcessAdapter } from "./process/interface";
import type { ShellAdapter } from "./shell/interface";
import type { ShortcutAdapter } from "./shortcut/interface";
import type { SqlAdapter } from "./sql/interface";
import type { StoreAdapter } from "./store/interface";
import type { UpdaterAdapter } from "./updater/interface";
import type { WindowAdapter } from "./window/interface";

/**
 * Canonical home of the platform adapter registry (AD-23).
 *
 * The registry is the single place that holds adapter implementations.
 * Callers reach adapters only through the `platform` object or
 * getPlatformAdapter, never by importing an implementation file, and
 * never by checking the runtime mode themselves. Mode selection itself
 * lives in detect.ts; this module only stores what the boot sequence
 * registers for the detected mode.
 *
 * G0 state: this module provides the typed registration mechanism, the
 * capability flags, and the freeze. No implementation factory is wired
 * here yet, because no implementation file exists on this branch. The
 * implementation workers wire their factories through
 * registerPlatformAdapter, and the boot sequence freezes the registry
 * once registration is complete. Until then, resolving any adapter
 * throws an error that says no implementation is registered.
 *
 * The untyped registerAdapter/getAdapter/hasAdapter/listAdapters
 * functions are the original skeleton API and are kept for
 * compatibility; new code uses the typed registerPlatformAdapter and
 * getPlatformAdapter functions. Both APIs share one store and honor
 * the same freeze.
 */
export type AdapterRegistration = {
  name: string;
  adapter: unknown;
  modes: readonly PlatformMode[];
};

export interface PlatformAdapters {
  readonly store: StoreAdapter;
  readonly sql: SqlAdapter;
  readonly fs: FsAdapter;
  readonly path: PathAdapter;
  readonly dialog: DialogAdapter;
  readonly opener: OpenerAdapter;
  readonly http: HttpAdapter;
  readonly os: OsAdapter;
  readonly clipboard: ClipboardAdapter;
  readonly notification: NotificationAdapter;
  readonly window: WindowAdapter;
  readonly event: EventAdapter;
  readonly shortcut: ShortcutAdapter;
  readonly shell: ShellAdapter;
  readonly process: ProcessAdapter;
  readonly autostart: AutostartAdapter;
  readonly updater: UpdaterAdapter;
  readonly assetUrl: AssetUrlAdapter;
  readonly invoke: InvokeAdapter;
  readonly channel: ChannelAdapter;
}

export type AdapterName = keyof PlatformAdapters;

const ADAPTER_NAMES: readonly AdapterName[] = [
  "store",
  "sql",
  "fs",
  "path",
  "dialog",
  "opener",
  "http",
  "os",
  "clipboard",
  "notification",
  "window",
  "event",
  "shortcut",
  "shell",
  "process",
  "autostart",
  "updater",
  "assetUrl",
  "invoke",
  "channel",
];

function isAdapterName(value: string): value is AdapterName {
  return (ADAPTER_NAMES as readonly string[]).includes(value);
}

const registry = new Map<string, AdapterRegistration>();

let frozen = false;

function assertNotFrozen(): void {
  if (frozen) {
    throw new Error(
      "Platform registry is frozen: adapters cannot be registered after boot",
    );
  }
}

export function registerAdapter(registration: AdapterRegistration): void {
  assertNotFrozen();
  registry.set(registration.name, registration);
}

export function registerPlatformAdapter<K extends AdapterName>(
  name: K,
  adapter: PlatformAdapters[K],
  modes: readonly PlatformMode[] = ["web", "tauri"],
): void {
  assertNotFrozen();
  registry.set(name, { name, adapter, modes });
}

export function getAdapter<T>(name: string): T {
  const entry = registry.get(name);
  if (!entry) {
    throw new Error(`Platform adapter "${name}" is not registered`);
  }
  return entry.adapter as T;
}

export function getPlatformAdapter<K extends AdapterName>(
  name: K,
): PlatformAdapters[K] {
  const entry = registry.get(name);
  if (!entry) {
    throw new Error(
      `Platform adapter "${name}" is not registered ` +
        `(mode: ${getPlatformMode()}). No implementation has been ` +
        "registered yet; adapter implementations land with the wave workers.",
    );
  }
  return entry.adapter as PlatformAdapters[K];
}

export function hasAdapter(name: string): boolean {
  return registry.has(name);
}

export function listAdapters(): readonly AdapterRegistration[] {
  return [...registry.values()];
}

export function getCurrentMode(): PlatformMode {
  return getPlatformMode();
}

/** Freeze registration. Called once by the boot sequence. */
export function freezeRegistry(): void {
  frozen = true;
}

export function isRegistryFrozen(): boolean {
  return frozen;
}

/**
 * Capability flags. UI code reads these flags instead of checking the
 * runtime mode itself. Flags describe what the running runtime can do,
 * not which adapters are registered. The terminal flag is always false:
 * terminal execution is permanently removed from the web fork.
 */
export interface PlatformCapabilities {
  readonly multiWindow: boolean;
  readonly globalShortcut: boolean;
  readonly fileSystemAccess: boolean;
  readonly clipboardImage: boolean;
  readonly notifications: boolean;
  readonly screenshot: boolean;
  readonly terminal: boolean;
  readonly autostart: boolean;
  readonly updater: boolean;
  readonly watchPush: boolean;
}

let cachedCapabilities: PlatformCapabilities | null = null;

function readWindowFeature(name: string): unknown {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (window as unknown as Record<string, unknown>)[name];
}

export function getCapabilities(): PlatformCapabilities {
  if (cachedCapabilities) {
    return cachedCapabilities;
  }
  const mode = getPlatformMode();
  const isTauriMode = mode === "tauri";
  cachedCapabilities = Object.freeze({
    multiWindow: isTauriMode || typeof readWindowFeature("open") === "function",
    globalShortcut: isTauriMode,
    fileSystemAccess:
      !isTauriMode &&
      typeof readWindowFeature("showOpenFilePicker") === "function",
    clipboardImage:
      isTauriMode || typeof readWindowFeature("ClipboardItem") !== "undefined",
    notifications:
      isTauriMode || typeof readWindowFeature("Notification") !== "undefined",
    screenshot: isTauriMode,
    terminal: false,
    autostart: isTauriMode,
    updater: isTauriMode,
    watchPush:
      isTauriMode || typeof readWindowFeature("WebSocket") !== "undefined",
  });
  return cachedCapabilities;
}

/**
 * Lazily evaluated capability flags. A Proxy (rather than a frozen
 * object built at import time) keeps server-side evaluation honest:
 * feature detection runs on first access in the running environment,
 * not at module load.
 */
export const capabilities: PlatformCapabilities = new Proxy(
  {} as PlatformCapabilities,
  {
    get(_target, prop) {
      if (typeof prop === "string" && prop in getCapabilities()) {
        return getCapabilities()[prop as keyof PlatformCapabilities];
      }
      return undefined;
    },
    set() {
      throw new Error("Platform capabilities are read-only");
    },
    deleteProperty() {
      throw new Error("Platform capabilities are read-only");
    },
    defineProperty() {
      throw new Error("Platform capabilities are read-only");
    },
    has(_target, prop) {
      return typeof prop === "string" && prop in getCapabilities();
    },
    ownKeys() {
      return Object.keys(getCapabilities());
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "string" && prop in getCapabilities()) {
        return {
          configurable: true,
          enumerable: true,
          get() {
            return getCapabilities()[prop as keyof PlatformCapabilities];
          },
        };
      }
      return undefined;
    },
  },
);

/**
 * The bound platform object. Property access resolves lazily through
 * the registry, so importing this module performs no I/O and creates
 * no adapter. Accessing an adapter that has no registered
 * implementation throws a descriptive error. The object is read-only:
 * adapters change only through registration before the freeze.
 */
export const platform: PlatformAdapters = new Proxy(
  {} as PlatformAdapters,
  {
    get(_target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }
      if (prop === "then") {
        return undefined;
      }
      if (isAdapterName(prop)) {
        return getPlatformAdapter(prop);
      }
      throw new Error(`Unknown platform adapter "${prop}"`);
    },
    set() {
      throw new Error(
        "Platform adapters are read-only: register implementations " +
          "with registerPlatformAdapter before the registry is frozen",
      );
    },
    deleteProperty() {
      throw new Error("Platform adapters are read-only");
    },
    defineProperty() {
      throw new Error("Platform adapters are read-only");
    },
    has(_target, prop) {
      return typeof prop === "string" && isAdapterName(prop);
    },
    ownKeys() {
      return [...ADAPTER_NAMES];
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "string" && isAdapterName(prop)) {
        return {
          configurable: true,
          enumerable: true,
          get() {
            return getPlatformAdapter(prop);
          },
        };
      }
      return undefined;
    },
  },
);

export function getPlatform(): PlatformAdapters {
  return platform;
}

/**
 * Test-only reset. Clears all registrations, lifts the freeze, and
 * drops the cached capability flags. Production code must never call
 * this function.
 */
export function __resetPlatformForTests(): void {
  registry.clear();
  frozen = false;
  cachedCapabilities = null;
}
