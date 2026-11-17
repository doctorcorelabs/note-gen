// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { isTauri } from '@/lib/platform/detect'
import { BOOT_FAILURE_MESSAGES } from '@/lib/web/boot-guard'
import {
  SESSION_CHECK_TIMEOUT_MS,
  SessionCheckCancelledError,
  checkSession,
  type SessionCheckCode,
} from '@/lib/web/session-check'
import {
  SESSION_EXPIRED_LOGIN_PATH,
  getSharedAuthSessionClient,
} from '@/lib/web/auth-client'

type GuardState =
  | { kind: 'checking' }
  | { kind: 'authenticated' }
  | { kind: 'unauthenticated'; code: SessionCheckCode }
  | { kind: 'unknown'; code: SessionCheckCode }

/**
 * Session guard for the /core shell (Fase 1, V3-03 slot 03b).
 *
 * The boot guard in src/app/page.tsx (V2-08) gates normal entry, but
 * a deep link straight to /core/* bypasses it. This guard is the
 * second seam: in web mode it probes GET /api/auth/me before the
 * shell renders, blocks entry while the session state is unknown
 * (fail closed, exactly like the boot guard), and redirects to the
 * login page when the server rejects the session. It also listens
 * for session expiry reported by the shared auth client, so a 401
 * from any API call during the session sends the user back to the
 * login page instead of leaving a dead shell on screen.
 *
 * In the desktop (Tauri) shell this guard renders children
 * immediately and never probes: desktop auth is out of scope for
 * the web fork, and desktop behavior must not change.
 *
 * The guard blocks rendering of the shell subtree, not the layout
 * effects of src/app/core/layout.tsx, which run regardless. That
 * matches the boot guard layering: the probe here is cheap and the
 * redirect is immediate, so no protected content is ever painted
 * without a proven session.
 */
export function SessionGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [state, setState] = useState<GuardState>({ kind: 'checking' })
  const [attempt, setAttempt] = useState(0)
  const webMode = !isTauri()
  const redirectSentRef = useRef(false)

  const goToLogin = useCallback(() => {
    if (redirectSentRef.current) {
      return
    }
    redirectSentRef.current = true
    // Expiry, not logout: the login page shows its expiry notice.
    router.replace(SESSION_EXPIRED_LOGIN_PATH)
  }, [router])

  useEffect(() => {
    if (!webMode) {
      return
    }
    const controller = new AbortController()
    let current = true
    void (async () => {
      try {
        const result = await checkSession({
          timeoutMs: SESSION_CHECK_TIMEOUT_MS,
          signal: controller.signal,
        })
        if (!current) {
          return
        }
        if (result.state === 'authenticated') {
          // Fresh proof the session is alive: a previous expiry
          // must not linger into this shell.
          getSharedAuthSessionClient().resetSessionStatus()
          redirectSentRef.current = false
          setState({ kind: 'authenticated' })
        } else if (result.state === 'unauthenticated') {
          // A rejected session must never keep a stale CSRF token.
          getSharedAuthSessionClient().clearCsrfToken()
          setState({ kind: 'unauthenticated', code: result.code })
          goToLogin()
        } else {
          setState({ kind: 'unknown', code: result.code })
        }
      } catch (error) {
        if (!current || error instanceof SessionCheckCancelledError) {
          return
        }
        setState({ kind: 'unknown', code: 'SESSION_UNKNOWN' })
      }
    })()
    return () => {
      current = false
      controller.abort()
    }
  }, [webMode, attempt, goToLogin])

  useEffect(() => {
    if (!webMode) {
      return
    }
    // Mid-session expiry: a 401 anywhere in the app ends the shell.
    const unsubscribe = getSharedAuthSessionClient().subscribeToSessionExpiry(() => {
      setState({ kind: 'unauthenticated', code: 'SESSION_REJECTED' })
      goToLogin()
    })
    return unsubscribe
  }, [webMode, goToLogin])

  if (!webMode || state.kind === 'authenticated') {
    return <>{children}</>
  }

  if (state.kind === 'checking') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <div role="status" aria-live="polite" className="flex flex-col items-center gap-4 text-center">
          <div
            aria-hidden="true"
            className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
          />
          <p className="text-sm text-muted-foreground">Checking your session...</p>
        </div>
      </main>
    )
  }

  const failureCode =
    state.kind === 'unauthenticated' ? 'BOOT_SESSION_EXPIRED' : 'BOOT_SESSION_UNKNOWN'
  const message = BOOT_FAILURE_MESSAGES[failureCode]
  const detail = `Code: ${failureCode} (step: session, ${state.code})`
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div
        role="alert"
        className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm"
      >
        <h1 className="text-lg font-semibold">{message.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message.body}</p>
        <p className="mt-4 font-mono text-xs text-muted-foreground">{detail}</p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          {state.kind === 'unauthenticated' ? (
            <button
              type="button"
              onClick={() => router.replace(SESSION_EXPIRED_LOGIN_PATH)}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Sign in
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setState({ kind: 'checking' })
                setAttempt((n) => n + 1)
              }}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </main>
  )
}
