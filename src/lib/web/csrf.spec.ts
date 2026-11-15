// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for src/lib/web/csrf.ts (Fase 1, V3-30b).
//
// Runner: Vitest, unit project (vitest run --project unit). The
// suite uses fake fetch implementations only; no test sends HTTP
// and no test touches the DOM, navigation, or any storage API.
// A dedicated case installs recording localStorage/sessionStorage
// spies to prove the store never calls them.

import { describe, expect, it } from "vitest";

import {
  buildCsrfHeaders,
  classifyAuthFailure,
  createCsrfTokenStore,
  createUnauthorizedHandler,
  createWebApiAuthSeam,
  CSRF_ENDPOINT,
  CSRF_HEADER_NAME,
  CsrfTokenError,
  handleUnauthorizedError,
  isCsrfInvalidError,
  isMutationMethod,
  isUnauthorizedError,
  isUnauthorizedStatus,
  parseCsrfTokenBody,
  shouldRefreshCsrf,
  withCsrfRetry,
  type CsrfTokenStoreDeps,
} from "./csrf";

interface FakeResponse {
  status: number;
  text: () => Promise<string>;
}

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(status: number, body: unknown): FakeResponse {
  return { status, text: async () => JSON.stringify(body) };
}

function textResponse(status: number, body: string): FakeResponse {
  return { status, text: async () => body };
}

function csrfSuccessResponse(token: string): FakeResponse {
  return jsonResponse(200, { ok: true, data: { csrfToken: token } });
}

function asFetchFn(
  fn: (url: string, init?: RequestInit) => Promise<FakeResponse>,
): CsrfTokenStoreDeps["fetchFn"] {
  return fn as unknown as CsrfTokenStoreDeps["fetchFn"];
}

