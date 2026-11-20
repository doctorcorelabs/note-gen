// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Security settings logic for the settings page (Fase 1, V3-29b):
// TOTP enrollment/disable/recovery codes and session list/revoke.
// This module holds no React code so the show-once discipline, the
// input validation, and the wire shapes are unit tested under node.
//
// Wire sources (read from the merged server code, not invented):
// - server/src/routes/auth-totp.ts: enroll/start answers
//   { otpauthUrl, secret }; enroll/confirm answers
//   { totpEnabled: true, csrfToken }; disable answers
//   { totpEnabled: false, csrfToken } and takes exactly one of
//   { code } or { recoveryCode }; recovery-codes/regenerate answers
//   { codes } with exactly 10 codes. All four require a fresh
//   step-up. Confirm does NOT display the initial recovery set:
//   the user obtains visible codes through regenerate.
// - server/src/routes/auth-core.ts: GET /api/auth/sessions answers
//   SessionListEntry rows; DELETE /api/auth/sessions/:id answers
//   200 with an empty envelope; GET /api/auth/me answers
//   { totpEnabled, session: { stepUpAt, ... } }.
// - server/src/routes/auth-stepup.ts: POST /api/auth/step-up takes
//   { password } plus exactly one of { code } or { recoveryCode }
//   when TOTP is enabled and answers { csrfToken } (DA-02-F04).
// - desain-auth.md sections 1.4, 3.4, 3.5 and 4.3: step-up window
//   15 minutes, recovery codes shown once, no token or secret in
//   localStorage/sessionStorage/IndexedDB.
//
// Show-once discipline, enforced structurally:
// - The server never re-serves a staged TOTP secret or a recovery
//   set: there is no endpoint that returns them again.
// - This module never writes a secret or a code to any storage
//   API, never puts one in a URL, and never logs one. Secrets live
//   only in memory, inside a ShowOnce holder and React state.
// - The holder destroys its value on dismiss. A dismissed set can
//   never be shown again; only a fresh server response (a new
//   enroll/start or regenerate call) can populate a new value.
// - The settings components clear show-once state when the user
//   dismisses the panel, leaves the security section, or closes
//   the settings dialog.
//
// CSRF wiring follows the V3-30 seams: one shared WebApiAuthSeam
// per transport, mutations through withCsrfRetry (one refresh and
// one retry on 403 csrf_invalid), and csrfToken values returned by
// step-up/confirm/disable seeded back into the store so the next
// mutation uses the rotated token without an extra round trip.

import {
  createApiClient,
  DEFAULT_API_CLIENT_TIMEOUT_MS,
  type ApiClient,
} from "./api-client";
import {
  createWebApiAuthSeam,
  handleUnauthorizedError,
  withCsrfRetry,
  type WebApiAuthSeam,
} from "./csrf";

/** Step-up freshness window in milliseconds (15 minutes). */
export const STEP_UP_WINDOW_MS = 15 * 60 * 1000;

/** Recovery codes per set, matching the server batch size. */
export const RECOVERY_CODE_COUNT = 10;

/** Recovery code alphabet: lowercase without l/o, digits without 0/1. */
export const RECOVERY_CODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** One row of GET /api/auth/sessions (server SessionListEntry). */
export interface AuthSessionEntry {
  id: string;
  deviceLabel: string;
  userAgent: string | null;
  createdIp: string | null;
  lastSeenIp: string | null;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  isCurrent: boolean;
}

/** The account/security fields the settings page reads from /me. */
export interface SecurityStatus {
  email: string;
  totpEnabled: boolean;
  /** ISO timestamp of the last step-up on this session, or null. */
  stepUpAt: string | null;
  /** Row id of the current session, or null when absent. */
  currentSessionId: string | null;
}

/** Show-once payload of POST /api/auth/totp/enroll/start. */
export interface TotpEnrollStart {
  otpauthUrl: string;
  secret: string;
}

/** Show-once payload of POST /api/auth/totp/recovery-codes/regenerate. */
export interface RecoveryCodeSet {
  codes: string[];
}

/** Proof for POST /api/auth/totp/disable: exactly one field. */
export type TotpDisableProof =
  | { kind: "code"; code: string }
  | { kind: "recoveryCode"; recoveryCode: string };

/** Proof for POST /api/auth/step-up: exactly one second factor. */
export type StepUpProof =
  | { kind: "code"; code: string }
  | { kind: "recoveryCode"; recoveryCode: string };

