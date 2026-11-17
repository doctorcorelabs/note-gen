// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web platform boot (N-5, 3E-STOREWIRE).
 *
 * The one boot seam that runs before any adapter is resolved:
 *
 * 1. POC cleanup (runPocCleanupOnce), so legacy POC keys are gone
 *    before the first load() and before any device-local document
 *    is read. The cleanup runs regardless of auth status and never
 *    throws; on a browser without POC keys it finds nothing.
 * 2. initializeWebPlatform, which registers every web adapter and
 *    freezes the registry. The store adapter receives its CSRF
 *    token provider from the one shared V3-30 seam (see below).
 *
 * Call site: the root layout module scope (src/app/layout.tsx),
 * which wraps every route, so module evaluation precedes all
 * renders and effects, including CustomCssController, the core and
 * mobile layouts, and the special routes. The root page effect
 * (src/app/page.tsx) calls this function again before the boot
 * guard chain; that call is a no-op once the registry is frozen.
 * No other call site is needed, and no other module may call
 * initializeWebPlatform directly.
 *
 * Guards: a no-op during SSR and build (no window), and a no-op
 * inside the Tauri shell, where a separate Tauri wiring step owns
 * registration (desktop mode is currently unregistered; that gap
 * predates this module and is out of scope). Registration itself
 * is idempotent through the registry freeze, so repeated calls
 * (dev re-run, strict re-mount) are safe.
 *
 * CSRF seam: the provider resolves the shared auth session lazily
 * on each call and returns null on any failure, honoring the
 * WebStoreAdapterDeps contract (a mutation without a token is sent
 * without the header and the server answers honestly). Boot never
 * creates a second token store: the session, its seam, and its
 * in-memory token stay the single instance owned by auth-client.
 * A stale cached token is not refreshed on this path: the store
 * adapter has no csrf_invalid retry, so a stale token fails every
 * later flush until reload. That refresh belongs to a flush
 * behavior change and is recorded as an open item, not fixed here.
 */

import { isTauri } from "../platform/detect";
import { runPocCleanupOnce } from "../platform/store/poc-cleanup";
import { initializeWebPlatform } from "../platform/wiring";
import { getSharedAuthSession } from "./auth-client";

/**
 * CSRF token provider for store mutations, from the one shared
 * V3-30 seam. The seam getToken fetches when no token is cached
 * and throws when the session is dead or the fetch fails; this
 * wrapper converts every failure to null, per the adapter dep
 * contract. Exported for the boot spec; production code reaches it
 * only through ensureWebPlatformInitialized.
 */
export async function getStoreCsrfTokenFromSharedSeam(): Promise<
  string | null
> {
  try {
    return await getSharedAuthSession().seam.csrf.getToken();
  } catch {
    return null;
  }
}

/**
 * Run the web boot sequence once: POC cleanup, then adapter
 * registration plus freeze. Safe to call repeatedly; safe to call
 * during SSR, in the Tauri shell, and before or after other boot
 * entry points. Must run before any platform adapter is resolved.
 */
export function ensureWebPlatformInitialized(): void {
  if (typeof window === "undefined") {
    return;
  }
  if (isTauri()) {
    return;
  }
  runPocCleanupOnce();
  initializeWebPlatform({
    getStoreCsrfToken: getStoreCsrfTokenFromSharedSeam,
  });
}
