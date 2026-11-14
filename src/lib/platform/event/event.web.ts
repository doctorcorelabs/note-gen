// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web EventAdapter (V2-13): in-app event bus replacing Tauri events.
 *
 * Delivery has two layers:
 * 1. Local: listeners in this tab, stored in a Map. Synchronous handler
 *    errors are isolated per listener so one failing listener cannot break
 *    the others or the emitter.
 * 2. Cross-tab: one BroadcastChannel (`notegen-platform-events-v1`) carries
 *    emitted events to other tabs. Messages carry a per-instance source id
 *    so the emitting tab never delivers its own broadcast twice, and an
 *    optional target label for `emitTo`. Payloads must be
 *    structured-cloneable; a payload that cannot cross tabs is still
 *    delivered locally.
 *
 * Special Tauri names (see `interface.ts` for the full mapping):
 * - `tauri://focus` / `tauri://blur` come from DOM focus/blur and
 *   `visibilitychange`, current tab only, attached lazily while listeners
 *   exist.
 * - `tauri://created` / `tauri://window-created` fire once right after
 *   registration, because the tab already exists.
 * - Bridge events (`web-clipper://*`, `local-mcp://request`) cannot be
 *   emitted on the web and throw `PlatformCapabilityError`.
 *
 * This file must never import `@tauri-apps/*`.
 */

import { capabilityError } from "../errors";
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

/** Tauri bridge event names with no web equivalent. Emitting one is an error on the web. */
export const BRIDGE_EVENT_NAMES: readonly string[] = [
  "web-clipper://request",
  "web-clipper://pairing-request",
  "local-mcp://request",
];

export function isBridgeEventName(event: string): boolean {
  return (BRIDGE_EVENT_NAMES as readonly string[]).includes(event);
}

const CHANNEL_NAME = "notegen-platform-events-v1";
const FOCUS_EVENT = "tauri://focus";
const BLUR_EVENT = "tauri://blur";
const CREATED_EVENTS: readonly string[] = ["tauri://created", "tauri://window-created"];

