// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Independent in-memory fake for the StoreAdapter interface.
//
// The fake implements the StoreHandle surface from the scaffold-local
// contract types (tests/contract/contract-types.ts) over a plain Map.
// It never wraps the web or Tauri implementation. Backing maps are shared
// between adapter instances created with the same backings object, which
// is how contract cases simulate a second session or a restart inside one
// process. There is no persistence across processes and no network.
//
// Classification is the minimal fake-local subset of
// fase1/desain-store-adapter.md section 2.3: exact key "pin" and keys
// whose lowercase name contains a sensitive pattern (apikey, accesskey,
// accesstoken, password, secret, token, credential) behave as absent on
// every read surface, and set() over them throws PlatformCapabilityError.
// The full key-schema module (classifyKey, S/L lists, aiModelList split)
// belongs to the store-interface owner and the real adapter; the fake
// must not grow it.

import { capabilityError } from "../../src/lib/platform/errors";
import { ContractError } from "../contract/contract-errors";
import type {
  StoreAdapter,
  StoreHandle,
  StoreOptions,
  UnlistenFn,
} from "../contract/contract-types";

const SECRET_PATTERNS = [
  "apikey",
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "password",
  "secret",
  "token",
  "credential",
];

// Removed store files (fase1/desain-store-adapter.md section 2.8). Only
// store.json loads in web mode; every other name fails closed.
const REMOVED_STORE_FILES = new Set([
  "sync_config.json",
  "sync_logs.json",
  "sync_timing_logs.json",
  "sync_remote_content_cache.json",
  "sync_file_proofs.json",
  "onedrive_data_sync_recovery.json",
  "desktop-screenshot.json",
  "workspace_path_moves.json",
  "self-hosted-sync-ui.json",
  "app-lock.json",
  "web-clipper.json",
  "local-mcp.json",
  "agent_debug_logs.json",
]);

export type FakeStoreBackings = Map<string, Map<string, unknown>>;

export function isSecretStoreKey(key: string): boolean {
  if (key === "pin") {
    return true;
  }
  const lower = key.toLowerCase();
  return SECRET_PATTERNS.some((pattern) => lower.includes(pattern));
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new ContractError(
      "VALIDATION",
      "Store value is not serializable",
      {},
    );
  }
}

type KeyListener = (value: unknown) => void;
type ChangeListener = (key: string, value: unknown) => void;

export class FakeStoreHandle implements StoreHandle {
  readonly path: string;
  private readonly backing: Map<string, unknown>;
  private closed = false;
  private readonly keyListeners = new Map<string, Set<KeyListener>>();
  private readonly changeListeners = new Set<ChangeListener>();

  constructor(path: string, backing: Map<string, unknown>) {
    this.path = path;
    this.backing = backing;
  }

