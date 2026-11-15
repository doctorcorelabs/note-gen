// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Tauri StoreAdapter (V3-11, wave 3B): thin wrapper over
 * @tauri-apps/plugin-store 2.3.0 (V1-02 section 3.6).
 *
 * Desktop behavior must not change: every handle method delegates
 * 1:1 to the same method on the plugin Store, with no added logic,
 * no key classification, no file routing, and no aiModelList
 * splitting. Options pass through untouched. The adapter keeps one
 * wrapper per store path, matching the registry cache requirement
 * (F1 section 3.2); the plugin itself owns the underlying instance
 * cache.
 *
 * The single exception to "no added logic" is the closed-handle
 * guard: after close(), wrapper methods throw a plain Error naming
 * the closed handle (the same message the fake uses), and a second
 * close() is a no-op. The plugin documents that methods must not be
 * called after close(); the guard makes that contract deterministic
 * instead of depending on Rust resource errors.
 *
 * This file is the only file in the store family allowed to import
 * `@tauri-apps/plugin-store`. It must never import store.web.ts,
 * persistence queue code, or key-schema code, so the web bundle
 * never pulls in Tauri code.
 *
 * The plugin surface is injected through createTauriStoreAdapter-
 * WithPlugin so specs can verify delegation against a recording
 * fake without a Tauri runtime. Production code uses
 * createTauriStoreAdapter(), which binds the real plugin.
 */

import { Store as TauriStore } from "@tauri-apps/plugin-store";
import type { UnlistenFn } from "../event/interface";
import type {
  StoreAdapter,
  StoreHandle,
  StoreOptions,
} from "./interface";

/**
 * Structural shape of a plugin Store instance: the IStore surface
 * from @tauri-apps/plugin-store 2.3.0, minus the path field (the
 * plugin has none; the wrapper supplies it).
 */
export interface TauriStoreInstance {
  set(key: string, value: unknown): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  reset(): Promise<void>;
  keys(): Promise<string[]>;
  values<T>(): Promise<T[]>;
  entries<T>(): Promise<Array<[string, T]>>;
  length(): Promise<number>;
  reload(): Promise<void>;
  save(): Promise<void>;
  onKeyChange<T>(
    key: string,
    cb: (value: T | undefined) => void,
  ): Promise<UnlistenFn>;
  onChange<T>(
    cb: (key: string, value: T | undefined) => void,
  ): Promise<UnlistenFn>;
  close(): Promise<void>;
}

/** Minimal plugin surface: the Store.load / Store.get entry points. */
export interface TauriStorePlugin {
  load(path: string, options?: StoreOptions): Promise<TauriStoreInstance>;
  get(path: string): Promise<TauriStoreInstance | null>;
}

class TauriStoreHandle implements StoreHandle {
  readonly path: string;
  private readonly inner: TauriStoreInstance;
  private readonly onEvict: () => void;
  private closed = false;

  constructor(
    path: string,
    inner: TauriStoreInstance,
    onEvict: () => void,
  ) {
    this.path = path;
    this.inner = inner;
    this.onEvict = onEvict;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`Store handle for "${this.path}" is closed`);
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.assertOpen();
    return this.inner.get<T>(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.assertOpen();
    await this.inner.set(key, value);
  }

  async has(key: string): Promise<boolean> {
    this.assertOpen();
    return this.inner.has(key);
  }

  async delete(key: string): Promise<boolean> {
    this.assertOpen();
    return this.inner.delete(key);
  }

  async clear(): Promise<void> {
    this.assertOpen();
    await this.inner.clear();
  }

  async reset(): Promise<void> {
    this.assertOpen();
    await this.inner.reset();
  }

  async keys(): Promise<string[]> {
    this.assertOpen();
    return this.inner.keys();
  }

  async values<T>(): Promise<T[]> {
    this.assertOpen();
    return this.inner.values<T>();
  }

  async entries<T>(): Promise<Array<[string, T]>> {
    this.assertOpen();
    return this.inner.entries<T>();
  }

  async length(): Promise<number> {
    this.assertOpen();
    return this.inner.length();
  }

  async reload(): Promise<void> {
    this.assertOpen();
    await this.inner.reload();
  }

  async save(): Promise<void> {
    this.assertOpen();
    await this.inner.save();
  }

  async onKeyChange<T>(
    key: string,
    cb: (value: T | undefined) => void,
  ): Promise<UnlistenFn> {
    this.assertOpen();
    return this.inner.onKeyChange<T>(key, cb);
  }

  async onChange<T>(
    cb: (key: string, value: T | undefined) => void,
  ): Promise<UnlistenFn> {
    this.assertOpen();
    return this.inner.onChange<T>(cb);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.inner.close();
    this.onEvict();
  }
}

class TauriStoreAdapter implements StoreAdapter {
  private readonly plugin: TauriStorePlugin;
  private readonly handles = new Map<string, TauriStoreHandle>();

  constructor(plugin: TauriStorePlugin) {
    this.plugin = plugin;
  }

  async load(path: string, options?: StoreOptions): Promise<StoreHandle> {
    const existing = this.handles.get(path);
    if (existing) {
      return existing;
    }
    const inner = await this.plugin.load(path, options);
    const handle = new TauriStoreHandle(path, inner, () => {
      this.handles.delete(path);
    });
    this.handles.set(path, handle);
    return handle;
  }

  async getStore(path: string): Promise<StoreHandle | null> {
    const existing = this.handles.get(path);
    if (existing) {
      return existing;
    }
    const inner = await this.plugin.get(path);
    if (inner === null) {
      return null;
    }
    const handle = new TauriStoreHandle(path, inner, () => {
      this.handles.delete(path);
    });
    this.handles.set(path, handle);
    return handle;
  }

  async closeAll(): Promise<void> {
    const handles = [...this.handles.values()];
    for (const handle of handles) {
      await handle.close();
    }
  }
}

/**
 * Creates a Tauri StoreAdapter bound to the given plugin surface.
 * Test seam: specs pass a recording fake; production passes nothing
 * and uses createTauriStoreAdapter() instead.
 */
export function createTauriStoreAdapterWithPlugin(
  plugin: TauriStorePlugin,
): StoreAdapter {
  return new TauriStoreAdapter(plugin);
}

/** Creates a Tauri StoreAdapter bound to the real plugin-store. */
export function createTauriStoreAdapter(): StoreAdapter {
  return new TauriStoreAdapter({
    load: (path, options) => TauriStore.load(path, options),
    get: (path) => TauriStore.get(path),
  });
}
