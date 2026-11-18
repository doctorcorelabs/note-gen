// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for src/lib/web/security-settings.ts (Fase 1, V3-29b).
//
// Runner: Vitest, unit project. The suite uses a fake transport
// only; no test sends HTTP, touches the DOM, or touches any
// storage API. The show-once cases prove the holder destroys a
// dismissed value and can never show it again; the service cases
// prove the exact wire shape each method sends.

import { describe, expect, it } from "vitest";

import {
  classifySecurityError,
  createSecuritySettingsApi,
  createShowOnce,
  isRecoveryCodeInput,
  isStepUpFresh,
  isTotpCode,
  normalizeRecoveryCodeInput,
  securityErrorMessageKey,
  STEP_UP_WINDOW_MS,
  type SecurityTransport,
} from "./security-settings";

interface RecordedCall {
  method: "get" | "post" | "delete";
  path: string;
  body?: unknown;
}

function createFakeTransport(
  handler: (call: RecordedCall) => unknown,
): { transport: SecurityTransport; calls: RecordedCall[]; seeded: string[] } {
  const calls: RecordedCall[] = [];
  const seeded: string[] = [];
  const transport: SecurityTransport = {
    async get<T>(path: string): Promise<T> {
      const call: RecordedCall = { method: "get", path };
      calls.push(call);
      return handler(call) as T;
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      const call: RecordedCall = { method: "post", path, body };
      calls.push(call);
      return handler(call) as T;
    },
    async delete<T>(path: string): Promise<T> {
      const call: RecordedCall = { method: "delete", path };
      calls.push(call);
      return handler(call) as T;
    },
    seedCsrfToken(token: string): void {
      seeded.push(token);
    },
  };
  return { transport, calls, seeded };
}

describe("isTotpCode", () => {
  it("accepts exactly 6 digits, ignoring surrounding whitespace", () => {
    expect(isTotpCode("123456")).toBe(true);
    expect(isTotpCode("  123456  ")).toBe(true);
  });

  it("rejects short, long, non-digit, and spaced codes", () => {
    expect(isTotpCode("12345")).toBe(false);
    expect(isTotpCode("1234567")).toBe(false);
    expect(isTotpCode("12345a")).toBe(false);
    expect(isTotpCode("123 456")).toBe(false);
    expect(isTotpCode("123-456")).toBe(false);
    expect(isTotpCode("")).toBe(false);
    expect(isTotpCode(null)).toBe(false);
    expect(isTotpCode(123456)).toBe(false);
  });
});

describe("recovery code input", () => {
  it("normalizes case and separators like the server", () => {
    expect(normalizeRecoveryCodeInput("ABCD-EFGH-IJKM-NPQR")).toBe(
      "abcdefghijkmnpqr",
    );
    expect(normalizeRecoveryCodeInput("  abcd efgh ijkm npqr ")).toBe(
      "abcdefghijkmnpqr",
    );
  });

  it("accepts 16 characters from the recovery alphabet", () => {
    expect(isRecoveryCodeInput("abcd-efgh-ijkm-npqr")).toBe(true);
    expect(isRecoveryCodeInput("abcdefghijkmnpqr")).toBe(true);
  });

  it("rejects ambiguous characters and wrong lengths", () => {
    expect(isRecoveryCodeInput("abcd-efgh-ijkm-nplo")).toBe(false);
    expect(isRecoveryCodeInput("abcd-efgh-ijkm-np01")).toBe(false);
    expect(isRecoveryCodeInput("abcd-efgh-ijkm-npq")).toBe(false);
    expect(isRecoveryCodeInput("abcd-efgh-ijkm-npqrs")).toBe(false);
    expect(isRecoveryCodeInput("")).toBe(false);
    expect(isRecoveryCodeInput(42)).toBe(false);
  });
});

