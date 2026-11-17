// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Behavior tests for the web store adapter (store.web.ts).
 *
 * Runner: node:test with node:assert/strict, the pattern the repo
 * already uses for its colocated specs. Vitest is the planned
 * harness in desain-pengujian, but the colocated specs in this tree
 * run through the esbuild bundle below; the parameterized contract
 * suite in tests/contract/ stays fake-only until the integrator
 * registers web/tauri factories there (see the gap note in
 * fase1/laporan-v3b-11a-store.md).
 *
 * How to run (no new dependency): bundle with the installed esbuild,
 * then run the bundle under node:test:
 *
 *   node_modules/.bin/esbuild src/lib/platform/store/store.web.spec.ts \
 *     --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert --external:node:assert/strict \
 *     --outfile=/tmp/store.web.spec.mjs
 *   node --test /tmp/store.web.spec.mjs
 *
 * The fake transport below is a small in-memory settings server that
 * mirrors the landed server semantics: the { ok, data } / { ok,
 * error } envelope, the baseRevision guard with 409 details, the
 * rejected list, revision bumps only when a key applies, the
 * aiModelList secret cascade, and orphan rejection on the secret
 * PUT. Canary strings are obvious dummies, never real secrets.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { PlatformCapabilityError } from "../errors";
import type {
  StoreAdapter,
  StoreKeyClass,
  StoreOptions,
} from "./interface";
import { createLazyStore } from "./lazy";
import {
  createDefaultStoreKeyClassifier,
  createWebStoreAdapter,
  isStoreWebError,
  WEB_LOCAL_STORAGE_PREFIX,
  WEB_R_REJECT_KEYS,
  type StoreKeyClassifier,
  type StoreWebBroadcastChannel,
  type StoreWebFetch,
  type StoreWebFetchInit,
  type StoreWebFetchResponse,
  type StoreWebStorage,
  type WebStoreAdapterDeps,
  type WebStoreHandle,
} from "./store.web";

const CANARY = "CANARY-SECRET-9d2e71";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) {
      return;
    }
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function isCapabilityError(
  error: unknown,
  code: string,
  capability: string,
): boolean {
  return (
    error instanceof PlatformCapabilityError &&
    error.code === code &&
    error.capability === capability &&
    error.adapter === "store" &&
    error.mode === "web"
  );
}

function isWebErrorCode(error: unknown, code: string): boolean {
  return isStoreWebError(error) && error.code === code;
}

interface LoggedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: string;
}

function jsonResponse(
  status: number,
  payload: unknown,
): StoreWebFetchResponse {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
  };
}

function rawResponse(status: number, text: string): StoreWebFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
  };
}

function errorResponse(
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): StoreWebFetchResponse {
  return jsonResponse(status, {
    ok: false,
    error: {
      code,
      message: `test ${code}`,
      requestId: "test-req-1",
      retryable: false,
      details,
    },
  });
}

class FakeSettingsServer {
  revision = 0;
  settings = new Map<string, unknown>();
  secrets = new Map<string, Record<string, unknown>>();
  requests: LoggedRequest[] = [];
  rejectKeys = new Map<string, string>();
  failNext: { status: number; code: string } | null = null;
  failNetwork = false;
  failPutOnce = false;
  conflictCountdown = 0;
  malformedNext = false;
  patchGate: Promise<void> | null = null;

  seed(settings: Record<string, unknown>, revision = 0): void {
    this.settings = new Map(Object.entries(settings));
    this.revision = revision;
  }

  patchRequests(): LoggedRequest[] {
    return this.requests.filter((request) => request.method === "PATCH");
  }

  putRequests(): LoggedRequest[] {
    return this.requests.filter((request) => request.method === "PUT");
  }

  getRequests(): LoggedRequest[] {
    return this.requests.filter((request) => request.method === "GET");
  }

