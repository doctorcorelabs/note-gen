// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for src/lib/web/auth-client.ts (Fase 1, V3-03a).
//
// Runner: Vitest, unit project (vitest run --project unit). The
// suite uses fake fetch implementations only; no test sends HTTP
// and no test touches the DOM, navigation, or any storage API. A
// dedicated case installs recording storage spies to prove the
// page auth calls never write a token to web storage.

import { describe, expect, it } from "vitest";

import {
  AuthClientError,
  createAuthSession,
  createFirstAccount,
  fetchCurrentAccount,
  isValidSetupPassword,
  isValidTotpCode,
  LOGIN_ENDPOINT,
  LOGIN_TOTP_ENDPOINT,
  ME_ENDPOINT,
  normalizeEmail,
  parseCurrentAccount,
  parseLoginResponse,
  parseLoginSuccess,
  parseSetupResult,
  resolvePostLoginTarget,
  SETUP_ENDPOINT,
  toAuthClientError,
  type AuthSession,
} from "./auth-client";
import { loginWithPassword, loginWithTotp } from "./auth-client";
import { ApiError } from "./errors";

interface FakeResponse {
  status: number;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
}

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(status: number, body: unknown): FakeResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function successEnvelope(data: unknown): unknown {
  return { ok: true, data };
}

function errorEnvelope(code: string, status: number): unknown {
  return {
    ok: false,
    error: { code, message: "generic", requestId: `req-${status}`, retryable: false, details: {} },
  };
}

function asFetchFn(
  fn: (url: string, init?: RequestInit) => Promise<FakeResponse>,
): typeof fetch {
  return fn as unknown as typeof fetch;
}

function capturingFetch(
  calls: CapturedCall[],
  behavior: (url: string, init?: RequestInit) => Promise<FakeResponse>,
): typeof fetch {
  return asFetchFn(async (url, init) => {
    calls.push({ url, init });
    return behavior(url, init);
  });
}

function headerOf(call: CapturedCall, name: string): string | undefined {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

function bodyOf(call: CapturedCall): Record<string, unknown> {
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
  function sessionFor(behavior: (url: string, init?: RequestInit) => Promise<FakeResponse>): {
    session: AuthSession;
    calls: CapturedCall[];
  } {
    const calls: CapturedCall[] = [];
    const session = createAuthSession({ fetchFn: capturingFetch(calls, behavior) });
    return { session, calls };
  }

  it("sends a pre-session request and seeds the seam on 200", async () => {
    const { session, calls } = sessionFor(async () =>
      jsonResponse(200, successEnvelope(LOGIN_SUCCESS)),
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
      jsonResponse(202, successEnvelope({ challengeToken: "challenge-1", step: "totp" })),
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
      jsonResponse(401, errorEnvelope("invalid_credentials", 401)),
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
      jsonResponse(429, errorEnvelope("rate_limited", 429)),
    );
    await expect(
      loginWithPassword(session, { email: "op@example.com", password: "a-password-value" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("fails closed on a 200 with an unrecognized body", async () => {
    const { session } = sessionFor(async () => jsonResponse(200, successEnvelope({ nope: true })));
    await expect(
      loginWithPassword(session, { email: "op@example.com", password: "a-password-value" }),
    ).rejects.toMatchObject({ code: "SERVER_ERROR" });
    expect(session.seam.csrf.hasToken()).toBe(false);
  });

  it("rejects empty credentials without a request", async () => {
    const { session, calls } = sessionFor(async () =>
      jsonResponse(200, successEnvelope(LOGIN_SUCCESS)),
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
    const calls: CapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () => jsonResponse(200, successEnvelope(LOGIN_SUCCESS))),
    });
    const result = await loginWithTotp(session, { challengeToken: "challenge-1", code: "123456" });
    expect(result).toEqual(LOGIN_SUCCESS);
    expect(calls[0].url).toBe(LOGIN_TOTP_ENDPOINT);
    expect(headerOf(calls[0], "X-CSRF-Token")).toBeUndefined();
    expect(bodyOf(calls[0])).toEqual({ challengeToken: "challenge-1", code: "123456" });
    expect(session.seam.csrf.hasToken()).toBe(true);
  });

  it("sends only the recovery code for recovery verification", async () => {
    const calls: CapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () => jsonResponse(200, successEnvelope(LOGIN_SUCCESS))),
    });
    await loginWithTotp(session, {
      challengeToken: "challenge-1",
      recoveryCode: "  ABCD-1234 ",
    });
    expect(bodyOf(calls[0])).toEqual({ challengeToken: "challenge-1", recoveryCode: "ABCD-1234" });
  });

  it("rejects a malformed code without a request", async () => {
    const calls: CapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () => jsonResponse(200, successEnvelope(LOGIN_SUCCESS))),
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
        jsonResponse(401, errorEnvelope("invalid_verification_code", 401)),
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
    const calls: CapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () =>
        jsonResponse(201, successEnvelope({ id: "u", email: "op@example.com", workspaceId: "w" })),
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
    const calls: CapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () =>
        jsonResponse(201, successEnvelope({ id: "u", email: "op@example.com", workspaceId: "w" })),
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
      fetchFn: asFetchFn(async () => jsonResponse(404, errorEnvelope("not_found", 404))),
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
        jsonResponse(401, errorEnvelope("invalid_setup_token", 401)),
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
    const calls: CapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () =>
        jsonResponse(201, successEnvelope({ id: "u", email: "e", workspaceId: "w" })),
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
    const calls: CapturedCall[] = [];
    const session = createAuthSession({
      fetchFn: capturingFetch(calls, async () => jsonResponse(200, successEnvelope(ME_BODY))),
    });
    const account = await fetchCurrentAccount(session);
    expect(account).toEqual(ME_BODY);
    expect(calls[0].url).toBe(ME_ENDPOINT);
    expect(calls[0].init?.method).toBe("GET");
    expect(session.seam.getSessionStatus()).toBe("active");
  });

  it("returns null on 401 and notifies expiry listeners through the wired client", async () => {
    const session = createAuthSession({
      fetchFn: asFetchFn(async () => jsonResponse(401, errorEnvelope("unauthenticated", 401))),
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
      fetchFn: asFetchFn(async () => jsonResponse(500, errorEnvelope("internal_error", 500))),
    });
    await expect(fetchCurrentAccount(failing)).rejects.toMatchObject({ code: "SERVER_ERROR" });
    const malformed = createAuthSession({
      fetchFn: asFetchFn(async () => jsonResponse(200, successEnvelope({ nope: true }))),
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
            return jsonResponse(200, successEnvelope(ME_BODY));
          }
          if (url === SETUP_ENDPOINT) {
            return jsonResponse(
              201,
              successEnvelope({ id: "u", email: "op@example.com", workspaceId: "w" }),
            );
          }
          return jsonResponse(200, successEnvelope(LOGIN_SUCCESS));
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
