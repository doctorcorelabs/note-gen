// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Minimal watcher status banner (V3-09). It reads the shared status
// published by the watcher client layer (src/lib/web/watcher-client.ts)
// and shows an honest message only while watching is degraded:
// polling fallback, offline, or unavailable. Healthy states render
// nothing, so the file tree layout is unchanged while watching works.
// The message text is English (AD-21) and lives in the watcher client
// module; no message catalog key is claimed here (Q8 undecided).
// The snapshot is the message string itself, a primitive, so the
// server snapshot (null) and the initial client snapshot (null for
// the starting state) agree by value during hydration.

'use client'

import { useSyncExternalStore } from 'react'

import {
  getWatcherStatus,
  subscribeWatcherStatus,
  watcherStatusMessage,
} from '@/lib/web/watcher-client'

function getWatcherMessageSnapshot(): string | null {
  return watcherStatusMessage(getWatcherStatus())
}

function getServerWatcherMessageSnapshot(): string | null {
  return null
}

export function WatcherStatus() {
  const message = useSyncExternalStore(
    subscribeWatcherStatus,
    getWatcherMessageSnapshot,
    getServerWatcherMessageSnapshot,
  )
  if (message === null) return null
  return (
    <div role="status" className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
      {message}
    </div>
  )
}
