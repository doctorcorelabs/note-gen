// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Behavior tests for POC key cleanup (poc-cleanup.ts, CT-16).
 *
 * Runner: node:test with node:assert/strict, the pattern the repo
 * already uses for its colocated specs (see key-schema.spec.ts).
 * Bundle with the installed esbuild, then run the bundle under
 * node:test:
 *
 *   node_modules/.bin/esbuild src/lib/platform/store/poc-cleanup.spec.ts \
 *     --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert --external:node:assert/strict \
 *     --outfile=/tmp/poc-cleanup.spec.mjs
 *   node --test /tmp/poc-cleanup.spec.mjs
 *
 * What this spec pins (V1-02 section 6.2, the six cleanup items):
 * exact-prefix removal, values never read, the new device-local
 * prefix and unrelated keys untouched, once-per-boot semantics,
 * count-only logging, and never-throw behavior on unavailable or
 * throwing storage. The POC prefix literal appears nowhere in this
 * file: keys are built from the exported constant, so gate G2 keeps
 * exactly one literal in the module plus this test file's import.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  POC_STORAGE_PREFIX,
  __resetPocCleanupOnceForTests,
  runPocCleanup,
  runPocCleanupOnce,
  type PocCleanupStorage,
} from "./poc-cleanup";
import { WEB_LOCAL_STORAGE_PREFIX } from "./store.web";

/**
 * Storage fake with live-index semantics like the DOM Storage: keys
 * shift when an entry is removed, so a forward scan that removes as
 * it goes would skip entries. The read method exists only to prove
 * cleanup never calls it.
 */
class FakeStorage implements PocCleanupStorage {
  private readonly entries: Array<[string, string]> = [];
  readonly readCalls: string[] = [];
  readonly removedKeys: string[] = [];

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
    const at = this.entries.findIndex(([name]) => name === key);
    if (at >= 0) {
      this.entries.splice(at, 1);
      this.removedKeys.push(key);
    }
  }

  getItem(key: string): string | null {
    this.readCalls.push(key);
    return this.entries.find(([name]) => name === key)?.[1] ?? null;
  }

  setItem(key: string, value: string): void {
    const at = this.entries.findIndex(([name]) => name === key);
    if (at >= 0) {
      this.entries[at] = [key, value];
    } else {
      this.entries.push([key, value]);
    }
  }

  keys(): string[] {
    return this.entries.map(([name]) => name);
  }

  has(key: string): boolean {
    return this.entries.some(([name]) => name === key);
  }
}

function pocKey(suffix: string): string {
  return `${POC_STORAGE_PREFIX}${suffix}`;
}

function captureInfo(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.info = original;
    },
  };
}

beforeEach(() => {
  __resetPocCleanupOnceForTests();
});

