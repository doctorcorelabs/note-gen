// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { platform } from '@/lib/platform'
import type { Event, EventCallback, EventName, EventTarget, UnlistenFn } from '@tauri-apps/api/event'

interface CallbackRegistry {
  unregisterCallback: (id: number) => void
}

// Tauri 2.11 can resolve listen() before its listener-table script executes.
// Keep the callback ID so disposal does not read that still-missing table entry.
export async function listenTauriEvent<T>(event: EventName, handler: EventCallback<T>, target: EventTarget = { kind: 'Any' }): Promise<UnlistenFn> {
  // AD-89 registered remainder: functional use of the Tauri internals
  // registry (unregisterCallback has no public @tauri-apps/api export),
  // not a detection check. It closes only when a detect.ts seam or a
  // registry surface for listenTauriEvent lands (3D/manual, AD-91).
  const registry = (window as unknown as { __TAURI_INTERNALS__: CallbackRegistry }).__TAURI_INTERNALS__
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
    registry.unregisterCallback(callbackId)
    throw error
  }

  return () => {
    if (disposed) return
    disposed = true
    registry.unregisterCallback(callbackId)
    void platform.invoke.invoke('plugin:event|unlisten', { event, eventId }).catch(error => {
      console.error('Failed to unregister native event listener:', event, error)
    })
  }
}
