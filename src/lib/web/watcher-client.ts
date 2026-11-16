// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Watcher client (V3-09): a thin layer over FsAdapter.watch().
 *
 * Ownership boundary (binding, from the 3D preparation findings):
 * FsAdapter.watch() in src/lib/platform/fs/fs.web.ts already owns the
 * single WebSocket connection per tab, seq tracking, resync requests,
 * and the polling snapshot fallback (desain-workspace-api.md section 9
 * and AD-09). This module must never open a second WebSocket, track
 * seq a second time, run a second polling loop, or translate wire
 * events again. Two connections per tab would mean two seq trackers
 * that can diverge, and the design allows exactly one connection.
 *
 * What this layer owns, and only this:
 * 1. An honest connection-status surface for the UI, derived only
 *    from signals this layer can actually observe. The adapter does
 *    not report whether it is currently on WebSocket or on polling,
 *    so this layer never claims "live". In web mode it reports
 *    "polling" only when WebSocket is unavailable at start (the
 *    adapter then deterministically polls), "offline" only when the
 *    browser reports offline, and "unavailable" only when the watch
 *    subscription itself is rejected. Otherwise it reports "active"
 *    without claiming a transport. The adapter-internal switch from
 *    WebSocket to polling after repeated failures is invisible here;
 *    surfacing it needs an adapter hook (recorded Q6 follow-up) and
 *    is not faked.
 * 2. Resync triggers for the file tree (desain 9.7): when the tab
 *    becomes visible, gains focus, or comes back online, the layer
 *    asks the tree to reload (loadFileTree) without a full page
 *    reload. Triggers are coalesced inside one debounce window so a
 *    focus-plus-visibility burst causes one reload request, not two.
 *    This is tree-level resync. Sequence-level resync (resync after
 *    hello, replay after a seq gap) stays in the adapter.
 * 3. Ordered, isolated event forwarding: WatchEvents reach the
 *    existing hook handler in arrival order, and a throwing handler
 *    cannot break the watcher. No second debounce is added here: the
 *    delay is forwarded to FsAdapter.watch(), which already
 *    debounces per path.
 *
 * The watcher path flows through the internal emitter
 * (src/lib/emitter.ts, event "workspace-file-changed"), not through
 * EventAdapter. EventAdapter (V2-13) has no gap for this path and is
 * not touched by V3-09. Cache invalidation for the tree is the
 * article store reload itself (loadFileTree / loadCollapsibleFiles /
 * reconcileLocalFile / markFileDirty); the file tree model holds no
 * separate cache, and the workspace image URL cache in
 * src/lib/utils.ts stores version-less URLs, so clearing it would
 * not change any rendered URL and is deliberately not done.
 *
 * Constants below cite their protocol source. The canonical values
 * live in server/src/services/workspace/watcher-protocol.ts
 * (WATCHER_DEBOUNCE_MS) and desain-workspace-api.md section 9.6.
 * This module duplicates no other protocol constant.
 */

import {
  getPlatformMode,
  type DebouncedWatchOptions,
  type PlatformMode,
  type UnwatchFn,
  type WatchEvent,
} from "../platform";

/**
 * Debounce delay forwarded to FsAdapter.watch(), in milliseconds.
 * Source: desain-workspace-api.md section 9.6 (300 ms per path) and
 * WATCHER_DEBOUNCE_MS in watcher-protocol.ts. The existing watcher
 * hook already passed 300; this constant keeps the value in one
 * named place for the V3-09 layer.
 */
export const WATCHER_CLIENT_DELAY_MS = 300;

/**
 * Coalescing window for tree resync triggers, in milliseconds. Uses
 * the same 300 ms window as the watcher debounce above so that a
 * visibility-plus-focus burst collapses into one reload request.
 * This is a client-side coalescing choice, not a wire value.
 */
export const WATCHER_RESYNC_COALESCE_MS = 300;

/** Observable watcher states. See the module header for honesty rules. */
export type WatcherClientState =
  | "starting"
  | "active"
  | "polling"
  | "offline"
  | "unavailable"
  | "stopped";

/**
 * Transport detail. "unknown" is the honest default in web mode when
 * WebSocket is available: the adapter owns the transport and does
 * not report switches. "polling" is reported only when polling is
 * certain (no WebSocket constructor). "native" is the desktop OS
 * watcher in Tauri mode.
 */
