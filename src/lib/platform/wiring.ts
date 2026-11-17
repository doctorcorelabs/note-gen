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
 * Registered here (19): every factory present at the base, each
 * called with no arguments so the adapter reads browser globals and
 * defaults at call time, except the store adapter, which receives
 * its key classifier (and, when boot supplies one, its CSRF token
 * provider) as injected deps. Each adapter is registered for mode
 * "web" only. Tauri implementations, when they exist, are registered
 * by a separate Tauri wiring step; this module never imports a
 * *.tauri.ts file.
 *
 * NOT registered here (recorded follow-up, no stubs): sql. No web
 * factory exists for it at the base: the sql directory holds only
 * the interface and the ops catalog. The store factory landed
 * (V3-11) and is registered below with the key-schema classifier;
 * the channel factory landed as a 3D follow-up (C2) in
 * invoke/channel.web.ts and is registered below; the streaming
 * surface on WebInvokeAdapter is a different interface and must
 * never be registered as the channel adapter. When the sql factory
 * lands, the follow-up adds its import plus exactly one
 * registration line inside registerWebAdapters, before the freeze:
 *
 *   registerPlatformAdapter("sql", createWebSqlAdapter(), ["web"]);
 *
 * with the factory name adjusted to the name the landing worker
 * actually exports. The follow-up also extends the wiring spec with
 * the new name and re-runs the gates in the spec header.
 *
 * Store CSRF seam: registerWebAdapters accepts an optional CSRF
 * token provider, supplied by boot from the one shared V3-30 seam.
 * Wiring never imports the web auth layer and never creates a
 * second token store: services arrive as parameters (the
 * dialog-wiring precedent). Without a provider, store mutations go
 * out without the header and the server answers honestly. The fetch
 * transport is deliberately not replaced: the shared ApiClient
 * consumes the envelope, while the store adapter needs the raw
 * response surface for its 409 handling.
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
import { createWebFsAdapter } from "./fs/fs.web";
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
  "store",
  "updater",
  "window",
];

/**
 * Optional boot-supplied seams for registration. Only the store
 * adapter takes injected deps today; every other factory is still
 * called with no arguments.
 */
export interface WebAdapterWiringOptions {
  /**
   * CSRF token provider for store mutations, from the one shared
   * V3-30 seam owned by boot. Same contract as
   * WebStoreAdapterDeps.getCsrfToken: return null when no token is
   * available instead of throwing. When absent, store mutations go
   * out without the header and the server answers honestly.
   */
  getStoreCsrfToken?: WebStoreAdapterDeps["getCsrfToken"];
}

/**
 * Register every web adapter present at the base. One-shot boot use:
 * calling it after the freeze throws (registry semantics), and
 * calling it twice before the freeze replaces the registered
 * instances. Production boot calls initializeWebPlatform instead.
 * The store adapter is built with the key-schema classifier; the
 * CSRF provider arrives through options (see the module header).
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
  registerPlatformAdapter("fs", createWebFsAdapter(), ["web"]);
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
    "store",
    createWebStoreAdapter({
      classifyKey,
      getCsrfToken: options.getStoreCsrfToken,
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