class ApiLikeError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(status: number, code?: string, requestId?: string) {
    super(`API error ${status} ${code ?? ""}`.trim());
    this.name = "ApiLikeError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

describe("parseCsrfTokenBody", () => {
  it("extracts the token from the success envelope", () => {
    expect(parseCsrfTokenBody(JSON.stringify({ ok: true, data: { csrfToken: "tok-1" } }))).toBe(
      "tok-1",
    );
  });

  it("accepts a bare token body without an ok field", () => {
    expect(parseCsrfTokenBody(JSON.stringify({ csrfToken: "tok-2" }))).toBe("tok-2");
  });

  it("rejects an error envelope", () => {
    expect(
      parseCsrfTokenBody(
        JSON.stringify({
          ok: false,
          error: { code: "unauthenticated", message: "x", requestId: "r", retryable: false, details: {} },
        }),
      ),
    ).toBeNull();
  });

  it("rejects a body without a token", () => {
    expect(parseCsrfTokenBody(JSON.stringify({ ok: true, data: {} }))).toBeNull();
    expect(parseCsrfTokenBody(JSON.stringify({ ok: true, data: null }))).toBeNull();
    expect(parseCsrfTokenBody(JSON.stringify({ ok: true }))).toBeNull();
  });

  it("rejects empty and whitespace tokens", () => {
    expect(parseCsrfTokenBody(JSON.stringify({ ok: true, data: { csrfToken: "" } }))).toBeNull();
    expect(
      parseCsrfTokenBody(JSON.stringify({ ok: true, data: { csrfToken: "has space" } })),
    ).toBeNull();
    expect(
      parseCsrfTokenBody(JSON.stringify({ ok: true, data: { csrfToken: " padded " } })),
    ).toBeNull();
  });

  it("rejects non-JSON, non-object, and array bodies", () => {
    expect(parseCsrfTokenBody("not json")).toBeNull();
    expect(parseCsrfTokenBody("42")).toBeNull();
    expect(parseCsrfTokenBody('"tok"')).toBeNull();
    expect(parseCsrfTokenBody(JSON.stringify(["tok"]))).toBeNull();
  });

  it("rejects a non-object data value", () => {
    expect(parseCsrfTokenBody(JSON.stringify({ ok: true, data: "tok" }))).toBeNull();
    expect(parseCsrfTokenBody(JSON.stringify({ ok: true, data: ["tok"] }))).toBeNull();
  });
});

describe("method and failure classification", () => {
  it("marks only POST, PUT, PATCH, and DELETE as mutations", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "Put"]) {
      expect(isMutationMethod(method)).toBe(true);
    }
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isMutationMethod(method)).toBe(false);
    }
  });

  it("refreshes only on 403 with code csrf_invalid", () => {
    expect(shouldRefreshCsrf(403, "csrf_invalid")).toBe(true);
    expect(shouldRefreshCsrf(403, "forbidden")).toBe(false);
    expect(shouldRefreshCsrf(403, "origin_rejected")).toBe(false);
    expect(shouldRefreshCsrf(403, "step_up_required")).toBe(false);
    expect(shouldRefreshCsrf(403)).toBe(false);
    expect(shouldRefreshCsrf(401, "csrf_invalid")).toBe(false);
    expect(shouldRefreshCsrf(200, "csrf_invalid")).toBe(false);
  });

  it("classifies 401 as expired and other 403 codes as other", () => {
    expect(classifyAuthFailure(401, "unauthenticated")).toBe("session_expired");
    expect(classifyAuthFailure(401, "invalid_credentials")).toBe("session_expired");
    expect(classifyAuthFailure(401)).toBe("session_expired");
    expect(classifyAuthFailure(403, "csrf_invalid")).toBe("csrf_invalid");
    expect(classifyAuthFailure(403, "forbidden")).toBe("other");
    expect(classifyAuthFailure(403, "origin_rejected")).toBe("other");
    expect(classifyAuthFailure(404, "not_found")).toBe("other");
    expect(classifyAuthFailure(500, "internal_error")).toBe("other");
  });

  it("reads status and code structurally from error-like values", () => {
    expect(isUnauthorizedStatus(401)).toBe(true);
    expect(isUnauthorizedStatus(403)).toBe(false);
    expect(isUnauthorizedError(new ApiLikeError(401, "unauthenticated"))).toBe(true);
    expect(isUnauthorizedError(new ApiLikeError(403, "forbidden"))).toBe(false);
    expect(isUnauthorizedError({ status: 401 })).toBe(true);
    expect(isUnauthorizedError({ status: "401" })).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
    expect(isUnauthorizedError("401")).toBe(false);
    expect(isCsrfInvalidError(new ApiLikeError(403, "csrf_invalid"))).toBe(true);
    expect(isCsrfInvalidError(new ApiLikeError(403, "forbidden"))).toBe(false);
    expect(isCsrfInvalidError(new ApiLikeError(401, "csrf_invalid"))).toBe(false);
    expect(isCsrfInvalidError({ status: 403 })).toBe(false);
    expect(isCsrfInvalidError(null)).toBe(false);
  });

  it("builds the canonical CSRF header and rejects unusable tokens", () => {
    expect(buildCsrfHeaders("tok-1")).toEqual({ [CSRF_HEADER_NAME]: "tok-1" });
    expect(CSRF_HEADER_NAME).toBe("X-CSRF-Token");
    expect(CSRF_ENDPOINT).toBe("/api/auth/csrf");
    const first = buildCsrfHeaders("tok-1");
    const second = buildCsrfHeaders("tok-1");
    expect(first).not.toBe(second);
    expect(() => buildCsrfHeaders("")).toThrow(TypeError);
    expect(() => buildCsrfHeaders("has space")).toThrow(TypeError);
  });

  it("never puts the token value in a validation error message", () => {
    const secretLike = "tok-with space-12345";
    let message = "";
    try {
      buildCsrfHeaders(secretLike);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(secretLike);
    expect(message).not.toContain("12345");
  });
});