  async handle(
    url: string,
    init?: StoreWebFetchInit,
  ): Promise<StoreWebFetchResponse> {
    const method = init?.method ?? "GET";
    let body: unknown;
    if (init?.body !== undefined) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    this.requests.push({
      method,
      url,
      headers: { ...(init?.headers ?? {}) },
      body,
      credentials: init?.credentials,
    });
    if (this.failNetwork) {
      throw new Error("fetch failed");
    }
    if (this.failNext !== null) {
      const failure = this.failNext;
      this.failNext = null;
      return errorResponse(failure.status, failure.code);
    }
    if (this.malformedNext) {
      this.malformedNext = false;
      return rawResponse(200, "this is not json");
    }
    if (method === "GET" && url === "/api/settings") {
      return jsonResponse(200, {
        ok: true,
        data: {
          revision: this.revision,
          settings: Object.fromEntries(this.settings),
        },
      });
    }
    if (method === "PATCH" && url === "/api/settings") {
      if (this.patchGate !== null) {
        await this.patchGate;
      }
      if (this.conflictCountdown > 0) {
        this.conflictCountdown -= 1;
        return errorResponse(409, "revision_conflict", {
          revision: this.revision,
          settings: Object.fromEntries(this.settings),
        });
      }
      if (!isRecord(body) || !isRecord(body["settings"])) {
        return errorResponse(400, "validation_failed");
      }
      const baseRevision = body["baseRevision"];
      if (baseRevision !== this.revision) {
        return errorResponse(409, "revision_conflict", {
          revision: this.revision,
          settings: Object.fromEntries(this.settings),
        });
      }
      const applied: string[] = [];
      const rejected: Array<{ key: string; reason: string }> = [];
      const incoming = body["settings"] as Record<string, unknown>;
      let aiModelListTouched = false;
      let aiModelListDeleted = false;
      for (const [key, value] of Object.entries(incoming)) {
        const reason = this.rejectKeys.get(key);
        if (reason !== undefined) {
          rejected.push({ key, reason });
          continue;
        }
        applied.push(key);
        if (value === null) {
          this.settings.delete(key);
          if (key === "aiModelList") {
            aiModelListTouched = true;
            aiModelListDeleted = true;
          }
        } else {
          this.settings.set(key, value);
          if (key === "aiModelList") {
            aiModelListTouched = true;
          }
        }
      }
      if (aiModelListTouched) {
        if (aiModelListDeleted) {
          this.secrets.clear();
        } else {
          const listed = new Set<string>();
          const list = this.settings.get("aiModelList");
          if (Array.isArray(list)) {
            for (const entry of list) {
              if (
                isRecord(entry) &&
                typeof entry["key"] === "string"
              ) {
                listed.add(entry["key"]);
              }
            }
          }
          for (const ref of [...this.secrets.keys()]) {
            if (!listed.has(ref)) {
              this.secrets.delete(ref);
            }
          }
        }
      }
      if (applied.length > 0) {
        this.revision += 1;
      }
      return jsonResponse(200, {
        ok: true,
        data: { revision: this.revision, applied, rejected },
      });
    }
    if (method === "PUT" && url === "/api/settings/secrets/ai-providers") {
      if (this.failPutOnce) {
        this.failPutOnce = false;
        return errorResponse(500, "internal_error");
      }
      if (!isRecord(body) || !Array.isArray(body["providers"])) {
        return errorResponse(400, "validation_failed");
      }
      const metadataKeys = new Set<string>();
      const list = this.settings.get("aiModelList");
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (isRecord(entry) && typeof entry["key"] === "string") {
            metadataKeys.add(entry["key"]);
          }
        }
      }
      const updated: Array<{
        providerKey: string;
        hasApiKey: boolean;
        updatedAt: number;
      }> = [];
      for (const provider of body["providers"]) {
        if (!isRecord(provider) || typeof provider["providerKey"] !== "string") {
          return errorResponse(400, "validation_failed");
        }
        const providerKey = provider["providerKey"];
        if (!metadataKeys.has(providerKey)) {
          return errorResponse(400, "validation_failed");
        }
        const merged: Record<string, unknown> = {
          ...(this.secrets.get(providerKey) ?? {}),
        };
        for (const [field, value] of Object.entries(provider)) {
          if (field === "providerKey") {
            continue;
          }
          if (value === null) {
            delete merged[field];
          } else {
            merged[field] = value;
          }
        }
        if (Object.keys(merged).length === 0) {
          this.secrets.delete(providerKey);
        } else {
          this.secrets.set(providerKey, merged);
        }
        updated.push({ providerKey, hasApiKey: true, updatedAt: 1 });
      }
      return jsonResponse(200, { ok: true, data: { updated } });
    }
    return errorResponse(404, "not_found");
  }
}

class FakeStorage implements StoreWebStorage {
  private readonly data = new Map<string, string>();
  failWrites = false;
  writes: Array<[string, string]> = [];

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error("QuotaExceededError: storage full");
    }
    this.writes.push([key, value]);
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  seedDoc(path: string, doc: unknown): void {
    this.data.set(
      `${WEB_LOCAL_STORAGE_PREFIX}${path}`,
      JSON.stringify(doc),
    );
  }

  seedRaw(path: string, raw: string): void {
    this.data.set(`${WEB_LOCAL_STORAGE_PREFIX}${path}`, raw);
  }

  readDoc(path: string): unknown {
    const raw = this.data.get(`${WEB_LOCAL_STORAGE_PREFIX}${path}`);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}

class FakeBroadcastChannel implements StoreWebBroadcastChannel {
  static hubs = new Map<string, Set<FakeBroadcastChannel>>();
  static posted: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
    let hub = FakeBroadcastChannel.hubs.get(name);
    if (!hub) {
      hub = new Set<FakeBroadcastChannel>();
      FakeBroadcastChannel.hubs.set(name, hub);
    }
    hub.add(this);
  }

  postMessage(data: unknown): void {
    FakeBroadcastChannel.posted.push(data);
    const hub = FakeBroadcastChannel.hubs.get(this.name);
    if (!hub) {
      return;
    }
    for (const other of [...hub]) {
      if (other !== this) {
        other.onmessage?.({ data });
      }
    }
  }

  close(): void {
    FakeBroadcastChannel.hubs.get(this.name)?.delete(this);
  }

  static reset(): void {
    FakeBroadcastChannel.hubs.clear();
    FakeBroadcastChannel.posted = [];
  }
}

function classifierWith(
  overrides: Record<string, StoreKeyClass>,
): StoreKeyClassifier {
  const base = createDefaultStoreKeyClassifier();
  return (key: string) => overrides[key] ?? base(key);
}

function makeDeps(
  server: FakeSettingsServer,
  storage: FakeStorage,
  extra: WebStoreAdapterDeps = {},
): WebStoreAdapterDeps {
  const fetchImpl: StoreWebFetch = (url, init) => server.handle(url, init);
  return {
    fetchImpl,
    storage,
    broadcastChannelImpl: null,
    ...extra,
  };
}

