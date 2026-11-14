// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Boot guard logic for the web entry page (Fase 1, V2-08). This module
// is pure logic with no React and no DOM dependency: the page component
// in src/app/page.tsx renders the states and supplies the real
// dependencies, and unit tests supply fakes.
//
// Design sources: fase1/analisis-init-lanjut.md section 4 (two-layer
// guard, failure classes, 15 second recommended budget) and
// fase1/investigasi-hang-eperm.md mitigations M1/M2 (a boot path must
// never hang silently; every wait needs a bound and a visible failure).
// The guard runs its checks in the order section 4.2 requires: session
// first (so an expired session is never misreported as a store
// failure), then liveness, then readiness, then the store. Workspace
// readiness is read from the ready envelope, because no dedicated
// workspace API exists yet in wave 2; the ready handler already checks
// the workspace root on the server.
//
// The guard never throws: runBootGuard always resolves to ready,
// failed, or cancelled. A cancelled outcome means a newer attempt or
// an unmount superseded this one, and the caller must ignore it.

import {
  SESSION_CHECK_TIMEOUT_MS,
  SessionCheckCancelledError,
  checkSession,
  type SessionCheckDeps,
  type SessionCheckResult,
} from "./session-check";

/** Total budget for one guard attempt, from the first check to the redirect decision. */
export const BOOT_GUARD_TIMEOUT_MS = 15000;

export type BootStep = "session" | "live" | "ready" | "store" | "workspace" | "guard";

export type BootFailureCode =
  | "BOOT_DB_UNREACHABLE"
  | "BOOT_SESSION_EXPIRED"
  | "BOOT_SESSION_UNKNOWN"
  | "BOOT_WORKSPACE_NOT_FOUND"
  | "BOOT_NETWORK_UNREACHABLE"
  | "BOOT_TIMEOUT"
  | "BOOT_STORE_UNAVAILABLE"
  | "BOOT_UNKNOWN";

export interface BootGuardFailure {
  code: BootFailureCode;
  /** Guard step that produced the failure, shown on the detail line. */
  step: BootStep;
  /**
   * Stable machine detail (a check error code or a guard constant).
   * Never a raw error message, URL, stack trace, or secret value.
   */
  detail?: string;
}

export interface BootGuardMessage {
  title: string;
  body: string;
  /** Primary action for the failure screen. */
  action: "retry" | "sign-in";
}

/**
 * User-facing messages, in English (the fork default locale is en).
 * Titles and bodies follow analisis-init-lanjut.md section 4.4, with
 * two additions that section 4.4 does not name: BOOT_SESSION_UNKNOWN
 * (the probe could not determine the session state, so the guard
 * blocks without claiming the session expired) and
 * BOOT_STORE_UNAVAILABLE (the store readiness check failed). Each
 * message states what happened, that notes are safe, and one action.
 * These strings are intentionally hardcoded here instead of going
 * through next-intl: the guard must render even when message catalog
 * keys for boot states do not exist yet. Moving them to the catalog
 * is a follow-up for the i18n owner, not a behavior change.
 */
export const BOOT_FAILURE_MESSAGES: Record<BootFailureCode, BootGuardMessage> = {
  BOOT_DB_UNREACHABLE: {
    title: "Could not reach the database.",
    body: "NoteGen is running, but its database is not responding. Your notes are safe. Try again in a moment.",
    action: "retry",
  },
  BOOT_SESSION_EXPIRED: {
    title: "Your session has expired.",
    body: "Sign in again to continue. Your notes are safe.",
    action: "sign-in",
  },
  BOOT_SESSION_UNKNOWN: {
    title: "Could not verify your session.",
    body: "NoteGen could not confirm that you are signed in, so it cannot open your workspace yet. Your notes are safe. Try again.",
    action: "retry",
  },
  BOOT_WORKSPACE_NOT_FOUND: {
    title: "Workspace not found.",
    body: "Your workspace could not be found on the server. It may have been moved or deleted. Your other data is safe.",
    action: "retry",
  },
  BOOT_NETWORK_UNREACHABLE: {
    title: "No connection to the server.",
    body: "Check your internet connection, then try again. Nothing was changed.",
    action: "retry",
  },
  BOOT_TIMEOUT: {
    title: "NoteGen is taking too long to start.",
    body: "The server did not respond in time. Your notes are safe. Try again.",
    action: "retry",
  },
  BOOT_STORE_UNAVAILABLE: {
    title: "Could not load your settings.",
    body: "NoteGen could not read its saved settings. Your notes are safe. Try again.",
    action: "retry",
  },
  BOOT_UNKNOWN: {
    title: "NoteGen could not start.",
    body: "Something went wrong while starting. Your notes are safe. Try again, and check the server status if the problem continues.",
    action: "retry",
  },
};

