// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web adapter registration wiring (N-1, AD-33, owner V3-11).
 *
 * This is the ONE module that writes registration calls. It imports
 * every web adapter implementation present at the base, registers
 * each one through registerPlatformAdapter, and freezes the registry.
 * No other module writes registration calls: adapters that land later
 * are added here by the wiring owner through a recorded follow-up
 * merge, never by each adapter worker.
 *
 * The registry itself (registry.ts) is mechanism only: it holds the
 * store, the typed accessors, and the freeze. It contains no
 * registration lines, and this module never edits it.
 *
 * Boot entry: boot code imports this module and calls
 * initializeWebPlatform() once, before any adapter is resolved. The
 * boot call site itself is owned by the boot/integrator task (N-5);
 * this task adds the module only and edits no boot file.
 *
 * Registered here (20): every factory present at the base, each
 * called with no arguments so the adapter reads browser globals and
 * defaults at call time, except the store adapter, which receives
 * its key classifier (and, when boot supplies one, its CSRF token
 * provider) as injected deps, and the sql adapter, which receives
 * its db-client port (and, when boot supplies one, its CSRF token
 * provider) plus its health probe as injected deps. Each adapter
 * is registered for mode "web" only. Tauri implementations, when
 * they exist, are registered by a separate Tauri wiring step; this
 * module never imports a *.tauri.ts file.
 *
 * No adapter name stays unregistered: the store factory landed
 * (V3-11) and is registered below with the key-schema classifier;
 * the channel factory landed as a 3D follow-up (C2) in
 * invoke/channel.web.ts and is registered below; the streaming
 * surface on WebInvokeAdapter is a different interface and must
 * never be registered as the channel adapter; the sql factory
 * landed (V3-14) and is registered below with its real deps:
 *
 *   registerPlatformAdapter(
 *     "sql",
 *     createWebSqlAdapter({
 *       port: createSqlDbClient({
 *         getCsrfToken: options.getSqlCsrfToken,
 *       }),
 *       health: probeSqlHealth,
 *     }),
 *     ["web"],
 *   );
 *
 * The no-arg form createWebSqlAdapter() never existed: the factory
 * requires WebSqlAdapterDeps (sql.web.ts). A future adapter
 * follow-up extends the wiring spec with the new name and re-runs
 * the gates in the spec header.
 *
 * Store and SQL CSRF seams: registerWebAdapters accepts an
 * optional CSRF token provider per adapter, each supplied by boot
 * from the one shared V3-30 seam.
 * Wiring never imports the web auth layer and never creates a
 * second token store: services arrive as parameters (the
 * dialog-wiring precedent). Without a provider, store mutations
 * and sql requests go out without the header and the server
 * answers honestly. The fetch transport is deliberately not
 * replaced: the shared ApiClient consumes the envelope, while the
 * store adapter needs the raw response surface for its 409
 * handling.
 *
 * SQL health probe: the sql adapter reports migration currency
 * from GET /api/health/ready through probeSqlHealth below, in
 * the probe shape WebSqlAdapterDeps expects (two booleans: ok
 * and migrationsCurrent). The probe runs only when ready() is
 * called, never at registration, so registration stays free of
 * I/O. See the probe for the response mapping.
 *
 * DialogService wiring (N-10) is a separate AD-33 item and is not
 * done here: the dialog adapter is registered with no dialog
 * service, so confirm/ask/message/prompt methods throw the
 * documented unavailable error until the service wiring lands.
 *
 * Guard note: scripts/platform-guard.sh check 3 predates the AD-33
 * correction and exempts only registry.ts. It flags the direct
 * implementation imports in this module by design. The guard update
 * (exempt this file alongside registry.ts) is a recorded follow-up
 * for the integrator; it is not part of this change.
 */

import { createWebAssetUrlAdapter } from "./asset/asset.web";
import { createWebAutostartAdapter } from "./autostart/autostart.web";
import { createWebClipboardAdapter } from "./clipboard/clipboard.web";
import { createWebDialogAdapter } from "./dialog/dialog.web";
import { createWebEventAdapter } from "./event/event.web";
import { createWebFsAdapter, type WebFsAdapterDeps } from "./fs/fs.web";
import { createWebHttpAdapter } from "./http/http.web";
import { createWebChannelAdapter } from "./invoke/channel.web";
import { createWebInvokeAdapter } from "./invoke/web";
import { createWebNotificationAdapter } from "./notification/notification.web";
import { createWebOpenerAdapter } from "./opener/opener.web";
import { createWebOsAdapter } from "./os/os.web";
import { createWebPathAdapter } from "./path/path.web";
import { createWebProcessAdapter } from "./process/process.web";
import { createWebShellAdapter } from "./shell/shell.web";
import { createWebShortcutAdapter } from "./shortcut/shortcut.web";
import { createSqlDbClient, type SqlDbCsrfTokenProvider, type SqlDbCsrfTokenRefresher } from "./sql/db-client";
import {
  createWebSqlAdapter,
  type SqlHealthProbeResult,
} from "./sql/sql.web";
import { classifyKey } from "./store/key-schema";
import {
  createWebStoreAdapter,
  type WebStoreAdapterDeps,
} from "./store/store.web";
import { createWebUpdaterAdapter } from "./updater/updater.web";
import { createWebWindowAdapter } from "./window/window.web";
import {
  freezeRegistry,
  isRegistryFrozen,
  registerPlatformAdapter,
} from "./registry";