async function openStore(
  server: FakeSettingsServer,
  storage: FakeStorage,
  extra: WebStoreAdapterDeps = {},
  loadOptions: StoreOptions = { autoSave: false },
): Promise<{ adapter: StoreAdapter; store: WebStoreHandle }> {
  const adapter = createWebStoreAdapter(makeDeps(server, storage, extra));
  const store = (await adapter.load(
    "store.json",
    loadOptions,
  )) as WebStoreHandle;
  return { adapter, store };
}

beforeEach(() => {
  FakeBroadcastChannel.reset();
});

describe("web store: loading and routing", () => {
  it("load fetches the S document, caches one handle, getStore stays null before", async () => {
    const server = new FakeSettingsServer();
    server.seed({ language: "English", editorLineHeight: 1.6 }, 7);
    const storage = new FakeStorage();
    const adapter = createWebStoreAdapter(makeDeps(server, storage));
    assert.equal(await adapter.getStore("store.json"), null);
    const first = await adapter.load("store.json", { autoSave: false });
    const second = await adapter.load("store.json", { autoSave: false });
    assert.equal(first, second);
    assert.equal(await adapter.getStore("store.json"), first);
    assert.equal(first.path, "store.json");
    assert.equal(await first.get("language"), "English");
    assert.equal(await first.get("editorLineHeight"), 1.6);
    assert.equal(server.getRequests().length, 1);
    assert.equal((first as WebStoreHandle).lastRevision(), 7);
    await first.close();
  });

  it("load throws on server failure and leaves no cached handle", async () => {
    const server = new FakeSettingsServer();
    server.failNext = { status: 500, code: "internal_error" };
    const storage = new FakeStorage();
    const adapter = createWebStoreAdapter(makeDeps(server, storage));
    await assert.rejects(
      adapter.load("store.json"),
      (error: unknown) => isWebErrorCode(error, "internal_error"),
    );
    assert.equal(await adapter.getStore("store.json"), null);
    const store = await adapter.load("store.json", { autoSave: false });
    assert.equal(await store.get("anything"), undefined);
    await store.close();
  });

  it("removed files and custom serializers throw capability errors", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const adapter = createWebStoreAdapter(makeDeps(server, storage));
    for (const path of [
      "sync_config.json",
      "sync_logs.json",
      "agent_debug_logs.json",
      "app-lock.json",
      "unknown-store.json",
    ]) {
      await assert.rejects(
        adapter.load(path),
        (error: unknown) =>
          isCapabilityError(error, "unavailable", "store.loadRemovedFile"),
        path,
      );
      assert.equal(await adapter.getStore(path), null, path);
    }
    await assert.rejects(
      adapter.load("store.json", { serializeFnName: "custom" }),
      (error: unknown) =>
        isCapabilityError(error, "unsupported", "store.customSerializer"),
    );
    await assert.rejects(
      adapter.load("store.json", { deserializeFnName: "custom" }),
      (error: unknown) =>
        isCapabilityError(error, "unsupported", "store.customSerializer"),
    );
  });

  it("second load returns the cached handle and ignores new options", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { adapter, store } = await openStore(server, storage, {
      coalesceMs: 5,
    });
    const again = await adapter.load("store.json", { autoSave: true });
    assert.equal(again, store);
    await store.set("k", "v");
    await sleep(30);
    assert.equal(server.patchRequests().length, 0);
    await store.close();
  });

  it("createNew empties the cache and flushes a delete-all PATCH", async () => {
    const server = new FakeSettingsServer();
    server.seed({ language: "English" }, 3);
    const storage = new FakeStorage();
    const adapter = createWebStoreAdapter(makeDeps(server, storage));
    const store = await adapter.load("store.json", {
      autoSave: false,
      createNew: true,
    });
    assert.equal(await store.get("language"), undefined);
    assert.equal(server.patchRequests().length, 1);
    const body = server.patchRequests()[0]?.body;
    assert.ok(isRecord(body));
    assert.deepEqual(body["settings"], {
      language: null,
      aiModelList: null,
    });
    assert.equal(server.settings.size, 0);
    await store.set("keep", "yes");
    const again = await adapter.load("store.json", {
      autoSave: false,
      createNew: true,
    });
    assert.equal(again, store);
    assert.equal(await again.get("keep"), undefined);
    await store.close();
  });

  it("createLazyStore defers the GET until the first method call", async () => {
    const server = new FakeSettingsServer();
    server.seed({ language: "English" }, 1);
    const storage = new FakeStorage();
    const adapter = createWebStoreAdapter(makeDeps(server, storage));
    const lazy = createLazyStore(adapter, "store.json", { autoSave: false });
    assert.equal(lazy.path, "store.json");
    assert.equal(server.getRequests().length, 0);
    await lazy.set("k", "v");
    assert.equal(server.getRequests().length, 1);
    assert.equal(await lazy.get("k"), "v");
    assert.equal(server.getRequests().length, 1);
    await lazy.close();
  });
});