describe("isStepUpFresh", () => {
  const nowMs = Date.parse("2026-11-16T10:00:00.000Z");

  it("is fresh within the window, inclusive of the boundary", () => {
    expect(
      isStepUpFresh(
        new Date(nowMs - STEP_UP_WINDOW_MS).toISOString(),
        nowMs,
      ),
    ).toBe(true);
    expect(
      isStepUpFresh(new Date(nowMs - 60_000).toISOString(), nowMs),
    ).toBe(true);
  });

  it("is stale past the window", () => {
    expect(
      isStepUpFresh(
        new Date(nowMs - STEP_UP_WINDOW_MS - 1).toISOString(),
        nowMs,
      ),
    ).toBe(false);
  });

  it("is never fresh for null, empty, or unparseable values", () => {
    expect(isStepUpFresh(null, nowMs)).toBe(false);
    expect(isStepUpFresh(undefined, nowMs)).toBe(false);
    expect(isStepUpFresh("", nowMs)).toBe(false);
    expect(isStepUpFresh("not-a-date", nowMs)).toBe(false);
  });
});

describe("classifySecurityError", () => {
  it("maps step_up_required, invalid codes, and session expiry", () => {
    expect(
      classifySecurityError({ status: 403, code: "step_up_required" }),
    ).toBe("step_up_required");
    expect(
      classifySecurityError({
        status: 401,
        wireCode: "invalid_verification_code",
      }),
    ).toBe("invalid_code");
    expect(classifySecurityError({ status: 401, code: "unauthenticated" })).toBe(
      "session_expired",
    );
  });

  it("maps rate limit, not found, and server failures", () => {
    expect(classifySecurityError({ status: 429, code: "rate_limited" })).toBe(
      "rate_limited",
    );
    expect(classifySecurityError({ status: 404, code: "not_found" })).toBe(
      "not_found",
    );
    expect(classifySecurityError({ status: 503, code: "unavailable" })).toBe(
      "unavailable",
    );
    expect(classifySecurityError({ status: 500, code: "server_error" })).toBe(
      "unavailable",
    );
  });

  it("maps anything else to unknown without throwing", () => {
    expect(classifySecurityError({ status: 400, code: "validation_error" })).toBe(
      "unknown",
    );
    expect(classifySecurityError(new Error("boom"))).toBe("unknown");
    expect(classifySecurityError(null)).toBe("unknown");
    expect(classifySecurityError("nope")).toBe("unknown");
  });
});

describe("securityErrorMessageKey", () => {
  it("maps every error kind to its camelCase message key", () => {
    expect(securityErrorMessageKey("step_up_required")).toBe("stepUpRequired");
    expect(securityErrorMessageKey("invalid_code")).toBe("invalidCode");
    expect(securityErrorMessageKey("session_expired")).toBe("sessionExpired");
    expect(securityErrorMessageKey("rate_limited")).toBe("rateLimited");
    expect(securityErrorMessageKey("not_found")).toBe("notFound");
    expect(securityErrorMessageKey("unavailable")).toBe("unavailable");
    expect(securityErrorMessageKey("unknown")).toBe("unknown");
  });

  it("never returns a snake_case wire value", () => {
    const kinds = [
      "step_up_required",
      "invalid_code",
      "session_expired",
      "rate_limited",
      "not_found",
      "unavailable",
      "unknown",
    ] as const;
    for (const kind of kinds) {
      expect(securityErrorMessageKey(kind)).not.toContain("_");
    }
  });
});

describe("createShowOnce", () => {
  it("holds nothing before the first set", () => {
    const holder = createShowOnce<string[]>();
    expect(holder.hasValue()).toBe(false);
    expect(holder.peek()).toBeNull();
  });

  it("shows the held value until dismissed", () => {
    const holder = createShowOnce<string>();
    holder.set("secret-value");
    expect(holder.hasValue()).toBe(true);
    expect(holder.peek()).toBe("secret-value");
    expect(holder.peek()).toBe("secret-value");
  });

  it("never shows a dismissed value again", () => {
    const holder = createShowOnce<string>();
    holder.set("secret-value");
    holder.dismiss();
    expect(holder.hasValue()).toBe(false);
    expect(holder.peek()).toBeNull();
    holder.dismiss();
    expect(holder.peek()).toBeNull();
  });

  it("shows a fresh value after a new set", () => {
    const holder = createShowOnce<string>();
    holder.set("first-value");
    holder.dismiss();
    holder.set("second-value");
    expect(holder.peek()).toBe("second-value");
  });
});

