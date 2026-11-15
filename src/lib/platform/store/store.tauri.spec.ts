// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Delegation tests for the Tauri store adapter (store.tauri.ts).
 *
 * The adapter is a thin wrapper over @tauri-apps/plugin-store 2.3.0,
 * so these tests verify 1:1 delegation against a recording fake
 * plugin bound through createTauriStoreAdapterWithPlugin: every
 * method forwards the same arguments, returns the plugin result,
 * passes listener callbacks through by identity, and adds no
 * classification, file routing, or option rewriting. No Tauri
 * runtime is needed; the real plugin module is imported but never
 * called.
 *
 * Runner: node:test with node:assert/strict, the pattern the repo
 * already uses for its colocated specs. Run via the esbuild bundle:
 *
 *   node_modules/.bin/esbuild src/lib/platform/store/store.tauri.spec.ts \
 *     --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert --external:node:assert/strict \
 *     --outfile=/tmp/store.tauri.spec.mjs
 *   node --test /tmp/store.tauri.spec.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UnlistenFn } from "../event/interface";
import type { StoreOptions } from "./interface";
import {
  createTauriStoreAdapter,
  createTauriStoreAdapterWithPlugin,
  type TauriStoreInstance,
  type TauriStorePlugin,
} from "./store.tauri";

type CallRecord = { method: string; args: unknown[] };

class FakePluginStore implements TauriStoreInstance {
  readonly calls: CallRecord[] = [];
  readonly data = new Map<string, unknown>();
  closedCount = 0;
  unlistenFn: UnlistenFn = () => {};
  lastKeyListener: ((value: unknown) => void) | null = null;
  lastChangeListener: ((key: string, value: unknown) => void) | null = null;

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  async set(key: string, value: unknown): Promise<void> {
    this.record("set", [key, value]);
    this.data.set(key, value);
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.record("get", [key]);
    return this.data.get(key) as T | undefined;
  }

  async has(key: string): Promise<boolean> {
    this.record("has", [key]);
    return this.data.has(key);
  }

  async delete(key: string): Promise<boolean> {
    this.record("delete", [key]);
    return this.data.delete(key);
  }

  async clear(): Promise<void> {
    this.record("clear", []);
    this.data.clear();
  }

  async reset(): Promise<void> {
    this.record("reset", []);
    this.data.clear();
  }

  async keys(): Promise<string[]> {
    this.record("keys", []);
    return [...this.data.keys()];
  }

  async values<T>(): Promise<T[]> {
    this.record("values", []);
    return [...this.data.values()] as T[];
  }

  async entries<T>(): Promise<Array<[string, T]>> {
    this.record("entries", []);
    return [...this.data.entries()] as Array<[string, T]>;
  }

  async length(): Promise<number> {
    this.record("length", []);
    return this.data.size;
  }

  async reload(): Promise<void> {
    this.record("reload", []);
  }

  async save(): Promise<void> {
    this.record("save", []);
  }

  async onKeyChange<T>(
    key: string,
    cb: (value: T | undefined) => void,
  ): Promise<UnlistenFn> {
    this.record("onKeyChange", [key, cb]);
    this.lastKeyListener = cb as (value: unknown) => void;
    return this.unlistenFn;
  }

  async onChange<T>(
    cb: (key: string, value: T | undefined) => void,
  ): Promise<UnlistenFn> {
    this.record("onChange", [cb]);
    this.lastChangeListener = cb as (key: string, value: unknown) => void;
    return this.unlistenFn;
  }

  async close(): Promise<void> {
    this.record("close", []);
    this.closedCount += 1;
  }

  callsOf(method: string): CallRecord[] {
    return this.calls.filter((call) => call.method === method);
  }
}

class FakePlugin implements TauriStorePlugin {
  readonly stores = new Map<string, FakePluginStore>();
  readonly loadCalls: Array<{ path: string; options?: StoreOptions }> = [];
  readonly getCalls: string[] = [];

  async load(
    path: string,
    options?: StoreOptions,
  ): Promise<TauriStoreInstance> {
    this.loadCalls.push({ path, options });
    let store = this.stores.get(path);
    if (!store) {
      store = new FakePluginStore();
      this.stores.set(path, store);
    }
    return store;
  }