describe("web store: L document", () => {
  it("L keys read from localStorage and never reach PATCH", async () => {
    const server = new FakeSettingsServer();
    server.seed({ language: "English" }, 1);
    const storage = new FakeStorage();
    storage.seedDoc("store.json", {
      openTabs: ["tab-1"],
      deviceId: "dev-1",
      language: "drop-me",
    });
    const classifyKey = classifierWith({ openTabs: "L", deviceId: "L" });
    const { store } = await openStore(
      server,
      storage,
      { classifyKey },
    );
    assert.deepEqual(await store.get("openTabs"), ["tab-1"]);
    assert.equal(await store.get("deviceId"), "dev-1");
    assert.equal(await store.get("language"), "English");
    await store.set("deviceId", "dev-2");
    await store.set("language", "French");
    await store.save();
    assert.equal(server.patchRequests().length, 1);
    const body = server.patchRequests()[0]?.body;
    assert.ok(isRecord(body));
    assert.deepEqual(body["settings"], { language: "French" });
    assert.deepEqual(storage.readDoc("store.json"), {
      openTabs: ["tab-1"],
      deviceId: "dev-2",
    });
    await store.close();
  });

  it("reload re-reads the L document", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    storage.seedDoc("store.json", { openTabs: ["tab-1"] });
    const classifyKey = classifierWith({ openTabs: "L" });
    const { store } = await openStore(server, storage, { classifyKey });
    storage.seedDoc("store.json", { openTabs: ["tab-9"] });
    await store.reload();
    assert.deepEqual(await store.get("openTabs"), ["tab-9"]);
    await store.close();
  });

  it("corrupt L document falls back to empty without throwing", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    storage.seedRaw("store.json", "{not json");
    const classifyKey = classifierWith({ openTabs: "L" });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const { store } = await openStore(server, storage, { classifyKey });
      assert.equal(await store.get("openTabs"), undefined);
      assert.equal(await store.length(), 0);
      assert.equal(warnings.length, 1);
      await store.close();
    } finally {
      console.warn = originalWarn;
    }
  });

  it("quota failure surfaces but does not block the S flush", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const classifyKey = classifierWith({ openTabs: "L" });
    const { store } = await openStore(server, storage, { classifyKey });
    await store.set("openTabs", ["tab-1"]);
    await store.set("language", "English");
    storage.failWrites = true;
    await assert.rejects(
      store.save(),
      (error: unknown) => isWebErrorCode(error, "storage_error"),
    );
    assert.equal(server.patchRequests().length, 1);
    assert.ok(store.pendingCount() >= 1);
    storage.failWrites = false;
    await store.save();
    assert.equal(store.pendingCount(), 0);
    assert.deepEqual(storage.readDoc("store.json"), {
      openTabs: ["tab-1"],
    });
    await store.close();
  });
});