describe("CSRF token store: fetch and cache", () => {
  it("fetches with GET, cookie credentials, and no-store, then caches", async () => {
    const calls: CapturedCall[] = [];
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async (url, init) => {
        calls.push({ url: String(url), init });
        return csrfSuccessResponse("tok-cached");
      }),
    });
    expect(store.hasToken()).toBe(false);
    await expect(store.getToken()).resolves.toBe("tok-cached");
    await expect(store.getToken()).resolves.toBe("tok-cached");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/auth/csrf");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(calls[0]?.init?.cache).toBe("no-store");
    expect(calls[0]?.init?.headers).toEqual({ Accept: "application/json" });
    expect(store.hasToken()).toBe(true);
  });

  it("honors a custom endpoint", async () => {
    const urls: string[] = [];
    const store = createCsrfTokenStore({
      endpoint: "/api/auth/csrf?test=1",
      fetchFn: asFetchFn(async (url) => {
        urls.push(String(url));
        return csrfSuccessResponse("tok-custom");
      }),
    });
    await expect(store.getToken()).resolves.toBe("tok-custom");
    expect(urls).toEqual(["/api/auth/csrf?test=1"]);
  });

  it("coalesces concurrent cold fetches into one request", async () => {
    let fetchCount = 0;
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => {
        fetchCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return csrfSuccessResponse("tok-shared");
      }),
    });
    const tokens = await Promise.all(Array.from({ length: 10 }, () => store.getToken()));
    expect(tokens).toEqual(Array(10).fill("tok-shared"));
    expect(fetchCount).toBe(1);
  });

  it("does not poison the cache when a fetch fails", async () => {
    let fetchCount = 0;
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          throw new Error("network down");
        }
        return csrfSuccessResponse("tok-retry");
      }),
    });
    await expect(store.getToken()).rejects.toBeInstanceOf(CsrfTokenError);
    await expect(store.getToken()).resolves.toBe("tok-retry");
    expect(fetchCount).toBe(2);
  });

  it("maps a network failure to network_error without expiry", async () => {
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => {
        throw new Error("network down");
      }),
    });
    const error = await store.getToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CsrfTokenError);
    const tokenError = error as CsrfTokenError;
    expect(tokenError.reason).toBe("network_error");
    expect(tokenError.sessionExpired).toBe(false);
    expect(tokenError.status).toBeUndefined();
  });

  it("maps 401 to unauthenticated with sessionExpired true", async () => {
    let fetchCount = 0;
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => {
        fetchCount += 1;
        return jsonResponse(401, {
          ok: false,
          error: {
            code: "unauthenticated",
            message: "generic",
            requestId: "req-1",
            retryable: false,
            details: {},
          },
        });
      }),
    });
    const error = await store.getToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CsrfTokenError);
    const tokenError = error as CsrfTokenError;
    expect(tokenError.reason).toBe("unauthenticated");
    expect(tokenError.sessionExpired).toBe(true);
    expect(tokenError.status).toBe(401);
    expect(tokenError.wireCode).toBe("unauthenticated");
    expect(store.hasToken()).toBe(false);
    await expect(store.getToken()).rejects.toBeInstanceOf(CsrfTokenError);
    expect(fetchCount).toBe(2);
  });

  it("maps 401 without a parseable envelope to unauthenticated", async () => {
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => textResponse(401, "not json")),
    });
    const error = await store.getToken().catch((caught: unknown) => caught);
    const tokenError = error as CsrfTokenError;
    expect(tokenError.reason).toBe("unauthenticated");
    expect(tokenError.sessionExpired).toBe(true);
    expect(tokenError.wireCode).toBe("unauthenticated");
  });

  it("maps 500 to server_error without expiry", async () => {
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => jsonResponse(500, { ok: false, error: { code: "internal_error" } })),
    });
    const error = await store.getToken().catch((caught: unknown) => caught);
    const tokenError = error as CsrfTokenError;
    expect(tokenError.reason).toBe("server_error");
    expect(tokenError.sessionExpired).toBe(false);
    expect(tokenError.status).toBe(500);
  });

  it("maps 404 to invalid_response without expiry", async () => {
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => textResponse(404, "no such endpoint")),
    });
    const error = await store.getToken().catch((caught: unknown) => caught);
    const tokenError = error as CsrfTokenError;
    expect(tokenError.reason).toBe("invalid_response");
    expect(tokenError.sessionExpired).toBe(false);
  });

  it("maps a 200 malformed body to invalid_response", async () => {
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => textResponse(200, "not json")),
    });
    const error = await store.getToken().catch((caught: unknown) => caught);
    const tokenError = error as CsrfTokenError;
    expect(tokenError.reason).toBe("invalid_response");
    expect(tokenError.sessionExpired).toBe(false);
    expect(tokenError.status).toBe(200);
  });

  it("maps a 200 error envelope to invalid_response", async () => {
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () =>
        jsonResponse(200, { ok: false, error: { code: "internal_error" } }),
      ),
    });
    const error = await store.getToken().catch((caught: unknown) => caught);
    expect((error as CsrfTokenError).reason).toBe("invalid_response");
    expect((error as CsrfTokenError).sessionExpired).toBe(false);
  });

  it("times out a fetch that never settles and aborts its signal", async () => {
    let capturedSignal: AbortSignal | undefined;
    const store = createCsrfTokenStore({
      timeoutMs: 5,
      fetchFn: asFetchFn(async (_url, init) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<FakeResponse>(() => {
          // Never settles on purpose; the store timeout must bound it.
        });
      }),
    });
    const error = await store.getToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CsrfTokenError);
    expect((error as CsrfTokenError).reason).toBe("timeout");
    expect((error as CsrfTokenError).sessionExpired).toBe(false);
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("CSRF token store: set, clear, and refresh", () => {
  it("setToken seeds the cache without fetching and replaces the old token", async () => {
    let fetchCount = 0;
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => {
        fetchCount += 1;
        return csrfSuccessResponse("tok-fetched");
      }),
    });
    store.setToken("tok-login");
    await expect(store.getToken()).resolves.toBe("tok-login");
    store.setToken("tok-rotated");
    await expect(store.getToken()).resolves.toBe("tok-rotated");
    expect(fetchCount).toBe(0);
  });

  it("setToken rejects unusable tokens", () => {
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => csrfSuccessResponse("tok-x")),
    });
    expect(() => store.setToken("")).toThrow(TypeError);
    expect(() => store.setToken("has space")).toThrow(TypeError);
    expect(store.hasToken()).toBe(false);
  });

  it("clearToken forces the next getToken to fetch again", async () => {
    let fetchCount = 0;
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => {
        fetchCount += 1;
        return csrfSuccessResponse(`tok-${fetchCount}`);
      }),
    });
    await expect(store.getToken()).resolves.toBe("tok-1");
    store.clearToken();
    expect(store.hasToken()).toBe(false);
    await expect(store.getToken()).resolves.toBe("tok-2");
    expect(fetchCount).toBe(2);
  });

  it("refreshToken fetches fresh even when a token is cached", async () => {
    let fetchCount = 0;
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => {
        fetchCount += 1;
        return csrfSuccessResponse(`tok-${fetchCount}`);
      }),
    });
    await expect(store.getToken()).resolves.toBe("tok-1");
    await expect(store.refreshToken()).resolves.toBe("tok-2");
    await expect(store.getToken()).resolves.toBe("tok-2");
    expect(fetchCount).toBe(2);
  });

  it("coalesces concurrent refreshToken calls into one fresh fetch", async () => {
    let fetchCount = 0;
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => {
        fetchCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return csrfSuccessResponse(`tok-${fetchCount}`);
      }),
    });
    await expect(store.getToken()).resolves.toBe("tok-1");
    const tokens = await Promise.all(Array.from({ length: 5 }, () => store.refreshToken()));
    expect(tokens).toEqual(Array(5).fill("tok-2"));
    expect(fetchCount).toBe(2);
  });

  it("discards a stale in-flight fetch result after a refresh starts", async () => {
    let releaseFirst: (() => void) | undefined;
    let fetchCount = 0;
    const store = createCsrfTokenStore({
      fetchFn: asFetchFn(async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return csrfSuccessResponse("tok-stale");
        }
        return csrfSuccessResponse("tok-fresh");
      }),
    });
    const firstWait = store.getToken();
    const refreshed = await store.refreshToken();
    expect(refreshed).toBe("tok-fresh");
    releaseFirst?.();
    await expect(firstWait).resolves.toBe("tok-stale");
    await expect(store.getToken()).resolves.toBe("tok-fresh");
    expect(fetchCount).toBe(2);
  });

  it("never calls localStorage or sessionStorage", async () => {
    const calls: string[] = [];
    const spyStorage = {
      getItem: (key: string) => {
        calls.push(`get:${key}`);
        return null;
      },
      setItem: (key: string) => {
        calls.push(`set:${key}`);
      },
      removeItem: (key: string) => {
        calls.push(`remove:${key}`);
      },
      clear: () => {
        calls.push("clear");
      },
      key: () => null,
      length: 0,
    };
    const globalObject = globalThis as Record<string, unknown>;
    const previousLocal = globalObject.localStorage;
    const previousSession = globalObject.sessionStorage;
    globalObject.localStorage = spyStorage;
    globalObject.sessionStorage = spyStorage;
    try {
      const store = createCsrfTokenStore({
        fetchFn: asFetchFn(async () => csrfSuccessResponse("tok-spy")),
      });
      store.setToken("tok-seeded");
      await store.getToken();
      await store.refreshToken();
      store.clearToken();
      await store.getToken();
    } finally {
      if (previousLocal === undefined) {
        delete globalObject.localStorage;
      } else {
        globalObject.localStorage = previousLocal;
      }
      if (previousSession === undefined) {
        delete globalObject.sessionStorage;
      } else {
        globalObject.sessionStorage = previousSession;
      }
    }
    expect(calls).toEqual([]);
  });
});