/**
 * User-facing failure classes for security actions. Derived only
 * from HTTP status and wire error code; never from message text
 * and never carrying a secret value.
 */
export type SecurityErrorKind =
  | "step_up_required"
  | "invalid_code"
  | "session_expired"
  | "rate_limited"
  | "not_found"
  | "unavailable"
  | "unknown";

/**
 * True when the value is a 6-digit TOTP code. Surrounding
 * whitespace is ignored; inner spaces and dashes are rejected so
 * a mistyped code fails locally instead of consuming a server
 * attempt.
 */
export function isTotpCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value.trim());
}

/**
 * Normalize a recovery code the way the server does: trim,
 * lowercase, strip whitespace and dashes.
 */
export function normalizeRecoveryCodeInput(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]/g, "");
}

/**
 * True when the value is a well-formed recovery code: 16
 * characters from the recovery alphabet after normalization.
 * This checks shape only; validity is decided by the server.
 */
export function isRecoveryCodeInput(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = normalizeRecoveryCodeInput(value);
  if (normalized.length !== 16) {
    return false;
  }
  for (const char of normalized) {
    if (!RECOVERY_CODE_ALPHABET.includes(char)) {
      return false;
    }
  }
  return true;
}

/**
 * True when a step-up recorded at stepUpAt is still fresh at
 * nowMs. The boundary is inclusive, matching the server check.
 * Null or unparseable timestamps are never fresh.
 */
export function isStepUpFresh(
  stepUpAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (typeof stepUpAt !== "string" || stepUpAt === "") {
    return false;
  }
  const atMs = Date.parse(stepUpAt);
  if (Number.isNaN(atMs)) {
    return false;
  }
  return nowMs - atMs <= STEP_UP_WINDOW_MS;
}

function readErrorStatusCode(error: unknown): {
  status: number | null;
  code: string | null;
} {
  if (typeof error !== "object" || error === null) {
    return { status: null, code: null };
  }
  const record = error as Record<string, unknown>;
  const status = typeof record.status === "number" ? record.status : null;
  const code =
    typeof record.code === "string"
      ? record.code
      : typeof record.wireCode === "string"
        ? record.wireCode
        : null;
  return { status, code };
}

/**
 * Classify a thrown request failure into a SecurityErrorKind.
 * A 403 step_up_required always wins: the UI must offer step-up
 * again rather than report a generic failure.
 */
export function classifySecurityError(error: unknown): SecurityErrorKind {
  const { status, code } = readErrorStatusCode(error);
  if (status === 403 && code === "step_up_required") {
    return "step_up_required";
  }
  if (status === 401 && code === "invalid_verification_code") {
    return "invalid_code";
  }
  if (status === 401) {
    return "session_expired";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 503 || status === 502 || status === 504) {
    return "unavailable";
  }
  if (status !== null && status >= 500) {
    return "unavailable";
  }
  return "unknown";
}

/**
 * i18n key for a SecurityErrorKind under the
 * `settings.security.errors` namespace. The kinds are snake_case
 * wire values; the message keys are camelCase, so the mapping
 * must be explicit: passing a kind straight to the translator
 * would render the raw wire value instead of a message.
 */
export function securityErrorMessageKey(kind: SecurityErrorKind): string {
  switch (kind) {
    case "step_up_required":
      return "stepUpRequired";
    case "invalid_code":
      return "invalidCode";
    case "session_expired":
      return "sessionExpired";
    case "rate_limited":
      return "rateLimited";
    case "not_found":
      return "notFound";
    case "unavailable":
      return "unavailable";
    case "unknown":
      return "unknown";
  }
}

/**
 * A memory-only, show-once holder. The value is readable while it
 * is held and is destroyed by dismiss(); after dismiss the holder
 * yields nothing until set() receives a fresh value. There is no
 * serialization, no storage, and no way to recover a dismissed
 * value.
 */
export interface ShowOnce<T> {
  set(value: T): void;
  /** The held value, or null once dismissed or never set. */
  peek(): T | null;
  hasValue(): boolean;
  /** Destroy the held value. Irreversible until a fresh set(). */
  dismiss(): void;
}

export function createShowOnce<T>(): ShowOnce<T> {
  let held: T | null = null;
  let dismissed = false;
  return {
    set(value: T): void {
      held = value;
      dismissed = false;
    },
    peek(): T | null {
      return dismissed ? null : held;
    },
    hasValue(): boolean {
      return !dismissed && held !== null;
    },
    dismiss(): void {
      held = null;
      dismissed = true;
    },
  };
}

