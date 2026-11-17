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
 * What this file verifies: all 20 web adapters are registered and
 * retrievable through the registry, the sql adapter resolves with
 * the SqlAdapter surface and reports the wired health probe
 * through ready(), and the freeze holds (late registration
 * throws, double freeze is safe, the boot entry is idempotent).
 *
 * What this file cannot verify: real browser behavior of any
 * adapter, the boot call site (owned by the boot/integrator task,
 * N-5), and DialogService wiring (N-10, separate AD-33 item). No
 * test here sends real HTTP or touches the DOM: registration
 * creates adapter instances only, and the ready() tests run
 * against a stubbed global fetch, so first real I/O happens when
 * an adapter method is called in production.
 *
 * When a follow-up adds an adapter, extend
 * REGISTERED_WEB_ADAPTER_NAMES in wiring.ts, add the name to the
 * registered tests, and re-run this spec plus the root typecheck
 * and the contract suite.
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

beforeEach(() => {
  __resetPlatformForTests();
});

function specGlobals(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

interface FetchStubCall {
  url: unknown;
  init: unknown;
}

/**
 * Replace the global fetch with a stub that records calls and
 * answers one fixed response (or throws). Returns a restore
 * function; every probe test restores in a finally block. No
 * real HTTP is sent.
 */
function stubFetch(
  response: { status: number; body: string } | Error,
  calls: FetchStubCall[],
): () => void {
  const savedFetch = specGlobals()["fetch"];
  specGlobals()["fetch"] = async (url: unknown, init: unknown) => {
    calls.push({ url, init });
    if (response instanceof Error) {
      throw response;
    }
    return {
      status: response.status,
      text: async () => response.body,
    };
  };
  return () => {
    specGlobals()["fetch"] = savedFetch;
  };
}

/** Ready-envelope body in the server health shape, as JSON text. */
function readyBody(migrationsStatus: string, ok: boolean): string {
  return JSON.stringify({
    ok,
    status: ok ? "ready" : "not_ready",
    checks: {
      db: { status: "ok", latencyMs: 0, detail: null, error: null },
      workspace: { status: "ok", latencyMs: 0, detail: null, error: null },
      migrations: {
        status: migrationsStatus,
        latencyMs: 0,
        detail: null,
        error: null,
      },
      pgvector: { status: "ok", latencyMs: 0, detail: null, error: null },
      worker: { status: "skipped", latencyMs: null, detail: null, error: null },
    },
  });
}

describe("registerWebAdapters", () => {
  test("registers all 20 web adapters present at the base", () => {
    assert.equal(REGISTERED_WEB_ADAPTER_NAMES.length, 20);
    registerWebAdapters();
    for (const name of REGISTERED_WEB_ADAPTER_NAMES) {
      assert.equal(hasAdapter(name), true, `${name} should be registered`);
    }
    assert.equal(listAdapters().length, 20);
  });

  test("store adapter resolves with the StoreAdapter surface", () => {
    registerWebAdapters();
    const store = getPlatformAdapter("store");
    assert.equal(typeof store.load, "function");
    assert.equal(typeof store.getStore, "function");
    assert.equal(typeof store.closeAll, "function");
  });

  test("accepts a CSRF provider without calling it at registration", () => {
    let calls = 0;
    registerWebAdapters({
      getStoreCsrfToken: () => {
        calls += 1;
        return "test-token";
      },
    });
    assert.equal(hasAdapter("store"), true);
    assert.equal(calls, 0);
  });

  test("sql adapter resolves with the SqlAdapter surface", () => {
    registerWebAdapters();
    const sql = getPlatformAdapter("sql");
    assert.equal(sql.mode, "web");
    assert.equal(typeof sql.query, "function");
    assert.equal(typeof sql.queryOne, "function");
    assert.equal(typeof sql.queryMany, "function");
    assert.equal(typeof sql.execute, "function");
    assert.equal(typeof sql.transaction, "function");
    assert.equal(typeof sql.ready, "function");
    assert.equal(typeof sql.close, "function");
  });

  test("accepts a SQL CSRF provider without calling it at registration", () => {
    let calls = 0;
    registerWebAdapters({
      getSqlCsrfToken: () => {
        calls += 1;
        return "test-token";
      },
    });
    assert.equal(hasAdapter("sql"), true);
    assert.equal(calls, 0);
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
});

describe("sql health probe", () => {
  test("ready() reports probe values when the endpoint is ready", async () => {
    registerWebAdapters();
    const calls: FetchStubCall[] = [];
    const restore = stubFetch(
      { status: 200, body: readyBody("ok", true) },
      calls,
    );
    try {
      const health = await getPlatformAdapter("sql").ready();
      assert.deepEqual(health, {
        ok: true,
        mode: "web",
        migrationsCurrent: true,
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, "/api/health/ready");
    } finally {
      restore();
    }
  });

  test("ready() reports migrations unverified when the check is skipped", async () => {
    registerWebAdapters();
    const calls: FetchStubCall[] = [];
    const restore = stubFetch(
      { status: 200, body: readyBody("skipped", true) },
      calls,
    );
    try {
      const health = await getPlatformAdapter("sql").ready();
      assert.deepEqual(health, {
        ok: true,
        mode: "web",
        migrationsCurrent: false,
      });
    } finally {
      restore();
    }
  });

  test("ready() answers not-ok when migrations fail", async () => {
    registerWebAdapters();
    const calls: FetchStubCall[] = [];
    const restore = stubFetch(
      { status: 503, body: readyBody("fail", false) },
      calls,
    );
    try {
      const health = await getPlatformAdapter("sql").ready();
      assert.deepEqual(health, {
        ok: false,
        mode: "web",
        migrationsCurrent: false,
      });
    } finally {
      restore();
    }
  });

  test("ready() answers not-ok when the probe fetch throws or the body is malformed", async () => {
    registerWebAdapters();
    const calls: FetchStubCall[] = [];
    const restoreThrow = stubFetch(new Error("network down"), calls);
    try {
      assert.deepEqual(await getPlatformAdapter("sql").ready(), {
        ok: false,
        mode: "web",
        migrationsCurrent: false,
      });
    } finally {
      restoreThrow();
    }
    const restoreMalformed = stubFetch(
      { status: 200, body: "not json" },
      calls,
    );
    try {
      assert.deepEqual(await getPlatformAdapter("sql").ready(), {
        ok: false,
        mode: "web",
        migrationsCurrent: false,
      });
    } finally {
      restoreMalformed();
    }
  });

  test("registration performs no fetch: the probe runs only on ready()", async () => {
    const calls: FetchStubCall[] = [];
    const restore = stubFetch(
      { status: 200, body: readyBody("ok", true) },
      calls,
    );
    try {
      registerWebAdapters();
      assert.equal(calls.length, 0);
      await getPlatformAdapter("sql").ready();
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });
});

describe("freeze", () => {
  test("initializeWebPlatform registers and freezes", () => {
    assert.equal(isRegistryFrozen(), false);
    initializeWebPlatform();
    assert.equal(isRegistryFrozen(), true);
    assert.equal(listAdapters().length, 20);
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
    assert.equal(listAdapters().length, 20);
  });

  test("registering twice before the freeze replaces instances", () => {
    registerWebAdapters();
    const first = getPlatformAdapter("fs");
    assert.doesNotThrow(() => registerWebAdapters());
    assert.notEqual(getPlatformAdapter("fs"), first);
    assert.equal(listAdapters().length, 20);
  });
});
