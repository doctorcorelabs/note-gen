// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-event-type-only. Synthetic example.

import type { Event, EventCallback, EventName, EventTarget, UnlistenFn } from '@tauri-apps/api/event';

export function describeEvent(event: Event<string>): EventName {
  return event.event;
}

export function makeHandler(cb: EventCallback<string>): EventCallback<string> {
  return cb;
}

export function targetLabel(target: EventTarget): string {
  return String(target);
}

export function noopUnlisten(unlisten: UnlistenFn): void {
  unlisten();
}
