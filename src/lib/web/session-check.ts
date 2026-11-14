// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Session probe seam for the web boot guard (Fase 1, V2-08).
//
// Wave 3 (auth) owns the real session implementation behind this
// interface. It may change how the probe fetches and what metadata it
// returns, but it must keep the three-state contract and the fail-closed
// rule below. The boot guard in src/app/page.tsx depends only on the
// SessionState result, never on probe internals.
//
// FAIL CLOSED: only an explicit, successful, authenticated response
// means "authenticated". Every other outcome is either "unauthenticated"
// (the server explicitly rejected the session) or "unknown" (anything
// else: network failure, timeout, unexpected status, malformed body,
// or an endpoint that does not exist yet). "unknown" MUST block entry
// to the shell, exactly like "unauthenticated" blocks with a sign-in
// prompt. There is no code path in this module that treats "unknown"
// as authenticated, and callers must not add one.
//
// Probe endpoint: GET /api/auth/me, the canonical session-required
// metadata endpoint (kontrak-api-kanonis, auth table; desain-auth
// section 12.2). The request is same-origin and relative on purpose:
// the browser calls the API through the relative /api/* path and the
// edge routes it to the API service, so no API base URL variable
// exists (see .env.example). The cookie session is opaque and
// HttpOnly; this probe never reads, stores, or logs any token value.

export type SessionState = "authenticated" | "unauthenticated" | "unknown";

export type SessionCheckCode =
  | "SESSION_OK"
  | "SESSION_REJECTED"
  | "SESSION_UNKNOWN"
  | "SESSION_TIMEOUT"
  | "SESSION_NETWORK_ERROR"
  | "SESSION_ENDPOINT_MISSING";

export interface SessionCheckResult {
  state: SessionState;
  /** HTTP status of the probe response, when a response was received. */
  status?: number;
  /** Stable machine code for the detail line. Never contains secrets. */
  code: SessionCheckCode;
  /** Unix timestamp in milliseconds when the check completed. */
  checkedAt: number;
}

export interface SessionCheckDeps {
  /** Fetch implementation. Defaults to the global fetch. Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Probe endpoint. Defaults to the canonical /api/auth/me. */
  endpoint?: string;
  /** Per-probe timeout in milliseconds. Defaults to SESSION_CHECK_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Outer abort signal from the boot guard budget or from unmount/retry.
   * When it aborts, checkSession rejects with SessionCheckCancelledError
   * instead of returning a result, so a stale attempt can never be
   * mistaken for a fresh failure.
   */
  signal?: AbortSignal;
}

/** Canonical session probe endpoint. Do not change without updating the API contract. */
export const SESSION_PROBE_ENDPOINT = "/api/auth/me";

/** Per-probe budget. The boot guard total budget is larger (see boot-guard.ts). */
export const SESSION_CHECK_TIMEOUT_MS = 5000;

/** Thrown only when the outer abort signal fires. Not a failure state. */
export class SessionCheckCancelledError extends Error {
  constructor() {
    super("Session check was cancelled");
    this.name = "SessionCheckCancelledError";
  }
}

/** Internal marker: the probe exceeded its own timeout budget. */
class SessionProbeTimeoutError extends Error {
  constructor() {
    super("Session check timed out");
    this.name = "SessionProbeTimeoutError";
  }
}

/**
 * Classify a probe HTTP status into a session state.
 *
 * Only 200 can mean authenticated, and only after the body passes
 * isValidSessionBody. 401/403 mean the server explicitly rejected the
 * session. 404 means the endpoint does not exist yet (the auth backend
 * has not landed); that is "unknown", never a bypass and never a claim
 * that the session expired. Every other status is "unknown".
 */
export function classifySessionStatus(status: number): {
  state: SessionState;
  code: SessionCheckCode;
} {
  if (status === 200) {
    return { state: "authenticated", code: "SESSION_OK" };
  }
  if (status === 401 || status === 403) {
    return { state: "unauthenticated", code: "SESSION_REJECTED" };
  }
  if (status === 404) {
    return { state: "unknown", code: "SESSION_ENDPOINT_MISSING" };
  }
  return { state: "unknown", code: "SESSION_UNKNOWN" };
}

/**
 * Validate a 200 probe body.
 *
 * The body must be a JSON object. When it carries the envelope `ok`
 * field (kontrak-api-kanonis section 2), `ok` must be true; a 200
 * response that reports failure is not authentication. Bodies without
 * an `ok` field are accepted so the probe stays tolerant of the exact
 * metadata shape wave 3 returns. Unparseable bodies are rejected.
 */
export function isValidSessionBody(bodyText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  if ("ok" in parsed) {
    return (parsed as { ok?: unknown }).ok === true;
  }
  return true;
}

/**
 * Probe the current session. Returns a three-state result and never
 * throws for an ordinary failure (network error, timeout, unexpected
 * status, malformed body); those all become "unknown". The only
 * rejection is SessionCheckCancelledError when the outer signal
 * aborts, which callers treat as cancellation, not failure.
 */
export async function checkSession(deps: SessionCheckDeps = {}): Promise<SessionCheckResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const endpoint = deps.endpoint ?? SESSION_PROBE_ENDPOINT;
  const timeoutMs = deps.timeoutMs ?? SESSION_CHECK_TIMEOUT_MS;
  const outerSignal = deps.signal;

  if (outerSignal?.aborted) {
    throw new SessionCheckCancelledError();
  }

  const controller = new AbortController();
  let timedOut = false;
  // The fetch is raced against explicit timeout and abort promises on
  // top of the AbortSignal, so the probe can never hang on an
  // implementation that ignores the signal: aborting the controller
  // alone only rejects a fetch that honors it. The race losers are
  // cleaned up in the finally block below.
  let rejectOnTimeout: ((error: Error) => void) | undefined;
  let rejectOnAbort: ((error: Error) => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectOnTimeout = reject;
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectOnTimeout?.(new SessionProbeTimeoutError());
  }, timeoutMs);
  const onOuterAbort = (): void => {
    controller.abort();
    rejectOnAbort?.(new SessionCheckCancelledError());
  };
  if (outerSignal) {
    outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    const response = await Promise.race([
      fetchFn(endpoint, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      }),
      timeoutPromise,
      abortPromise,
    ]);
    const classified = classifySessionStatus(response.status);
    if (classified.state !== "authenticated") {
      return { ...classified, status: response.status, checkedAt: Date.now() };
    }
    const bodyText = await Promise.race([response.text(), timeoutPromise, abortPromise]);
    if (!isValidSessionBody(bodyText)) {
      return {
        state: "unknown",
        code: "SESSION_UNKNOWN",
        status: response.status,
        checkedAt: Date.now(),
      };
    }
    return {
      state: "authenticated",
      code: "SESSION_OK",
      status: response.status,
      checkedAt: Date.now(),
    };
  } catch (error) {
    if (error instanceof SessionCheckCancelledError) {
      throw error;
    }
    if (error instanceof SessionProbeTimeoutError || timedOut) {
      return { state: "unknown", code: "SESSION_TIMEOUT", checkedAt: Date.now() };
    }
    if (controller.signal.aborted) {
      throw new SessionCheckCancelledError();
    }
    return { state: "unknown", code: "SESSION_NETWORK_ERROR", checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
    if (outerSignal) {
      outerSignal.removeEventListener("abort", onOuterAbort);
    }
  }
}