describe("unauthorized handler", () => {
  it("starts unknown and becomes active on success", () => {
    const handler = createUnauthorizedHandler();
    expect(handler.getSessionStatus()).toBe("unknown");
    handler.markSessionActive();
    expect(handler.getSessionStatus()).toBe("active");
    handler.markSessionActive();
    expect(handler.getSessionStatus()).toBe("active");
  });

  it("notifies listeners exactly once per transition to expired", () => {
    const handler = createUnauthorizedHandler();
    const seen: Array<{ code?: string; path?: string; status: number; at: number }> = [];
    handler.subscribe((event) => {
      seen.push(event);
    });
    handler.onUnauthorized({ code: "unauthenticated", requestId: "req-9", path: "/api/records" });
    handler.onUnauthorized({ code: "unauthenticated", path: "/api/other" });
    expect(handler.getSessionStatus()).toBe("expired");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe(401);
    expect(seen[0]?.code).toBe("unauthenticated");
    expect(seen[0]?.path).toBe("/api/records");
    expect(typeof seen[0]?.at).toBe("number");
  });

  it("never resurrects an expired session except through reset", () => {
    const handler = createUnauthorizedHandler();
    let notifications = 0;
    handler.subscribe(() => {
      notifications += 1;
    });
    handler.onUnauthorized({});
    handler.markSessionActive();
    expect(handler.getSessionStatus()).toBe("expired");
    handler.resetSessionStatus();
    expect(handler.getSessionStatus()).toBe("unknown");
    handler.onUnauthorized({});
    expect(notifications).toBe(2);
  });

  it("swallows listener errors so the 401 is not masked", () => {
    const handler = createUnauthorizedHandler();
    handler.subscribe(() => {
      throw new Error("listener broke");
    });
    let secondCalled = false;
    handler.subscribe(() => {
      secondCalled = true;
    });
    expect(() => handler.onUnauthorized({})).not.toThrow();
    expect(secondCalled).toBe(true);
    expect(handler.getSessionStatus()).toBe("expired");
  });

  it("supports unsubscribe and does not replay to late subscribers", () => {
    const handler = createUnauthorizedHandler();
    let firstCount = 0;
    const unsubscribe = handler.subscribe(() => {
      firstCount += 1;
    });
    unsubscribe();
    handler.onUnauthorized({});
    expect(firstCount).toBe(0);
    let lateCount = 0;
    handler.subscribe(() => {
      lateCount += 1;
    });
    expect(lateCount).toBe(0);
    expect(handler.getSessionStatus()).toBe("expired");
  });
});

