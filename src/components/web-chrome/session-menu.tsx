// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut, RefreshCw, User } from 'lucide-react'
import { isTauri } from '@/lib/platform/detect'
import {
  SESSION_LOGIN_PATH,
  getSharedAuthSessionClient,
  type AuthMeData,
  type AuthSessionEntry,
} from '@/lib/web/auth-client'
import { ApiError } from '@/lib/web/errors'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type PanelState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; me: AuthMeData; sessions: AuthSessionEntry[] }
  | { kind: 'expired' }
  | { kind: 'error'; message: string }

/**
 * Session menu in the web top app bar (Fase 1, V3-03 slot 03b).
 * Minimal chrome surface for the session: who is signed in, the
 * list of signed-in devices with per-device revoke, sign out of
 * this device, and sign out of all devices. The settings page
 * (V3-29) may offer the same list through the same auth-client
 * functions; this menu does not own settings.
 *
 * Strings are hardcoded in English, following the boot guard
 * precedent (src/lib/web/boot-guard.ts): the message catalog
 * namespace for new UI is undecided (Q8), and the guard must
 * render even when catalog keys do not exist. Moving these
 * strings to the catalog is a follow-up for the i18n owner.
 *
 * In the desktop (Tauri) shell this renders nothing: there is no
 * web session to manage there, and desktop behavior must not
 * change. Nothing here reads or writes any storage: the session
 * lives in the HttpOnly cookie and the CSRF token in module
 * memory, both owned by src/lib/web/auth-client.ts.
 */
export function SessionMenu() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [panel, setPanel] = useState<PanelState>({ kind: 'idle' })
  const [busyId, setBusyId] = useState<string | null>(null)
  const [logoutAllArmed, setLogoutAllArmed] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    setPanel({ kind: 'loading' })
    setActionError(null)
    try {
      const client = getSharedAuthSessionClient()
      const [me, sessions] = await Promise.all([client.getMe(), client.listSessions()])
      if (mountedRef.current) {
        setPanel({ kind: 'loaded', me, sessions })
      }
    } catch (error) {
      if (!mountedRef.current) {
        return
      }
      if (error instanceof ApiError && error.status === 401) {
        setPanel({ kind: 'expired' })
      } else {
        setPanel({ kind: 'error', message: 'Could not load your sessions. Try again.' })
      }
    }
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      setLogoutAllArmed(false)
      setActionError(null)
      if (next) {
        void load()
      }
    },
    [load],
  )

  const handleLogout = useCallback(async () => {
    setBusyId('logout')
    setActionError(null)
    try {
      await getSharedAuthSessionClient().logout()
      setOpen(false)
      router.push(SESSION_LOGIN_PATH)
    } catch {
      if (mountedRef.current) {
        setActionError('Could not sign out. Try again.')
      }
    } finally {
      if (mountedRef.current) {
        setBusyId(null)
      }
    }
  }, [router])

  const handleLogoutAll = useCallback(async () => {
    if (!logoutAllArmed) {
      setLogoutAllArmed(true)
      return
    }
    setBusyId('logout-all')
    setActionError(null)
    try {
      await getSharedAuthSessionClient().logoutAll()
      setOpen(false)
      router.push(SESSION_LOGIN_PATH)
    } catch (error) {
      if (!mountedRef.current) {
        return
      }
      if (error instanceof ApiError && error.code === 'step_up_required') {
        setActionError('Signing out everywhere needs a fresh password confirmation first.')
      } else {
        setActionError('Could not sign out everywhere. Try again.')
      }
    } finally {
      if (mountedRef.current) {
        setBusyId(null)
      }
    }
  }, [logoutAllArmed, router])

  const handleRevoke = useCallback(
    async (entry: AuthSessionEntry) => {
      setBusyId(entry.id)
      setActionError(null)
      try {
        await getSharedAuthSessionClient().revokeSession(entry.id, {
          isCurrent: entry.isCurrent,
        })
        if (entry.isCurrent) {
          setOpen(false)
          router.push(SESSION_LOGIN_PATH)
          return
        }
        await load()
      } catch (error) {
        if (!mountedRef.current) {
          return
        }
        if (error instanceof ApiError && error.status === 401) {
          setPanel({ kind: 'expired' })
        } else if (error instanceof ApiError && error.status === 404) {
          // Already gone: refresh the list instead of alarming.
          await load()
        } else {
          setActionError('Could not revoke that session. Try again.')
        }
      } finally {
        if (mountedRef.current) {
          setBusyId(null)
        }
      }
    },
    [load, router],
  )

  if (isTauri()) {
    return null
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Account and sessions">
              <User className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>Account and sessions</p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">Sessions</p>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Reload sessions"
            disabled={panel.kind === 'loading'}
            onClick={() => void load()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>

        {panel.kind === 'loading' || panel.kind === 'idle' ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading...</p>
        ) : null}

        {panel.kind === 'expired' ? (
          <div className="mt-2">
            <p className="text-sm text-muted-foreground">
              Your session has expired. Sign in again to continue.
            </p>
            <Button
              className="mt-3 w-full"
              onClick={() => router.push(SESSION_LOGIN_PATH)}
            >
              Sign in
            </Button>
          </div>
        ) : null}

        {panel.kind === 'error' ? (
          <div className="mt-2">
            <p className="text-sm text-muted-foreground">{panel.message}</p>
            <Button className="mt-3 w-full" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : null}

        {panel.kind === 'loaded' ? (
          <div className="mt-2 flex flex-col gap-3">
            <p className="truncate text-sm text-muted-foreground" title={panel.me.email}>
              Signed in as {panel.me.email}
              {panel.me.role === 'admin' ? ' (admin)' : ''}
            </p>
            {panel.sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No other sessions.</p>
            ) : (
              <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                {panel.sessions.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-start justify-between gap-2 rounded-md border border-border px-2 py-1.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {entry.deviceLabel}
                        {entry.isCurrent ? ' (this device)' : ''}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        Last seen {formatSeenAt(entry.lastSeenAt)}
                        {entry.lastSeenIp ? ` from ${entry.lastSeenIp}` : ''}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-xs"
                      disabled={busyId !== null}
                      onClick={() => void handleRevoke(entry)}
                    >
                      {entry.isCurrent ? 'Sign out' : 'Revoke'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {actionError !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                className="w-full justify-start"
                disabled={busyId !== null}
                onClick={() => void handleLogout()}
              >
                <LogOut className="h-4 w-4" />
                Sign out of this device
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start"
                disabled={busyId !== null}
                onClick={() => void handleLogoutAll()}
              >
                <LogOut className="h-4 w-4" />
                {logoutAllArmed
                  ? 'Click again to sign out everywhere'
                  : 'Sign out of all devices'}
              </Button>
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function formatSeenAt(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleString()
}