describe("web store: basic semantics", () => {
  it("set is visible without save; save sends one PATCH; second save sends nothing", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("language", "English");
    assert.equal(await store.get("language"), "English");
    assert.equal(server.patchRequests().length, 0);
    await store.save();
    assert.equal(server.patchRequests().length, 1);
    const body = server.patchRequests()[0]?.body;
    assert.ok(isRecord(body));
    assert.deepEqual(body["settings"], { language: "English" });
    assert.equal(body["baseRevision"], 0);
    await store.save();
    assert.equal(server.patchRequests().length, 1);
    await store.close();
  });

  it("save waits for server confirmation", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    let release!: () => void;
    server.patchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store } = await openStore(server, storage);
    await store.set("k", "v");
    let settled = false;
    const pending = store.save().then(() => {
      settled = true;
    });
    await sleep(30);
    assert.equal(settled, false);
    release();
    await pending;
    assert.equal(settled, true);
    assert.equal(server.settings.get("k"), "v");
    await store.close();
  });

  it("deep clones in both directions", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    const written = { nested: { count: 1 } };
    await store.set("obj", written);
    written.nested.count = 99;
    assert.deepEqual(await store.get("obj"), { nested: { count: 1 } });
    const read = (await store.get<{ nested: { count: number } }>("obj")) as {
      nested: { count: number };
    };
    read.nested.count = 42;
    assert.deepEqual(await store.get("obj"), { nested: { count: 1 } });
    await store.close();
  });

  it("has distinguishes stored null; delete returns existence and notifies", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    const seen: Array<[string, unknown]> = [];
    await store.onChange((key, value) => {
      seen.push([key, value]);
    });
    await store.set("nullable", null);
    assert.equal(await store.has("nullable"), true);
    assert.equal(await store.get("nullable"), null);
    assert.equal(await store.has("missing"), false);
    assert.equal(await store.delete("missing"), false);
    await store.set("k", "v");
    assert.equal(await store.delete("k"), true);
    assert.equal(await store.delete("k"), false);
    assert.deepEqual(seen, [
      ["nullable", null],
      ["k", "v"],
      ["k", undefined],
    ]);
    await store.close();
  });

  it("keys, values, entries, and length stay consistent", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("b", 2);
    await store.set("a", 1);
    assert.equal(await store.length(), 2);
    assert.deepEqual([...(await store.keys())].sort(), ["a", "b"]);
    assert.deepEqual([...(await store.values<number>())].sort(), [1, 2]);
    assert.deepEqual(
      new Map(await store.entries<number>()),
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    const keysFirst = await store.keys();
    keysFirst.push("mutated");
    assert.deepEqual([...(await store.keys())].sort(), ["a", "b"]);
    await store.close();
  });

  it("clear and reset empty the store, notify per key, and queue delete-all", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("a", 1);
    await store.set("b", 2);
    const seen: string[] = [];
    await store.onChange((key) => {
      seen.push(key);
    });
    await store.clear();
    assert.equal(await store.length(), 0);
    assert.deepEqual(seen.sort(), ["a", "b"]);
    await store.save();
    const body = server.patchRequests()[0]?.body;
    assert.ok(isRecord(body));
    assert.deepEqual(body["settings"], {
      a: null,
      b: null,
      aiModelList: null,
    });
    await store.set("c", 3);
    await store.reset();
    assert.equal(await store.length(), 0);
    await store.close();
  });

  it("set(key, undefined) throws a validation error and leaves the key unchanged (F1-22 H3, AD-106)", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("k", "v");
    const seen: unknown[] = [];
    await store.onKeyChange("k", (value) => {
      seen.push(value);
    });
    await assert.rejects(
      store.set("k", undefined),
      (error: unknown) =>
        isCapabilityError(error, "invalid_argument", "store.set"),
    );
    assert.equal(await store.get("k"), "v");
    assert.equal(await store.has("k"), true);
    assert.deepEqual(seen, []);
    assert.equal(store.pendingCount(), 1);
    await assert.rejects(
      store.set("never-existed", undefined),
      (error: unknown) =>
        isCapabilityError(error, "invalid_argument", "store.set"),
    );
    assert.equal(await store.has("never-existed"), false);
    assert.equal(store.pendingCount(), 1);
    await store.save();
    const body = server.patchRequests()[0]?.body;
    assert.ok(isRecord(body));
    assert.equal(
      (body["settings"] as Record<string, unknown>)["k"],
      "v",
    );
    await store.close();
  });

  it("reload flushes first, replaces the cache, and fires no listeners", async () => {
    const server = new FakeSettingsServer();
    server.seed({ a: "server-a" }, 1);
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("a", "local-a");
    let calls = 0;
    await store.onChange(() => {
      calls += 1;
    });
    server.settings.set("ext", "new");
    server.revision = 5;
    await store.reload();
    assert.equal(calls, 0);
    assert.equal(await store.get("a"), "local-a");
    assert.equal(await store.get("ext"), "new");
    // Two PATCHes: the first hits the externally bumped revision
    // (409), the retry succeeds. Both precede the reload GET.
    assert.equal(server.patchRequests().length, 2);
    assert.equal(server.getRequests().length, 2);
    const patchIndex = server.requests.findIndex(
      (request) => request.method === "PATCH",
    );
    const secondGetIndex = server.requests.findIndex(
      (request, index) => request.method === "GET" && index > 0,
    );
    assert.ok(patchIndex !== -1 && patchIndex < secondGetIndex);
    await store.close();
  });

  it("reload with a failing refetch throws and leaves the cache unchanged", async () => {
    const server = new FakeSettingsServer();
    server.seed({ k: "v" }, 1);
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    server.failNext = { status: 500, code: "internal_error" };
    await assert.rejects(
      store.reload(),
      (error: unknown) => isWebErrorCode(error, "internal_error"),
    );
    assert.equal(await store.get("k"), "v");
    await store.close();
  });

  it("methods throw after close, second close is a no-op, load gives a fresh handle", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const adapter = createWebStoreAdapter(makeDeps(server, storage));
    const store = await adapter.load("store.json", { autoSave: false });
    await store.set("a", 1);
    await store.close();
    await store.close();
    await assert.rejects(store.get("a"), /closed/);
    await assert.rejects(store.set("b", 2), /closed/);
    assert.equal(await adapter.getStore("store.json"), null);
    assert.equal(server.patchRequests().length, 1);
    const fresh = await adapter.load("store.json", { autoSave: false });
    assert.notEqual(fresh, store);
    assert.equal(await fresh.get("a"), 1);
    await fresh.close();
  });

  it("close with a failing flush throws and the handle stays usable", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("k", "v");
    server.failNext = { status: 500, code: "internal_error" };
    await assert.rejects(store.close(), isStoreWebError);
    assert.equal(await store.get("k"), "v");
    await store.close();
    await assert.rejects(store.get("k"), /closed/);
  });

  it("closeAll closes every handle", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const adapter = createWebStoreAdapter(makeDeps(server, storage));
    const store = await adapter.load("store.json", { autoSave: false });
    await adapter.closeAll();
    await assert.rejects(store.get("x"), /closed/);
  });

  it("listeners: onKeyChange scope, unlisten, throwing listener isolation", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    const seen: unknown[] = [];
    const unlisten = await store.onKeyChange("watched", (value) => {
      seen.push(value);
    });
    await store.set("other", 1);
    await store.set("watched", "first");
    unlisten();
    await store.set("watched", "second");
    assert.deepEqual(seen, ["first"]);
    const seenAll: unknown[] = [];
    await store.onChange(() => {
      throw new Error("listener boom");
    });
    await store.onChange((_key, value) => {
      seenAll.push(value);
    });
    await store.set("k", "v");
    assert.equal(await store.get("k"), "v");
    assert.deepEqual(seenAll, ["v"]);
    await store.close();
  });

  it("handle and adapter expose the full surface plus web extensions", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const adapter = createWebStoreAdapter(makeDeps(server, storage));
    for (const method of ["load", "getStore", "closeAll"]) {
      assert.equal(
        typeof (adapter as unknown as Record<string, unknown>)[method],
        "function",
        method,
      );
    }
    const store = (await adapter.load("store.json", {
      autoSave: false,
    })) as WebStoreHandle;
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
      "pendingCount",
      "lastRevision",
      "lastFlushError",
      "onPersistenceChange",
    ]) {
      assert.equal(
        typeof (store as unknown as Record<string, unknown>)[method],
        "function",
        method,
      );
    }
    await store.close();
  });
});

