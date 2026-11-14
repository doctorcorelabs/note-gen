// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Behavior tests for the in-memory fake store (store.fake.ts).
 *
 * Runner: node:test with node:assert/strict, the pattern the repo
 * already uses for its existing .mjs specs. Vitest is the planned
 * harness in desain-pengujian, but it is not installed in this repo
 * yet (no vitest dependency, no vitest config at a28fd02), and adding
 * a test framework is outside this task. When the Vitest contract
 * suite lands, these cases map to the fake column of CT-03, CT-04,
 * CT-09, CT-17, and the serializer part of CT-22 in
 * desain-store-adapter.md section 8; the fake itself is reused
 * unchanged by that suite.
 *
 * How to run (no new dependency): bundle with the installed esbuild,
 * then run the bundle under node:test:
 *
 *   node_modules/.bin/esbuild src/lib/platform/store/store.fake.spec.ts \
 *     --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert \
 *     --outfile=/tmp/store.fake.spec.mjs
 *   node --test /tmp/store.fake.spec.mjs
 *
 * The bundle step exists because the sources use extensionless
 * imports (repo convention, bundler module resolution), which Node
 * type stripping cannot resolve directly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlatformCapabilityError } from "../errors";
import { createLazyStore, type StoreAdapter } from "./interface";
import {
  classifyFakeKey,
  createFakeStoreAdapter,
  R_MVP_REJECT_KEYS,
} from "./store.fake";

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

describe("fake store: basic semantics (CT-03)", () => {
  it("getStore returns null before load, load caches one handle per file", async () => {
    const adapter = createFakeStoreAdapter();
    assert.equal(await adapter.getStore("store.json"), null);
    const first = await adapter.load("store.json");
    const second = await adapter.load("store.json");
    assert.equal(first, second);
    assert.equal(await adapter.getStore("store.json"), first);
    assert.equal(first.path, "store.json");
  });

  it("get on a missing key returns undefined and never throws", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    assert.equal(await store.get("never-set"), undefined);
    assert.equal(await store.has("never-set"), false);
  });

  it("set is visible to get without save, and save resolves", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    await store.set("language", "English");
    assert.equal(await store.get("language"), "English");
    await store.save();
    assert.equal(await store.get("language"), "English");
  });

  it("deep clones in both directions", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    const written = { nested: { count: 1 } };
    await store.set("obj", written);
    written.nested.count = 99;
    assert.equal((await store.get<{ nested: { count: number } }>("obj"))?.nested.count, 1);
    const read = await store.get<{ nested: { count: number } }>("obj");
    assert.ok(read);
    read.nested.count = 42;
    assert.equal((await store.get<{ nested: { count: number } }>("obj"))?.nested.count, 1);
  });

  it("has distinguishes a stored null from a missing key", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    await store.set("nullable", null);
    assert.equal(await store.has("nullable"), true);
    assert.equal(await store.get("nullable"), null);
    assert.equal(await store.has("missing"), false);
  });

  it("delete returns whether the key existed and fires undefined", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    const seen: Array<[string, unknown]> = [];
    await store.onChange((key, value) => {
      seen.push([key, value]);
    });
    await store.set("k", "v");
    assert.equal(await store.delete("k"), true);
    assert.equal(await store.delete("k"), false);
    assert.deepEqual(seen, [
      ["k", "v"],
      ["k", undefined],
    ]);
  });

  it("keys, values, entries, and length stay consistent as sets", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    await store.set("b", 2);
    await store.set("a", 1);
    assert.equal(await store.length(), 2);
    assert.deepEqual([...(await store.keys())].sort(), ["a", "b"]);
    assert.deepEqual([...(await store.values<number>())].sort(), [1, 2]);
    const entries = await store.entries<number>();
    assert.deepEqual(
      entries.map(([key]) => key).sort(),
      ["a", "b"],
    );
    assert.deepEqual(
      new Map(entries),
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    const keysFirst = await store.keys();
    keysFirst.push("mutated");
    assert.deepEqual([...(await store.keys())].sort(), ["a", "b"]);
  });

  it("clear and reset empty the store and notify per key", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    await store.set("a", 1);
    await store.set("b", 2);
    const seen: string[] = [];
    await store.onChange((key) => {
      seen.push(key);
    });
    await store.clear();
    assert.equal(await store.length(), 0);
    assert.deepEqual(seen.sort(), ["a", "b"]);
    await store.set("c", 3);
    await store.reset();
    assert.equal(await store.length(), 0);
    assert.equal(await store.get("c"), undefined);
  });

  it("reload does not fire listeners", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    await store.set("a", 1);
    let calls = 0;
    await store.onChange(() => {
      calls += 1;
    });
    await store.reload();
    assert.equal(calls, 0);
    assert.equal(await store.get("a"), 1);
  });

  it("methods throw after close, second close is a no-op, load gives a fresh handle", async () => {
    const adapter = createFakeStoreAdapter();
    const store = await adapter.load("store.json");
    await store.set("a", 1);
    await store.close();
    await store.close();
    await assert.rejects(store.get("a"), /closed/);
    await assert.rejects(store.set("b", 2), /closed/);
    assert.equal(await adapter.getStore("store.json"), null);
    const fresh = await adapter.load("store.json");
    assert.notEqual(fresh, store);
    assert.equal(await fresh.get("a"), undefined);
  });

  it("closeAll closes every handle", async () => {
    const adapter = createFakeStoreAdapter();
    const store = await adapter.load("store.json");
    await adapter.closeAll();
    await assert.rejects(store.get("x"), /closed/);
  });

  it("two adapters do not share state", async () => {
    const a = await createFakeStoreAdapter().load("store.json");
    const b = await createFakeStoreAdapter().load("store.json");
    await a.set("k", "from-a");
    assert.equal(await b.get("k"), undefined);
  });
});