interface BroadcastChannelLike {
  postMessage(data: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

interface FocusSourceLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface DocumentLike extends FocusSourceLike {
  readonly visibilityState: string;
}

interface ChannelMessage {
  marker: "notegen-platform-event";
  sourceId: string;
  event: string;
  payload: unknown;
  targetLabel?: string;
  windowLabel: string;
}

function isChannelMessage(value: unknown): value is ChannelMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<ChannelMessage>;
  return (
    message.marker === "notegen-platform-event" &&
    typeof message.sourceId === "string" &&
    typeof message.event === "string" &&
    typeof message.windowLabel === "string"
  );
}

let instanceCounter = 0;

export interface WebEventAdapterOptions {
  /** Label of this window or tab for `emitTo` targeting. Defaults to `main`. */
  windowLabel?: string;
  /** Factory for the cross-tab channel. Defaults to the browser BroadcastChannel when available. */
  createBroadcastChannel?: (name: string) => BroadcastChannelLike | null;
  /** Focus event source. Defaults to the browser window when available. */
  windowLike?: FocusSourceLike | null;
  /** Visibility event source. Defaults to the browser document when available. */
  documentLike?: DocumentLike | null;
  /** Called when a listener throws or rejects. Defaults to rethrowing asynchronously. */
  onHandlerError?: (error: unknown, event: string) => void;
}

export function createWebEventAdapter(
  options: WebEventAdapterOptions = {},
): EventAdapter & EventAdapterExtensions {
  const windowLabel = options.windowLabel ?? "main";
  const sourceId = `event-${Date.now().toString(36)}-${(instanceCounter += 1)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const listeners = new Map<string, Set<EventCallback<unknown>>>();
  const channel =
    options.createBroadcastChannel !== undefined
      ? options.createBroadcastChannel(CHANNEL_NAME)
      : typeof BroadcastChannel !== "undefined"
        ? (new BroadcastChannel(CHANNEL_NAME) as unknown as BroadcastChannelLike)
        : null;
  let nextId = 1;
  let disposed = false;
  let domHooksAttached = false;

  const windowLike =
    options.windowLike !== undefined
      ? options.windowLike
      : typeof window !== "undefined"
        ? (window as unknown as FocusSourceLike)
        : null;
  const documentLike =
    options.documentLike !== undefined
      ? options.documentLike
      : typeof document !== "undefined"
        ? (document as unknown as DocumentLike)
        : null;

  function reportHandlerError(error: unknown, event: string): void {
    if (options.onHandlerError !== undefined) {
      options.onHandlerError(error, event);
      return;
    }
    queueMicrotask(() => {
      throw error;
    });
  }

  function deliverToOne<T>(handler: EventCallback<T>, event: string, payload: T): void {
    const delivered: Event<T> = { event: event as EventName, id: nextId, payload };
    nextId += 1;
    try {
      const result = handler(delivered) as unknown;
      if (result !== undefined && typeof (result as PromiseLike<void>).then === "function") {
        (result as Promise<void>).catch((error: unknown) => reportHandlerError(error, event));
      }
    } catch (error) {
      reportHandlerError(error, event);
    }
  }

  function deliverLocally<T>(event: string, payload: T): void {
    const handlers = listeners.get(event);
    if (handlers === undefined || handlers.size === 0) return;
    const delivered: Event<T> = { event: event as EventName, id: nextId, payload };
    nextId += 1;
    for (const handler of [...handlers]) {
      try {
        const result = handler(delivered) as unknown;
        if (result !== undefined && typeof (result as PromiseLike<void>).then === "function") {
          (result as Promise<void>).catch((error: unknown) => reportHandlerError(error, event));
        }
      } catch (error) {
        reportHandlerError(error, event);
      }
    }
  }

  function broadcast<T>(event: string, payload: T, targetLabel?: string): void {
    if (channel === null) return;
    const message: ChannelMessage = {
      marker: "notegen-platform-event",
      sourceId,
      event,
      payload,
      targetLabel,
      windowLabel,
    };
    try {
      channel.postMessage(message);
    } catch {
      // Payload is not structured-cloneable. Local delivery already
      // happened; cross-tab delivery is skipped for this event.
    }
  }

  if (channel !== null) {
    channel.onmessage = (messageEvent: { data: unknown }) => {
      if (disposed) return;
      const message = messageEvent.data;
      if (!isChannelMessage(message)) return;
      if (message.sourceId === sourceId) return;
      if (message.targetLabel !== undefined && message.targetLabel !== windowLabel) return;
      deliverLocally(message.event, message.payload);
    };
  }

  function onDomFocus(): void {
    deliverLocally(FOCUS_EVENT, undefined);
  }

  function onDomBlur(): void {
    deliverLocally(BLUR_EVENT, undefined);
  }

  function onVisibilityChange(): void {
    if (documentLike === null) return;
    if (documentLike.visibilityState === "visible") {
      deliverLocally(FOCUS_EVENT, undefined);
    } else {
      deliverLocally(BLUR_EVENT, undefined);
    }
  }

  function syncDomHooks(): void {
    const wantsHooks =
      (listeners.get(FOCUS_EVENT)?.size ?? 0) > 0 || (listeners.get(BLUR_EVENT)?.size ?? 0) > 0;
    if (wantsHooks && !domHooksAttached) {
      windowLike?.addEventListener("focus", onDomFocus);
      windowLike?.addEventListener("blur", onDomBlur);
      documentLike?.addEventListener("visibilitychange", onVisibilityChange);
      domHooksAttached = true;
    } else if (!wantsHooks && domHooksAttached) {
      windowLike?.removeEventListener("focus", onDomFocus);
      windowLike?.removeEventListener("blur", onDomBlur);
      documentLike?.removeEventListener("visibilitychange", onVisibilityChange);
      domHooksAttached = false;
    }
  }

  function addListener<T>(event: string, handler: EventCallback<T>): UnlistenFn {
    let handlers = listeners.get(event);
    if (handlers === undefined) {
      handlers = new Set();
      listeners.set(event, handlers);
    }
    handlers.add(handler as EventCallback<unknown>);
    syncDomHooks();
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      handlers.delete(handler as EventCallback<unknown>);
      if (handlers.size === 0) listeners.delete(event);
      syncDomHooks();
    };
  }

  function assertNotBridge(event: string): void {
    if (isBridgeEventName(event)) {
      throw capabilityError(
        "unsupported",
        "event",
        "event.bridge",
        "web",
        `event "${event}" is a Tauri bridge event with no web equivalent; the bridge component is disabled in web mode and replaced by a backend endpoint`,
      );
    }
  }

  function targetLabelOf(target: EventTarget | string): string | undefined {
    if (typeof target === "string") return target;
    switch (target.kind) {
      case "Any":
      case "App":
        return undefined;
      default:
        return target.label;
    }
  }

  /**
   * Whether a listen target selects this tab. Untargeted listeners and
   * the broadcast kinds (Any, App) always match; a labeled target matches
   * only when its label is this tab's label.
   */
  function targetMatchesThisTab(target: string | EventTarget | undefined): boolean {
    if (target === undefined) return true;
    if (typeof target === "string") return target === windowLabel;
    switch (target.kind) {
      case "Any":
      case "App":
        return true;
      default:
        return target.label === windowLabel;
    }
  }

  return {
    async listen<T>(
      event: EventName,
      handler: EventCallback<T>,
      options?: EventListenOptions,
    ): Promise<UnlistenFn> {
      if (disposed) return () => undefined;
      if (!targetMatchesThisTab(options?.target)) return () => undefined;
      let active = true;
      const inner = addListener(event, handler);
      const unlisten: UnlistenFn = () => {
        active = false;
        inner();
      };
      if ((CREATED_EVENTS as readonly string[]).includes(event)) {
        // The web tab already exists, so creation already happened. Deliver
        // to this listener only, not to every listener of the event.
        queueMicrotask(() => {
          if (active && !disposed) deliverToOne(handler, event, undefined as T);
        });
      }
      return unlisten;
    },

    async once<T>(
      event: EventName,
      handler: EventCallback<T>,
      options?: EventListenOptions,
    ): Promise<UnlistenFn> {
      if (disposed) return () => undefined;
      if (!targetMatchesThisTab(options?.target)) return () => undefined;
      let active = true;
      let inner: UnlistenFn = () => undefined;
      const wrapper: EventCallback<T> = (platformEvent) => {
        active = false;
        inner();
        return handler(platformEvent);
      };
      inner = addListener(event, wrapper);
      const unlisten: UnlistenFn = () => {
        active = false;
        inner();
      };
      if ((CREATED_EVENTS as readonly string[]).includes(event)) {
        queueMicrotask(() => {
          if (active && !disposed) deliverToOne(wrapper, event, undefined as T);
        });
      }
      return unlisten;
    },

    async emit<T>(event: string, payload?: T): Promise<void> {
      assertNotBridge(event);
      if (disposed) return;
      deliverLocally(event, payload);
      broadcast(event, payload);
    },

    async emitTo<T>(target: EventTarget | string, event: string, payload?: T): Promise<void> {
      assertNotBridge(event);
      if (disposed) return;
      const label = targetLabelOf(target);
      const deliverHere = label === undefined || label === windowLabel;
      if (deliverHere) deliverLocally(event, payload);
      broadcast(event, payload, label);
    },

    listenerCount(event?: string): number {
      if (event !== undefined) return listeners.get(event)?.size ?? 0;
      let total = 0;
      for (const handlers of listeners.values()) total += handlers.size;
      return total;
    },

    dispose(): void {
      disposed = true;
      listeners.clear();
      syncDomHooks();
      if (channel !== null) {
        channel.onmessage = null;
        channel.close();
      }
    },
  };
}
