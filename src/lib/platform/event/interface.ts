// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * EventAdapter interface (migration wave G4).
 *
 * Replaces the upstream api/event surface: listen, emit, emitTo, once, and
 * the event types. Signatures mirror the installed upstream declarations
 * (api 2.11.1) and were checked against every import site in the reference
 * tree at 4dcaa3f. The listen options bag is named EventListenOptions here
 * (upstream name: Options) so the platform barrel stays unambiguous.
 *
 * The internal emitter in src/lib/emitter.ts is not a Tauri event and is
 * not part of this adapter.
 */
export type EventTarget =
  | { kind: "Any" }
  | { kind: "AnyLabel"; label: string }
  | { kind: "App" }
  | { kind: "Window"; label: string }
  | { kind: "Webview"; label: string }
  | { kind: "WebviewWindow"; label: string };

export interface Event<T> {
  event: EventName;
  id: number;
  payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;

export type UnlistenFn = () => void;

export type TauriEvent =
  | "tauri://resize"
  | "tauri://move"
  | "tauri://close-requested"
  | "tauri://destroyed"
  | "tauri://focus"
  | "tauri://blur"
  | "tauri://scale-change"
  | "tauri://theme-changed"
  | "tauri://window-created"
  | "tauri://suspended"
  | "tauri://resumed"
  | "tauri://webview-created"
  | "tauri://drag-enter"
  | "tauri://drag-over"
  | "tauri://drag-drop"
  | "tauri://drag-leave";

export type EventName = `${TauriEvent}` | (string & Record<never, never>);

export interface EventListenOptions {
  target?: string | EventTarget;
}

export interface EventAdapter {
  listen<T>(
    event: EventName,
    handler: EventCallback<T>,
    options?: EventListenOptions,
  ): Promise<UnlistenFn>;
  once<T>(
    event: EventName,
    handler: EventCallback<T>,
    options?: EventListenOptions,
  ): Promise<UnlistenFn>;
  emit<T>(event: string, payload?: T): Promise<void>;
  emitTo<T>(
    target: EventTarget | string,
    event: string,
    payload?: T,
  ): Promise<void>;
}
