// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Import mapping tables for the codemod engine (V3-16a).
 *
 * One entry per imported name that occurs in the tree, per Tauri module
 * specifier. The table is grounded in a read-only inventory of the trunk
 * tree (branch web at c3f1c940): every static and dynamic import of a
 * Tauri specifier outside src/lib/platform/ was enumerated, including
 * dynamic-only names (once, getAllWebviewWindows) and the default import
 * Database. Names that do not occur in the tree have no entry on purpose:
 * an unknown name fails a declaration closed (skip + report) instead of
 * being guessed.
 *
 * Actions:
 * - "platform": the binding is removed and an import of `platform` from
 *   the registry barrel is ensured. Call sites are NOT rewritten by this
 *   engine; the report lists every reference with a suggested replacement
 *   expression for the wave worker (3C) to apply.
 * - "barrel": the binding is re-imported from the registry barrel under
 *   the same name (alias preserved). barrelKind "value" is a runtime
 *   export (BaseDirectory, isTauri). barrelKind "type" is a type-only
 *   export; the engine rewrites it only when every reference is in a
 *   type position, otherwise the declaration is skipped.
 * - "none": no same-name replacement exists. The declaration is skipped
 *   with a reason. This covers QueryResult (rejected by AD-26), Update
 *   used as a value (barrel has UpdateInfo, a different shape), and
 *   LogicalSize / PhysicalPosition used as values (barrel has *Value
 *   structural types; the one call site migrates to a plain object in
 *   G4, manually). The same names used ONLY in type positions are
 *   handled by typeBarrelName below instead of skipping.
 * - "typeBarrelName": when present, a binding whose references are all
 *   in type positions is re-imported as a barrel type under the new
 *   name, keeping the local name as an alias
 *   (`import type { StoreHandle as Store }`). References keep working;
 *   the wave worker renames them to the barrel name at stage A. Mixed
 *   type+value use of such a binding fails the declaration closed.
 * - "manualReview": when present, the file is flagged MANUAL-REVIEW in
 *   the report even when its import rewrite is mechanical, because a
 *   human decision is required before merge (V3-16c manual-review
 *   kind). Auto cases never carry this flag.
 *
 * Wave: the migration wave that owns the name. The api/core specifier is
 * shared: invoke/Channel/transformCallback close at G2, convertFileSrc
 * at G3, isTauri at G4. A binding whose wave differs from the run wave
 * is kept in a residual declaration (partial transform), never dropped.
 */

export const PLATFORM_BARREL = "@/lib/platform";

/**
 * Specifiers handled by each wave (desain-registry-shim.md section 4.2).
 * api/core spans three waves per binding: invoke/Channel/
 * transformCallback at G2, convertFileSrc at G3, isTauri at G4. Each
 * wave lists api/core so its own bindings stay reachable in wave mode;
 * bindings of other waves are kept as a residual declaration.
 */
export const WAVE_SPECIFIERS = {
  G1: [
    "@tauri-apps/plugin-store",
    "@tauri-apps/plugin-sql",
    "@tauri-apps/api/path",
    "@tauri-apps/plugin-fs",
  ],
  G2: ["@tauri-apps/api/core", "@tauri-apps/plugin-http"],
  G3: [
    "@tauri-apps/plugin-dialog",
    "@tauri-apps/plugin-opener",
    "@tauri-apps/plugin-clipboard-manager",
    "tauri-plugin-clipboard-api",
    "@tauri-apps/api/core",
  ],
  G4: [
    "@tauri-apps/api/window",
    "@tauri-apps/api/webviewWindow",
    "@tauri-apps/api/event",
    "@tauri-apps/plugin-os",
    "@tauri-apps/api/app",
    "@tauri-apps/plugin-notification",
    "@tauri-apps/api/core",
  ],
  G5: [
    "@tauri-apps/plugin-global-shortcut",
    "@tauri-apps/plugin-shell",
    "@tauri-apps/plugin-process",
    "@tauri-apps/plugin-autostart",
    "@tauri-apps/plugin-updater",
    "@tauri-apps/api/image",
  ],
};

/** All specifiers the engine knows, in wave order. */
export const KNOWN_SPECIFIERS = [...new Set(Object.values(WAVE_SPECIFIERS).flat())];