  async get(path: string): Promise<TauriStoreInstance | null> {
    this.getCalls.push(path);
    return this.stores.get(path) ?? null;
  }
}

describe("tauri store: adapter caching and entry points", () => {
  it("load delegates with path and options, and caches one wrapper per path", async () => {
    const plugin = new FakePlugin();
    const adapter = createTauriStoreAdapterWithPlugin(plugin);
    const options: StoreOptions = { autoSave: 100, createNew: true };
    const first = await adapter.load("store.json", options);
    const second = await adapter.load("store.json");
    assert.equal(first, second);
    assert.equal(first.path, "store.json");
    assert.equal(plugin.loadCalls.length, 1);
    assert.equal(plugin.loadCalls[0]?.path, "store.json");
    assert.equal(plugin.loadCalls[0]?.options, options);
    await first.close();
  });

  it("getStore returns null when the plugin has no store, and wraps plugin.get results", async () => {
    const plugin = new FakePlugin();
    const adapter = createTauriStoreAdapterWithPlugin(plugin);
    assert.equal(await adapter.getStore("store.json"), null);
    assert.deepEqual(plugin.getCalls, ["store.json"]);
    const seeded = new FakePluginStore();
    seeded.data.set("seeded", "yes");
    plugin.stores.set("store.json", seeded);
    const handle = await adapter.getStore("store.json");
    assert.ok(handle);
    assert.equal(handle.path, "store.json");
    assert.equal(await handle.get("seeded"), "yes");
    assert.equal(await adapter.getStore("store.json"), handle);
    await handle.close();
  });

  it("load passes every file name and option through without routing or rewriting", async () => {
    const plugin = new FakePlugin();
    const adapter = createTauriStoreAdapterWithPlugin(plugin);
    for (const path of ["sync_config.json", "agent_debug_logs.json", "custom.json"]) {
      const handle = await adapter.load(path, {
        serializeFnName: "customSer",
        deserializeFnName: "customDe",
      });
      assert.equal(handle.path, path);
    }
    assert.equal(plugin.loadCalls.length, 3);
    assert.equal(plugin.loadCalls[0]?.options?.serializeFnName, "customSer");
    await adapter.closeAll();
  });

  it("closeAll closes every cached handle", async () => {
    const plugin = new FakePlugin();
    const adapter = createTauriStoreAdapterWithPlugin(plugin);
    const a = await adapter.load("a.json");
    const b = await adapter.load("b.json");
    await adapter.closeAll();
    await assert.rejects(a.get("x"), /closed/);
    await assert.rejects(b.get("x"), /closed/);
    assert.equal(plugin.stores.get("a.json")?.closedCount, 1);
    assert.equal(plugin.stores.get("b.json")?.closedCount, 1);
  });
});