describe("web store: secret keys are invisible and never sent", () => {
  it("every R-MVP-REJECT key behaves as absent and rejects set", async () => {
    assert.ok(WEB_R_REJECT_KEYS.length >= 18);
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    for (const key of WEB_R_REJECT_KEYS) {
      assert.equal(await store.get(key), undefined, key);
      assert.equal(await store.has(key), false, key);
      assert.equal(await store.delete(key), false, key);
      await assert.rejects(
        store.set(key, { canary: true }),
        (error: unknown) =>
          isCapabilityError(error, "unavailable", "store.setSecretKey"),
        key,
      );
    }
    assert.equal(await store.length(), 0);
    assert.deepEqual(await store.keys(), []);
    await store.save();
    assert.equal(server.patchRequests().length, 0);
    await store.close();
  });

  it("pattern keys are rejected", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    for (const key of [
      "myApiKey",
      "giteeAccessToken",
      "dbPassword",
      "someSecretValue",
      "authToken",
      "myCredential",
      "accessKeyId",
      "apiKey",
      "customSecretToken",
    ]) {
      await assert.rejects(
        store.set(key, CANARY),
        (error: unknown) =>
          isCapabilityError(error, "unavailable", "store.setSecretKey"),
        key,
      );
      assert.equal(await store.get(key), undefined, key);
    }
    assert.equal(await store.length(), 0);
    await store.close();
  });

  it("colon-scoped variants inherit the base classification", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await assert.rejects(
      store.set("s3SyncConfig:work", {}),
      PlatformCapabilityError,
    );
    await assert.rejects(
      store.set("aiModelList:work", []),
      PlatformCapabilityError,
    );
    assert.equal(await store.get("s3SyncConfig:work"), undefined);
    await store.close();
  });

  it("R keys arriving in the server document are filtered from the cache", async () => {
    const server = new FakeSettingsServer();
    server.seed({ apiKey: "server-secret", language: "English" }, 1);
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    assert.equal(await store.get("apiKey"), undefined);
    assert.deepEqual(await store.keys(), ["language"]);
    assert.equal(JSON.stringify(await store.entries()).includes("server-secret"), false);
    await store.close();
  });

  it("aiModelList is split: metadata via PATCH, secrets via PUT, never in cache", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("aiModelList", [
      {
        key: "provider-a",
        title: "Provider A",
        baseURL: "https://api.example.com/v1",
        apiKey: CANARY,
        webSearchApiKey: CANARY,
        webSearchApiKeys: { web: CANARY },
        customHeaders: { Authorization: `Bearer ${CANARY}` },
        models: [{ id: "model-1" }],
      },
    ]);
    const read = await store.get<Array<Record<string, unknown>>>("aiModelList");
    assert.ok(read);
    assert.equal(read.length, 1);
    const entry = read[0] as Record<string, unknown>;
    assert.equal(entry["key"], "provider-a");
    assert.equal(entry["title"], "Provider A");
    assert.equal("apiKey" in entry, false);
    assert.equal("webSearchApiKey" in entry, false);
    assert.equal("webSearchApiKeys" in entry, false);
    assert.equal("customHeaders" in entry, false);
    assert.equal("hasApiKey" in entry, false);
    assert.equal(JSON.stringify(await store.entries()).includes(CANARY), false);
    await store.save();
    assert.equal(server.patchRequests().length, 1);
    assert.equal(server.putRequests().length, 1);
    const patchBody = server.patchRequests()[0]?.body;
    assert.ok(isRecord(patchBody));
    assert.equal(JSON.stringify(patchBody).includes(CANARY), false);
    const patchIndex = server.requests.findIndex(
      (request) => request.method === "PATCH",
    );
    const putIndex = server.requests.findIndex(
      (request) => request.method === "PUT",
    );
    assert.ok(patchIndex !== -1 && patchIndex < putIndex);
    const putBody = server.putRequests()[0]?.body;
    assert.ok(isRecord(putBody));
    assert.deepEqual(putBody["providers"], [
      {
        providerKey: "provider-a",
        apiKey: CANARY,
        webSearchApiKey: CANARY,
        webSearchApiKeys: { web: CANARY },
        customHeaders: { Authorization: `Bearer ${CANARY}` },
      },
    ]);
    assert.deepEqual(server.secrets.get("provider-a"), {
      apiKey: CANARY,
      webSearchApiKey: CANARY,
      webSearchApiKeys: { web: CANARY },
      customHeaders: { Authorization: `Bearer ${CANARY}` },
    });
    assert.equal(JSON.stringify(storage.readDoc("store.json") ?? {}).includes(CANARY), false);
    await store.close();
  });

  it("aiModelList entries without a provider key drop their secret patch", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("aiModelList", [{ title: "No key", apiKey: CANARY }]);
    const read = await store.get<Array<Record<string, unknown>>>("aiModelList");
    assert.equal("apiKey" in (read?.[0] as Record<string, unknown>), false);
    await store.save();
    assert.equal(server.patchRequests().length, 1);
    assert.equal(server.putRequests().length, 0);
    await store.close();
  });

  it("removing a provider drops its pending secrets; the server cascade deletes stored ones", async () => {
    const server = new FakeSettingsServer();
    server.seed(
      {
        aiModelList: [
          { key: "pa", title: "A", hasApiKey: true, updatedAt: 1 },
        ],
      },
      1,
    );
    server.secrets.set("pa", { apiKey: CANARY });
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("aiModelList", [
      { key: "pb", title: "B", apiKey: CANARY },
    ]);
    await store.set("aiModelList", []);
    await store.save();
    assert.equal(server.putRequests().length, 0);
    assert.equal(server.secrets.size, 0);
    await store.close();
  });

  it("non-array aiModelList passes through without splitting", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("aiModelList", "not-an-array");
    assert.equal(await store.get("aiModelList"), "not-an-array");
    await store.save();
    assert.equal(server.putRequests().length, 0);
    const body = server.patchRequests()[0]?.body;
    assert.ok(isRecord(body));
    assert.equal(
      (body["settings"] as Record<string, unknown>)["aiModelList"],
      "not-an-array",
    );
    await store.close();
  });
});