/**
 * Mapping entry fields:
 * - wave: owning wave (G1..G5).
 * - action: "platform" | "barrel" | "none".
 * - adapter: platform adapter key, for "platform" entries.
 * - replacement: expression or instruction replacing the binding at call
 *   sites. Report-only; the engine never edits call sites.
 * - barrelKind: "value" | "type", for "barrel" entries.
 * - typeBarrelName: barrel type name for type-only references (see above).
 * - manualReview: human-decision note; flags the file MANUAL-REVIEW.
 * - note: extra context for the wave worker, kept in the report.
 */
export const NAME_MAPPINGS = {
  "@tauri-apps/plugin-store": {
    Store: {
      wave: "G1",
      action: "platform",
      adapter: "store",
      replacement: "platform.store",
      typeBarrelName: "StoreHandle",
      note: "Store.load(...) becomes platform.store.load(...). A type-only Store binding is re-imported as StoreHandle (aliased to Store).",
    },
  },
  "@tauri-apps/plugin-sql": {
    default: {
      wave: "G1",
      action: "platform",
      adapter: "sql",
      replacement: "typed operations via platform.sql",
      manualReview: "SQL funnel (db/index.ts): migration to typed operations is manual work (V3-14), not an import rewrite.",
      note:
        "No direct replacement: the SqlAdapter interface (V3-14) exposes typed operations, not Database.load. The db/index.ts funnel migrates when that interface lands.",
    },
    QueryResult: {
      wave: "G1",
      action: "none",
      manualReview: "QueryResult has no barrel equivalent (AD-26); the funnel migrates manually (V3-14).",
      note: "No barrel equivalent: QueryResult was rejected by AD-26 and must not be reintroduced.",
    },
  },
  "@tauri-apps/api/path": {
    appDataDir: { wave: "G1", action: "platform", adapter: "path", replacement: "platform.path.appDataDir" },
    appConfigDir: { wave: "G1", action: "platform", adapter: "path", replacement: "platform.path.appConfigDir" },
    join: { wave: "G1", action: "platform", adapter: "path", replacement: "platform.path.join" },
    dirname: { wave: "G1", action: "platform", adapter: "path", replacement: "platform.path.dirname" },
    basename: { wave: "G1", action: "platform", adapter: "path", replacement: "platform.path.basename" },
    normalize: { wave: "G1", action: "platform", adapter: "path", replacement: "platform.path.normalize" },
  },
  "@tauri-apps/plugin-fs": {
    exists: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.exists" },
    mkdir: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.mkdir" },
    readFile: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.readFile" },
    writeFile: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.writeFile" },
    readTextFile: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.readTextFile" },
    writeTextFile: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.writeTextFile" },
    readDir: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.readDir" },
    remove: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.remove" },
    lstat: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.lstat" },
    stat: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.stat" },
    copyFile: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.copyFile" },
    rename: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.rename" },
    open: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.open" },
    watch: { wave: "G1", action: "platform", adapter: "fs", replacement: "platform.fs.watch" },
    BaseDirectory: { wave: "G1", action: "barrel", barrelKind: "value" },
    DirEntry: { wave: "G1", action: "barrel", barrelKind: "type" },
    WatchEvent: { wave: "G1", action: "barrel", barrelKind: "type" },
    WriteFileOptions: { wave: "G1", action: "barrel", barrelKind: "type" },
  },
  "@tauri-apps/api/core": {
    invoke: {
      wave: "G2",
      action: "platform",
      adapter: "invoke",
      replacement: "typed router call via platform.invoke",
      note: "No raw replacement: G2 replaces invoke(...) with the typed command router.",
    },
    Channel: {
      wave: "G2",
      action: "platform",
      adapter: "channel",
      replacement: "platform.channel.createChannel(...)",
      note: "The Channel constructor has no direct replacement; the channel seam is createChannel.",
    },
    transformCallback: {
      wave: "G2",
      action: "platform",
      adapter: "invoke",
      replacement: "internal invoke seam (tauri-event-listener relocation)",
      note: "Only used by src/lib/tauri-event-listener.ts, which relocates into src/lib/platform/ at G2.",
    },
    convertFileSrc: {
      wave: "G3",
      action: "platform",
      adapter: "assetUrl",
      replacement: "platform.assetUrl.convertFileSrc",
    },
    isTauri: { wave: "G4", action: "barrel", barrelKind: "value" },
  },
  "@tauri-apps/plugin-http": {
    fetch: { wave: "G2", action: "platform", adapter: "http", replacement: "platform.http.fetch" },
    ClientOptions: { wave: "G2", action: "barrel", barrelKind: "type" },
    Proxy: { wave: "G2", action: "barrel", barrelKind: "type" },
  },
  "@tauri-apps/plugin-dialog": {
    open: { wave: "G3", action: "platform", adapter: "dialog", replacement: "platform.dialog.open" },
    save: { wave: "G3", action: "platform", adapter: "dialog", replacement: "platform.dialog.save" },
    confirm: { wave: "G3", action: "platform", adapter: "dialog", replacement: "platform.dialog.confirm" },
    ask: { wave: "G3", action: "platform", adapter: "dialog", replacement: "platform.dialog.ask" },
    message: { wave: "G3", action: "platform", adapter: "dialog", replacement: "platform.dialog.message" },
  },
  "@tauri-apps/plugin-opener": {
    openUrl: { wave: "G3", action: "platform", adapter: "opener", replacement: "platform.opener.openUrl" },
    openPath: {
      wave: "G3",
      action: "platform",
      adapter: "opener",
      replacement: "platform.opener.openPath",
      manualReview: "Per-call-site decision: workspace paths map to downloads; OS paths throw PlatformCapabilityError. A human records the decision.",
    },
    revealItemInDir: {
      wave: "G3",
      action: "platform",
      adapter: "opener",
      replacement: "platform.opener.revealItemInDir",
      manualReview: "Per-call-site decision: workspace paths map to downloads; OS paths throw PlatformCapabilityError. A human records the decision.",
    },
  },
  "@tauri-apps/plugin-clipboard-manager": {
    writeText: { wave: "G3", action: "platform", adapter: "clipboard", replacement: "platform.clipboard.writeText" },
    writeImage: { wave: "G3", action: "platform", adapter: "clipboard", replacement: "platform.clipboard.writeImage" },
    writeHtml: { wave: "G3", action: "platform", adapter: "clipboard", replacement: "platform.clipboard.writeHtml" },
  },
  "tauri-plugin-clipboard-api": {
    hasText: { wave: "G3", action: "platform", adapter: "clipboard", replacement: "platform.clipboard.hasText" },
    hasImage: { wave: "G3", action: "platform", adapter: "clipboard", replacement: "platform.clipboard.hasImage" },
    readText: { wave: "G3", action: "platform", adapter: "clipboard", replacement: "platform.clipboard.readText" },
    readImageBase64: { wave: "G3", action: "platform", adapter: "clipboard", replacement: "platform.clipboard.readImageBase64" },
    clear: { wave: "G3", action: "platform", adapter: "clipboard", replacement: "platform.clipboard.clear" },
    writeText: { wave: "G3", action: "platform", adapter: "clipboard", replacement: "platform.clipboard.writeText" },
  },
  "@tauri-apps/api/window": {
    getCurrentWindow: { wave: "G4", action: "platform", adapter: "window", replacement: "platform.window.getCurrentWindow" },
    currentMonitor: { wave: "G4", action: "platform", adapter: "window", replacement: "platform.window.currentMonitor" },
    LogicalSize: {
      wave: "G4",
      action: "none",
      typeBarrelName: "LogicalSizeValue",
      manualReview: "Construction sites migrate to plain objects with manual verification; type-only uses map to LogicalSizeValue.",
      note: "No same-name barrel export (barrel has LogicalSizeValue). The one construction site migrates to a plain object in G4, manually.",
    },
    PhysicalPosition: {
      wave: "G4",
      action: "none",
      typeBarrelName: "PhysicalPositionValue",
      manualReview: "Construction sites migrate to plain objects with manual verification; type-only uses map to PhysicalPositionValue.",
      note: "No same-name barrel export (barrel has PhysicalPositionValue). The one construction site migrates to a plain object in G4, manually.",
    },
  },
  "@tauri-apps/api/webviewWindow": {
    WebviewWindow: {
      wave: "G4",
      action: "platform",
      adapter: "window",
      replacement: "platform.window.createWebviewWindow(...)",
      note: "The WebviewWindow constructor becomes the createWebviewWindow factory.",
    },
    getCurrentWebviewWindow: { wave: "G4", action: "platform", adapter: "window", replacement: "platform.window.getCurrentWebviewWindow" },
    getAllWebviewWindows: { wave: "G4", action: "platform", adapter: "window", replacement: "platform.window.getAllWebviewWindows" },
  },
  "@tauri-apps/api/event": {
    listen: { wave: "G4", action: "platform", adapter: "event", replacement: "platform.event.listen" },
    emit: { wave: "G4", action: "platform", adapter: "event", replacement: "platform.event.emit" },
    emitTo: { wave: "G4", action: "platform", adapter: "event", replacement: "platform.event.emitTo" },
    once: { wave: "G4", action: "platform", adapter: "event", replacement: "platform.event.once" },
    Event: { wave: "G4", action: "barrel", barrelKind: "type" },
    EventCallback: { wave: "G4", action: "barrel", barrelKind: "type" },
    EventName: { wave: "G4", action: "barrel", barrelKind: "type" },
    EventTarget: { wave: "G4", action: "barrel", barrelKind: "type" },
    UnlistenFn: { wave: "G4", action: "barrel", barrelKind: "type" },
  },
  "@tauri-apps/plugin-os": {
    platform: {
      wave: "G4",
      action: "platform",
      adapter: "os",
      replacement: "platform.os.platform",
      note: "Manual audit per call site: the web value 'web' must be handled. A local name of `platform` collides with the registry import, so the engine skips such declarations.",
    },
    version: { wave: "G4", action: "platform", adapter: "os", replacement: "platform.os.version" },
    arch: { wave: "G4", action: "platform", adapter: "os", replacement: "platform.os.arch" },
    locale: { wave: "G4", action: "platform", adapter: "os", replacement: "platform.os.locale" },
  },
  "@tauri-apps/api/app": {
    getVersion: { wave: "G4", action: "platform", adapter: "os", replacement: "platform.os.getAppVersion" },
  },
  "@tauri-apps/plugin-notification": {
    isPermissionGranted: { wave: "G4", action: "platform", adapter: "notification", replacement: "platform.notification.isPermissionGranted" },
    requestPermission: { wave: "G4", action: "platform", adapter: "notification", replacement: "platform.notification.requestPermission" },
    sendNotification: { wave: "G4", action: "platform", adapter: "notification", replacement: "platform.notification.sendNotification" },
  },
  "@tauri-apps/plugin-global-shortcut": {
    register: { wave: "G5", action: "platform", adapter: "shortcut", replacement: "platform.shortcut.register" },
    unregister: { wave: "G5", action: "platform", adapter: "shortcut", replacement: "platform.shortcut.unregister" },
    isRegistered: { wave: "G5", action: "platform", adapter: "shortcut", replacement: "platform.shortcut.isRegistered" },
  },
  "@tauri-apps/plugin-shell": {
    open: { wave: "G5", action: "platform", adapter: "shell", replacement: "platform.shell.open" },
  },
  "@tauri-apps/plugin-process": {
    relaunch: { wave: "G5", action: "platform", adapter: "process", replacement: "platform.process.relaunch" },
    exit: { wave: "G5", action: "platform", adapter: "process", replacement: "platform.process.exit" },
  },
  "@tauri-apps/plugin-autostart": {
    enable: { wave: "G5", action: "platform", adapter: "autostart", replacement: "platform.autostart.enable" },
    disable: { wave: "G5", action: "platform", adapter: "autostart", replacement: "platform.autostart.disable" },
    isEnabled: { wave: "G5", action: "platform", adapter: "autostart", replacement: "platform.autostart.isEnabled" },
  },
  "@tauri-apps/plugin-updater": {
    check: { wave: "G5", action: "platform", adapter: "updater", replacement: "platform.updater.check" },
    Update: {
      wave: "G5",
      action: "none",
      typeBarrelName: "UpdateInfo",
      manualReview: "Update to UpdateInfo mapping and check behavior need manual verification, including the updater trigger guard in layout (V3-21, AD-42).",
      note: "No same-name barrel export: the barrel has UpdateInfo (data), while Update is a class with downloadAndInstall. Type-only uses map to UpdateInfo; value uses migrate manually in G5.",
    },
  },
  "@tauri-apps/api/image": {
    Image: {
      wave: "G5",
      action: "platform",
      adapter: "clipboard",
      replacement: "bytes via platform.clipboard",
      manualReview: "Copy flow: TauriImage.fromBytes is only an intermediate to writeImage; the worker drops fromBytes/close and passes bytes to platform.clipboard.writeImage. Route behavior on web is owned by V3-21.",
      note: "No adapter of its own: ClipboardAdapter builds the image internally from bytes (copy flow of the screenshot routes).",
    },
  },
};

/** Look up the mapping for one imported name, or null when unknown. */
export function lookupMapping(specifier, importedName) {
  const table = NAME_MAPPINGS[specifier];
  if (!table) return null;
  return table[importedName] ?? null;
}