describe("fake store: listeners", () => {
  it("onKeyChange only fires for its key, unlisten stops delivery", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    const seen: unknown[] = [];
    const unlisten = await store.onKeyChange("watched", (value) => {
      seen.push(value);
    });
    await store.set("other", 1);
    await store.set("watched", "first");
    unlisten();
    await store.set("watched", "second");
    assert.deepEqual(seen, ["first"]);
  });

  it("a throwing listener does not break set or other listeners", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    const seen: unknown[] = [];
    await store.onChange(() => {
      throw new Error("listener boom");
    });
    await store.onChange((_key, value) => {
      seen.push(value);
    });
    await store.set("k", "v");
    assert.equal(await store.get("k"), "v");
    assert.deepEqual(seen, ["v"]);
  });
});

describe("fake store: F1-22 temporary behavior (CT-02, verdict pending)", () => {
  it("set(key, undefined) deletes an existing key and notifies", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    await store.set("k", "v");
    const seen: unknown[] = [];
    await store.onKeyChange("k", (value) => {
      seen.push(value);
    });
    await store.set("k", undefined);
    assert.equal(await store.get("k"), undefined);
    assert.equal(await store.has("k"), false);
    assert.deepEqual(seen, [undefined]);
  });

  it("set(key, undefined) on a missing key resolves without creating it", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    await store.set("missing", undefined);
    assert.equal(await store.has("missing"), false);
    assert.equal(await store.length(), 0);
  });
});

