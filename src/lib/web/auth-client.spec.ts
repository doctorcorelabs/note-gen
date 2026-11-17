// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for the unified src/lib/web/auth-client.ts (Fase 1,
// V3-03): the session suite (slot 03b) plus the page suite (slot
// 03a), unioned at merge time. The page suite helpers carry a
// `page` prefix because their fake shapes differ from the session
// suite helpers of the same name.
//
// Runner: Vitest, unit project (vitest run --project unit). The
// suites use fake fetch implementations only; no test sends HTTP
// and no test touches the DOM, navigation, or any storage API.
// Dedicated cases install recording storage spies to prove the
// client never calls web storage, and a grep gate in the task
// report proves the module source contains no storage access.

import { describe, expect, it } from "vitest";

import {
  AuthClientError,
  createAuthSession,
  createAuthSessionClient,
  createFirstAccount,
  fetchCurrentAccount,
  isSafeSessionRowId,
  isValidSetupPassword,
  isValidTotpCode,
  LOGIN_ENDPOINT,
  LOGIN_TOTP_ENDPOINT,
  loginWithPassword,
  loginWithTotp,
  ME_ENDPOINT,
  normalizeEmail,
  parseAuthMeData,
  parseAuthSessionList,
  parseCurrentAccount,
  parseLoginResponse,
  parseLoginSuccess,
  parseSetupResult,
  resolvePostLoginTarget,
  SESSION_EXPIRED_LOGIN_PATH,
  SESSION_LOGIN_PATH,
  SETUP_ENDPOINT,
  toAuthClientError,
  type AuthSession,
  type AuthSessionClient,
} from "./auth-client";
import { CsrfTokenError } from "./csrf";
import { ApiError } from "./errors";

interface FakeResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text: () => Promise<string>;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: unknown;
}

function jsonResponse(status: number, body: unknown): FakeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function successEnvelope(data: unknown): Record<string, unknown> {
  return { ok: true, data };
}

function errorEnvelope(code: string): Record<string, unknown> {
  return {
    ok: false,
    error: { code, message: "rejected", requestId: "req-test", retryable: false, details: {} },
  };
}

type Responder = (call: CapturedCall) => FakeResponse;

function makeFetch(responder: Responder): {
  fetchFn: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<FakeResponse> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: CapturedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...headers },
      credentials: init?.credentials,
    };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function meData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "user-1",
    email: "owner@example.test",
    role: "admin",
    totpEnabled: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    lastLoginAt: "2026-11-15T00:00:00.000Z",
    workspaceId: "ws-1",
    session: {
      id: "sess-current",
      deviceLabel: "Test Browser",
      createdAt: "2026-11-15T00:00:00.000Z",
      lastSeenAt: "2026-11-16T00:00:00.000Z",
      absoluteExpiresAt: "2026-12-15T00:00:00.000Z",
      stepUpAt: null,
    },
    ...overrides,
  };
}

function sessionEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sess-1",
    deviceLabel: "Test Browser",
    userAgent: "TestAgent/1.0",
    createdIp: "127.0.0.1",
    lastSeenIp: "127.0.0.1",
    createdAt: "2026-11-15T00:00:00.000Z",
    lastSeenAt: "2026-11-16T00:00:00.000Z",
    absoluteExpiresAt: "2026-12-15T00:00:00.000Z",
    isCurrent: true,
    ...overrides,
  };
}

/** Responder serving the CSRF endpoint plus a per-path table. */
function tableResponder(
  table: Record<string, FakeResponse>,
  csrfTokens: string[] = ["tok-1"],
): Responder {
  let csrfCount = 0;
  return (call) => {
    if (call.url === "/api/auth/csrf") {
      const token = csrfTokens[Math.min(csrfCount, csrfTokens.length - 1)] as string;
      csrfCount += 1;
      return jsonResponse(200, successEnvelope({ csrfToken: token }));
    }
    const response = table[`${call.method} ${call.url}`];
    if (response === undefined) {
      return jsonResponse(404, errorEnvelope("not_found"));
    }
    return response;
  };
}

describe("parseAuthMeData", () => {
  it("accepts the server MeData shape and ignores extra fields", () => {
    const parsed = parseAuthMeData(meData({ extraField: "ignored" }));
    expect(parsed).not.toBeNull();
    expect(parsed?.email).toBe("owner@example.test");
    expect(parsed?.role).toBe("admin");
    expect(parsed?.session.id).toBe("sess-current");
    expect(parsed?.session.stepUpAt).toBeNull();
  });

  it("rejects a null, array, or non-object body", () => {
    expect(parseAuthMeData(null)).toBeNull();
    expect(parseAuthMeData([])).toBeNull();
    expect(parseAuthMeData("ok")).toBeNull();
  });

  it("rejects an unknown role instead of inventing a privilege", () => {
    expect(parseAuthMeData(meData({ role: "superadmin" }))).toBeNull();
    expect(parseAuthMeData(meData({ role: "USER" }))).toBeNull();
  });

  it("rejects a missing session, a wrong totpEnabled type, and a numeric lastLoginAt", () => {
    const noSession = meData();
    delete noSession.session;
    expect(parseAuthMeData(noSession)).toBeNull();
    expect(parseAuthMeData(meData({ totpEnabled: "false" }))).toBeNull();
    expect(parseAuthMeData(meData({ lastLoginAt: 123 }))).toBeNull();
    expect(parseAuthMeData(meData({ email: "" }))).toBeNull();
  });
});