export type WatcherTransport = "unknown" | "polling" | "native";

export interface WatcherClientStatus {
  readonly state: WatcherClientState;
  readonly transport: WatcherTransport;
  readonly mode: PlatformMode;
  /** Epoch milliseconds of the last forwarded event, or null. */
  readonly lastEventAt: number | null;
  /** Diagnostic detail for the unavailable state, or null. Never a secret. */
  readonly detail: string | null;
}

export type WatcherResyncReason = "visibility" | "focus" | "online" | "manual";

/** Minimal watch signature, matching the FsAdapter.watch subset the hook uses. */
export type WatcherWatchFn = (
  paths: string,
  cb: (event: WatchEvent) => void,
  options?: DebouncedWatchOptions,
) => Promise<UnwatchFn>;

export interface WatcherEventSourceLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface WatcherDocumentLike extends WatcherEventSourceLike {
  readonly visibilityState: string;
}

export type WatcherErrorContext = "event" | "watch" | "status";

export interface WatcherClientOptions {
  /** Workspace root passed to FsAdapter.watch, unchanged from the hook. */
  root: string;
  /** Watch function, normally (root, cb, opts) => platform.fs.watch(...). */
  watch: WatcherWatchFn;
  /** Debounce delay forwarded to watch(). Defaults to WATCHER_CLIENT_DELAY_MS. */
  delayMs?: number;
  /** Existing hook handler. Called in arrival order for every WatchEvent. */
  onEvent: (event: WatchEvent) => void;
  /** Called when a tree resync is requested. The hook reloads the tree here. */
  onResyncRequested?: (reason: WatcherResyncReason) => void;
  /** Called on state, transport, or detail changes only, never per event. */
  onStatusChange?: (status: WatcherClientStatus) => void;
  /** Called when onEvent/onResyncRequested throws, watch() rejects, or a status listener throws. */
  onError?: (error: unknown, context: WatcherErrorContext) => void;
  /** Platform mode. Defaults to getPlatformMode(). */
  mode?: PlatformMode;
  /** Whether a WebSocket constructor is available. Defaults to a global check. */
  webSocketAvailable?: boolean;
  /** Window-like source for focus/online/offline. Defaults to global window. */
  windowLike?: WatcherEventSourceLike | null;
  /** Document-like source for visibilitychange. Defaults to global document. */
  documentLike?: WatcherDocumentLike | null;
  /** Online probe. Defaults to navigator.onLine when present, else true. */
  isOnline?: () => boolean;
  /** Clock, for tests. Defaults to Date.now. */
  now?: () => number;
  /** Resync coalescing window in ms. Defaults to WATCHER_RESYNC_COALESCE_MS. */
  resyncCoalesceMs?: number;
  /**
   * Publish status into the shared module store read by the UI.
   * Defaults to true. Tests that run several clients pass false to
   * keep the shared store out of their assertions.
   */
  shareStatus?: boolean;
}