describe("CT-16: POC cleanup", () => {
  test("removes every key under the POC prefix and returns the count", () => {
    const storage = new FakeStorage({
      [pocKey("store.json")]: '{"sentinel":"poc-persist-1"}',
      [pocKey("other.json")]: '{"sentinel":"poc-persist-2"}',
      [pocKey("nested:doc")]: "dummy",
    });
    assert.equal(runPocCleanup(storage), 3);
    assert.deepEqual(storage.keys(), []);
    assert.deepEqual(
      [...storage.removedKeys].sort(),
      [pocKey("nested:doc"), pocKey("other.json"), pocKey("store.json")].sort(),
    );
  });

  test("leaves the new device-local prefix and unrelated keys untouched", () => {
    const storage = new FakeStorage({
      [pocKey("store.json")]: "dummy",
      [`${WEB_LOCAL_STORAGE_PREFIX}store.json`]: '{"language":"en"}',
      "unrelated-key": "keep-me",
      "notegen-settings": "keep-me-too",
    });
    assert.equal(runPocCleanup(storage), 1);
    assert.equal(storage.has(`${WEB_LOCAL_STORAGE_PREFIX}store.json`), true);
    assert.equal(storage.has("unrelated-key"), true);
    assert.equal(storage.has("notegen-settings"), true);
    assert.equal(storage.has(pocKey("store.json")), false);
  });

  test("matches the prefix exactly, never as a substring", () => {
    const storage = new FakeStorage({
      [`x-${POC_STORAGE_PREFIX}store.json`]: "dummy",
      "notegen-poc-storex": "dummy",
      "notegen-poc-store": "dummy",
      [pocKey("store.json")]: "dummy",
    });
    assert.equal(runPocCleanup(storage), 1);
    assert.equal(storage.has(`x-${POC_STORAGE_PREFIX}store.json`), true);
    assert.equal(storage.has("notegen-poc-storex"), true);
    assert.equal(storage.has("notegen-poc-store"), true);
  });

  test("never reads a value: enumeration plus removal only", () => {
    const storage = new FakeStorage({
      [pocKey("store.json")]: "dummy-secret-value",
      "other": "dummy-other-value",
    });
    assert.equal(runPocCleanup(storage), 1);
    assert.deepEqual(storage.readCalls, []);
    assert.deepEqual(storage.removedKeys, [pocKey("store.json")]);
  });

  test("removes all POC keys when removal shifts live indices", () => {
    const storage = new FakeStorage({
      [pocKey("a")]: "1",
      "keep-1": "1",
      [pocKey("b")]: "2",
      [pocKey("c")]: "3",
      "keep-2": "2",
      [pocKey("d")]: "4",
    });
    assert.equal(runPocCleanup(storage), 4);
    assert.deepEqual(storage.keys(), ["keep-1", "keep-2"]);
  });

  test("logs one count-only line when keys were removed, silence otherwise", () => {
    const storage = new FakeStorage({
      [pocKey("store.json")]: "dummy-value-1",
      [pocKey("other.json")]: "dummy-value-2",
    });
    const capture = captureInfo();
    try {
      assert.equal(runPocCleanup(storage), 2);
      assert.equal(capture.messages.length, 1);
      assert.match(capture.messages[0] as string, /2/);
      assert.equal((capture.messages[0] as string).includes("store.json"), false);
      assert.equal((capture.messages[0] as string).includes("dummy-value-1"), false);
      assert.equal((capture.messages[0] as string).includes("dummy-value-2"), false);
    } finally {
      capture.restore();
    }

    const empty = new FakeStorage({ "other": "dummy" });
    const silent = captureInfo();
    try {
      assert.equal(runPocCleanup(empty), 0);
      assert.deepEqual(silent.messages, []);
    } finally {
      silent.restore();
    }
  });

  test("null storage and absent global storage return 0 without throwing", () => {
    assert.equal(runPocCleanup(null), 0);
    const globals = globalThis as Record<string, unknown>;
    const saved = globals["localStorage"];
    delete globals["localStorage"];
    try {
      assert.equal(typeof globals["localStorage"], "undefined");
      assert.equal(runPocCleanup(), 0);
    } finally {
      if (saved !== undefined) {
        globals["localStorage"] = saved;
      }
    }
  });

  test("uses the global localStorage when no storage is passed", () => {
    const globals = globalThis as Record<string, unknown>;
    const saved = globals["localStorage"];
    const storage = new FakeStorage({
      [pocKey("store.json")]: "dummy",
      "other": "dummy",
    });
    globals["localStorage"] = storage;
    try {
      assert.equal(runPocCleanup(), 1);
      assert.equal(storage.has(pocKey("store.json")), false);
      assert.equal(storage.has("other"), true);
    } finally {
      if (saved !== undefined) {
        globals["localStorage"] = saved;
      } else {
        delete globals["localStorage"];
      }
    }
  });

  test("throwing storage never throws and never deletes on enumeration failure", () => {
    const failingLength: PocCleanupStorage = {
      get length(): number {
        throw new Error("storage blocked");
      },
      key: () => null,
      removeItem: () => undefined,
    };
    assert.equal(runPocCleanup(failingLength), 0);

    let removed = 0;
    const failingKey: PocCleanupStorage = {
      length: 2,
      key: () => {
        throw new Error("storage blocked");
      },
      removeItem: () => {
        removed += 1;
      },
    };
    assert.equal(runPocCleanup(failingKey), 0);
    assert.equal(removed, 0);
  });

  test("a throwing removal does not stop the remaining keys", () => {
    const backing = new FakeStorage({
      [pocKey("a")]: "1",
      [pocKey("b")]: "2",
      [pocKey("c")]: "3",
    });
    const flaky: PocCleanupStorage = {
      get length(): number {
        return backing.length;
      },
      key: (index: number) => backing.key(index),
      removeItem: (key: string) => {
        if (key === pocKey("b")) {
          throw new Error("quota");
        }
        backing.removeItem(key);
      },
    };
    assert.equal(runPocCleanup(flaky), 2);
    assert.equal(backing.has(pocKey("a")), false);
    assert.equal(backing.has(pocKey("b")), true);
    assert.equal(backing.has(pocKey("c")), false);
  });

  test("once seam scans a single time per page lifetime", () => {
    const storage = new FakeStorage({ [pocKey("store.json")]: "dummy" });
    assert.equal(runPocCleanupOnce(storage), 1);
    storage.setItem(pocKey("store.json"), "dummy-again");
    assert.equal(runPocCleanupOnce(storage), 0);
    assert.equal(storage.has(pocKey("store.json")), true);

    __resetPocCleanupOnceForTests();
    assert.equal(runPocCleanupOnce(storage), 1);
    assert.equal(storage.has(pocKey("store.json")), false);
  });
});