describe("fake store: secret keys are invisible, reject writes (CT-09)", () => {
  it("every R-MVP-REJECT key behaves as absent and rejects set", async () => {
    assert.ok(R_MVP_REJECT_KEYS.length >= 18);
    const store = await createFakeStoreAdapter().load("store.json");
    for (const key of R_MVP_REJECT_KEYS) {
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
    assert.deepEqual(await store.entries(), []);
    assert.deepEqual(await store.values(), []);
  });

  it("pattern keys (apiKey, token, password, secret, credential) are rejected", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    const patternKeys = [
      "myApiKey",
      "giteeAccessToken",
      "dbPassword",
      "someSecretValue",
      "authToken",
      "myCredential",
      "accessKeyId",
    ];
    for (const key of patternKeys) {
      assert.equal(classifyFakeKey(key), "rejected-secret", key);
      await assert.rejects(
        store.set(key, "CANARY-VALUE"),
        (error: unknown) =>
          isCapabilityError(error, "unavailable", "store.setSecretKey"),
        key,
      );
      assert.equal(await store.get(key), undefined, key);
    }
    assert.equal(await store.length(), 0);
  });

  it("colon-scoped variants inherit the base classification", async () => {
    assert.equal(classifyFakeKey("s3SyncConfig:work"), "rejected-secret");
    assert.equal(classifyFakeKey("aiModelList:work"), "rejected-secret");
    const store = await createFakeStoreAdapter().load("store.json");
    await assert.rejects(store.set("s3SyncConfig:work", {}), PlatformCapabilityError);
  });

  it("aiModelList entries are stored with secret fields stripped", async () => {
    const store = await createFakeStoreAdapter().load("store.json");
    const canary = "CANARY-SECRET-7f3a9c";
    await store.set("aiModelList", [
      {
        key: "provider-a",
        title: "Provider A",
        baseURL: "https://api.example.com/v1",
        apiKey: canary,
        webSearchApiKey: canary,
        webSearchApiKeys: { web: canary },
        customHeaders: { Authorization: `Bearer ${canary}` },
        models: [{ id: "model-1" }],
      },
    ]);
    const read = await store.get<Array<Record<string, unknown>>>("aiModelList");
    assert.ok(read);
    assert.equal(read.length, 1);
    const entry = read[0] as Record<string, unknown>;
    assert.equal(entry["key"], "provider-a");
    assert.equal(entry["title"], "Provider A");
    assert.equal(entry["baseURL"], "https://api.example.com/v1");
    assert.equal("apiKey" in entry, false);
    assert.equal("webSearchApiKey" in entry, false);
    assert.equal("webSearchApiKeys" in entry, false);
    assert.equal("customHeaders" in entry, false);
    assert.equal(JSON.stringify(await store.entries()).includes(canary), false);
    assert.equal(JSON.stringify(await store.values()).includes(canary), false);
  });
});

describe("fake store: file routing and options (CT-17, CT-22)", () => {
  it("load throws for removed and unknown file names, getStore stays null", async () => {
    const adapter = createFakeStoreAdapter();
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
  });

  it("custom serializer options throw", async () => {
    const adapter = createFakeStoreAdapter();
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

  it("createNew empties an existing handle, plain reload keeps data", async () => {
    const adapter = createFakeStoreAdapter();
    const first = await adapter.load("store.json");
    await first.set("k", "v");
    const kept = await adapter.load("store.json");
    assert.equal(await kept.get("k"), "v");
    const emptied = await adapter.load("store.json", { createNew: true });
    assert.equal(emptied, first);
    assert.equal(await emptied.get("k"), undefined);
  });
});

describe("fake store: surface parity (CT-01 subset) and lazy store (CT-04)", () => {
  it("handle and adapter expose the full interface surface", async () => {
    const adapter = createFakeStoreAdapter();
    for (const method of ["load", "getStore", "closeAll"]) {
      assert.equal(typeof (adapter as unknown as Record<string, unknown>)[method], "function", method);
    }
    const store = await adapter.load("store.json");
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
      assert.equal(typeof (store as unknown as Record<string, unknown>)[method], "function", method);
    }
  });

  it("createLazyStore defers load until the first method call", async () => {
    let loads = 0;
    const inner = createFakeStoreAdapter();
    const counting: StoreAdapter = {
      load: async (...args: Parameters<StoreAdapter["load"]>) => {
        loads += 1;
        return inner.load(...args);
      },
      getStore: (...args: Parameters<StoreAdapter["getStore"]>) =>
        inner.getStore(...args),
      closeAll: () => inner.closeAll(),
    };
    const lazy = createLazyStore(counting, "store.json");
    assert.equal(lazy.path, "store.json");
    assert.equal(loads, 0);
    await lazy.set("k", "v");
    assert.equal(loads, 1);
    assert.equal(await lazy.get("k"), "v");
    assert.equal(loads, 1);
    const direct = await inner.getStore("store.json");
    assert.ok(direct);
    assert.equal(await direct.get("k"), "v");
  });
});