export type BootGuardOutcome =
  | { status: "ready"; target: string }
  | { status: "failed"; failure: BootGuardFailure }
  | { status: "cancelled" };

/** Minimal shape of a health response. A real Response satisfies this. */
export interface HealthResponse {
  status: number;
  text: () => Promise<string>;
}

export type HealthFetch = (path: string, signal: AbortSignal) => Promise<HealthResponse>;

export async function defaultHealthFetch(path: string, signal: AbortSignal): Promise<HealthResponse> {
  return fetch(path, {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
}

export interface BootStoreSnapshot {
  currentPage: string | undefined;
  persistCurrentPage: (value: string) => Promise<void>;
}

export type BootStoreLoader = () => Promise<BootStoreSnapshot>;

export interface BootGuardDeps {
  /** Session probe. Defaults to checkSession from session-check.ts. */
  checkSessionFn?: (deps: SessionCheckDeps) => Promise<SessionCheckResult>;
  /** Health fetch. Defaults to defaultHealthFetch (relative /api/* paths). */
  healthFetch?: HealthFetch;
  /** Loads store.json and reads currentPage. Supplied by the page. */
  loadStore: BootStoreLoader;
  /** Mobile detection, supplied by the page (upstream isMobileDevice). */
  isMobileDevice: () => boolean;
  /** Optional online probe (navigator.onLine). Absent means "assume online". */
  isOnline?: () => boolean;
  /** Total attempt budget. Defaults to BOOT_GUARD_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Per-probe session budget. Defaults to SESSION_CHECK_TIMEOUT_MS. */
  sessionTimeoutMs?: number;
  /** Progress callback so the page can show which check is running. */
  onStep?: (step: BootStep) => void;
}

class BootGuardAbortedError extends Error {
  constructor() {
    super("Boot guard attempt was aborted");
    this.name = "BootGuardAbortedError";
  }
}

/**
 * Await a promise that does not accept an abort signal (Store calls,
 * injected fakes) while still honoring the guard budget: when the
 * signal aborts, the wait rejects even if the underlying promise never
 * settles. The underlying promise may still settle later; its result
 * is ignored, and the only side effect it can still perform is an
 * idempotent rewrite of the normalized currentPage value.
 */
function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new BootGuardAbortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new BootGuardAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Accept only internal redirect targets. Upstream pushed the stored
 * currentPage value unchecked; a stored absolute URL or protocol
 * relative value must never become a navigation away from the app.
 * Legitimate stored values are internal paths and pass through
 * unchanged; anything else falls back to the branch default.
 */
function sanitizeRedirectTarget(target: string, fallback: string): string {
  if (!target.startsWith("/") || target.startsWith("//")) {
    return fallback;
  }
  return target;
}

/**
 * Pure port of the redirect logic in upstream src/app/page.tsx
 * (HEAD 4dcaa3f), factored so it can be unit tested. The branch
 * structure is preserved exactly:
 *
 * - A stored knowledge path is rewritten to the branch home
 *   (/mobile/chat or /core/main) and persisted.
 * - On mobile, a stored mobile path is kept; anything else goes to
 *   /mobile/chat.
 * - On desktop, the three legacy paths (/core/article, /core/record,
 *   /core/search) are rewritten to /core/main and persisted; a stored
 *   mobile path goes to /core/main; anything else is kept, defaulting
 *   to /core/main when nothing is stored.
 *
 * Returns the navigation target plus the value to persist, or null
 * when no rewrite happened and nothing needs persisting.
 */
export function resolveRedirectTarget(
  currentPage: string | undefined | null,
  isMobile: boolean,
): { target: string; storeUpdate: string | null } {
  let page: string | undefined = currentPage ?? undefined;
  let storeUpdate: string | null = null;
  if (page?.startsWith("/core/knowledge") || page?.startsWith("/mobile/knowledge")) {
    page = isMobile ? "/mobile/chat" : "/core/main";
    storeUpdate = page;
  }
  if (isMobile) {
    const target = page?.includes("/mobile") ? page || "/mobile/chat" : "/mobile/chat";
    return { target: sanitizeRedirectTarget(target, "/mobile/chat"), storeUpdate };
  }
  if (page === "/core/article" || page === "/core/record" || page === "/core/search") {
    page = "/core/main";
    storeUpdate = "/core/main";
  }
  const target = !page?.includes("/mobile") ? page || "/core/main" : "/core/main";
  return { target: sanitizeRedirectTarget(target, "/core/main"), storeUpdate };
}

/** Only allow stable machine codes onto the detail line. */
function safeDetailCode(value: unknown, fallback: string): string {
  if (typeof value === "string" && /^[A-Z0-9_]{1,64}$/.test(value)) {
    return value;
  }
  return fallback;
}

interface ReadyCheckShape {
  status?: unknown;
  error?: unknown;
}

interface ReadyEnvelopeShape {
  ok?: unknown;
  checks?: Record<string, ReadyCheckShape>;
}

function checkOf(envelope: ReadyEnvelopeShape, name: string): ReadyCheckShape | undefined {
  const checks = envelope.checks;
  if (typeof checks !== "object" || checks === null) {
    return undefined;
  }
  const check = checks[name];
  if (typeof check !== "object" || check === null) {
    return undefined;
  }
  return check;
}

/**
 * Classify a /api/health/ready response. Ready requires HTTP 200 with
 * ok true, matching the health contract (200 with ok false and 503
 * with ok true are both forbidden server-side). A failed db check
 * means the database class; a failed workspace check with
 * WORKSPACE_MISSING means the workspace class; any other failed
 * workspace check is unknown with the workspace step, because the
 * "moved or deleted" message would misdescribe a permission or
 * writability failure. A failed migrations check means the database
 * class, since drift leaves the database unusable for boot.
 */
export function classifyReadyResponse(
  status: number,
  bodyText: string,
): { ready: boolean; failure?: BootGuardFailure } {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      ready: false,
      failure: { code: "BOOT_UNKNOWN", step: "ready", detail: "READY_BODY_UNPARSEABLE" },
    };
  }
  if (typeof body !== "object" || body === null) {
    return {
      ready: false,
      failure: { code: "BOOT_UNKNOWN", step: "ready", detail: "READY_BODY_INVALID" },
    };
  }
  const envelope = body as ReadyEnvelopeShape;
  if (status === 200 && envelope.ok === true) {
    return { ready: true };
  }
  const db = checkOf(envelope, "db");
  if (db?.status === "fail") {
    return {
      ready: false,
      failure: {
        code: "BOOT_DB_UNREACHABLE",
        step: "ready",
        detail: safeDetailCode(db.error, "DB_CHECK_FAILED"),
      },
    };
  }
  const workspace = checkOf(envelope, "workspace");
  if (workspace?.status === "fail") {
    const errorCode = safeDetailCode(workspace.error, "WORKSPACE_CHECK_FAILED");
    if (errorCode === "WORKSPACE_MISSING") {
      return {
        ready: false,
        failure: { code: "BOOT_WORKSPACE_NOT_FOUND", step: "workspace", detail: errorCode },
      };
    }
    return {
      ready: false,
      failure: { code: "BOOT_UNKNOWN", step: "workspace", detail: errorCode },
    };
  }
  const migrations = checkOf(envelope, "migrations");
  if (migrations?.status === "fail") {
    return {
      ready: false,
      failure: {
        code: "BOOT_DB_UNREACHABLE",
        step: "ready",
        detail: safeDetailCode(migrations.error, "MIGRATION_CHECK_FAILED"),
      },
    };
  }
  if (status === 503) {
    return {
      ready: false,
      failure: { code: "BOOT_UNKNOWN", step: "ready", detail: "READY_NOT_OK" },
    };
  }
  return {
    ready: false,
    failure: { code: "BOOT_UNKNOWN", step: "ready", detail: `READY_HTTP_${status}` },
  };
}

