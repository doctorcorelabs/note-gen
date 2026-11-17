// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for the session part of src/lib/web/auth-client.ts
// (Fase 1, V3-03 slot 03b).
//
// Runner: Vitest, unit project (vitest run --project unit). The
// suite uses fake fetch implementations only; no test sends HTTP
// and no test touches the DOM, navigation, or any storage API.
// A dedicated case installs recording localStorage/sessionStorage
// spies to prove the client never calls them, and a grep gate in
// the task report proves the module source contains no storage
// access at all.

import { describe, expect, it } from "vitest";

import {
  createAuthSessionClient,
  isSafeSessionRowId,
  parseAuthMeData,
  parseAuthSessionList,
  SESSION_EXPIRED_LOGIN_PATH,
  SESSION_LOGIN_PATH,
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
