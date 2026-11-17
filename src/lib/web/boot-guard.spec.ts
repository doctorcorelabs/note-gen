// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the boot guard timeout contract (boot-guard.ts and
 * session-check.ts), using the repo convention (node:test with
 * node:assert/strict). Run through scripts/run-adapter-tests.mjs
 * (pnpm test:adapter), which bundles this file with esbuild and
 * asserts a counted result; see src/lib/web/errors.spec.ts for the
 * bundling pattern.
 *
 * Scope: the timeout and fail-closed cases that the ephemeral V2-08
 * harness proved 44/44 in /tmp but never committed (gate A5 CELAH-3).
 * Every case uses injected fakes with small budgets (tens of
 * milliseconds) plus a 5 second test bound, so a regression that
 * hangs fails fast instead of hanging the runner. No test sends
 * HTTP, touches the DOM, or reads storage.
 *
 * Deliberately NOT covered here: the React timers in
 * NextIntlProvider (catalog load timeout, M1) and src/app/page.tsx
 * (navigation timeout, M2). Those live in components with no DOM
 * test environment in this tree; they are proven live by the stall
 * spec tests/e2e/boot-stall.spec.ts, not by this file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOOT_GUARD_TIMEOUT_MS,
  BOOT_NAVIGATION_TIMEOUT_MS,
  classifyLiveResponse,
  classifyReadyResponse,
  resolveRedirectTarget,
  runBootGuard,
  type BootGuardDeps,
  type HealthResponse,
} from "./boot-guard";
import {
  checkSession,
  classifySessionStatus,
  isValidSessionBody,
  type SessionCheckDeps,
  type SessionCheckResult,
} from "./session-check";

interface FakeFetchResponse {
  status: number;
  text: () => Promise<string>;
}

function asFetch(
  fn: (url: string) => Promise<FakeFetchResponse>,
): typeof fetch {
  return fn as unknown as typeof fetch;
}

/** A fetch that never settles and ignores its abort signal. */
const hangingFetch = asFetch(() => new Promise<FakeFetchResponse>(() => {}));

function jsonFetch(status: number, bodyText: string): typeof fetch {
  return asFetch(async () => ({ status, text: async () => bodyText }));
}

function healthResponse(status: number, bodyText: string): HealthResponse {
  return { status, text: async () => bodyText };
}

/**
 * Fail a test instead of hanging the runner when the code under test
 * never settles. The implementation budgets below are tens of
 * milliseconds; the 5 second bound only names a hung implementation.
 */
async function withBound<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`test bound exceeded (hung implementation): ${label}`)),
      5000,
    );
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    clearTimeout(timer);
  }
}

function readyDeps(overrides: Partial<BootGuardDeps> = {}): BootGuardDeps {
  return {
    checkSessionFn: async (): Promise<SessionCheckResult> => ({
      state: "authenticated",
      code: "SESSION_OK",
      status: 200,
      checkedAt: Date.now(),
    }),
    healthFetch: async (path: string) => {
      if (path === "/api/health/live") {
        return healthResponse(200, JSON.stringify({ ok: true }));
      }
      return healthResponse(200, JSON.stringify({ ok: true }));
    },
    loadStore: async () => ({
      currentPage: undefined,
      persistCurrentPage: async () => {},
    }),
    isMobileDevice: () => false,
    ...overrides,
  };
}

describe("classifySessionStatus", () => {
  it("treats 200 as authenticated only (body validation decides next)", () => {
    assert.deepEqual(classifySessionStatus(200), {
      state: "authenticated",
      code: "SESSION_OK",
    });
  });

  it("treats 401 and 403 as an explicit rejection", () => {
    assert.deepEqual(classifySessionStatus(401), {
      state: "unauthenticated",
      code: "SESSION_REJECTED",
    });
    assert.deepEqual(classifySessionStatus(403), {
      state: "unauthenticated",
      code: "SESSION_REJECTED",
    });
  });

  it("treats 404 as unknown, never as a bypass or an expiry claim", () => {
    assert.deepEqual(classifySessionStatus(404), {
      state: "unknown",
      code: "SESSION_ENDPOINT_MISSING",
    });
  });

  it("treats any other status as unknown", () => {
    assert.deepEqual(classifySessionStatus(500), {
      state: "unknown",
      code: "SESSION_UNKNOWN",
    });
  });
});