/**
 * Minimal transport surface the security service needs. The real
 * implementation wraps ApiClient plus the CSRF seam; tests inject
 * a fake. seedCsrfToken stores a rotated token in memory only.
 */
export interface SecurityTransport {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
  seedCsrfToken(token: string): void;
}

export function createSecurityTransport(
  client: ApiClient,
  seam: WebApiAuthSeam,
): SecurityTransport {
  return {
    async get<T>(path: string): Promise<T> {
      try {
        return await client.getJson<T>(path);
      } catch (error) {
        handleUnauthorizedError(seam, error, { path });
        throw error;
      }
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      return withCsrfRetry(seam, () => client.postJson<T>(path, body), {
        path,
      });
    },
    async delete<T>(path: string): Promise<T> {
      return withCsrfRetry(seam, () => client.deleteJson<T>(path), {
        path,
      });
    },
    seedCsrfToken(token: string): void {
      seam.csrf.setToken(token);
    },
  };
}

/**
 * Build the production transport: one seam shared by one client,
 * wired through the V3-30b seams. The caller keeps the seam only
 * when it needs session-expiry subscriptions; the transport alone
 * is enough for the settings page.
 */
export function createDefaultSecurityTransport(): {
  transport: SecurityTransport;
  seam: WebApiAuthSeam;
} {
  const seam = createWebApiAuthSeam();
  const client = createApiClient({
    csrfTokenProvider: () => seam.csrf.getToken(),
    onUnauthorized: (error) => {
      handleUnauthorizedError(seam, error);
    },
    defaultTimeoutMs: DEFAULT_API_CLIENT_TIMEOUT_MS,
  });
  return { transport: createSecurityTransport(client, seam), seam };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`Malformed security response: ${field}`);
  }
  return value;
}

function parseSessionEntry(value: unknown): AuthSessionEntry {
  if (!isRecord(value)) {
    throw new TypeError("Malformed security response: session entry");
  }
  return {
    id: requireNonEmptyString(value.id, "session id"),
    deviceLabel: requireNonEmptyString(
      value.deviceLabel,
      "session deviceLabel",
    ),
    userAgent:
      typeof value.userAgent === "string" ? value.userAgent : null,
    createdIp:
      typeof value.createdIp === "string" ? value.createdIp : null,
    lastSeenIp:
      typeof value.lastSeenIp === "string" ? value.lastSeenIp : null,
    createdAt: requireNonEmptyString(value.createdAt, "session createdAt"),
    lastSeenAt: requireNonEmptyString(value.lastSeenAt, "session lastSeenAt"),
    absoluteExpiresAt: requireNonEmptyString(
      value.absoluteExpiresAt,
      "session absoluteExpiresAt",
    ),
    isCurrent: value.isCurrent === true,
  };
}

function parseCsrfToken(value: unknown): string {
  if (!isRecord(value)) {
    throw new TypeError("Malformed security response: body");
  }
  return requireNonEmptyString(value.csrfToken, "csrfToken");
}

/**
 * Security settings API over a transport. Every method sends
 * exactly the wire shape the merged server routes accept; unknown
 * fields are never sent because the server rejects them.
 */
export interface SecuritySettingsApi {
  getSecurityStatus(): Promise<SecurityStatus>;
  listSessions(): Promise<AuthSessionEntry[]>;
  revokeSession(sessionId: string): Promise<void>;
  logoutAll(): Promise<void>;
  stepUp(password: string, proof?: StepUpProof): Promise<void>;
  startTotpEnroll(): Promise<TotpEnrollStart>;
  confirmTotpEnroll(code: string): Promise<void>;
  disableTotp(proof: TotpDisableProof): Promise<void>;
  regenerateRecoveryCodes(code: string): Promise<RecoveryCodeSet>;
}