describe("tauri store: 1:1 delegation", () => {
  it("every handle method forwards the same arguments and returns the plugin result", async () => {
    const plugin = new FakePlugin();
    const adapter = createTauriStoreAdapterWithPlugin(plugin);
    const handle = await adapter.load("store.json");
    const inner = plugin.stores.get("store.json") as FakePluginStore;

    await handle.set("k", { nested: 1 });
    assert.deepEqual(inner.callsOf("set")[0], {
      method: "set",
      args: ["k", { nested: 1 }],
    });
    assert.deepEqual(await handle.get("k"), { nested: 1 });
    assert.equal(await handle.has("k"), true);
    assert.equal(await handle.has("missing"), false);
    assert.equal(await handle.delete("k"), true);
    assert.equal(await handle.delete("k"), false);
    await handle.set("a", 1);
    await handle.set("b", 2);
    assert.deepEqual(await handle.keys(), ["a", "b"]);
    assert.deepEqual(await handle.values<number>(), [1, 2]);
    assert.deepEqual(await handle.entries<number>(), [
      ["a", 1],
      ["b", 2],
    ]);
    assert.equal(await handle.length(), 2);
    await handle.reload();
    await handle.save();
    await handle.clear();
    assert.equal(await handle.length(), 0);
    await handle.set("c", 3);
    await handle.reset();
    assert.equal(await handle.length(), 0);
    for (const method of [
      "get",
      "set",
      "has",
      "delete",
      "clear",
      "reset",
      "keys",
      "values",
      "entries",
      "length",
      "reload",
      "save",
    ]) {
      assert.ok(inner.callsOf(method).length >= 1, method);
    }
    await handle.close();
    assert.equal(inner.callsOf("close").length, 1);
  });

  it("secret-looking keys pass through untouched: no classification on desktop", async () => {
    const plugin = new FakePlugin();
    const adapter = createTauriStoreAdapterWithPlugin(plugin);
    const handle = await adapter.load("store.json");
    await handle.set("apiKey", "CANARY-SECRET-tauri-1");
    await handle.set("pin", "1234");
    assert.equal(await handle.get("apiKey"), "CANARY-SECRET-tauri-1");
    assert.equal(await handle.get("pin"), "1234");
    assert.deepEqual(await handle.keys(), ["apiKey", "pin"]);
    await handle.close();
  });

  it("listener callbacks pass through by identity and unlisten is the plugin function", async () => {
    const plugin = new FakePlugin();
    const adapter = createTauriStoreAdapterWithPlugin(plugin);
    const handle = await adapter.load("store.json");
    const inner = plugin.stores.get("store.json") as FakePluginStore;
    const keyCb = (_value: string | undefined): void => {
      void _value;
    };
    const changeCb = (_key: string, _value: string | undefined): void => {
      void _key;
      void _value;
    };
    const unlistenKey = await handle.onKeyChange("watched", keyCb);
    const unlistenAll = await handle.onChange(changeCb);
    assert.equal(unlistenKey, inner.unlistenFn);
    assert.equal(unlistenAll, inner.unlistenFn);
    assert.equal(inner.lastKeyListener, keyCb);
    assert.equal(inner.lastChangeListener, changeCb);
    assert.equal(inner.callsOf("onKeyChange")[0]?.args[0], "watched");
    await handle.close();
  });

  it("close delegates once, evicts, and later methods throw; second close is a no-op", async () => {
    const plugin = new FakePlugin();
    const adapter = createTauriStoreAdapterWithPlugin(plugin);
    const handle = await adapter.load("store.json");
    const inner = plugin.stores.get("store.json") as FakePluginStore;
    await handle.close();
    await handle.close();
    assert.equal(inner.closedCount, 1);
    await assert.rejects(handle.get("x"), /closed/);
    await assert.rejects(handle.set("x", 1), /closed/);
    // The Rust side evicts the closed store from its own cache, so
    // a later plugin get() returns null; model that eviction here.
    plugin.stores.delete("store.json");
    assert.equal(await adapter.getStore("store.json"), null);
    const fresh = await adapter.load("store.json");
    assert.notEqual(fresh, handle);
    await fresh.close();
  });

  it("handle and adapter expose the full IStore surface", async () => {
    const plugin = new FakePlugin();
    const adapter = createTauriStoreAdapterWithPlugin(plugin);
    for (const method of ["load", "getStore", "closeAll"]) {
      assert.equal(
        typeof (adapter as unknown as Record<string, unknown>)[method],
        "function",
        method,
      );
    }
    const handle = await adapter.load("store.json");
    for (const method of [
      "get",
      "set",
      "has",
      "delete",
      "clear",
      "reset",
      "keys",
      "values",
      "entries",
      "length",
      "reload",
      "save",
      "onKeyChange",
      "onChange",
      "close",
    ]) {
      assert.equal(
        typeof (handle as unknown as Record<string, unknown>)[method],
        "function",
        method,
      );
    }
    await handle.close();
  });

  it("createTauriStoreAdapter binds the real plugin factory shape", () => {
    const adapter = createTauriStoreAdapter();
    assert.equal(typeof adapter.load, "function");
    assert.equal(typeof adapter.getStore, "function");
    assert.equal(typeof adapter.closeAll, "function");
  });
});
