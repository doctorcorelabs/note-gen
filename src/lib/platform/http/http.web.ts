// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { capabilityError } from "../errors";
import type { HttpAdapter, HttpClientOptions } from "./interface";

/**
 * Web implementation of HttpAdapter: a guard around the browser fetch.
 *
 * Origin policy (MVP, binding):
 * - Relative URLs and absolute URLs whose origin exactly matches the
 *   page origin are allowed. The page origin is read from
 *   `location.origin` at factory time.
 * - Absolute URLs to any other origin are rejected with
 *   PlatformCapabilityError before any network request is made. The
 *   cross-origin allowlist is EMPTY in the MVP: no third-party origin
 *   may be contacted directly from the browser. This is what enforces
 *   AD-12 at the adapter layer (case material must never touch a
 *   third-party provider directly) and AD-16 (the only path to an AI
 *   provider is the same-origin server-side proxy). Sync providers,
 *   image hosts, and other remote endpoints must go through a
 *   same-origin backend endpoint; the backend owns its own host
 *   allowlist and SSRF guards.
 * - The allowlist lives in WEB_HTTP_ALLOWLIST below. Adding an entry
 *   is a deliberate security decision for a later phase: it needs a
 *   recorded review of CORS, credential handling, and SSRF exposure,
 *   and must never be done silently. The MVP value is the empty list.
 * - Protocol-relative URLs (//host/path) resolve against the page
 *   scheme and are checked like any absolute URL, so they cannot
 *   bypass the guard. The same holds for the other spellings the URL
 *   parser normalizes into a foreign origin (leading whitespace,
 *   backslashes in place of slashes): after resolution, a URL that
 *   started out relative is allowed only when its resolved origin
 *   still equals the expected origin, so no spelling can smuggle a
 *   foreign origin past the check. URLs with embedded credentials
 *   and URLs with a non-http(s) scheme are rejected. Error reasons
 *   name the origin only, never the full URL, so query tokens cannot
 *   leak into logs.
 *
 * ClientOptions mapping:
 * - `maxRedirections: 0` maps to `redirect: "manual"`. Any positive
 *   value maps to `redirect: "follow"` (the browser default): browsers
 *   cannot enforce an exact redirect count, so the count itself is
 *   not honored. Call sites that depend on observing a redirect
 *   response must use `maxRedirections: 0`.
 * - `connectTimeout` maps to an abort timer on the request. The
 *   browser has no connect-only timeout, so the timer covers the
 *   whole request until the response headers arrive. The timer is
 *   combined with the caller's own abort signal; a timeout rejects
 *   with a TimeoutError DOMException.
 * - `proxy` and `danger` have no browser equivalent. A non-empty
 *   proxy configuration or an enabled danger flag is rejected with
 *   PlatformCapabilityError instead of being silently ignored:
 *   ignoring a proxy would misroute traffic the caller expected to
 *   be proxied. An empty proxy object or all-false danger flags are
 *   treated as absent.
 * - The plugin-only option keys are stripped from the init object
 *   passed to the browser fetch. The caller's init object is never
 *   mutated (unlike the upstream encode-fetch wrapper, which deletes
 *   keys from the object it receives).
 */

/**
 * Cross-origin allowlist, as exact origins ("https://host:port").
 * EMPTY in the MVP. See the header comment before changing this.
 */
const WEB_HTTP_ALLOWLIST: readonly string[] = Object.freeze([]);

/** Placeholder base used only to parse relative URLs when no page origin is known. Never fetched. */
const PLACEHOLDER_BASE = "http://web-adapter.invalid";

export interface WebHttpAdapterOptions {
  /**
   * Fetch implementation to delegate to. Defaults to the global
   * fetch, resolved at call time. Test-only in practice.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Page origin used for the same-origin check. When the key is
   * absent, `location.origin` is read. Pass null (or a thunk
   * returning null) to simulate an unknown origin, in which case
   * every absolute URL is rejected. A string may carry a path or
   * query; only its origin part is used. Test-only in practice;
   * production code calls the factory with no arguments.
   */
  readonly baseOrigin?: string | (() => string | null) | null;
}

function readLocationOrigin(): string | null {
  const locationValue = (globalThis as { location?: { origin?: unknown } }).location;
  const origin = typeof locationValue?.origin === "string" ? locationValue.origin : null;
  return origin && origin !== "null" ? origin : null;
}

function normalizeOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    return parsed.origin === "null" ? null : parsed.origin;
  } catch {
    throw new TypeError("HttpAdapter base origin is not a valid absolute URL.");
  }
}

function resolveBaseOrigin(options?: WebHttpAdapterOptions): string | null {
  if (options === undefined || !("baseOrigin" in options)) {
    return readLocationOrigin();
  }
  const raw = options.baseOrigin;
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "function") {
    const value = raw();
    return value === null ? null : normalizeOrigin(value);
  }
  return normalizeOrigin(raw);
}

function parseTarget(
  input: string | URL | Request,
  baseOrigin: string | null,
): { url: URL; wasRelative: boolean } {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return { url: new URL(raw), wasRelative: false };
  } catch {
    // Not an absolute URL: resolve as relative against the page origin
    // (or the placeholder base, purely for parsing).
  }
  try {
    return { url: new URL(raw, baseOrigin ?? PLACEHOLDER_BASE), wasRelative: true };
  } catch {
    throw new TypeError("HttpAdapter.fetch received an invalid URL.");
  }
}

