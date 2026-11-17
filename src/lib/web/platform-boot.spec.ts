// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Behavior tests for web platform boot (platform-boot.ts, N-5).
 *
 * Runner: node:test with node:assert/strict, over an esbuild bundle,
 * following the repo convention for adapter specs. From the repo
 * root, after `pnpm install`:
 *
 *   ./node_modules/.bin/esbuild src/lib/web/platform-boot.spec.ts --bundle --platform=node --format=esm --outfile=/tmp/platform-boot.spec.mjs
 *   node --test --test-force-exit /tmp/platform-boot.spec.mjs
 *
 * The --test-force-exit flag is required: registration constructs
 * the event adapter, which opens a BroadcastChannel that keeps the
 * node event loop alive after the tests finish. The flag only ends
 * the runner process; it does not skip or weaken any test.
 *
 * What this spec pins: in web mode the boot call runs the POC
 * cleanup before registration and freezes the registry with the
 * store and sql adapters registered; during SSR (no window) and
 * inside the Tauri shell it does nothing; repeated calls keep the
 * same instances; and each CSRF provider returns null instead of
 * throwing when the token fetch fails. The browser ordering
 * guarantee (root layout module evaluation precedes all effects)
 * is not provable in node and stays a merge-gate browser check.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { __setTauriInternalsForTests } from "../platform/detect";
import {
  getPlatformAdapter,
  hasAdapter,
  isRegistryFrozen,
  __resetPlatformForTests,
} from "../platform/registry";
import {
  POC_STORAGE_PREFIX,
  __resetPocCleanupOnceForTests,
  type PocCleanupStorage,
} from "../platform/store/poc-cleanup";
import {
  ensureWebPlatformInitialized,
  getSqlCsrfTokenFromSharedSeam,
  getStoreCsrfTokenFromSharedSeam,
} from "./platform-boot";

class FakeStorage implements PocCleanupStorage {
  private readonly entries: Array<[string, string]> = [];
  /** Registry frozen state observed inside each removal. */
  readonly frozenDuringRemoval: boolean[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.entries.push([key, value]);
    }
  }

  get length(): number {
    return this.entries.length;
  }

  key(index: number): string | null {
    return this.entries[index]?.[0] ?? null;
  }

  removeItem(key: string): void {
    this.frozenDuringRemoval.push(isRegistryFrozen());
    const at = this.entries.findIndex(([name]) => name === key);
    if (at >= 0) {
      this.entries.splice(at, 1);
    }
  }

  has(key: string): boolean {
    return this.entries.some(([name]) => name === key);
  }
}

function globals(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

function setWebGlobals(storage: FakeStorage): void {
  globals()["window"] = {};
  globals()["localStorage"] = storage;
}

beforeEach(() => {
  __resetPlatformForTests();
  __resetPocCleanupOnceForTests();
  __setTauriInternalsForTests(false);
  delete globals()["window"];
  delete globals()["localStorage"];
});

describe("ensureWebPlatformInitialized", () => {
  test("runs cleanup and registers the platform in web mode", () => {
    const storage = new FakeStorage({
      [`${POC_STORAGE_PREFIX}store.json`]: "dummy",
      "keep-me": "dummy",
    });
    setWebGlobals(storage);
    ensureWebPlatformInitialized();
    assert.equal(storage.has(`${POC_STORAGE_PREFIX}store.json`), false);
    assert.equal(storage.has("keep-me"), true);
    assert.equal(isRegistryFrozen(), true);
    assert.equal(hasAdapter("store"), true);
    assert.equal(typeof getPlatformAdapter("store").load, "function");
    assert.equal(hasAdapter("sql"), true);
    assert.equal(getPlatformAdapter("sql").mode, "web");
    assert.equal(typeof getPlatformAdapter("sql").ready, "function");
  });

  test("cleanup runs before registration", () => {
    const storage = new FakeStorage({
      [`${POC_STORAGE_PREFIX}store.json`]: "dummy",
    });
    setWebGlobals(storage);
    ensureWebPlatformInitialized();
    assert.deepEqual(storage.frozenDuringRemoval, [false]);
    assert.equal(isRegistryFrozen(), true);
  });

  test("does nothing during SSR (no window)", () => {
    const storage = new FakeStorage({
      [`${POC_STORAGE_PREFIX}store.json`]: "dummy",
    });
    globals()["localStorage"] = storage;
    assert.equal(typeof globals()["window"], "undefined");
    ensureWebPlatformInitialized();
    assert.equal(storage.has(`${POC_STORAGE_PREFIX}store.json`), true);
    assert.equal(isRegistryFrozen(), false);
    assert.equal(hasAdapter("store"), false);
  });

  test("does nothing inside the Tauri shell", () => {
    const storage = new FakeStorage({
      [`${POC_STORAGE_PREFIX}store.json`]: "dummy",
    });
    setWebGlobals(storage);
    __setTauriInternalsForTests(true);
    ensureWebPlatformInitialized();
    assert.equal(storage.has(`${POC_STORAGE_PREFIX}store.json`), true);
    assert.equal(isRegistryFrozen(), false);
    assert.equal(hasAdapter("store"), false);
  });

  test("repeated calls keep the same instances", () => {
    const storage = new FakeStorage({});
    setWebGlobals(storage);
    ensureWebPlatformInitialized();
    const first = getPlatformAdapter("store");
    ensureWebPlatformInitialized();
    assert.equal(getPlatformAdapter("store"), first);
    assert.equal(isRegistryFrozen(), true);
  });
});

describe("getStoreCsrfTokenFromSharedSeam", () => {
  test("returns null instead of throwing when the fetch fails", async () => {
    const savedFetch = globals()["fetch"];
    globals()["fetch"] = async () => {
      throw new Error("network down");
    };
    try {
      assert.equal(await getStoreCsrfTokenFromSharedSeam(), null);
    } finally {
      globals()["fetch"] = savedFetch;
    }
  });
});

describe("getSqlCsrfTokenFromSharedSeam", () => {
  test("returns null instead of throwing when the fetch fails", async () => {
    const savedFetch = globals()["fetch"];
    globals()["fetch"] = async () => {
      throw new Error("network down");
    };
    try {
      assert.equal(await getSqlCsrfTokenFromSharedSeam(), null);
    } finally {
      globals()["fetch"] = savedFetch;
    }
  });
});
