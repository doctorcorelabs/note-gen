'use client'

// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-2 (ACT-02): renders web in-app fallback notifications as
// toasts. Mounted once in the root layout next to the Toaster.
// The subscription logic lives in
// lib/platform/notification/in-app-toasts.ts (unit tested); this
// component only binds it to the platform registry.

import { useEffect } from 'react'

import { toast } from '@/hooks/use-toast'
import { platform } from '@/lib/platform'
import { subscribeInAppNotificationToasts } from '@/lib/platform/notification/in-app-toasts'

export function InAppNotificationToasts() {
  useEffect(() => {
    let unsubscribe: (() => void) | null = null
    try {
      unsubscribe = subscribeInAppNotificationToasts(platform.notification, toast)
    } catch {
      // Platform not initialized yet (for example during SSR
      // prerender); the fallback simply stays unsubscribed.
      return
    }
    return () => {
      unsubscribe?.()
    }
  }, [])

  return null
}