describe("auth seam and handleUnauthorizedError", () => {
  it("seam onUnauthorized clears the token and notifies once", async () => {
    const seam = createWebApiAuthSeam({
      fetchFn: asFetchFn(async () => csrfSuccessResponse("tok-seam")),
    });
    seam.csrf.setToken("tok-seeded");
    let notifications = 0;
    seam.subscribeToSessionExpiry(() => {
      notifications += 1;
    });
    seam.onUnauthorized({ code: "unauthenticated" });
    expect(seam.getSessionStatus()).toBe("expired");
    expect(seam.csrf.hasToken()).toBe(false);
    expect(notifications).toBe(1);
    seam.onUnauthorized({});
    expect(notifications).toBe(1);
  });

  it("handleUnauthorizedError reports 401 and ignores other errors", () => {
    const seam = createWebApiAuthSeam({
      fetchFn: asFetchFn(async () => csrfSuccessResponse("tok-seam")),
    });
    seam.csrf.setToken("tok-seeded");
    const events: Array<{ code?: string; requestId?: string; path?: string }> = [];
    seam.subscribeToSessionExpiry((event) => {
      events.push(event);
    });
    expect(handleUnauthorizedError(seam, new ApiLikeError(403, "csrf_invalid"))).toBe(false);
    expect(handleUnauthorizedError(seam, new ApiLikeError(500, "internal_error"))).toBe(false);
    expect(handleUnauthorizedError(seam, null)).toBe(false);
    expect(seam.getSessionStatus()).toBe("unknown");
    expect(seam.csrf.hasToken()).toBe(true);
    expect(
      handleUnauthorizedError(seam, new ApiLikeError(401, "unauthenticated", "req-7"), {
        path: "/api/workspace/list",
      }),
    ).toBe(true);
    expect(seam.getSessionStatus()).toBe("expired");
    expect(seam.csrf.hasToken()).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      code: "unauthenticated",
      requestId: "req-7",
      path: "/api/workspace/list",
    });
  });
});