export function createSecuritySettingsApi(
  transport: SecurityTransport,
): SecuritySettingsApi {
  return {
    async getSecurityStatus(): Promise<SecurityStatus> {
      const data = await transport.get<unknown>("/api/auth/me");
      if (!isRecord(data)) {
        throw new TypeError("Malformed security response: me");
      }
      if (typeof data.totpEnabled !== "boolean") {
        throw new TypeError("Malformed security response: totpEnabled");
      }
      const session = isRecord(data.session) ? data.session : null;
      const stepUpAt =
        session !== null && typeof session.stepUpAt === "string"
          ? session.stepUpAt
          : null;
      const currentSessionId =
        session !== null && typeof session.id === "string"
          ? session.id
          : null;
      return {
        email: requireNonEmptyString(data.email, "email"),
        totpEnabled: data.totpEnabled,
        stepUpAt,
        currentSessionId,
      };
    },

    async listSessions(): Promise<AuthSessionEntry[]> {
      const data = await transport.get<unknown>("/api/auth/sessions");
      if (!Array.isArray(data)) {
        throw new TypeError("Malformed security response: sessions");
      }
      return data.map(parseSessionEntry);
    },

    async revokeSession(sessionId: string): Promise<void> {
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new TypeError("A session id is required to revoke a session.");
      }
      await transport.delete<unknown>(
        `/api/auth/sessions/${encodeURIComponent(sessionId)}`,
      );
    },

    async logoutAll(): Promise<void> {
      await transport.post<unknown>("/api/auth/logout-all");
    },

    async stepUp(password: string, proof?: StepUpProof): Promise<void> {
      if (typeof password !== "string" || password === "") {
        throw new TypeError("A password is required for step-up.");
      }
      const body: Record<string, string> = { password };
      if (proof !== undefined) {
        if (proof.kind === "code") {
          if (!isTotpCode(proof.code)) {
            throw new TypeError("A step-up code must be 6 digits.");
          }
          body.code = proof.code.trim();
        } else if (proof.kind === "recoveryCode") {
          if (!isRecoveryCodeInput(proof.recoveryCode)) {
            throw new TypeError("A recovery code must be 16 characters.");
          }
          body.recoveryCode = proof.recoveryCode.trim();
        } else {
          throw new TypeError(
            "A step-up proof must be a TOTP code or a recovery code.",
          );
        }
      }
      const data = await transport.post<unknown>("/api/auth/step-up", body);
      transport.seedCsrfToken(parseCsrfToken(data));
    },

    async startTotpEnroll(): Promise<TotpEnrollStart> {
      const data = await transport.post<unknown>(
        "/api/auth/totp/enroll/start",
      );
      if (!isRecord(data)) {
        throw new TypeError("Malformed security response: enroll start");
      }
      return {
        otpauthUrl: requireNonEmptyString(data.otpauthUrl, "otpauthUrl"),
        secret: requireNonEmptyString(data.secret, "secret"),
      };
    },

    async confirmTotpEnroll(code: string): Promise<void> {
      if (!isTotpCode(code)) {
        throw new TypeError("A confirmation code must be 6 digits.");
      }
      const data = await transport.post<unknown>(
        "/api/auth/totp/enroll/confirm",
        { code: code.trim() },
      );
      transport.seedCsrfToken(parseCsrfToken(data));
    },

    async disableTotp(proof: TotpDisableProof): Promise<void> {
      let body: Record<string, string>;
      if (proof.kind === "code") {
        if (!isTotpCode(proof.code)) {
          throw new TypeError("A TOTP code must be 6 digits.");
        }
        body = { code: proof.code.trim() };
      } else {
        if (!isRecoveryCodeInput(proof.recoveryCode)) {
          throw new TypeError("A recovery code must be 16 characters.");
        }
        body = { recoveryCode: proof.recoveryCode.trim() };
      }
      const data = await transport.post<unknown>(
        "/api/auth/totp/disable",
        body,
      );
      transport.seedCsrfToken(parseCsrfToken(data));
    },

    async regenerateRecoveryCodes(code: string): Promise<RecoveryCodeSet> {
      if (!isTotpCode(code)) {
        throw new TypeError("A TOTP code must be 6 digits.");
      }
      const data = await transport.post<unknown>(
        "/api/auth/totp/recovery-codes/regenerate",
        { code: code.trim() },
      );
      if (!isRecord(data) || !Array.isArray(data.codes)) {
        throw new TypeError("Malformed security response: recovery codes");
      }
      if (data.codes.length !== RECOVERY_CODE_COUNT) {
        throw new TypeError("Malformed security response: recovery code count");
      }
      for (const entry of data.codes) {
        if (typeof entry !== "string" || entry === "") {
          throw new TypeError("Malformed security response: recovery code");
        }
      }
      return { codes: [...(data.codes as string[])] };
    },
  };
}