  isClosed(): boolean {
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ContractError("NOT_FOUND", "Store handle is closed");
    }
  }

  private notify(key: string, value: unknown): void {
    const keySet = this.keyListeners.get(key);
    if (keySet) {
      for (const listener of [...keySet]) {
        listener(cloneValue(value));
      }
    }
    for (const listener of [...this.changeListeners]) {
      listener(key, cloneValue(value));
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.assertOpen();
    if (isSecretStoreKey(key)) {
      return undefined;
    }
    const value = this.backing.get(key);
    return value === undefined ? undefined : cloneValue(value as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.assertOpen();
    if (isSecretStoreKey(key)) {
      throw capabilityError(
        "unavailable",
        "store",
        key === "pin" ? "app-lock" : "secret-key-write",
        "web",
        `Key "${key}" must not be written through the settings store`,
      );
    }
    if (value === undefined) {
      // Interim behavior for F1-22 (verdict unconfirmed, CT-02 pending):
      // set(key, undefined) deletes the key, matching the POC shim.
      const existed = this.backing.delete(key);
      if (existed) {
        this.notify(key, undefined);
      }
      return;
    }
    const stored = cloneValue(value);
    this.backing.set(key, stored);
    this.notify(key, stored);
  }

  async has(key: string): Promise<boolean> {
    this.assertOpen();
    if (isSecretStoreKey(key)) {
      return false;
    }
    return this.backing.has(key);
  }

  async delete(key: string): Promise<boolean> {
    this.assertOpen();
    if (isSecretStoreKey(key)) {
      return false;
    }
    const existed = this.backing.delete(key);
    if (existed) {
      this.notify(key, undefined);
    }
    return existed;
  }

  async clear(): Promise<void> {
    this.assertOpen();
    const keys = [...this.backing.keys()];
    this.backing.clear();
    for (const key of keys) {
      this.notify(key, undefined);
    }
  }

  async reset(): Promise<void> {
    await this.clear();
  }

  async keys(): Promise<string[]> {
    this.assertOpen();
    return [...this.backing.keys()].filter((key) => !isSecretStoreKey(key));
  }

  async values<T>(): Promise<T[]> {
    const entries = await this.entries<T>();
    return entries.map(([, value]) => value);
  }

  async entries<T>(): Promise<Array<[string, T]>> {
    this.assertOpen();
    const result: Array<[string, T]> = [];
    for (const [key, value] of this.backing) {
      if (!isSecretStoreKey(key)) {
        result.push([key, cloneValue(value as T)]);
      }
    }
    return result;
  }

  async length(): Promise<number> {
    return (await this.keys()).length;
  }

  async reload(): Promise<void> {
    this.assertOpen();
    // The backing map is the source of truth; reload re-reads it and
    // deliberately emits no change events (plugin-store semantics).
  }

  async save(): Promise<void> {
    this.assertOpen();
    // No server behind the fake; writes are already in the backing map.
    // Server confirmation semantics (CT-15) belong to the web adapter.
  }

  async onKeyChange<T>(
    key: string,
    cb: (value: T | undefined) => void,
  ): Promise<UnlistenFn> {
    this.assertOpen();
    let set = this.keyListeners.get(key);
    if (!set) {
      set = new Set();
      this.keyListeners.set(key, set);
    }
    const listener = cb as KeyListener;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  async onChange<T>(
    cb: (key: string, value: T | undefined) => void,
  ): Promise<UnlistenFn> {
    this.assertOpen();
    const listener = cb as ChangeListener;
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.keyListeners.clear();
    this.changeListeners.clear();
  }
}

export interface FakeStoreAdapterOptions {
  backings?: FakeStoreBackings;
  // When true, load() rejects as if the stored document were corrupt.
  corrupt?: boolean;
}

export class FakeStoreAdapter implements StoreAdapter {
  readonly backings: FakeStoreBackings;
  private readonly corrupt: boolean;
  private readonly handles = new Map<string, FakeStoreHandle>();

  constructor(options: FakeStoreAdapterOptions = {}) {
    this.backings = options.backings ?? new Map();
    this.corrupt = options.corrupt ?? false;
  }

  protected createHandle(
    path: string,
    backing: Map<string, unknown>,
  ): FakeStoreHandle {
    return new FakeStoreHandle(path, backing);
  }

  async load(path: string, options: StoreOptions = {}): Promise<StoreHandle> {
    if (
      options.serializeFnName !== undefined ||
      options.deserializeFnName !== undefined
    ) {
      throw capabilityError(
        "unavailable",
        "store",
        "custom-serializer",
        "web",
        "Custom serialize/deserialize functions are not available in web mode",
      );
    }
    if (path !== "store.json") {
      const reason = REMOVED_STORE_FILES.has(path)
        ? `Store file "${path}" was removed in the web fork`
        : `Unknown store file "${path}"`;
      throw capabilityError("unavailable", "store", `load:${path}`, "web", reason);
    }
    if (this.corrupt) {
      throw new ContractError(
        "UNAVAILABLE",
        "Store document is corrupt and cannot be loaded",
      );
    }
    const existing = this.handles.get(path);
    if (existing && !existing.isClosed() && !options.createNew) {
      return existing;
    }
    if (options.createNew || !this.backings.has(path)) {
      this.backings.set(path, new Map());
    }
    const backing = this.backings.get(path) as Map<string, unknown>;
    const handle = this.createHandle(path, backing);
    this.handles.set(path, handle);
    return handle;
  }

  async getStore(path: string): Promise<StoreHandle | null> {
    return this.handles.get(path) ?? null;
  }

  async closeAll(): Promise<void> {
    for (const handle of this.handles.values()) {
      await handle.close();
    }
    this.handles.clear();
  }
}

export function createFakeStoreAdapter(
  options: FakeStoreAdapterOptions = {},
): FakeStoreAdapter {
  return new FakeStoreAdapter(options);
}
