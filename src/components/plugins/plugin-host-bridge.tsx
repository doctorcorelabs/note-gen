'use client'

import { useEffect, useRef } from 'react'
import { pluginHost } from '@/lib/plugins/host'
import type { PluginHostSurface } from '@/lib/plugins/host'
import { isPluginKillSwitchActive } from '@/lib/plugins/plugin-kill-switch'
import { usePluginStore } from '@/stores/plugins'

export function PluginHostBridge({
  ready,
  locale,
  surface = 'main',
}: {
  ready: boolean
  locale: string
  surface?: PluginHostSurface
}) {
  const localeRef = useRef(locale)
  localeRef.current = locale
  useEffect(() => { if (ready) pluginHost.setLocale(locale) }, [locale, ready])
  useEffect(() => {
    // G0 (W4-SEC): the kill switch gates the host start itself. While it
    // is active the host is never initialized at any mount site, so no
    // market refresh, no development auto-reload, and no plugin runtime
    // can start. The mount lines stay untouched (R7-5); the gate lives
    // here, inside the single shared bridge.
    if (isPluginKillSwitchActive()) return
    if (!ready) return
    let disposed = false
    let failed = false
    const start = () => {
      failed = false
      void pluginHost.initialize(localeRef.current, surface).catch((error) => {
        if (disposed) return
        failed = true
        usePluginStore.getState().addLog({
          pluginId: 'app.notegen.plugin-host',
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
    }
    const unsubscribe = usePluginStore.subscribe((state, previous) => {
      if (!disposed && failed && state.initialized && !previous.initialized) start()
    })
    start()
    return () => {
      disposed = true
      unsubscribe()
      pluginHost.stop()
    }
  }, [ready, surface])

  return null
}