describe("isValidSessionBody", () => {
  it("accepts a 200 envelope reporting ok true", () => {
    assert.equal(isValidSessionBody('{"ok":true}'), true);
  });

  it("rejects a 200 envelope reporting ok false", () => {
    assert.equal(isValidSessionBody('{"ok":false}'), false);
  });

  it("accepts a body without an ok field", () => {
    assert.equal(isValidSessionBody("{}"), true);
  });

  it("rejects unparseable bodies and arrays", () => {
    assert.equal(isValidSessionBody("not json"), false);
    assert.equal(isValidSessionBody("[]"), false);
  });
});

describe("checkSession timeout", () => {
  it("returns SESSION_TIMEOUT when the fetch never settles", async () => {
    const result = await withBound(
      checkSession({ fetchFn: hangingFetch, timeoutMs: 50 }),
      "checkSession with a hanging fetch",
    );
    assert.equal(result.state, "unknown");
    assert.equal(result.code, "SESSION_TIMEOUT");
  });

  it("returns SESSION_TIMEOUT when the response body never arrives", async () => {
    const hangingBody = asFetch(async () => ({
      status: 200,
      text: () => new Promise<string>(() => {}),
    }));
    const result = await withBound(
      checkSession({ fetchFn: hangingBody, timeoutMs: 50 }),
      "checkSession with a hanging body",
    );
    assert.equal(result.state, "unknown");
    assert.equal(result.code, "SESSION_TIMEOUT");
  });

  it("returns authenticated for a 200 response with a valid body", async () => {
    const result = await withBound(
      checkSession({ fetchFn: jsonFetch(200, '{"ok":true}'), timeoutMs: 1000 }),
      "checkSession success control",
    );
    assert.equal(result.state, "authenticated");
    assert.equal(result.code, "SESSION_OK");
    assert.equal(result.status, 200);
  });

  it("returns unknown for a 200 response reporting ok false (fail closed)", async () => {
    const result = await withBound(
      checkSession({ fetchFn: jsonFetch(200, '{"ok":false}'), timeoutMs: 1000 }),
      "checkSession ok-false control",
    );
    assert.equal(result.state, "unknown");
    assert.equal(result.code, "SESSION_UNKNOWN");
  });
});