describe("parseAuthSessionList", () => {
  it("accepts a list and keeps the server order", () => {
    const parsed = parseAuthSessionList([
      sessionEntry({ id: "sess-new", isCurrent: true }),
      sessionEntry({ id: "sess-old", isCurrent: false, deviceLabel: "Other Browser" }),
    ]);
    expect(parsed?.map((entry) => entry.id)).toEqual(["sess-new", "sess-old"]);
  });

  it("accepts an empty list", () => {
    expect(parseAuthSessionList([])).toEqual([]);
  });

  it("rejects a non-array body and a list with one malformed entry", () => {
    expect(parseAuthSessionList({})).toBeNull();
    expect(parseAuthSessionList([sessionEntry(), sessionEntry({ isCurrent: "yes" })])).toBeNull();
    expect(parseAuthSessionList([sessionEntry({ id: "" })])).toBeNull();
  });
});

describe("isSafeSessionRowId", () => {
  it("accepts a UUID-shaped id", () => {
    expect(isSafeSessionRowId("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("rejects empty, whitespace, separator, and non-string ids", () => {
    expect(isSafeSessionRowId("")).toBe(false);
    expect(isSafeSessionRowId("a b")).toBe(false);
    expect(isSafeSessionRowId("a/b")).toBe(false);
    expect(isSafeSessionRowId("a?b")).toBe(false);
    expect(isSafeSessionRowId("a#b")).toBe(false);
    expect(isSafeSessionRowId(42)).toBe(false);
    expect(isSafeSessionRowId(null)).toBe(false);
  });
});

describe("getMe and listSessions", () => {
  it("returns parsed metadata from GET /api/auth/me without a CSRF header", async () => {
    const { fetchFn, calls } = makeFetch(
      tableResponder({ "GET /api/auth/me": jsonResponse(200, successEnvelope(meData())) }),
    );
    const client = createAuthSessionClient({ fetchFn });
    const me = await client.getMe();
    expect(me.email).toBe("owner@example.test");
    expect(me.session.deviceLabel).toBe("Test Browser");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.credentials).toBe("include");
    expect(calls[0]?.headers["X-CSRF-Token"]).toBeUndefined();
  });

  it("throws a local SERVER_ERROR when the 200 body has the wrong shape", async () => {
    const { fetchFn } = makeFetch(
      tableResponder({ "GET /api/auth/me": jsonResponse(200, successEnvelope({ nope: true })) }),
    );
    const client = createAuthSessionClient({ fetchFn });
    await expect(client.getMe()).rejects.toMatchObject({
      localCode: "SERVER_ERROR",
      status: null,
    });
  });

  it("returns the session list in server order", async () => {
    const { fetchFn } = makeFetch(
      tableResponder({
        "GET /api/auth/sessions": jsonResponse(
          200,
          successEnvelope([sessionEntry(), sessionEntry({ id: "sess-2", isCurrent: false })]),
        ),
      }),
    );
    const client = createAuthSessionClient({ fetchFn });
    const list = await client.listSessions();
    expect(list.map((entry) => entry.id)).toEqual(["sess-1", "sess-2"]);
  });

  it("throws a local SERVER_ERROR when the session list is malformed", async () => {
    const { fetchFn } = makeFetch(
      tableResponder({
        "GET /api/auth/sessions": jsonResponse(200, successEnvelope([{ id: "only-id" }])),
      }),
    );
    const client = createAuthSessionClient({ fetchFn });
    await expect(client.listSessions()).rejects.toMatchObject({ localCode: "SERVER_ERROR" });
  });

  it("notifies expiry listeners exactly once on a 401 and marks the session expired", async () => {
    const { fetchFn } = makeFetch(
      tableResponder({ "GET /api/auth/me": jsonResponse(401, errorEnvelope("unauthenticated")) }),
    );
    const client = createAuthSessionClient({ fetchFn });
    const events: number[] = [];
    client.subscribeToSessionExpiry((event) => {
      events.push(event.status);
    });
    await expect(client.getMe()).rejects.toBeInstanceOf(ApiError);
    await expect(client.getMe()).rejects.toBeInstanceOf(ApiError);
    expect(client.getSessionStatus()).toBe("expired");
    expect(events).toEqual([401]);
  });
});

describe("CSRF token lifecycle", () => {
  it("sends a seeded token without fetching from GET /api/auth/csrf", async () => {
    const { fetchFn, calls } = makeFetch(
      tableResponder({ "POST /api/auth/logout": jsonResponse(200, successEnvelope(null)) }),
    );
    const client = createAuthSessionClient({ fetchFn });
    // Seed first so logout success does not clear the copy under test.
    client.seedCsrfToken("tok-seeded");
    await client.logout();
    expect(client.hasCsrfToken()).toBe(false);
    const csrfCalls = calls.filter((call) => call.url === "/api/auth/csrf");
    expect(csrfCalls).toHaveLength(0);
    const logoutCall = calls.find((call) => call.url === "/api/auth/logout");
    expect(logoutCall?.headers["X-CSRF-Token"]).toBe("tok-seeded");
  });

  it("refetches the token after a reload: a fresh client fetches again", async () => {
    const { fetchFn, calls } = makeFetch(
      tableResponder({ "POST /api/auth/logout": jsonResponse(200, successEnvelope(null)) }),
    );
    const first = createAuthSessionClient({ fetchFn });
    await first.ensureCsrfToken();
    expect(calls.filter((call) => call.url === "/api/auth/csrf")).toHaveLength(1);
    await first.ensureCsrfToken();
    expect(calls.filter((call) => call.url === "/api/auth/csrf")).toHaveLength(1);
    // A reload loses module memory, modelled by a fresh client.
    const reloaded = createAuthSessionClient({ fetchFn });
    expect(reloaded.hasCsrfToken()).toBe(false);
    await reloaded.ensureCsrfToken();
    expect(calls.filter((call) => call.url === "/api/auth/csrf")).toHaveLength(2);
  });

  it("refreshCsrfToken discards the cached token and fetches a fresh one", async () => {
    const { fetchFn, calls } = makeFetch(tableResponder({}, ["tok-old", "tok-new"]));
    const client = createAuthSessionClient({ fetchFn });
    await expect(client.ensureCsrfToken()).resolves.toBe("tok-old");
    await expect(client.refreshCsrfToken()).resolves.toBe("tok-new");
    await expect(client.ensureCsrfToken()).resolves.toBe("tok-new");
    expect(calls.filter((call) => call.url === "/api/auth/csrf")).toHaveLength(2);
  });

  it("a 401 from GET /api/auth/csrf is a session expiry, not a token", async () => {
    const { fetchFn } = makeFetch((call) => {
      if (call.url === "/api/auth/csrf") {
        return jsonResponse(401, errorEnvelope("unauthenticated"));
      }
      return jsonResponse(404, errorEnvelope("not_found"));
    });
    const client = createAuthSessionClient({ fetchFn });
    const error = await client.ensureCsrfToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CsrfTokenError);
    expect((error as CsrfTokenError).sessionExpired).toBe(true);
    expect(client.hasCsrfToken()).toBe(false);
  });

  it("never calls localStorage or sessionStorage across the session lifecycle", async () => {
    const storageCalls: string[] = [];
    const spyStorage = {
      getItem: (key: string) => {
        storageCalls.push(`get:${key}`);
        return null;
      },
      setItem: (key: string) => {
        storageCalls.push(`set:${key}`);
      },
      removeItem: (key: string) => {
        storageCalls.push(`remove:${key}`);
      },
      clear: () => {
        storageCalls.push("clear");
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
      const { fetchFn } = makeFetch(
        tableResponder({
          "GET /api/auth/me": jsonResponse(200, successEnvelope(meData())),
          "GET /api/auth/sessions": jsonResponse(200, successEnvelope([sessionEntry()])),
          "POST /api/auth/logout": jsonResponse(200, successEnvelope(null)),
        }),
      );
      const client: AuthSessionClient = createAuthSessionClient({ fetchFn });
      client.seedCsrfToken("tok-spy");
      await client.getMe();
      await client.listSessions();
      await client.refreshCsrfToken();
      await client.logout();
      client.clearCsrfToken();
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
    expect(storageCalls).toEqual([]);
  });
});

describe("revokeSession", () => {
  it("sends DELETE with the fetched token and the encoded row id", async () => {
    const { fetchFn, calls } = makeFetch(
      tableResponder({
        "DELETE /api/auth/sessions/sess-2": jsonResponse(200, successEnvelope(null)),
      }),
    );
    const client = createAuthSessionClient({ fetchFn });
    await client.revokeSession("sess-2");
    const csrfCall = calls.find((call) => call.url === "/api/auth/csrf");
    const deleteCall = calls.find((call) => call.method === "DELETE");
    expect(csrfCall).toBeDefined();
    expect(deleteCall?.headers["X-CSRF-Token"]).toBe("tok-1");
    expect(client.hasCsrfToken()).toBe(true);
  });

  it("refreshes the token once on csrf_invalid and retries the DELETE once", async () => {
    let deleteCount = 0;
    const seenTokens: Array<string | undefined> = [];
    const { fetchFn, calls } = makeFetch((call) => {
      if (call.url === "/api/auth/csrf") {
        return jsonResponse(
          200,
          successEnvelope({ csrfToken: deleteCount === 0 ? "tok-stale" : "tok-fresh" }),
        );
      }
      if (call.method === "DELETE") {
        deleteCount += 1;
        seenTokens.push(call.headers["X-CSRF-Token"]);
        if (deleteCount === 1) {
          return jsonResponse(403, errorEnvelope("csrf_invalid"));
        }
        return jsonResponse(200, successEnvelope(null));
      }
      return jsonResponse(404, errorEnvelope("not_found"));
    });
    const client = createAuthSessionClient({ fetchFn });
    await client.revokeSession("sess-2");
    expect(deleteCount).toBe(2);
    expect(seenTokens).toEqual(["tok-stale", "tok-fresh"]);
    expect(calls.filter((call) => call.url === "/api/auth/csrf")).toHaveLength(2);
  });

  it("fails explicitly on a second csrf_invalid and clears the token", async () => {
    const { fetchFn } = makeFetch((call) => {
      if (call.url === "/api/auth/csrf") {
        return jsonResponse(200, successEnvelope({ csrfToken: "tok-1" }));
      }
      if (call.method === "DELETE") {
        return jsonResponse(403, errorEnvelope("csrf_invalid"));
      }
      return jsonResponse(404, errorEnvelope("not_found"));
    });
    const client = createAuthSessionClient({ fetchFn });
    await expect(client.revokeSession("sess-2")).rejects.toMatchObject({
      status: 403,
      code: "csrf_invalid",
    });
    expect(client.hasCsrfToken()).toBe(false);
  });

  it("does not refresh on other 403 codes", async () => {
    let deleteCount = 0;
    const { fetchFn, calls } = makeFetch((call) => {
      if (call.url === "/api/auth/csrf") {
        return jsonResponse(200, successEnvelope({ csrfToken: "tok-1" }));
      }
      if (call.method === "DELETE") {
        deleteCount += 1;
        return jsonResponse(403, errorEnvelope("forbidden"));
      }
      return jsonResponse(404, errorEnvelope("not_found"));
    });
    const client = createAuthSessionClient({ fetchFn });
    await expect(client.revokeSession("sess-2")).rejects.toMatchObject({ code: "forbidden" });
    expect(deleteCount).toBe(1);
    expect(calls.filter((call) => call.url === "/api/auth/csrf")).toHaveLength(1);
  });

  it("rejects an unsafe id before any fetch and surfaces a server 404 unchanged", async () => {
    const { fetchFn, calls } = makeFetch(tableResponder({}));
    const client = createAuthSessionClient({ fetchFn });
    await expect(client.revokeSession("a/b")).rejects.toMatchObject({
      localCode: "VALIDATION_ERROR",
    });
    expect(calls).toHaveLength(0);
    await expect(client.revokeSession("missing-id")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("clears the token when revoking the current session", async () => {
    const { fetchFn } = makeFetch(
      tableResponder({
        "DELETE /api/auth/sessions/sess-1": jsonResponse(200, successEnvelope(null)),
      }),
    );
    const client = createAuthSessionClient({ fetchFn });
    await client.ensureCsrfToken();
    expect(client.hasCsrfToken()).toBe(true);
    await client.revokeSession("sess-1", { isCurrent: true });
    expect(client.hasCsrfToken()).toBe(false);
  });
});

describe("logout and logoutAll", () => {
  it("logout clears the token on success", async () => {
    const { fetchFn } = makeFetch(
      tableResponder({ "POST /api/auth/logout": jsonResponse(200, successEnvelope(null)) }),
    );
    const client = createAuthSessionClient({ fetchFn });
    await client.ensureCsrfToken();
    await client.logout();
    expect(client.hasCsrfToken()).toBe(false);
  });

  it("logout treats a 401 as already logged out", async () => {
    const { fetchFn } = makeFetch(
      tableResponder({ "POST /api/auth/logout": jsonResponse(401, errorEnvelope("unauthenticated")) }),
    );
    const client = createAuthSessionClient({ fetchFn });
    client.seedCsrfToken("tok-seeded");
    await expect(client.logout()).resolves.toBeUndefined();
    expect(client.hasCsrfToken()).toBe(false);
    expect(client.getSessionStatus()).toBe("expired");
  });

  it("logout propagates a server error and keeps the token for a retry", async () => {
    const { fetchFn } = makeFetch(
      tableResponder({
        "POST /api/auth/logout": jsonResponse(503, errorEnvelope("service_unavailable")),
      }),
    );
    const client = createAuthSessionClient({ fetchFn });
    client.seedCsrfToken("tok-seeded");
    await expect(client.logout()).rejects.toMatchObject({ status: 503 });
    expect(client.hasCsrfToken()).toBe(true);
  });

  it("logoutAll surfaces step_up_required unchanged and keeps the token", async () => {
    const { fetchFn } = makeFetch(
      tableResponder({
        "POST /api/auth/logout-all": jsonResponse(403, errorEnvelope("step_up_required")),
      }),
    );
    const client = createAuthSessionClient({ fetchFn });
    client.seedCsrfToken("tok-seeded");
    await expect(client.logoutAll()).rejects.toMatchObject({
      status: 403,
      code: "step_up_required",
    });
    expect(client.hasCsrfToken()).toBe(true);
  });

  it("logoutAll clears the token on success", async () => {
    const { fetchFn } = makeFetch(
      tableResponder({ "POST /api/auth/logout-all": jsonResponse(200, successEnvelope(null)) }),
    );
    const client = createAuthSessionClient({ fetchFn });
    await client.ensureCsrfToken();
    await client.logoutAll();
    expect(client.hasCsrfToken()).toBe(false);
  });
});

describe("seedCsrfToken", () => {
  it("seeds the token without fetching and resets an expired status", async () => {
    const { fetchFn, calls } = makeFetch(
      tableResponder({
        "GET /api/auth/me": jsonResponse(401, errorEnvelope("unauthenticated")),
        "POST /api/auth/logout": jsonResponse(200, successEnvelope(null)),
      }),
    );
    const client = createAuthSessionClient({ fetchFn });
    await expect(client.getMe()).rejects.toBeInstanceOf(ApiError);
    expect(client.getSessionStatus()).toBe("expired");
    client.seedCsrfToken("tok-login");
    expect(client.getSessionStatus()).toBe("unknown");
    await client.logout();
    const logoutCall = calls.find((call) => call.url === "/api/auth/logout");
    expect(logoutCall?.headers["X-CSRF-Token"]).toBe("tok-login");
    expect(calls.filter((call) => call.url === "/api/auth/csrf")).toHaveLength(0);
  });

  it("rejects an unusable token", () => {
    const { fetchFn } = makeFetch(tableResponder({}));
    const client = createAuthSessionClient({ fetchFn });
    expect(() => client.seedCsrfToken("")).toThrow(TypeError);
    expect(() => client.seedCsrfToken("has space")).toThrow(TypeError);
  });
});

describe("login paths", () => {
  it("keeps the plain login path for logout and the expiry path for expired sessions", () => {
    expect(SESSION_LOGIN_PATH).toBe("/login");
    expect(SESSION_EXPIRED_LOGIN_PATH).toBe("/login?expired=1");
  });
});

interface PageFakeResponse {
  status: number;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
}

interface PageCapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function pageJsonResponse(status: number, body: unknown): PageFakeResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function pageSuccessEnvelope(data: unknown): unknown {
  return { ok: true, data };
}

function pageErrorEnvelope(code: string, status: number): unknown {
  return {
    ok: false,
    error: { code, message: "generic", requestId: `req-${status}`, retryable: false, details: {} },
  };
}

function asFetchFn(
  fn: (url: string, init?: RequestInit) => Promise<PageFakeResponse>,
): typeof fetch {
  return fn as unknown as typeof fetch;
}

function capturingFetch(
  calls: PageCapturedCall[],
  behavior: (url: string, init?: RequestInit) => Promise<PageFakeResponse>,
): typeof fetch {
  return asFetchFn(async (url, init) => {
    calls.push({ url, init });
    return behavior(url, init);
  });
}

function headerOf(call: PageCapturedCall, name: string): string | undefined {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

function bodyOf(call: PageCapturedCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body ?? "{}")) as Record<string, unknown>;
}

const LOGIN_SUCCESS = {
  id: "user-1",
  email: "op@example.com",
  role: "admin",
  totpEnabled: false,
  csrfToken: "csrf-token-value",
  sessionExpiresAt: "2026-12-16T00:00:00.000Z",
};

const ME_BODY = {
  id: "user-1",
  email: "op@example.com",
  role: "admin",
  totpEnabled: true,
  createdAt: "2026-11-01T00:00:00.000Z",
  lastLoginAt: "2026-11-16T00:00:00.000Z",
  workspaceId: "ws-1",
  session: {
    id: "session-row-1",
    deviceLabel: "Test device",
    createdAt: "2026-11-16T00:00:00.000Z",
    lastSeenAt: "2026-11-16T00:00:00.000Z",
    absoluteExpiresAt: "2026-12-16T00:00:00.000Z",
    stepUpAt: null,
  },
};

describe("parseLoginSuccess", () => {
  it("accepts the contract 200 shape", () => {
    expect(parseLoginSuccess(LOGIN_SUCCESS)).toEqual(LOGIN_SUCCESS);
  });

  it("ignores unknown extra fields", () => {
    expect(parseLoginSuccess({ ...LOGIN_SUCCESS, future: "x" })).toEqual(LOGIN_SUCCESS);
  });

  it("rejects a missing csrfToken", () => {
    expect(
      parseLoginSuccess({
        id: LOGIN_SUCCESS.id,
        email: LOGIN_SUCCESS.email,
        role: LOGIN_SUCCESS.role,
        totpEnabled: LOGIN_SUCCESS.totpEnabled,
        sessionExpiresAt: LOGIN_SUCCESS.sessionExpiresAt,
      }),
    ).toBeNull();
  });

  it("rejects a csrfToken containing whitespace", () => {
    expect(parseLoginSuccess({ ...LOGIN_SUCCESS, csrfToken: "has space" })).toBeNull();
  });

  it("rejects an unknown role", () => {
    expect(parseLoginSuccess({ ...LOGIN_SUCCESS, role: "super" })).toBeNull();
  });

  it("rejects a non-boolean totpEnabled", () => {
    expect(parseLoginSuccess({ ...LOGIN_SUCCESS, totpEnabled: "yes" })).toBeNull();
  });

  it("rejects non-objects and arrays", () => {
    expect(parseLoginSuccess(null)).toBeNull();
    expect(parseLoginSuccess("ok")).toBeNull();
    expect(parseLoginSuccess([LOGIN_SUCCESS])).toBeNull();
  });
});

describe("parseLoginResponse", () => {
  it("reads the 202 challenge shape", () => {
    expect(parseLoginResponse({ challengeToken: "challenge-1", step: "totp" })).toEqual({
      outcome: "totp_required",
      challenge: { challengeToken: "challenge-1" },
    });
  });

  it("reads the 200 success shape", () => {
    expect(parseLoginResponse(LOGIN_SUCCESS)).toEqual({
      outcome: "authenticated",
      session: LOGIN_SUCCESS,
    });
  });

  it("rejects a challenge token without the totp step", () => {
    expect(parseLoginResponse({ challengeToken: "challenge-1" })).toBeNull();
  });

  it("rejects an empty body", () => {
    expect(parseLoginResponse({})).toBeNull();
    expect(parseLoginResponse(null)).toBeNull();
  });
});

describe("parseSetupResult and parseCurrentAccount", () => {
  it("accepts the contract 201 setup shape", () => {
    expect(
      parseSetupResult({ id: "user-1", email: "op@example.com", workspaceId: "ws-1" }),
    ).toEqual({ id: "user-1", email: "op@example.com", workspaceId: "ws-1" });
  });

  it("rejects a setup body without a workspace id", () => {
    expect(parseSetupResult({ id: "user-1", email: "op@example.com" })).toBeNull();
  });

  it("accepts the full me shape", () => {
    expect(parseCurrentAccount(ME_BODY)).toEqual(ME_BODY);
  });

  it("accepts a minimal me shape without session metadata", () => {
    expect(
      parseCurrentAccount({ id: "u", email: "a@b.c", role: "user", totpEnabled: false }),
    ).toEqual({
      id: "u",
      email: "a@b.c",
      role: "user",
      totpEnabled: false,
      createdAt: null,
      lastLoginAt: null,
      workspaceId: null,
      session: null,
    });
  });

  it("rejects a me body with a malformed session", () => {
    expect(parseCurrentAccount({ ...ME_BODY, session: { id: "only" } })).toBeNull();
  });

  it("rejects a me body with an unknown role", () => {
    expect(parseCurrentAccount({ ...ME_BODY, role: "root" })).toBeNull();
  });
});

describe("input helpers", () => {
  it("normalizes email by trimming and lowercasing", () => {
    expect(normalizeEmail("  Op@Example.COM ")).toBe("op@example.com");
  });

  it("accepts only 6-digit TOTP codes", () => {
    expect(isValidTotpCode("123456")).toBe(true);
    expect(isValidTotpCode(" 123456 ")).toBe(true);
    expect(isValidTotpCode("12345")).toBe(false);
    expect(isValidTotpCode("1234567")).toBe(false);
    expect(isValidTotpCode("12345a")).toBe(false);
    expect(isValidTotpCode("")).toBe(false);
  });

  it("enforces the 12 to 128 password length rule", () => {
    expect(isValidSetupPassword("short")).toBe(false);
    expect(isValidSetupPassword("twelve-chars")).toBe(true);
    expect(isValidSetupPassword("x".repeat(128))).toBe(true);
    expect(isValidSetupPassword("x".repeat(129))).toBe(false);
  });
});

describe("resolvePostLoginTarget", () => {
  it("defaults to / for missing values", () => {
    expect(resolvePostLoginTarget(null)).toBe("/");
    expect(resolvePostLoginTarget(undefined)).toBe("/");
    expect(resolvePostLoginTarget("")).toBe("/");
  });

  it("keeps legitimate internal paths with query and hash", () => {
    expect(resolvePostLoginTarget("/core/main")).toBe("/core/main");
    expect(resolvePostLoginTarget("/core/main?tab=1#top")).toBe("/core/main?tab=1#top");
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(resolvePostLoginTarget("https://evil.example/")).toBe("/");
    expect(resolvePostLoginTarget("//evil.example/")).toBe("/");
  });

  it("rejects the login and setup pages themselves", () => {
    expect(resolvePostLoginTarget("/login")).toBe("/");
    expect(resolvePostLoginTarget("/login?next=/core/main")).toBe("/");
    expect(resolvePostLoginTarget("/setup")).toBe("/");
    expect(resolvePostLoginTarget("/setup#top")).toBe("/");
  });

  it("keeps paths that merely start with the same letters", () => {
    expect(resolvePostLoginTarget("/login-history")).toBe("/login-history");
  });

  it("rejects backslashes and whitespace", () => {
    expect(resolvePostLoginTarget("/core\\main")).toBe("/");
    expect(resolvePostLoginTarget("/core main")).toBe("/");
  });
});

describe("toAuthClientError", () => {
  function wireError(wireCode: string, status: number): ApiError {
    return new ApiError({ localCode: "AUTH_REQUIRED", wireCode, status, requestId: "r-1" });
  }

  it("maps the auth wire codes", () => {
    expect(toAuthClientError(wireError("invalid_credentials", 401), "login").code).toBe(
      "INVALID_CREDENTIALS",
    );
    expect(toAuthClientError(wireError("invalid_verification_code", 401), "totp").code).toBe(
      "INVALID_VERIFICATION_CODE",
    );
    expect(toAuthClientError(wireError("invalid_setup_token", 401), "setup").code).toBe(
      "INVALID_SETUP_TOKEN",
    );
    expect(toAuthClientError(wireError("not_found", 404), "setup").code).toBe("SETUP_CLOSED");
    expect(toAuthClientError(wireError("validation_failed", 400), "setup").code).toBe(
      "VALIDATION_FAILED",
    );
    expect(toAuthClientError(wireError("rate_limited", 429), "login").code).toBe("RATE_LIMITED");
    expect(toAuthClientError(wireError("unauthenticated", 401), "me").code).toBe("SESSION_EXPIRED");
    expect(toAuthClientError(wireError("csrf_invalid", 403), "me").code).toBe("REQUEST_REJECTED");
    expect(toAuthClientError(wireError("origin_rejected", 403), "me").code).toBe(
      "REQUEST_REJECTED",
    );
    expect(toAuthClientError(wireError("step_up_required", 403), "me").code).toBe(
      "STEP_UP_REQUIRED",
    );
  });

  it("falls back to status when the wire code is unknown", () => {
    expect(toAuthClientError(wireError("something_new", 401), "login").code).toBe(
      "INVALID_CREDENTIALS",
    );
    expect(toAuthClientError(wireError("something_new", 401), "me").code).toBe("SESSION_EXPIRED");
    expect(toAuthClientError(wireError("something_new", 500), "login").code).toBe("SERVER_ERROR");
  });

  it("maps transport failures to NETWORK_ERROR", () => {
    const network = new ApiError({ localCode: "NETWORK_ERROR", wireCode: null, status: null });
    expect(toAuthClientError(network, "login").code).toBe("NETWORK_ERROR");
    const timeout = new ApiError({ localCode: "TIMEOUT", wireCode: null, status: null });
    expect(toAuthClientError(timeout, "login").code).toBe("NETWORK_ERROR");
  });

  it("maps unknown throws to SERVER_ERROR and passes AuthClientError through", () => {
    expect(toAuthClientError(new TypeError("boom"), "login").code).toBe("SERVER_ERROR");
    const original = new AuthClientError("RATE_LIMITED");
    expect(toAuthClientError(original, "login")).toBe(original);
  });

  it("never puts the wire message in the error message", () => {
    const secretLike = "token-value-that-must-not-leak";
    const error = new ApiError({
      localCode: "AUTH_REQUIRED",
      wireCode: "invalid_credentials",
      status: 401,
      wireMessage: secretLike,
    });
    expect(toAuthClientError(error, "login").message).not.toContain(secretLike);
  });
});

describe("loginWithPassword", () => {
  function sessionFor(behavior: (url: string, init?: RequestInit) => Promise<PageFakeResponse>): {
    session: AuthSession;
    calls: PageCapturedCall[];
  } {
    const calls: PageCapturedCall[] = [];
    const session = createAuthSession({ fetchFn: capturingFetch(calls, behavior) });
    return { session, calls };
  }

  it("sends a pre-session request and seeds the seam on 200", async () => {
    const { session, calls } = sessionFor(async () =>
      pageJsonResponse(200, pageSuccessEnvelope(LOGIN_SUCCESS)),
    );
    const result = await loginWithPassword(session, {
      email: "  OP@Example.com ",
      password: "  keep-spaces  ",
    });
    expect(result).toEqual({ outcome: "authenticated", session: LOGIN_SUCCESS });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(LOGIN_ENDPOINT);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.credentials).toBe("include");
    expect(headerOf(calls[0], "X-CSRF-Token")).toBeUndefined();
    expect(bodyOf(calls[0])).toEqual({ email: "op@example.com", password: "  keep-spaces  " });
    expect(session.seam.csrf.hasToken()).toBe(true);
    expect(session.seam.getSessionStatus()).toBe("active");
  });

  it("returns the challenge on 202 without seeding a token", async () => {
    const { session, calls } = sessionFor(async () =>
      pageJsonResponse(202, pageSuccessEnvelope({ challengeToken: "challenge-1", step: "totp" })),
    );
    const result = await loginWithPassword(session, {
      email: "op@example.com",
      password: "a-password-value",
    });
    expect(result).toEqual({
      outcome: "totp_required",
      challenge: { challengeToken: "challenge-1" },
    });
    expect(calls).toHaveLength(1);
    expect(session.seam.csrf.hasToken()).toBe(false);
    expect(session.seam.getSessionStatus()).toBe("unknown");
  });

  it("maps a 401 to INVALID_CREDENTIALS without notifying expiry listeners", async () => {
    const { session } = sessionFor(async () =>
      pageJsonResponse(401, pageErrorEnvelope("invalid_credentials", 401)),
    );
    const seen: unknown[] = [];
    session.seam.subscribeToSessionExpiry((event) => {
      seen.push(event);
    });
    await expect(
      loginWithPassword(session, { email: "op@example.com", password: "wrong-password" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(seen).toHaveLength(0);
    expect(session.seam.getSessionStatus()).toBe("unknown");
  });

  it("maps a 429 to RATE_LIMITED", async () => {
    const { session } = sessionFor(async () =>
      pageJsonResponse(429, pageErrorEnvelope("rate_limited", 429)),
    );
    await expect(
      loginWithPassword(session, { email: "op@example.com", password: "a-password-value" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("fails closed on a 200 with an unrecognized body", async () => {
    const { session } = sessionFor(async () => pageJsonResponse(200, pageSuccessEnvelope({ nope: true })));
    await expect(
      loginWithPassword(session, { email: "op@example.com", password: "a-password-value" }),
    ).rejects.toMatchObject({ code: "SERVER_ERROR" });
    expect(session.seam.csrf.hasToken()).toBe(false);
  });

  it("rejects empty credentials without a request", async () => {
    const { session, calls } = sessionFor(async () =>
      pageJsonResponse(200, pageSuccessEnvelope(LOGIN_SUCCESS)),
    );
    await expect(loginWithPassword(session, { email: "  ", password: "x" })).rejects.toMatchObject(
      { code: "VALIDATION_FAILED" },
    );
    await expect(
      loginWithPassword(session, { email: "op@example.com", password: "" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(calls).toHaveLength(0);
  });

  it("maps a fetch rejection to NETWORK_ERROR", async () => {
    const session = createAuthSession({
      fetchFn: asFetchFn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    await expect(
      loginWithPassword(session, { email: "op@example.com", password: "a-password-value" }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});

describe("loginWithTotp", () => {
  it("sends exactly one code field for a TOTP code", async () => {
    const calls: PageCapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () => pageJsonResponse(200, pageSuccessEnvelope(LOGIN_SUCCESS))),
    });
    const result = await loginWithTotp(session, { challengeToken: "challenge-1", code: "123456" });
    expect(result).toEqual(LOGIN_SUCCESS);
    expect(calls[0].url).toBe(LOGIN_TOTP_ENDPOINT);
    expect(headerOf(calls[0], "X-CSRF-Token")).toBeUndefined();
    expect(bodyOf(calls[0])).toEqual({ challengeToken: "challenge-1", code: "123456" });
    expect(session.seam.csrf.hasToken()).toBe(true);
  });

  it("sends only the recovery code for recovery verification", async () => {
    const calls: PageCapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () => pageJsonResponse(200, pageSuccessEnvelope(LOGIN_SUCCESS))),
    });
    await loginWithTotp(session, {
      challengeToken: "challenge-1",
      recoveryCode: "  ABCD-1234 ",
    });
    expect(bodyOf(calls[0])).toEqual({ challengeToken: "challenge-1", recoveryCode: "ABCD-1234" });
  });

  it("rejects a malformed code without a request", async () => {
    const calls: PageCapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () => pageJsonResponse(200, pageSuccessEnvelope(LOGIN_SUCCESS))),
    });
    await expect(
      loginWithTotp(session, { challengeToken: "challenge-1", code: "12345" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      loginWithTotp(session, { challengeToken: "", code: "123456" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(calls).toHaveLength(0);
  });

  it("maps a 401 to INVALID_VERIFICATION_CODE", async () => {
    const session = createAuthSession({
      fetchFn: asFetchFn(async () =>
        pageJsonResponse(401, pageErrorEnvelope("invalid_verification_code", 401)),
      ),
    });
    await expect(
      loginWithTotp(session, { challengeToken: "challenge-1", code: "123456" }),
    ).rejects.toMatchObject({ code: "INVALID_VERIFICATION_CODE" });
    expect(session.seam.csrf.hasToken()).toBe(false);
  });
});

describe("createFirstAccount", () => {
  it("sends the setup body and omits a blank workspace name", async () => {
    const calls: PageCapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () =>
        pageJsonResponse(201, pageSuccessEnvelope({ id: "u", email: "op@example.com", workspaceId: "w" })),
      ),
    });
    const result = await createFirstAccount(session, {
      setupToken: "  setup-token-value ",
      email: "OP@Example.com",
      password: "a-long-enough-password",
      workspaceName: "   ",
    });
    expect(result).toEqual({ id: "u", email: "op@example.com", workspaceId: "w" });
    expect(calls[0].url).toBe(SETUP_ENDPOINT);
    expect(headerOf(calls[0], "X-CSRF-Token")).toBeUndefined();
    expect(bodyOf(calls[0])).toEqual({
      setupToken: "setup-token-value",
      email: "op@example.com",
      password: "a-long-enough-password",
    });
    expect(session.seam.csrf.hasToken()).toBe(false);
  });

  it("includes a workspace name when one is given", async () => {
    const calls: PageCapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () =>
        pageJsonResponse(201, pageSuccessEnvelope({ id: "u", email: "op@example.com", workspaceId: "w" })),
      ),
    });
    await createFirstAccount(session, {
      setupToken: "tok",
      email: "op@example.com",
      password: "a-long-enough-password",
      workspaceName: "  My Vault ",
    });
    expect(bodyOf(calls[0]).workspaceName).toBe("My Vault");
  });

  it("maps a 404 to SETUP_CLOSED", async () => {
    const session = createAuthSession({
      fetchFn: asFetchFn(async () => pageJsonResponse(404, pageErrorEnvelope("not_found", 404))),
    });
    await expect(
      createFirstAccount(session, {
        setupToken: "tok",
        email: "op@example.com",
        password: "a-long-enough-password",
      }),
    ).rejects.toMatchObject({ code: "SETUP_CLOSED" });
  });

  it("maps a 401 to INVALID_SETUP_TOKEN", async () => {
    const session = createAuthSession({
      fetchFn: asFetchFn(async () =>
        pageJsonResponse(401, pageErrorEnvelope("invalid_setup_token", 401)),
      ),
    });
    await expect(
      createFirstAccount(session, {
        setupToken: "tok",
        email: "op@example.com",
        password: "a-long-enough-password",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SETUP_TOKEN" });
  });

  it("rejects a short password without a request", async () => {
    const calls: PageCapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () =>
        pageJsonResponse(201, pageSuccessEnvelope({ id: "u", email: "e", workspaceId: "w" })),
      ),
    });
    await expect(
      createFirstAccount(session, { setupToken: "tok", email: "op@example.com", password: "short" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(calls).toHaveLength(0);
  });
});

describe("fetchCurrentAccount", () => {
  it("returns the account and marks the session active on 200", async () => {
    const calls: PageCapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () => pageJsonResponse(200, pageSuccessEnvelope(ME_BODY))),
    });
    const account = await fetchCurrentAccount(session);
    expect(account).toEqual(ME_BODY);
    expect(calls[0].url).toBe(ME_ENDPOINT);
    expect(calls[0].init?.method).toBe("GET");
    expect(session.seam.getSessionStatus()).toBe("active");
  });

  it("returns null on 401 and notifies expiry listeners through the wired client", async () => {
    const session = createAuthSession({
      fetchFn: asFetchFn(async () => pageJsonResponse(401, pageErrorEnvelope("unauthenticated", 401))),
    });
    const seen: unknown[] = [];
    session.seam.subscribeToSessionExpiry((event) => {
      seen.push(event);
    });
    await expect(fetchCurrentAccount(session)).resolves.toBeNull();
    expect(seen).toHaveLength(1);
    expect(session.seam.getSessionStatus()).toBe("expired");
  });

  it("throws on a 500 and on a malformed 200 body", async () => {
    const failing = createAuthSession({
      fetchFn: asFetchFn(async () => pageJsonResponse(500, pageErrorEnvelope("internal_error", 500))),
    });
    await expect(fetchCurrentAccount(failing)).rejects.toMatchObject({ code: "SERVER_ERROR" });
    const malformed = createAuthSession({
      fetchFn: asFetchFn(async () => pageJsonResponse(200, pageSuccessEnvelope({ nope: true }))),
    });
    await expect(fetchCurrentAccount(malformed)).rejects.toMatchObject({ code: "SERVER_ERROR" });
  });
});

describe("no token in web storage", () => {
  it("never calls localStorage or sessionStorage during page auth calls", async () => {
    const calls: string[] = [];
    const recorder = {
      getItem: (...args: unknown[]) => {
        calls.push(`get:${String(args[0])}`);
        return null;
      },
      setItem: (...args: unknown[]) => {
        calls.push(`set:${String(args[0])}`);
      },
      removeItem: (...args: unknown[]) => {
        calls.push(`remove:${String(args[0])}`);
      },
      clear: () => {
        calls.push("clear");
      },
      key: () => null,
      length: 0,
    };
    const scope = globalThis as Record<string, unknown>;
    const previousLocal = scope.localStorage;
    const previousSession = scope.sessionStorage;
    scope.localStorage = recorder;
    scope.sessionStorage = recorder;
    try {
      const session = createAuthSession({
        fetchFn: asFetchFn(async (url) => {
          if (url === ME_ENDPOINT) {
            return pageJsonResponse(200, pageSuccessEnvelope(ME_BODY));
          }
          if (url === SETUP_ENDPOINT) {
            return pageJsonResponse(
              201,
              pageSuccessEnvelope({ id: "u", email: "op@example.com", workspaceId: "w" }),
            );
          }
          return pageJsonResponse(200, pageSuccessEnvelope(LOGIN_SUCCESS));
        }),
      });
      await loginWithPassword(session, { email: "op@example.com", password: "a-password-value" });
      await loginWithTotp(session, { challengeToken: "challenge-1", code: "123456" });
      await createFirstAccount(session, {
        setupToken: "tok",
        email: "op@example.com",
        password: "a-long-enough-password",
      });
      await fetchCurrentAccount(session);
      expect(calls).toEqual([]);
    } finally {
      if (previousLocal === undefined) {
        delete scope.localStorage;
      } else {
        scope.localStorage = previousLocal;
      }
      if (previousSession === undefined) {
        delete scope.sessionStorage;
      } else {
        scope.sessionStorage = previousSession;
      }
    }
  });
});
