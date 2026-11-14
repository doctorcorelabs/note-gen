// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * EventAdapter interface (V2-13).
 *
 * Local interface definition for this adapter family, following the V1-05
 * inventory (desain-registry-shim.md section 1.12). V2-04 owns the canonical
 * interfaces; the integrator reconciles this definition with the canonical
 * one. Callers must use the adapter through the platform registry, never by
 * importing an implementation file directly.
 *
 * Upstream surface replaced: `listen`, `emit`, `emitTo`, `once`, and the
 * types `UnlistenFn`, `Event`, `EventCallback`, `EventName`, `EventTarget`
 * from `@tauri-apps/api/event`.
 *
 * This adapter is only for Tauri events. The internal emitter in
 * `src/lib/emitter.ts` is a separate in-process emitter and is NOT part of
 * this adapter; migration audits must keep the two apart.
 *
 * Event name mapping on the web (see laporan-window-adapters.md for the
 * full table):
 * - Plain app event names pass through the in-app bus unchanged, and cross
 *   tabs through BroadcastChannel.
 * - `tauri://focus` and `tauri://blur` map to DOM focus/blur and
 *   `visibilitychange` in the current tab only.
 * - `tauri://created` and `tauri://window-created` are delivered once, right
 *   after registration, because the web tab already exists.
 * - `tauri://error` and other `tauri://*` names have no web equivalent;
 *   listeners never fire.
 * - Bridge events (`web-clipper://request`, `web-clipper://pairing-request`,
 *   `local-mcp://request`) have no web equivalent; emitting one throws
 *   `PlatformCapabilityError` and listeners never fire. The bridge
 *   components are disabled in web mode and replaced by backend endpoints.
 */

export type UnlistenFn = () => void;

export interface PlatformEvent<T = unknown> {
  /** Event name, exactly as emitted. */
  event: string;
  /** Per-adapter incrementing identifier for the delivered event. */
  id: number;
  /** Event payload. Payloads that cross tabs must be structured-cloneable. */
  payload: T;
  /** Label of the window or tab the event was emitted from, when known. */
  windowLabel?: string;
}

export type EventCallback<T = unknown> = (event: PlatformEvent<T>) => void | Promise<void>;

export type EventTarget =
  | { kind: "any" }
  | { kind: "anyLabel"; label: string }
  | { kind: "app" }
  | { kind: "window"; label: string }
  | { kind: "webview"; label: string }
  | { kind: "webviewWindow"; label: string };

/** Tauri bridge event names with no web equivalent. Emitting one is an error on the web. */
export const BRIDGE_EVENT_NAMES: readonly string[] = [
  "web-clipper://request",
  "web-clipper://pairing-request",
  "local-mcp://request",
];

export function isBridgeEventName(event: string): boolean {
  return (BRIDGE_EVENT_NAMES as readonly string[]).includes(event);
}

export interface EventAdapter {
  /** Subscribe to an event. The returned function removes the listener. */
  listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn>;

  /** Subscribe to the next occurrence of an event, then unsubscribe automatically. */
  once<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn>;

  /** Emit an event to listeners in this tab and, on the web, in other tabs. */
  emit<T>(event: string, payload?: T): Promise<void>;

  /**
   * Emit an event to a target. `target` may be a window label string or a
   * structured target. `{ kind: "any" }` and `{ kind: "app" }` deliver to
   * all windows or tabs; a labeled target delivers only to that window.
   */
  emitTo<T>(target: EventTarget | string, event: string, payload?: T): Promise<void>;

  /** Number of active listeners, for one event or for all events. */
  listenerCount(event?: string): number;

  /** Remove all listeners and release cross-tab and DOM resources. */
  dispose(): void;
}