describe("web store: queue, flush, and revision guard", () => {
  it("writes coalesce per key; one PATCH carries the last value", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("a", 1);
    await store.set("a", 2);
    await store.set("b", "x");
    await store.delete("b");
    await store.set("c", "keep");
    await store.save();
    assert.equal(server.patchRequests().length, 1);
    const body = server.patchRequests()[0]?.body;
    assert.ok(isRecord(body));
    assert.deepEqual(body["settings"], { a: 2, b: null, c: "keep" });
    assert.equal(body["baseRevision"], 0);
    await store.close();
  });

  it("409 merges once: local pending wins, server changes arrive, listeners fire", async () => {
    const server = new FakeSettingsServer();
    server.seed({ a: "server-a", b: 1 }, 7);
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("a", "local-a");
    server.settings.set("b", 2);
    server.revision = 8;
    const seen: Array<[string, unknown]> = [];
    await store.onChange((key, value) => {
      seen.push([key, value]);
    });
    await store.save();
    assert.equal(await store.get("a"), "local-a");
    assert.equal(await store.get("b"), 2);
    assert.deepEqual(seen, [["b", 2]]);
    assert.equal(server.patchRequests().length, 2);
    const firstKey = server.patchRequests()[0]?.headers["Idempotency-Key"];
    const secondKey = server.patchRequests()[1]?.headers["Idempotency-Key"];
    assert.ok(typeof firstKey === "string" && firstKey.length > 0);
    assert.equal(firstKey, secondKey);
    assert.equal(store.lastRevision(), 9);
    await store.close();
  });

  it("a second 409 throws, keeps the queue, and a later save succeeds", async () => {
    const server = new FakeSettingsServer();
    server.conflictCountdown = 2;
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("k", "v");
    await assert.rejects(
      store.save(),
      (error: unknown) => isWebErrorCode(error, "revision_conflict"),
    );
    assert.equal(store.pendingCount(), 1);
    assert.equal(await store.get("k"), "v");
    await store.save();
    assert.equal(store.pendingCount(), 0);
    assert.equal(server.settings.get("k"), "v");
    await store.close();
  });

  it("rejected keys roll back to server values and fire listeners", async () => {
    const server = new FakeSettingsServer();
    server.seed({ openTabs: "server-tabs", language: "English" }, 4);
    server.rejectKeys.set("openTabs", "local_only");
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("openTabs", "local-tabs");
    await store.set("language", "French");
    const seen: Array<[string, unknown]> = [];
    await store.onChange((key, value) => {
      seen.push([key, value]);
    });
    await store.save();
    assert.equal(await store.get("openTabs"), "server-tabs");
    assert.equal(await store.get("language"), "French");
    assert.deepEqual(seen, [["openTabs", "server-tabs"]]);
    assert.equal(store.pendingCount(), 0);
    assert.equal(store.lastRevision(), 5);
    await store.close();
  });

  it("network failure keeps the queue; retry succeeds; lastFlushError tracks it", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("k", "v");
    server.failNetwork = true;
    await assert.rejects(
      store.save(),
      (error: unknown) => isWebErrorCode(error, "network_error"),
    );
    assert.equal(store.pendingCount(), 1);
    assert.ok(store.lastFlushError() instanceof Error);
    server.failNetwork = false;
    await store.save();
    assert.equal(store.pendingCount(), 0);
    assert.equal(store.lastFlushError(), null);
    await store.close();
  });

  it("a failed secret PUT keeps only the secret queue; metadata stays applied", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("aiModelList", [
      { key: "pa", title: "A", apiKey: CANARY },
    ]);
    server.failPutOnce = true;
    await assert.rejects(store.save(), isStoreWebError);
    assert.equal(server.patchRequests().length, 1);
    assert.equal(server.putRequests().length, 1);
    assert.equal(store.pendingCount(), 1);
    await store.save();
    assert.equal(server.patchRequests().length, 1);
    assert.equal(server.putRequests().length, 2);
    assert.equal(store.pendingCount(), 0);
    assert.equal(server.secrets.get("pa")?.["apiKey"], CANARY);
    await store.close();
  });

  it("401 and malformed envelopes surface as typed errors", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("k", "v");
    server.failNext = { status: 401, code: "unauthenticated" };
    await assert.rejects(
      store.save(),
      (error: unknown) => isWebErrorCode(error, "unauthenticated"),
    );
    server.malformedNext = true;
    await assert.rejects(
      store.save(),
      (error: unknown) => isWebErrorCode(error, "invalid_response"),
    );
    await store.save();
    await store.close();
  });

  it("mutations carry CSRF and credentials; reads carry no CSRF header", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage, {
      getCsrfToken: () => "CSRF-TOKEN-TEST",
    });
    await store.set("k", "v");
    await store.save();
    for (const request of server.requests) {
      assert.equal(request.credentials, "same-origin", request.method);
    }
    assert.equal(server.getRequests()[0]?.headers["X-CSRF-Token"], undefined);
    assert.equal(
      server.patchRequests()[0]?.headers["X-CSRF-Token"],
      "CSRF-TOKEN-TEST",
    );
    assert.ok(
      typeof server.patchRequests()[0]?.headers["Idempotency-Key"] === "string",
    );
    await store.close();
  });

  it("queue bound flushes before accepting more entries", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    for (let i = 0; i < 501; i++) {
      await store.set(`key-${i}`, i);
    }
    assert.ok(server.patchRequests().length >= 1);
    await store.save();
    assert.equal(server.patchRequests().length, 2);
    assert.equal(server.settings.size, 501);
    await store.close();
  });
});