function assertAllowedTarget(url: URL, wasRelative: boolean, baseOrigin: string | null): void {
  // A URL that started out relative is allowed only when resolution
  // kept it on the expected origin. Without this check, spellings
  // the URL parser normalizes into a foreign origin ("//evil/x",
  // "\\\\evil\\x", leading whitespace before "//evil/x") would
  // resolve cross-origin yet sail through as "relative". When no
  // page origin is known, the expected origin is the placeholder
  // parse base, so only genuinely relative spellings pass.
  if (wasRelative) {
    const expected = baseOrigin ?? new URL(PLACEHOLDER_BASE).origin;
    if (url.origin === expected) {
      return;
    }
    // Resolved away from the expected origin: fall through to the
    // absolute-URL checks below, which reject it unless the origin
    // is the page origin or on the allowlist.
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw capabilityError(
      "unsupported",
      "http",
      "http.fetch",
      "web",
      `URL scheme "${url.protocol}" is not supported; HttpAdapter only fetches http: and https: URLs`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw capabilityError(
      "invalid_argument",
      "http",
      "http.fetch",
      "web",
      "URLs with embedded credentials are rejected",
    );
  }
  if (baseOrigin !== null && url.origin === baseOrigin) {
    return;
  }
  if (WEB_HTTP_ALLOWLIST.includes(url.origin)) {
    return;
  }
  throw capabilityError(
    "unsupported",
    "http",
    "http.fetch",
    "web",
    `Cross-origin request to ${url.origin} is not allowed: the MVP allowlist is empty; use a same-origin backend endpoint instead`,
  );
}

function assertSupportedClientOptions(init: RequestInit & HttpClientOptions | undefined): void {
  const proxy = init?.proxy;
  if (proxy && (proxy.all !== undefined || proxy.http !== undefined || proxy.https !== undefined)) {
    throw capabilityError(
      "unsupported",
      "http",
      "http.fetch.proxy",
      "web",
      "Proxy configuration has no browser equivalent; configure the proxy on the same-origin backend instead",
    );
  }
  const danger = init?.danger;
  if (danger && (danger.acceptInvalidCerts === true || danger.acceptInvalidHostnames === true)) {
    throw capabilityError(
      "unsupported",
      "http",
      "http.fetch.danger",
      "web",
      "Disabling TLS verification has no browser equivalent",
    );
  }
  const maxRedirections = init?.maxRedirections;
  if (
    maxRedirections !== undefined &&
    (!Number.isInteger(maxRedirections) || maxRedirections < 0)
  ) {
    throw new TypeError("HttpAdapter.fetch: maxRedirections must be a non-negative integer.");
  }
  const connectTimeout = init?.connectTimeout;
  if (connectTimeout !== undefined && (!Number.isFinite(connectTimeout) || connectTimeout < 0)) {
    throw new TypeError(
      "HttpAdapter.fetch: connectTimeout must be a non-negative finite number of milliseconds.",
    );
  }
}

function abortReasonOf(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError");
}

function setupSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (callerSignal?.aborted) {
    throw abortReasonOf(callerSignal);
  }
  if (timeoutMs === undefined) {
    return { signal: callerSignal ?? undefined, cleanup: () => undefined };
  }
  const controller = new AbortController();
  const timeoutError = new DOMException("The operation timed out.", "TimeoutError");
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const onCallerAbort = (): void => {
    if (callerSignal) {
      controller.abort(abortReasonOf(callerSignal));
    }
  };
  if (callerSignal) {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (callerSignal) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}

export function createWebHttpAdapter(options?: WebHttpAdapterOptions): HttpAdapter {
  const baseOrigin = resolveBaseOrigin(options);
  const fetchImpl =
    options?.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  return {
    async fetch(
      input: string | URL | Request,
      init?: RequestInit & HttpClientOptions,
    ): Promise<Response> {
      const { url, wasRelative } = parseTarget(input, baseOrigin);
      assertAllowedTarget(url, wasRelative, baseOrigin);
      assertSupportedClientOptions(init);

      const maxRedirections = init?.maxRedirections;
      const connectTimeout = init?.connectTimeout;
      const browserInit: RequestInit = { ...(init ?? {}) };
      const stripped = browserInit as unknown as Record<string, unknown>;
      delete stripped.maxRedirections;
      delete stripped.connectTimeout;
      delete stripped.proxy;
      delete stripped.danger;

      const redirect =
        maxRedirections === undefined ? undefined : maxRedirections === 0 ? "manual" : "follow";
      const timeoutMs =
        connectTimeout === undefined || connectTimeout === 0 ? undefined : connectTimeout;
      const { signal, cleanup } = setupSignal(init?.signal ?? null, timeoutMs);
      try {
        const overrides: RequestInit = {};
        if (signal !== undefined) {
          overrides.signal = signal;
        }
        if (redirect !== undefined) {
          overrides.redirect = redirect;
        }
        if (typeof input === "string") {
          // Pass the original string so relative URLs resolve against
          // the real page origin, not the placeholder parse base.
          return await fetchImpl(input, { ...browserInit, ...overrides });
        }
        if (input instanceof URL) {
          return await fetchImpl(url.href, { ...browserInit, ...overrides });
        }
        return await fetchImpl(input, { ...browserInit, ...overrides });
      } finally {
        cleanup();
      }
    },
  };
}
