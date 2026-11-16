// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { platform } from '@/lib/platform'
import { getTauriCallbackRegistry } from '../detect'
import type { Event, EventCallback, EventName, EventTarget, UnlistenFn } from '@tauri-apps/api/event'

// Tauri 2.11 can resolve listen() before its listener-table script executes.
// Keep the callback ID so disposal does not read that still-missing table entry.
// The callback registry is read once, through the detect.ts seam (AD-89);
// this file never names the Tauri internals marker itself.
export async function listenTauriEvent<T>(event: EventName, handler: EventCallback<T>, target: EventTarget = { kind: 'Any' }): Promise<UnlistenFn> {
  const registry = getTauriCallbackRegistry()
  let disposed = false
  const callbackId = platform.invoke.transformCallback<Event<T>>(message => {
    if (!disposed) handler(message)
  })

  let eventId: number
  try {
    eventId = await platform.invoke.invoke<number>('plugin:event|listen', {
      event,
      target,
      handler: callbackId,
    })
  } catch (error) {
    registry?.unregisterCallback(callbackId)
    throw error
  }

  return () => {
    if (disposed) return
    disposed = true
    registry?.unregisterCallback(callbackId)
    void platform.invoke.invoke('plugin:event|unlisten', { event, eventId }).catch(error => {
      console.error('Failed to unregister native event listener:', event, error)
    })
  }
}
