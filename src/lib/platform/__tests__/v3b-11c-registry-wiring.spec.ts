// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the web adapter registration wiring (N-1, AD-33).
 *
 * Run with node:test over an esbuild bundle, following the repo
 * convention for adapter specs (node:test cannot resolve the
 * extensionless relative imports the repo uses). From the repo root,
 * after `pnpm install`:
 *
 *   ./node_modules/.bin/esbuild src/lib/platform/__tests__/v3b-11c-registry-wiring.spec.ts --bundle --platform=node --format=esm --outfile=/tmp/v3b-11c-wiring.spec.mjs
 *   node --test --test-force-exit /tmp/v3b-11c-wiring.spec.mjs
 *
 * The --test-force-exit flag is required: the event adapter opens a
 * BroadcastChannel at construction, which keeps the node event loop
 * alive after the tests finish. The flag only ends the runner
 * process; it does not skip or weaken any test.
 *
 * What this file verifies: every web adapter present at the base is
 * registered and retrievable through the registry, the two
 * adapters with no web factory yet (store, sql) stay
 * unregistered, and the freeze holds (late registration throws,
 * double freeze is safe, the boot entry is idempotent).
 *
 * What this file cannot verify: real browser behavior of any
 * adapter, the boot call site (owned by the boot/integrator task,
 * N-5), and DialogService wiring (N-10, separate AD-33 item). No
 * test here sends HTTP or touches the DOM: registration creates
 * adapter instances only, and first I/O happens when an adapter
 * method is called.
 *
 * When a follow-up registers store or sql, extend
 * REGISTERED_WEB_ADAPTER_NAMES in wiring.ts, move the name from the
 * unregistered test to the registered test, and re-run this spec
 * plus the root typecheck and the contract suite.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  freezeRegistry,
  getPlatformAdapter,
  hasAdapter,
  isRegistryFrozen,
  listAdapters,
  platform,
  registerPlatformAdapter,
  __resetPlatformForTests,
} from "../registry";
import {
  initializeWebPlatform,
  REGISTERED_WEB_ADAPTER_NAMES,
  registerWebAdapters,
} from "../wiring";

const UNREGISTERED_NAMES = ["store", "sql"] as const;

beforeEach(() => {
  __resetPlatformForTests();
});

describe("registerWebAdapters", () => {
  test("registers all 18 web adapters present at the base", () => {
    assert.equal(REGISTERED_WEB_ADAPTER_NAMES.length, 18);
    registerWebAdapters();
    for (const name of REGISTERED_WEB_ADAPTER_NAMES) {
      assert.equal(hasAdapter(name), true, `${name} should be registered`);
    }
    assert.equal(listAdapters().length, 18);
  });

  test("every registered adapter is retrievable and stable", () => {
    registerWebAdapters();
    for (const name of REGISTERED_WEB_ADAPTER_NAMES) {
      const viaAccessor = getPlatformAdapter(
        name as Parameters<typeof getPlatformAdapter>[0],
      );
      assert.notEqual(viaAccessor, undefined, `${name} should resolve`);
      assert.equal(typeof viaAccessor, "object", `${name} should be an object`);
      const viaPlatform = (platform as unknown as Record<string, unknown>)[
        name
      ];
      assert.equal(
        viaPlatform,
        viaAccessor,
        `${name} should resolve to the same instance through platform`,
      );
      assert.equal(
        getPlatformAdapter(name as Parameters<typeof getPlatformAdapter>[0]),
        viaAccessor,
        `${name} should resolve to the same instance on repeat access`,
      );
    }
  });

  test("every registration carries mode web only", () => {
    registerWebAdapters();
    for (const entry of listAdapters()) {
      assert.deepEqual(
        [...entry.modes],
        ["web"],
        `${entry.name} should be registered for web only`,
      );
    }
  });

  test("registered names match the wiring module list exactly", () => {
    registerWebAdapters();
    const registered = listAdapters()
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(
      registered,
      [...REGISTERED_WEB_ADAPTER_NAMES].sort(),
    );
  });

  test("store and sql stay unregistered (recorded follow-up)", () => {
    registerWebAdapters();
    for (const name of UNREGISTERED_NAMES) {
      assert.equal(hasAdapter(name), false, `${name} should stay unregistered`);
      assert.throws(
        () =>
          getPlatformAdapter(
            name as Parameters<typeof getPlatformAdapter>[0],
          ),
        /not registered/,
        `${name} should throw a not-registered error`,
      );
    }
  });
});

describe("freeze", () => {
  test("initializeWebPlatform registers and freezes", () => {
    assert.equal(isRegistryFrozen(), false);
    initializeWebPlatform();
    assert.equal(isRegistryFrozen(), true);
    assert.equal(listAdapters().length, 18);
    assert.notEqual(getPlatformAdapter("fs"), undefined);
  });

  test("late registration throws after the freeze", () => {
    initializeWebPlatform();
    assert.throws(
      () =>
        registerPlatformAdapter(
          "os",
          getPlatformAdapter("os"),
          ["web"],
        ),
      /frozen/,
    );
    assert.throws(() => registerWebAdapters(), /frozen/);
  });

  test("double freeze is safe", () => {
    freezeRegistry();
    assert.doesNotThrow(() => freezeRegistry());
    assert.equal(isRegistryFrozen(), true);
  });

  test("initializeWebPlatform is idempotent after the freeze", () => {
    initializeWebPlatform();
    const first = getPlatformAdapter("fs");
    assert.doesNotThrow(() => initializeWebPlatform());
    assert.equal(isRegistryFrozen(), true);
    assert.equal(getPlatformAdapter("fs"), first);
    assert.equal(listAdapters().length, 18);
  });

  test("registering twice before the freeze replaces instances", () => {
    registerWebAdapters();
    const first = getPlatformAdapter("fs");
    assert.doesNotThrow(() => registerWebAdapters());
    assert.notEqual(getPlatformAdapter("fs"), first);
    assert.equal(listAdapters().length, 18);
  });
});