export interface WatcherClient {
  readonly status: WatcherClientStatus;
  /** Start the single watch subscription. Idempotent; never rejects. */
  start(): Promise<void>;
  /** Request a tree resync. Subject to the same coalescing as triggers. */
  requestResync(reason: WatcherResyncReason): void;
  /** Subscribe to status transitions. Does not replay the current status. */
  subscribe(listener: (status: WatcherClientStatus) => void): () => void;
  /** Remove listeners and close the subscription. Idempotent. */
  dispose(): void;
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

function defaultWindowLike(): WatcherEventSourceLike | null {
  const candidate = (globalThis as { window?: unknown }).window;
  if (typeof candidate !== "object" || candidate === null) return null;
  const source = candidate as Partial<WatcherEventSourceLike>;
  return typeof source.addEventListener === "function" &&
    typeof source.removeEventListener === "function"
    ? (source as WatcherEventSourceLike)
    : null;
}

function defaultDocumentLike(): WatcherDocumentLike | null {
  const candidate = (globalThis as { document?: unknown }).document;
  if (typeof candidate !== "object" || candidate === null) return null;
  const source = candidate as Partial<WatcherDocumentLike>;
  return typeof source.addEventListener === "function" &&
    typeof source.removeEventListener === "function" &&
    typeof source.visibilityState === "string"
    ? (source as WatcherDocumentLike)
    : null;
}

function defaultWebSocketAvailable(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function";
}

function defaultIsOnline(): boolean {
  const candidate = (globalThis as { navigator?: unknown }).navigator;
  if (typeof candidate !== "object" || candidate === null) return true;
  const onLine = (candidate as { onLine?: unknown }).onLine;
  return typeof onLine === "boolean" ? onLine : true;
}

// ------------------------------------------------------------------
// Shared status store (single-owner: the one watcher hook instance)
// ------------------------------------------------------------------

function initialSharedStatus(): WatcherClientStatus {
  return {
    state: "starting",
    transport: "unknown",
    mode: getPlatformMode(),
    lastEventAt: null,
    detail: null,
  };
}

let sharedStatus: WatcherClientStatus = initialSharedStatus();
const sharedListeners = new Set<() => void>();

/** Current shared watcher status, for useSyncExternalStore getSnapshot. */
export function getWatcherStatus(): WatcherClientStatus {
  return sharedStatus;
}

/** Subscribe to shared status changes, for useSyncExternalStore. */
export function subscribeWatcherStatus(listener: () => void): () => void {
  sharedListeners.add(listener);
  return () => {
    sharedListeners.delete(listener);
  };
}

/**
 * Test support only: restore the shared store to its initial
 * snapshot. Production code must not call this.
 */
export function resetWatcherStatusStore(): void {
  sharedStatus = initialSharedStatus();
  for (const listener of [...sharedListeners]) {
    try {
      listener();
    } catch (error) {
      console.warn("[watcher-client] Shared status listener failed:", error);
    }
  }
}

function publishSharedStatus(status: WatcherClientStatus, notify: boolean): void {
  sharedStatus = status;
  if (!notify) return;
  for (const listener of [...sharedListeners]) {
    try {
      listener();
    } catch (error) {
      console.warn("[watcher-client] Shared status listener failed:", error);
    }
  }
}

/**
 * Honest user-facing message for a status, or null when nothing
 * needs to be shown. Active, starting, and stopped states stay
 * silent. English text (AD-21); moving these strings into the
 * message catalog is a sweep follow-up, not done here, so the
 * catalog hotspot stays untouched by V3-09.
 */
export function watcherStatusMessage(status: WatcherClientStatus): string | null {
  switch (status.state) {
    case "polling":
      return "Live updates are unavailable in this browser. The file tree checks for changes periodically.";
    case "offline":
      return "You are offline. The file tree will refresh when the connection returns.";
    case "unavailable":
      return "File watching is unavailable. New files from outside may not appear until you refresh the file tree.";
    default:
      return null;
  }
}

export function createWatcherClient(options: WatcherClientOptions): WatcherClient {
  const mode = options.mode ?? getPlatformMode();
  const webSocketAvailable = options.webSocketAvailable ?? defaultWebSocketAvailable();
  const windowLike =
    options.windowLike !== undefined ? options.windowLike : defaultWindowLike();
  const documentLike =
    options.documentLike !== undefined ? options.documentLike : defaultDocumentLike();
  const isOnline = options.isOnline ?? defaultIsOnline;
  const now = options.now ?? Date.now;
  const delayMs = options.delayMs ?? WATCHER_CLIENT_DELAY_MS;
  const resyncCoalesceMs = Math.max(
    0,
    options.resyncCoalesceMs ?? WATCHER_RESYNC_COALESCE_MS,
  );
  const shareStatus = options.shareStatus ?? true;

  const transport: WatcherTransport =
    mode === "tauri" ? "native" : webSocketAvailable ? "unknown" : "polling";

  let disposed = false;
  let subscribed = false;
  let watchFailed = false;
  let watchDetail: string | null = null;
  let browserOffline = false;
  let lastEventAt: number | null = null;
  let lastResyncRequestAt: number | null = null;
  let unwatch: UnwatchFn | null = null;
  let startPromise: Promise<void> | null = null;
  let listenersAttached = false;
  const listeners = new Set<(status: WatcherClientStatus) => void>();

  let currentStatus: WatcherClientStatus = {
    state: "starting",
    transport,
    mode,
    lastEventAt: null,
    detail: null,
  };

  function computeState(): WatcherClientState {
    if (disposed) return "stopped";
    if (watchFailed) return "unavailable";
    if (!subscribed) return "starting";
    if (mode === "web" && browserOffline) return "offline";
    if (mode === "web" && !webSocketAvailable) return "polling";
    return "active";
  }

  function refreshStatus(): void {
    const next: WatcherClientStatus = {
      state: computeState(),
      transport,
      mode,
      lastEventAt,
      detail: watchFailed ? watchDetail : null,
    };
    const changed =
      next.state !== currentStatus.state ||
      next.transport !== currentStatus.transport ||
      next.detail !== currentStatus.detail;
    currentStatus = next;
    if (shareStatus) publishSharedStatus(next, changed);
    if (!changed) return;
    if (options.onStatusChange !== undefined) {
      try {
        options.onStatusChange(next);
      } catch (error) {
        reportError(error, "status");
      }
    }
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        reportError(error, "status");
      }
    }
  }

  function reportError(error: unknown, context: WatcherErrorContext): void {
    if (options.onError !== undefined) {
      options.onError(error, context);
      return;
    }
    console.warn(`[watcher-client] Watcher ${context} failed:`, error);
  }

  function safeIsOnline(): boolean {
    try {
      return isOnline();
    } catch {
      return true;
    }
  }

  function requestResync(reason: WatcherResyncReason): void {
    if (disposed || !subscribed || watchFailed) return;
    if (options.onResyncRequested === undefined) return;
    const at = now();
    if (
      lastResyncRequestAt !== null &&
      at - lastResyncRequestAt < resyncCoalesceMs
    ) {
      return;
    }
    lastResyncRequestAt = at;
    try {
      options.onResyncRequested(reason);
    } catch (error) {
      reportError(error, "event");
    }
  }

  function handleEvent(event: WatchEvent): void {
    if (disposed) return;
    lastEventAt = now();
    refreshStatus();
    try {
      options.onEvent(event);
    } catch (error) {
      reportError(error, "event");
    }
  }

  function onVisibilityChange(): void {
    if (documentLike !== null && documentLike.visibilityState === "visible") {
      requestResync("visibility");
    }
  }

  function onFocus(): void {
    requestResync("focus");
  }

  function onOnline(): void {
    browserOffline = false;
    refreshStatus();
    requestResync("online");
  }

  function onOffline(): void {
    browserOffline = true;
    refreshStatus();
  }

  function attachListeners(): void {
    // Triggers are a web-mode polling-fallback concern (desain 9.7).
    // In Tauri mode the native watcher already covers local disk
    // changes, so no reload triggers are registered there.
    if (listenersAttached || mode !== "web") return;
    listenersAttached = true;
    documentLike?.addEventListener("visibilitychange", onVisibilityChange);
    windowLike?.addEventListener("focus", onFocus);
    windowLike?.addEventListener("online", onOnline);
    windowLike?.addEventListener("offline", onOffline);
  }

  function detachListeners(): void {
    if (!listenersAttached) return;
    listenersAttached = false;
    documentLike?.removeEventListener("visibilitychange", onVisibilityChange);
    windowLike?.removeEventListener("focus", onFocus);
    windowLike?.removeEventListener("online", onOnline);
    windowLike?.removeEventListener("offline", onOffline);
  }

  function start(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (startPromise !== null) return startPromise;
    startPromise = (async () => {
      browserOffline = mode === "web" ? !safeIsOnline() : false;
      attachListeners();
      refreshStatus();
      let nextUnwatch: UnwatchFn;
      try {
        nextUnwatch = await options.watch(options.root, handleEvent, {
          recursive: true,
          delayMs,
        });
      } catch (error) {
        watchFailed = true;
        watchDetail = messageOf(error);
        refreshStatus();
        reportError(error, "watch");
        return;
      }
      if (disposed) {
        try {
          nextUnwatch();
        } catch (error) {
          reportError(error, "watch");
        }
        return;
      }
      unwatch = nextUnwatch;
      subscribed = true;
      refreshStatus();
    })();
    return startPromise;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    detachListeners();
    if (unwatch !== null) {
      try {
        unwatch();
      } catch (error) {
        reportError(error, "watch");
      }
      unwatch = null;
    }
    refreshStatus();
  }

  return {
    get status(): WatcherClientStatus {
      return currentStatus;
    },
    start,
    requestResync,
    subscribe(listener: (status: WatcherClientStatus) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose,
  };
}