describe("web store: UNKNOWN keys and persistence extensions", () => {
  it("UNKNOWN reads are tolerant; UNKNOWN writes throw and leave the cache", async () => {
    const server = new FakeSettingsServer();
    server.seed({ mysteryKey: "server-value", language: "English" }, 1);
    const storage = new FakeStorage();
    const classifyKey = classifierWith({ mysteryKey: "UNKNOWN" });
    const { store } = await openStore(server, storage, { classifyKey });
    assert.equal(await store.get("mysteryKey"), "server-value");
    assert.equal(await store.has("mysteryKey"), true);
    await assert.rejects(
      store.set("mysteryKey", "new"),
      (error: unknown) =>
        isCapabilityError(error, "invalid_argument", "store.setUnknownKey"),
    );
    await assert.rejects(
      store.delete("mysteryKey"),
      (error: unknown) =>
        isCapabilityError(error, "invalid_argument", "store.deleteUnknownKey"),
    );
    assert.equal(await store.get("mysteryKey"), "server-value");
    await store.close();
  });

  it("persistence state moves dirty, flushing, clean, and reports errors", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    const states: string[] = [];
    store.onPersistenceChange((state) => {
      states.push(state.status);
    });
    assert.equal(store.pendingCount(), 0);
    assert.equal(store.lastRevision(), 0);
    await store.set("k", "v");
    assert.equal(store.pendingCount(), 1);
    await store.save();
    assert.deepEqual(states, ["dirty", "flushing", "clean"]);
    server.failNext = { status: 500, code: "internal_error" };
    await store.set("k2", "v2");
    await assert.rejects(store.save(), isStoreWebError);
    assert.ok(states.includes("error"));
    assert.ok(store.lastFlushError() instanceof Error);
    await store.save();
    assert.equal(states[states.length - 1], "clean");
    assert.equal(store.lastFlushError(), null);
    await store.close();
  });

  it("autoSave false sends no background flush; default autoSave flushes in the background", async () => {
    const server = new FakeSettingsServer();
    const storage = new FakeStorage();
    const { store } = await openStore(server, storage);
    await store.set("k", "v");
    await sleep(30);
    assert.equal(server.patchRequests().length, 0);
    await store.close();

    const server2 = new FakeSettingsServer();
    const storage2 = new FakeStorage();
    const adapter2 = createWebStoreAdapter(
      makeDeps(server2, storage2, { coalesceMs: 5 }),
    );
    const store2 = (await adapter2.load("store.json")) as WebStoreHandle;
    await store2.set("k", "v");
    await waitFor(() => server2.patchRequests().length === 1, "background flush");
    await store2.close();
  });
});

describe("web store: cross-tab broadcast", () => {
  it("a flush in one tab refreshes the other tab and fires listeners, without values on the channel", async () => {
    const server = new FakeSettingsServer();
    const storageA = new FakeStorage();
    const storageB = new FakeStorage();
    const adapterA = createWebStoreAdapter(
      makeDeps(server, storageA, {
        broadcastChannelImpl: FakeBroadcastChannel,
      }),
    );
    const adapterB = createWebStoreAdapter(
      makeDeps(server, storageB, {
        broadcastChannelImpl: FakeBroadcastChannel,
      }),
    );
    const storeA = await adapterA.load("store.json", { autoSave: false });
    const storeB = await adapterB.load("store.json", { autoSave: false });
    const seen: Array<[string, unknown]> = [];
    await storeB.onChange((key, value) => {
      seen.push([key, value]);
    });
    await storeA.set("shared", "CANARY-BROADCAST-VALUE-1");
    await storeA.save();
    for (let i = 0; i < 50; i++) {
      if ((await storeB.get("shared")) === "CANARY-BROADCAST-VALUE-1") {
        break;
      }
      await sleep(10);
    }
    assert.equal(await storeB.get("shared"), "CANARY-BROADCAST-VALUE-1");
    assert.deepEqual(seen, [["shared", "CANARY-BROADCAST-VALUE-1"]]);
    assert.ok(FakeBroadcastChannel.posted.length >= 1);
    assert.equal(
      JSON.stringify(FakeBroadcastChannel.posted).includes(
        "CANARY-BROADCAST-VALUE-1",
      ),
      false,
    );
    await storeA.close();
    await storeB.close();
  });

  it("a dirty tab ignores broadcast refresh until its own writes flush", async () => {
    const server = new FakeSettingsServer();
    const storageA = new FakeStorage();
    const storageB = new FakeStorage();
    const adapterA = createWebStoreAdapter(
      makeDeps(server, storageA, {
        broadcastChannelImpl: FakeBroadcastChannel,
      }),
    );
    const adapterB = createWebStoreAdapter(
      makeDeps(server, storageB, {
        broadcastChannelImpl: FakeBroadcastChannel,
      }),
    );
    const storeA = await adapterA.load("store.json", { autoSave: false });
    const storeB = await adapterB.load("store.json", { autoSave: false });
    await storeB.set("own", "pending");
    await storeA.set("shared", "from-a");
    await storeA.save();
    await sleep(30);
    assert.equal(await storeB.get("shared"), undefined);
    await storeB.save();
    await storeA.close();
    await storeB.close();
  });
});