/** Liveness requires HTTP 200 with a parseable envelope reporting ok true. */
export function classifyLiveResponse(status: number, bodyText: string): boolean {
  if (status !== 200) {
    return false;
  }
  try {
    const body: unknown = JSON.parse(bodyText);
    return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/**
 * Run one guard attempt: session, liveness, readiness (which covers
 * the workspace), then the store, then the redirect decision. Never
 * rejects. Never redirects on failure: the caller navigates only on
 * a "ready" outcome. A newer attempt or an unmount aborts this one
 * through outerSignal, producing "cancelled".
 */
export async function runBootGuard(
  deps: BootGuardDeps,
  outerSignal?: AbortSignal,
): Promise<BootGuardOutcome> {
  const timeoutMs = deps.timeoutMs ?? BOOT_GUARD_TIMEOUT_MS;
  const controller = new AbortController();
  const signal = controller.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = (): void => {
    controller.abort();
  };
  if (outerSignal) {
    if (outerSignal.aborted) {
      clearTimeout(timer);
      return { status: "cancelled" };
    }
    outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const fail = (failure: BootGuardFailure): BootGuardOutcome => ({ status: "failed", failure });

  try {
    if (deps.isOnline && !deps.isOnline()) {
      return fail({ code: "BOOT_NETWORK_UNREACHABLE", step: "guard", detail: "OFFLINE" });
    }

    deps.onStep?.("session");
    let session: SessionCheckResult;
    try {
      const probe = deps.checkSessionFn ?? checkSession;
      session = await awaitWithSignal(
        probe({
          timeoutMs: deps.sessionTimeoutMs ?? SESSION_CHECK_TIMEOUT_MS,
          signal,
        }),
        signal,
      );
    } catch (error) {
      if (error instanceof SessionCheckCancelledError || error instanceof BootGuardAbortedError) {
        throw error;
      }
      return fail({ code: "BOOT_SESSION_UNKNOWN", step: "session", detail: "SESSION_CHECK_FAILED" });
    }
    if (session.state === "unauthenticated") {
      return fail({ code: "BOOT_SESSION_EXPIRED", step: "session", detail: "SESSION_REJECTED" });
    }
    if (session.state !== "authenticated") {
      return fail({ code: "BOOT_SESSION_UNKNOWN", step: "session", detail: session.code });
    }

    const fetchHealth = deps.healthFetch ?? defaultHealthFetch;

    deps.onStep?.("live");
    let liveStatus: number;
    let liveText: string;
    try {
      const live = await awaitWithSignal(fetchHealth("/api/health/live", signal), signal);
      liveStatus = live.status;
      liveText = await awaitWithSignal(live.text(), signal);
    } catch (error) {
      if (error instanceof BootGuardAbortedError) {
        throw error;
      }
      if (signal.aborted) {
        throw new BootGuardAbortedError();
      }
      return fail({
        code: "BOOT_NETWORK_UNREACHABLE",
        step: "live",
        detail: "HEALTH_LIVE_UNREACHABLE",
      });
    }
    if (!classifyLiveResponse(liveStatus, liveText)) {
      return fail({ code: "BOOT_UNKNOWN", step: "live", detail: `LIVE_HTTP_${liveStatus}` });
    }

    deps.onStep?.("ready");
    let readyStatus: number;
    let readyText: string;
    try {
      const ready = await awaitWithSignal(fetchHealth("/api/health/ready", signal), signal);
      readyStatus = ready.status;
      readyText = await awaitWithSignal(ready.text(), signal);
    } catch (error) {
      if (error instanceof BootGuardAbortedError) {
        throw error;
      }
      if (signal.aborted) {
        throw new BootGuardAbortedError();
      }
      return fail({
        code: "BOOT_NETWORK_UNREACHABLE",
        step: "ready",
        detail: "HEALTH_READY_UNREACHABLE",
      });
    }
    const readyClassified = classifyReadyResponse(readyStatus, readyText);
    if (!readyClassified.ready) {
      return fail(
        readyClassified.failure ?? { code: "BOOT_UNKNOWN", step: "ready", detail: "READY_NOT_OK" },
      );
    }

    deps.onStep?.("store");
    let snapshot: BootStoreSnapshot;
    try {
      snapshot = await awaitWithSignal(deps.loadStore(), signal);
    } catch (error) {
      if (error instanceof BootGuardAbortedError) {
        throw error;
      }
      if (signal.aborted) {
        throw new BootGuardAbortedError();
      }
      return fail({ code: "BOOT_STORE_UNAVAILABLE", step: "store", detail: "STORE_LOAD_FAILED" });
    }
    const { target, storeUpdate } = resolveRedirectTarget(
      snapshot.currentPage,
      deps.isMobileDevice(),
    );
    if (storeUpdate !== null) {
      try {
        await awaitWithSignal(snapshot.persistCurrentPage(storeUpdate), signal);
      } catch (error) {
        if (error instanceof BootGuardAbortedError) {
          throw error;
        }
        if (signal.aborted) {
          throw new BootGuardAbortedError();
        }
        return fail({
          code: "BOOT_STORE_UNAVAILABLE",
          step: "store",
          detail: "STORE_SAVE_FAILED",
        });
      }
    }
    return { status: "ready", target };
  } catch (error) {
    if (error instanceof BootGuardAbortedError || error instanceof SessionCheckCancelledError) {
      if (timedOut) {
        return fail({ code: "BOOT_TIMEOUT", step: "guard", detail: "GUARD_TIMEOUT" });
      }
      return { status: "cancelled" };
    }
    return fail({ code: "BOOT_UNKNOWN", step: "guard", detail: "GUARD_INTERNAL_ERROR" });
  } finally {
    clearTimeout(timer);
    if (outerSignal) {
      outerSignal.removeEventListener("abort", onOuterAbort);
    }
  }
}