describe("runBootGuard timeout", () => {
  it("reaches ready when every check passes (control)", async () => {
    const outcome = await withBound(
      runBootGuard(readyDeps({ timeoutMs: 5000 })),
      "runBootGuard success control",
    );
    assert.deepEqual(outcome, { status: "ready", target: "/core/main" });
  });

  it("fails BOOT_TIMEOUT when the health fetch never settles", async () => {
    const outcome = await withBound(
      runBootGuard(
        readyDeps({
          timeoutMs: 100,
          healthFetch: () => new Promise<HealthResponse>(() => {}),
        }),
      ),
      "runBootGuard with a hanging health fetch",
    );
    assert.deepEqual(outcome, {
      status: "failed",
      failure: { code: "BOOT_TIMEOUT", step: "guard", detail: "GUARD_TIMEOUT" },
    });
  });

  it("fails BOOT_TIMEOUT when the store load never settles", async () => {
    const outcome = await withBound(
      runBootGuard(
        readyDeps({
          timeoutMs: 100,
          loadStore: () => new Promise<never>(() => {}),
        }),
      ),
      "runBootGuard with a hanging store load",
    );
    assert.deepEqual(outcome, {
      status: "failed",
      failure: { code: "BOOT_TIMEOUT", step: "guard", detail: "GUARD_TIMEOUT" },
    });
  });

  it("fails BOOT_TIMEOUT when the session probe never settles", async () => {
    const outcome = await withBound(
      runBootGuard(
        readyDeps({
          timeoutMs: 100,
          checkSessionFn: () => new Promise<SessionCheckResult>(() => {}),
        }),
      ),
      "runBootGuard with a hanging session probe",
    );
    assert.deepEqual(outcome, {
      status: "failed",
      failure: { code: "BOOT_TIMEOUT", step: "guard", detail: "GUARD_TIMEOUT" },
    });
  });

  it("fails BOOT_SESSION_UNKNOWN with SESSION_TIMEOUT when the real probe times out", async () => {
    // The real probe bounds itself before the guard budget expires,
    // so a stalled /api/auth/me surfaces as an unknown session with
    // the probe timeout detail, not as a guard timeout.
    const checkSessionFn = (deps: SessionCheckDeps): Promise<SessionCheckResult> =>
      checkSession({ ...deps, fetchFn: hangingFetch, timeoutMs: 50 });
    const outcome = await withBound(
      runBootGuard(readyDeps({ timeoutMs: 5000, checkSessionFn })),
      "runBootGuard with a timing-out real probe",
    );
    assert.deepEqual(outcome, {
      status: "failed",
      failure: { code: "BOOT_SESSION_UNKNOWN", step: "session", detail: "SESSION_TIMEOUT" },
    });
  });

  it("fails BOOT_SESSION_EXPIRED when the server rejects the session", async () => {
    const outcome = await withBound(
      runBootGuard(
        readyDeps({
          timeoutMs: 5000,
          checkSessionFn: async (): Promise<SessionCheckResult> => ({
            state: "unauthenticated",
            code: "SESSION_REJECTED",
            status: 401,
            checkedAt: Date.now(),
          }),
        }),
      ),
      "runBootGuard rejected-session control",
    );
    assert.deepEqual(outcome, {
      status: "failed",
      failure: { code: "BOOT_SESSION_EXPIRED", step: "session", detail: "SESSION_REJECTED" },
    });
  });
});

describe("classifyReadyResponse and classifyLiveResponse", () => {
  it("requires 200 with ok true for readiness", () => {
    assert.deepEqual(classifyReadyResponse(200, '{"ok":true}'), { ready: true });
    assert.equal(classifyReadyResponse(200, '{"ok":false}').ready, false);
    assert.equal(classifyReadyResponse(503, '{"ok":true}').ready, false);
  });

  it("requires 200 with ok true for liveness", () => {
    assert.equal(classifyLiveResponse(200, '{"ok":true}'), true);
    assert.equal(classifyLiveResponse(200, '{"ok":false}'), false);
    assert.equal(classifyLiveResponse(503, '{"ok":true}'), false);
  });
});

describe("resolveRedirectTarget", () => {
  it("defaults an empty desktop store to /core/main", () => {
    assert.deepEqual(resolveRedirectTarget(undefined, false), {
      target: "/core/main",
      storeUpdate: null,
    });
  });

  it("rewrites legacy desktop paths to /core/main and persists the rewrite", () => {
    assert.deepEqual(resolveRedirectTarget("/core/article", false), {
      target: "/core/main",
      storeUpdate: "/core/main",
    });
  });

  it("never navigates to an absolute URL stored in the store", () => {
    assert.deepEqual(resolveRedirectTarget("https://example.invalid/x", false), {
      target: "/core/main",
      storeUpdate: null,
    });
  });
});

describe("boot timeout budgets", () => {
  it("pins the guard, session, and navigation budgets the stall spec relies on", () => {
    // The E2E stall spec waits past these budgets to observe the
    // visible timeout screens. If a budget changes, the spec bounds
    // and this pin must change together, deliberately.
    assert.equal(BOOT_GUARD_TIMEOUT_MS, 15000);
    assert.equal(BOOT_NAVIGATION_TIMEOUT_MS, 30000);
  });
});
