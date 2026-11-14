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
} from "@tauri-apps/api/event";
import type {
  Event,
  EventAdapter,
  EventAdapterExtensions,
  EventCallback,
  EventListenOptions,
  EventName,
  EventTarget,
  UnlistenFn,
} from "./interface";

export function createTauriEventAdapter(): EventAdapter & EventAdapterExtensions {
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

  function adapt<T>(handler: EventCallback<T>): (event: Event<T>) => void {
    return (event) => {
      const result = handler(event) as unknown;
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
    async listen<T>(
      event: EventName,
      handler: EventCallback<T>,
      options?: EventListenOptions,
    ): Promise<UnlistenFn> {
      const unlisten = await tauriListen<T>(event, adapt(handler), options);
      return track(event, unlisten);
    },

    async once<T>(
      event: EventName,
      handler: EventCallback<T>,
      options?: EventListenOptions,
    ): Promise<UnlistenFn> {
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
      const unlisten = await tauriOnce<T>(event, adapt(firing), options);
      wrapped = track(event, unlisten);
      return wrapped;
    },

    async emit<T>(event: string, payload?: T): Promise<void> {
      await tauriEmit(event, payload);
    },

    async emitTo<T>(target: EventTarget | string, event: string, payload?: T): Promise<void> {
      await tauriEmitTo(target, event, payload);
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