describe("createSecuritySettingsApi", () => {
  it("reads status from GET /api/auth/me", async () => {
    const { transport, calls } = createFakeTransport(() => ({
      email: "operator@example.test",
      totpEnabled: true,
      session: { id: "session-row-id", stepUpAt: "2026-11-16T09:55:00.000Z" },
    }));
    const api = createSecuritySettingsApi(transport);
    const status = await api.getSecurityStatus();
    expect(status).toEqual({
      email: "operator@example.test",
      totpEnabled: true,
      stepUpAt: "2026-11-16T09:55:00.000Z",
      currentSessionId: "session-row-id",
    });
    expect(calls).toEqual([{ method: "get", path: "/api/auth/me" }]);
  });

  it("tolerates a missing session block in /me", async () => {
    const { transport } = createFakeTransport(() => ({
      email: "operator@example.test",
      totpEnabled: false,
    }));
    const api = createSecuritySettingsApi(transport);
    const status = await api.getSecurityStatus();
    expect(status.stepUpAt).toBeNull();
    expect(status.currentSessionId).toBeNull();
  });

  it("rejects a malformed /me response", async () => {
    const { transport } = createFakeTransport(() => ({
      email: "operator@example.test",
      totpEnabled: "yes",
    }));
    const api = createSecuritySettingsApi(transport);
    await expect(api.getSecurityStatus()).rejects.toThrow(TypeError);
  });

  it("lists sessions from GET /api/auth/sessions", async () => {
    const { transport, calls } = createFakeTransport(() => [
      {
        id: "row-1",
        deviceLabel: "Firefox on Linux",
        userAgent: "Mozilla/5.0",
        createdIp: "203.0.113.1",
        lastSeenIp: "203.0.113.1",
        createdAt: "2026-11-16T08:00:00.000Z",
        lastSeenAt: "2026-11-16T09:59:00.000Z",
        absoluteExpiresAt: "2026-12-16T08:00:00.000Z",
        isCurrent: true,
      },
    ]);
    const api = createSecuritySettingsApi(transport);
    const sessions = await api.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.isCurrent).toBe(true);
    expect(calls).toEqual([{ method: "get", path: "/api/auth/sessions" }]);
  });

  it("rejects a non-array sessions response", async () => {
    const { transport } = createFakeTransport(() => ({ sessions: [] }));
    const api = createSecuritySettingsApi(transport);
    await expect(api.listSessions()).rejects.toThrow(TypeError);
  });

  it("revokes one session with an encoded id", async () => {
    const { transport, calls } = createFakeTransport(() => null);
    const api = createSecuritySettingsApi(transport);
    await api.revokeSession("row id/1");
    expect(calls).toEqual([
      { method: "delete", path: "/api/auth/sessions/row%20id%2F1" },
    ]);
  });

  it("refuses to revoke without an id and sends nothing", async () => {
    const { transport, calls } = createFakeTransport(() => null);
    const api = createSecuritySettingsApi(transport);
    await expect(api.revokeSession("")).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });

  it("posts logout-all with no body", async () => {
    const { transport, calls } = createFakeTransport(() => null);
    const api = createSecuritySettingsApi(transport);
    await api.logoutAll();
    expect(calls).toEqual([
      { method: "post", path: "/api/auth/logout-all", body: undefined },
    ]);
  });

  it("steps up with password only and seeds the rotated token", async () => {
    const { transport, calls, seeded } = createFakeTransport(() => ({
      csrfToken: "rotated-token",
    }));
    const api = createSecuritySettingsApi(transport);
    await api.stepUp("correct horse battery staple");
    expect(calls).toEqual([
      {
        method: "post",
        path: "/api/auth/step-up",
        body: { password: "correct horse battery staple" },
      },
    ]);
    expect(seeded).toEqual(["rotated-token"]);
  });

  it("steps up with a TOTP code when one is given", async () => {
    const { transport, calls } = createFakeTransport(() => ({
      csrfToken: "rotated-token",
    }));
    const api = createSecuritySettingsApi(transport);
    await api.stepUp("password-value", { kind: "code", code: "123456" });
    expect(calls[0]?.body).toEqual({
      password: "password-value",
      code: "123456",
    });
  });

  it("steps up with a recovery code instead of a TOTP code", async () => {
    const { transport, calls, seeded } = createFakeTransport(() => ({
      csrfToken: "rotated-token",
    }));
    const api = createSecuritySettingsApi(transport);
    await api.stepUp("password-value", {
      kind: "recoveryCode",
      recoveryCode: "abcd-efgh-ijkm-npqr",
    });
    expect(calls).toEqual([
      {
        method: "post",
        path: "/api/auth/step-up",
        body: {
          password: "password-value",
          recoveryCode: "abcd-efgh-ijkm-npqr",
        },
      },
    ]);
    expect(seeded).toEqual(["rotated-token"]);
  });

  it("validates step-up input locally and sends nothing invalid", async () => {
    const { transport, calls } = createFakeTransport(() => ({
      csrfToken: "rotated-token",
    }));
    const api = createSecuritySettingsApi(transport);
    await expect(api.stepUp("")).rejects.toThrow(TypeError);
    await expect(
      api.stepUp("password-value", { kind: "code", code: "123" }),
    ).rejects.toThrow(TypeError);
    await expect(
      api.stepUp("password-value", {
        kind: "recoveryCode",
        recoveryCode: "short",
      }),
    ).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });

  it("starts enrollment with no body and returns the show-once payload", async () => {
    const { transport, calls } = createFakeTransport(() => ({
      otpauthUrl: "otpauth://totp/NoteGen:operator@example.test?secret=ABC",
      secret: "ABCDEFGHIJKLMNOP",
    }));
    const api = createSecuritySettingsApi(transport);
    const started = await api.startTotpEnroll();
    expect(started.secret).toBe("ABCDEFGHIJKLMNOP");
    expect(calls).toEqual([
      { method: "post", path: "/api/auth/totp/enroll/start", body: undefined },
    ]);
  });

  it("confirms enrollment with the code and seeds the rotated token", async () => {
    const { transport, calls, seeded } = createFakeTransport(() => ({
      totpEnabled: true,
      csrfToken: "rotated-token",
    }));
    const api = createSecuritySettingsApi(transport);
    await api.confirmTotpEnroll("123456");
    expect(calls[0]?.body).toEqual({ code: "123456" });
    expect(seeded).toEqual(["rotated-token"]);
  });

  it("refuses to confirm with a malformed code and sends nothing", async () => {
    const { transport, calls } = createFakeTransport(() => ({}));
    const api = createSecuritySettingsApi(transport);
    await expect(api.confirmTotpEnroll("12345")).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });

  it("disables with exactly one proof field", async () => {
    const { transport, calls, seeded } = createFakeTransport(() => ({
      totpEnabled: false,
      csrfToken: "rotated-token",
    }));
    const api = createSecuritySettingsApi(transport);
    await api.disableTotp({ kind: "code", code: "123456" });
    expect(calls[0]?.body).toEqual({ code: "123456" });
    await api.disableTotp({
      kind: "recoveryCode",
      recoveryCode: "abcd-efgh-ijkm-npqr",
    });
    expect(calls[1]?.body).toEqual({
      recoveryCode: "abcd-efgh-ijkm-npqr",
    });
    expect(seeded).toEqual(["rotated-token", "rotated-token"]);
  });

  it("refuses disable proofs with the wrong shape", async () => {
    const { transport, calls } = createFakeTransport(() => ({}));
    const api = createSecuritySettingsApi(transport);
    await expect(
      api.disableTotp({ kind: "code", code: "abcdef" }),
    ).rejects.toThrow(TypeError);
    await expect(
      api.disableTotp({ kind: "recoveryCode", recoveryCode: "short" }),
    ).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });

  it("regenerates exactly 10 recovery codes", async () => {
    const codes = Array.from(
      { length: 10 },
      (_, index) => `abcd-efgh-ijkm-npq${index}`,
    );
    const { transport, calls } = createFakeTransport(() => ({ codes }));
    const api = createSecuritySettingsApi(transport);
    const set = await api.regenerateRecoveryCodes("123456");
    expect(set.codes).toHaveLength(10);
    expect(calls[0]?.path).toBe(
      "/api/auth/totp/recovery-codes/regenerate",
    );
  });

  it("rejects a recovery set with the wrong count", async () => {
    const { transport } = createFakeTransport(() => ({
      codes: ["abcd-efgh-ijkm-npqr"],
    }));
    const api = createSecuritySettingsApi(transport);
    await expect(api.regenerateRecoveryCodes("123456")).rejects.toThrow(
      TypeError,
    );
  });
});