/**
 * Adapter names registered by this module, in registration order.
 * The wiring spec asserts this list against the registry so a future
 * follow-up that adds an adapter cannot forget the spec update.
 */
export const REGISTERED_WEB_ADAPTER_NAMES: readonly string[] = [
  "assetUrl",
  "autostart",
  "channel",
  "clipboard",
  "dialog",
  "event",
  "fs",
  "http",
  "invoke",
  "notification",
  "opener",
  "os",
  "path",
  "process",
  "shell",
  "shortcut",
  "sql",
  "store",
  "updater",
  "window",
];

/**
 * Optional boot-supplied seams for registration. The fs, store, and
 * sql adapters take injected CSRF deps; every other factory is still
 * called with no arguments.
 */
export interface WebAdapterWiringOptions {
  /**
   * CSRF token provider for fs mutations, from the one shared
   * V3-30 seam owned by boot. Same contract as
   * WebFsAdapterDeps.getCsrfToken: return null when no token is
   * available instead of throwing. When absent, fs mutations go
   * out without the header and the server answers honestly. The
   * fs adapter has no csrf_invalid refresh retry: its transport
   * returns raw responses, so a retry would need a clone-based
   * design; that is recorded as an open follow-up, not fixed
   * here. The store and sql adapters do refresh and retry once
   * (see their refresh options below).
   */
  getFsCsrfToken?: WebFsAdapterDeps["getCsrfToken"];
  /**
   * CSRF token provider for store mutations, from the one shared
   * V3-30 seam owned by boot. Same contract as
   * WebStoreAdapterDeps.getCsrfToken: return null when no token is
   * available instead of throwing. When absent, store mutations go
   * out without the header and the server answers honestly.
   */
  getStoreCsrfToken?: WebStoreAdapterDeps["getCsrfToken"];
  /**
   * CSRF token refresher for store mutations, from the same shared
   * seam. Called at most once per request, only after the server
   * answers 403 `csrf_invalid`; the request is then retried once
   * with a freshly read token. When absent, a stale token fails
   * the request with the server error.
   */
  refreshStoreCsrfToken?: WebStoreAdapterDeps["refreshCsrfToken"];
  /**
   * CSRF token provider for sql requests, from the one shared
   * V3-30 seam owned by boot. Same contract as
   * SqlDbClientDeps.getCsrfToken: return null when no token is
   * available instead of throwing. When absent, sql requests go
   * out without the header and the server answers honestly.
   */
  getSqlCsrfToken?: SqlDbCsrfTokenProvider;
  /**
   * CSRF token refresher for sql requests, from the same shared
   * seam. Same once-per-request semantics as
   * `refreshStoreCsrfToken`, sharing the single retry budget of
   * the sql retry policy.
   */
  refreshSqlCsrfToken?: SqlDbCsrfTokenRefresher;
}

/** Ready path, mirroring HEALTH_READY_PATH in server/src/routes/health.ts. */
const SQL_HEALTH_READY_PATH = "/api/health/ready";

interface SqlHealthReadyBody {
  ok?: unknown;
  checks?: Record<string, { status?: unknown } | undefined>;
}

/**
 * Health probe for the web SqlAdapter: one GET to the ready
 * endpoint, mapped to the two booleans ready() reports. The
 * endpoint answers the AD-19 non-envelope health shape
 * (server/src/health/schemas.ts): ok plus per-check statuses of
 * "ok", "fail", or "skipped". Ready means HTTP 200 with ok true
 * (the health contract forbids 200 with ok false and 503 with ok
 * true, and the boot guard classifies the same way). Migration
 * currency means the migrations check status is exactly "ok": a
 * "skipped" check means the server check is not configured, which
 * is unverified rather than current, and a missing or malformed
 * body is unverified too. The probe never throws: no fetch, a
 * rejected fetch, or an unparseable body all answer not-ok. It
 * runs only when ready() calls it, never at registration. No
 * auth or CSRF header is sent: the health paths require no
 * application auth (server/src/routes/health.ts). The fetch init
 * mirrors defaultHealthFetch in src/lib/web/boot-guard.ts.
 */