describe("withCsrfRetry", () => {
  function makeSeam(tokens: string[]) {
    let fetchCount = 0;
    const seam = createWebApiAuthSeam({
      fetchFn: asFetchFn(async () => {
        fetchCount += 1;
        return csrfSuccessResponse(tokens[fetchCount - 1] ?? `tok-${fetchCount}`);
      }),
    });
    return { seam, fetchCount: () => fetchCount };
  }

  it("sends the fetched token in the header on the first attempt", async () => {
    const { seam, fetchCount } = makeSeam(["tok-first"]);
    const seenTokens: string[] = [];
    const value = await withCsrfRetry(seam, async (token) => {
      seenTokens.push(token);
      const headers = buildCsrfHeaders(token);
      expect(headers[CSRF_HEADER_NAME]).toBe(token);
      return "ok";
    });
    expect(value).toBe("ok");
    expect(seenTokens).toEqual(["tok-first"]);
    expect(fetchCount()).toBe(1);
    expect(seam.getSessionStatus()).toBe("active");
  });

  it("refreshes once on csrf_invalid and retries with the new token", async () => {
    const { seam, fetchCount } = makeSeam(["tok-old", "tok-new"]);
    const seenTokens: string[] = [];
    let attempts = 0;
    const value = await withCsrfRetry(seam, async (token) => {
      seenTokens.push(token);
      attempts += 1;
      if (attempts === 1) {
        throw new ApiLikeError(403, "csrf_invalid");
      }
      return "retried";
    });
    expect(value).toBe("retried");
    expect(seenTokens).toEqual(["tok-old", "tok-new"]);
    expect(attempts).toBe(2);
    expect(fetchCount()).toBe(2);
    expect(seam.getSessionStatus()).toBe("active");
  });

  it("fails explicitly after a second csrf_invalid and clears the token", async () => {
    const { seam, fetchCount } = makeSeam(["tok-1", "tok-2"]);
    let attempts = 0;
    const thrown = await withCsrfRetry(seam, async () => {
      attempts += 1;
      throw new ApiLikeError(403, "csrf_invalid");
    }).catch((caught: unknown) => caught);
    expect(thrown).toBeInstanceOf(ApiLikeError);
    expect((thrown as ApiLikeError).status).toBe(403);
    expect((thrown as ApiLikeError).code).toBe("csrf_invalid");
    expect(attempts).toBe(2);
    expect(fetchCount()).toBe(2);
    expect(seam.csrf.hasToken()).toBe(false);
    expect(seam.getSessionStatus()).toBe("unknown");
  });

  it("does not refresh on 403 forbidden or origin_rejected", async () => {
    for (const code of ["forbidden", "origin_rejected", "step_up_required"]) {
      const { seam, fetchCount } = makeSeam(["tok-keep"]);
      let attempts = 0;
      await expect(
        withCsrfRetry(seam, async () => {
          attempts += 1;
          throw new ApiLikeError(403, code);
        }),
      ).rejects.toBeInstanceOf(ApiLikeError);
      expect(attempts).toBe(1);
      expect(fetchCount()).toBe(1);
      expect(seam.csrf.hasToken()).toBe(true);
      expect(seam.getSessionStatus()).toBe("unknown");
    }
  });

  it("maps 401 to expired, not unknown, without retrying", async () => {
    const { seam, fetchCount } = makeSeam(["tok-401"]);
    const events: Array<{ code?: string; path?: string; status: number }> = [];
    seam.subscribeToSessionExpiry((event) => {
      events.push(event);
    });
    let attempts = 0;
    await expect(
      withCsrfRetry(
        seam,
        async () => {
          attempts += 1;
          throw new ApiLikeError(401, "unauthenticated", "req-401");
        },
        { path: "/api/records" },
      ),
    ).rejects.toBeInstanceOf(ApiLikeError);
    expect(attempts).toBe(1);
    expect(fetchCount()).toBe(1);
    expect(seam.getSessionStatus()).toBe("expired");
    expect(seam.csrf.hasToken()).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 401, code: "unauthenticated", path: "/api/records" });
  });

  it("does not call the attempt when the token fetch returns 401", async () => {
    const seam = createWebApiAuthSeam({
      fetchFn: asFetchFn(async () =>
        jsonResponse(401, { ok: false, error: { code: "unauthenticated" } }),
      ),
    });
    let notifications = 0;
    seam.subscribeToSessionExpiry(() => {
      notifications += 1;
    });
    let attempts = 0;
    const thrown = await withCsrfRetry(seam, async () => {
      attempts += 1;
      return "never";
    }).catch((caught: unknown) => caught);
    expect(thrown).toBeInstanceOf(CsrfTokenError);
    expect((thrown as CsrfTokenError).sessionExpired).toBe(true);
    expect(attempts).toBe(0);
    expect(notifications).toBe(1);
    expect(seam.getSessionStatus()).toBe("expired");
  });

  it("does not attempt a second time when the refresh fetch fails", async () => {
    let fetchCount = 0;
    const seam = createWebApiAuthSeam({
      fetchFn: asFetchFn(async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return csrfSuccessResponse("tok-1");
        }
        throw new Error("network down");
      }),
    });
    let attempts = 0;
    const thrown = await withCsrfRetry(seam, async () => {
      attempts += 1;
      throw new ApiLikeError(403, "csrf_invalid");
    }).catch((caught: unknown) => caught);
    expect(thrown).toBeInstanceOf(CsrfTokenError);
    expect((thrown as CsrfTokenError).reason).toBe("network_error");
    expect(attempts).toBe(1);
    expect(fetchCount).toBe(2);
  });

  it("shares one token fetch across concurrent mutations", async () => {
    const { seam, fetchCount } = makeSeam(["tok-shared"]);
    const seenTokens: string[] = [];
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withCsrfRetry(seam, async (token) => {
          seenTokens.push(token);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return token;
        }),
      ),
    );
    expect(results).toEqual(Array(5).fill("tok-shared"));
    expect(seenTokens).toEqual(Array(5).fill("tok-shared"));
    expect(fetchCount()).toBe(1);
  });

  it("rethrows non-auth errors unchanged without refresh or expiry", async () => {
    const { seam, fetchCount } = makeSeam(["tok-keep"]);
    const original = new ApiLikeError(500, "internal_error");
    let attempts = 0;
    const thrown = await withCsrfRetry(seam, async () => {
      attempts += 1;
      throw original;
    }).catch((caught: unknown) => caught);
    expect(thrown).toBe(original);
    expect(attempts).toBe(1);
    expect(fetchCount()).toBe(1);
    expect(seam.csrf.hasToken()).toBe(true);
    expect(seam.getSessionStatus()).toBe("unknown");
  });

  it("notifies expiry when the second attempt returns 401", async () => {
    const { seam } = makeSeam(["tok-1", "tok-2"]);
    let notifications = 0;
    seam.subscribeToSessionExpiry(() => {
      notifications += 1;
    });
    let attempts = 0;
    await expect(
      withCsrfRetry(seam, async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new ApiLikeError(403, "csrf_invalid");
        }
        throw new ApiLikeError(401, "unauthenticated");
      }),
    ).rejects.toBeInstanceOf(ApiLikeError);
    expect(attempts).toBe(2);
    expect(notifications).toBe(1);
    expect(seam.getSessionStatus()).toBe("expired");
  });
});
