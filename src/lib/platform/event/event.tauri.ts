// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Tauri EventAdapter (V2-13): thin wrapper, no new logic.
 *
 * Desktop behavior must not change: every method delegates to
 * `@tauri-apps/api/event` exactly as the upstream code used it. Listener
 * counts are tracked locally because the Tauri API exposes no count. This
 * file is the only file in this adapter family allowed to import
 * `@tauri-apps/*`, and only the event specifier.
 */

import {
  emit as tauriEmit,
  emitTo as tauriEmitTo,
  listen as tauriListen,
  once as tauriOnce,
  type EventTarget as TauriEventTarget,
} from "@tauri-apps/api/event";
import type {
  EventAdapter,
  EventCallback,
  EventTarget,
  PlatformEvent,
  UnlistenFn,
} from "./interface";

function toTauriTarget(target: EventTarget | string): TauriEventTarget | string {
  if (typeof target === "string") return target;
  switch (target.kind) {
    case "any":
      return { kind: "Any" };
    case "anyLabel":
      return { kind: "AnyLabel", label: target.label };
    case "app":
      return { kind: "App" };
    case "window":
      return { kind: "Window", label: target.label };
    case "webview":
      return { kind: "Webview", label: target.label };
    case "webviewWindow":
      return { kind: "WebviewWindow", label: target.label };
  }
}

export function createTauriEventAdapter(): EventAdapter {
  const counts = new Map<string, number>();
  const unlisteners = new Set<UnlistenFn>();

  function track(event: string, unlisten: UnlistenFn): UnlistenFn {
    counts.set(event, (counts.get(event) ?? 0) + 1);
    let removed = false;
    const wrapped: UnlistenFn = () => {
      if (removed) return;
      removed = true;
      unlisteners.delete(wrapped);
      const next = (counts.get(event) ?? 1) - 1;
      if (next <= 0) counts.delete(event);
      else counts.set(event, next);
      unlisten();
    };
    unlisteners.add(wrapped);
    return wrapped;
  }

  function adapt<T>(handler: EventCallback<T>): (event: PlatformEvent<T>) => void {
    return (event) => {
      const result = handler(event);
      if (result !== undefined && typeof (result as PromiseLike<void>).then === "function") {
        (result as Promise<void>).catch((error: unknown) => {
          queueMicrotask(() => {
            throw error;
          });
        });
      }
    };
  }

  return {
    async listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
      const unlisten = await tauriListen<T>(event, adapt(handler));
      return track(event, unlisten);
    },

    async once<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
      // Tauri removes a once listener automatically after it fires, so the
      // local count must drop on fire too; otherwise listenerCount keeps
      // counting a listener that no longer exists. The wrapped unlisten is
      // assigned synchronously after registration, before any event callback
      // can run, and its removed guard makes a later manual unlisten safe.
      let wrapped: UnlistenFn = () => undefined;
      const firing: EventCallback<T> = (platformEvent) => {
        wrapped();
        return handler(platformEvent);
      };
      const unlisten = await tauriOnce<T>(event, adapt(firing));
      wrapped = track(event, unlisten);
      return wrapped;
    },

    async emit<T>(event: string, payload?: T): Promise<void> {
      await tauriEmit(event, payload);
    },

    async emitTo<T>(target: EventTarget | string, event: string, payload?: T): Promise<void> {
      await tauriEmitTo(toTauriTarget(target), event, payload);
    },

    listenerCount(event?: string): number {
      if (event !== undefined) return counts.get(event) ?? 0;
      let total = 0;
      for (const count of counts.values()) total += count;
      return total;
    },

    dispose(): void {
      for (const unlisten of [...unlisteners]) unlisten();
      counts.clear();
    },
  };
}