async function probeSqlHealth(): Promise<SqlHealthProbeResult> {
  const notOk: SqlHealthProbeResult = { ok: false, migrationsCurrent: false };
  try {
    const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof fetchFn !== "function") {
      return notOk;
    }
    const response = await fetchFn(SQL_HEALTH_READY_PATH, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    let body: SqlHealthReadyBody;
    try {
      body = JSON.parse(await response.text()) as SqlHealthReadyBody;
    } catch {
      return notOk;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return notOk;
    }
    const ok = response.status === 200 && body.ok === true;
    const migrations = body.checks?.["migrations"];
    const migrationsCurrent =
      typeof migrations === "object" &&
      migrations !== null &&
      migrations.status === "ok";
    return { ok, migrationsCurrent };
  } catch {
    return notOk;
  }
}

/**
 * Register every web adapter present at the base. One-shot boot use:
 * calling it after the freeze throws (registry semantics), and
 * calling it twice before the freeze replaces the registered
 * instances. Production boot calls initializeWebPlatform instead.
 * The store adapter is built with the key-schema classifier; the
 * CSRF providers and refreshers arrive through options (see the
 * module header). The sql adapter is built with a db-client port
 * plus the health probe; its CSRF provider and refresher arrive
 * through options the same way. The fs adapter receives its CSRF
 * provider through options too; it has no refresh retry (see the
 * option comment).
 */
export function registerWebAdapters(
  options: WebAdapterWiringOptions = {},
): void {
  registerPlatformAdapter("assetUrl", createWebAssetUrlAdapter(), ["web"]);
  registerPlatformAdapter("autostart", createWebAutostartAdapter(), ["web"]);
  registerPlatformAdapter("channel", createWebChannelAdapter(), ["web"]);
  registerPlatformAdapter("clipboard", createWebClipboardAdapter(), ["web"]);
  registerPlatformAdapter("dialog", createWebDialogAdapter(), ["web"]);
  registerPlatformAdapter("event", createWebEventAdapter(), ["web"]);
  registerPlatformAdapter(
    "fs",
    createWebFsAdapter({ getCsrfToken: options.getFsCsrfToken }),
    ["web"],
  );
  registerPlatformAdapter("http", createWebHttpAdapter(), ["web"]);
  registerPlatformAdapter("invoke", createWebInvokeAdapter(), ["web"]);
  registerPlatformAdapter(
    "notification",
    createWebNotificationAdapter(),
    ["web"],
  );
  registerPlatformAdapter("opener", createWebOpenerAdapter(), ["web"]);
  registerPlatformAdapter("os", createWebOsAdapter(), ["web"]);
  registerPlatformAdapter("path", createWebPathAdapter(), ["web"]);
  registerPlatformAdapter("process", createWebProcessAdapter(), ["web"]);
  registerPlatformAdapter("shell", createWebShellAdapter(), ["web"]);
  registerPlatformAdapter("shortcut", createWebShortcutAdapter(), ["web"]);
  registerPlatformAdapter(
    "sql",
    createWebSqlAdapter({
      port: createSqlDbClient({
        getCsrfToken: options.getSqlCsrfToken,
        refreshCsrfToken: options.refreshSqlCsrfToken,
      }),
      health: probeSqlHealth,
    }),
    ["web"],
  );
  registerPlatformAdapter(
    "store",
    createWebStoreAdapter({
      classifyKey,
      getCsrfToken: options.getStoreCsrfToken,
      refreshCsrfToken: options.refreshStoreCsrfToken,
    }),
    ["web"],
  );
  registerPlatformAdapter("updater", createWebUpdaterAdapter(), ["web"]);
  registerPlatformAdapter("window", createWebWindowAdapter(), ["web"]);
}

/**
 * Boot entry: register all web adapters, then freeze the registry.
 * Idempotent: a second call after the freeze is a no-op, so a boot
 * sequence that runs twice (dev re-run, strict re-mount) does not
 * throw. Options are honored only by the first call; a later call
 * with different options still no-ops. Late registration after this
 * call throws; that is the freeze doing its job, not a bug.
 */
export function initializeWebPlatform(
  options: WebAdapterWiringOptions = {},
): void {
  if (isRegistryFrozen()) {
    return;
  }
  registerWebAdapters(options);
  freezeRegistry();
}
