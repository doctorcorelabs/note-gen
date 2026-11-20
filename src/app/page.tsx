'use client'
// Modified for the web fork on 2026-11-14; see FORK.md.
//
// Web boot guard (Fase 1, V2-08). Upstream, this page rendered nothing
// and redirected blindly: a failed Store.load left a blank page with
// no message and no retry. In web mode this page now runs a two-layer
// guard before any navigation happens:
//
// Layer 1, shell status: a visible loading state renders on the first
// paint, with a progress label for the check that is running, so a
// slow or stalled boot can be observed instead of guessed at.
//
// Layer 2, mount gate: navigation into /core/main happens only after
// the session, liveness, readiness, and store checks all pass (see
// src/lib/web/boot-guard.ts). Any failure shows a visible error
// screen with one clear action and a retry button. The guard never
// redirects on failure, because a blind redirect would move the
// failure into initializeApp, where it is only logged to the console.
// The navigation itself is also bounded (BOOT_NAVIGATION_TIMEOUT_MS):
// if the URL has not reached the target when the timer fires, the
// spinner is replaced by a visible navigation timeout error with
// retry, so a stalled router.push can never spin without a bound
// (mitigation M2 for F1-59, wave 4).
//
// Desktop behavior is preserved: inside the Tauri shell the page runs
// the same Store reads and the same redirect decision as upstream,
// through the same resolveRedirectTarget helper the web path uses.
// The only deliberate desktop differences are a brief loading paint
// before the redirect (instead of a blank page) and a visible error
// screen with retry when the Store cannot be read (instead of a blank
// page with an unhandled rejection). The success path is unchanged.
import { platform } from '@/lib/platform'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isMobileDevice } from '@/lib/check'
import { isTauri } from '@/lib/platform/detect'
import {
  BOOT_FAILURE_MESSAGES,
  BOOT_GUARD_TIMEOUT_MS,
  BOOT_NAVIGATION_TIMEOUT_MS,
  resolveRedirectTarget,
  runBootGuard,
  type BootGuardFailure,
  type BootStep,
} from '@/lib/web/boot-guard'
import {
  SESSION_EXPIRED_LOGIN_PATH,
  getSharedAuthSessionClient,
} from '@/lib/web/auth-client'
import { ensureWebPlatformInitialized } from '@/lib/web/platform-boot'

type PageState =
  | { kind: 'checking'; step: BootStep }
  | { kind: 'redirecting' }
  | { kind: 'error'; failure: BootGuardFailure }

const STEP_LABELS: Record<BootStep, string> = {
  session: 'Checking your session...',
  live: 'Checking the server...',
  ready: 'Checking the database and workspace...',
  store: 'Loading your settings...',
  workspace: 'Checking the workspace...',
  guard: 'Starting NoteGen...',
}

export default function Home() {
  const router = useRouter()
  const [state, setState] = useState<PageState>({ kind: 'checking', step: 'guard' })
  const [attempt, setAttempt] = useState(0)
  const attemptRef = useRef(0)
  const autoRetryUsedRef = useRef(false)
  const stateRef = useRef(state)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const retry = useCallback(() => {
    autoRetryUsedRef.current = false
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    // Boot (N-5): re-assert platform initialization before the guard
    // chain resolves platform.store. The root layout already ran this
    // at module scope; this call is a no-op once frozen.
    ensureWebPlatformInitialized()
    const attemptId = attemptRef.current + 1
    attemptRef.current = attemptId
    const controller = new AbortController()
    const isCurrent = () => attemptRef.current === attemptId && !controller.signal.aborted
    setState({ kind: 'checking', step: 'guard' })

    // Navigation budget (M2, F1-59): the guard budget ends when
    // runBootGuard resolves, so router.push below needs its own
    // timer. A committed navigation unmounts this page and the
    // effect cleanup clears the timer. If the timer fires while
    // this page is still mounted and the URL has not reached the
    // target, the navigation stalled and a visible error screen
    // with retry replaces the spinner instead of spinning
    // without a bound.
    let navigationTimer: ReturnType<typeof setTimeout> | undefined
    function beginNavigation(target: string) {
      setState({ kind: 'redirecting' })
      router.push(target)
      navigationTimer = setTimeout(() => {
        if (!isCurrent()) {
          return
        }
        if (typeof window !== 'undefined' && window.location.pathname !== target) {
          setState({
            kind: 'error',
            failure: {
              code: 'BOOT_NAVIGATION_TIMEOUT',
              step: 'guard',
              detail: 'NAVIGATION_TIMEOUT',
            },
          })
        }
      }, BOOT_NAVIGATION_TIMEOUT_MS)
    }

    async function runWebAttempt() {
      const outcome = await runBootGuard(
        {
          loadStore: async () => {
            const store = await platform.store.load('store.json')
            const currentPage = await store.get<string>('currentPage')
            return {
              currentPage: currentPage ?? undefined,
              persistCurrentPage: async (value: string) => {
                await store.set('currentPage', value)
                await store.save()
              },
            }
          },
          isMobileDevice: () => isMobileDevice(),
          isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
          onStep: (step) => {
            if (isCurrent()) {
              setState({ kind: 'checking', step })
            }
          },
        },
        controller.signal,
      )
      if (!isCurrent()) {
        return
      }
      if (outcome.status === 'ready') {
        // Web fork (Fase 1, V3-03 slot 03b): the probe just proved
        // the session is alive, so a previous expiry must not
        // linger into the shell. The CSRF token itself stays in
        // memory and is refetched after a reload by the auth
        // client; nothing is seeded or stored here.
        getSharedAuthSessionClient().resetSessionStatus()
        beginNavigation(outcome.target)
      } else if (outcome.status === 'failed') {
        if (outcome.failure.code === 'BOOT_SESSION_EXPIRED') {
          // A rejected session must never keep a stale CSRF token
          // into the next sign-in. Other failures keep the token:
          // an inconclusive probe must not destroy a live session.
          getSharedAuthSessionClient().clearCsrfToken()
          // An unauthenticated visitor belongs on the login page,
          // exactly like a /core deep link (session-guard). The
          // login page only navigates away after a proven session,
          // so this cannot loop. Other failures keep the visible
          // error screen with retry.
          beginNavigation(SESSION_EXPIRED_LOGIN_PATH)
          return
        }
        setState({ kind: 'error', failure: outcome.failure })
      }
    }

    async function runDesktopAttempt() {
      let settled = false
      const timer = setTimeout(() => {
        if (settled || !isCurrent()) {
          return
        }
        settled = true
        setState({
          kind: 'error',
          failure: { code: 'BOOT_TIMEOUT', step: 'guard', detail: 'GUARD_TIMEOUT' },
        })
      }, BOOT_GUARD_TIMEOUT_MS)
      try {
        const store = await platform.store.load('store.json')
        const currentPage = await store.get<string>('currentPage')
        const { target, storeUpdate } = resolveRedirectTarget(
          currentPage ?? undefined,
          isMobileDevice(),
        )
        if (storeUpdate !== null) {
          await store.set('currentPage', storeUpdate)
          await store.save()
        }
        if (settled || !isCurrent()) {
          return
        }
        settled = true
        beginNavigation(target)
      } catch {
        if (settled || !isCurrent()) {
          return
        }
        settled = true
        setState({
          kind: 'error',
          failure: {
            code: 'BOOT_STORE_UNAVAILABLE',
            step: 'store',
            detail: 'STORE_LOAD_FAILED',
          },
        })
      } finally {
        clearTimeout(timer)
      }
    }

    if (isTauri()) {
      void runDesktopAttempt()
    } else {
      void runWebAttempt()
    }
    return () => {
      clearTimeout(navigationTimer)
      controller.abort()
    }
  }, [attempt, router])

  useEffect(() => {
    function handleOnline() {
      if (autoRetryUsedRef.current) {
        return
      }
      const current = stateRef.current
      if (current.kind === 'error' && current.failure.code === 'BOOT_NETWORK_UNREACHABLE') {
        autoRetryUsedRef.current = true
        setAttempt((n) => n + 1)
      }
    }
    window.addEventListener('online', handleOnline)
    return () => {
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  function handleSignIn() {
    // No automatic redirect to the login page: the guard never loops
    // between here and login on its own. This navigation is
    // user-initiated; if the session is still rejected after signing
    // in, returning here shows this screen again instead of looping.
    // The /login page itself is owned by wave 3 (auth).
    router.push('/login')
  }

  if (state.kind === 'error') {
    const message = BOOT_FAILURE_MESSAGES[state.failure.code]
    const detail = `Code: ${state.failure.code} (step: ${state.failure.step}${
      state.failure.detail ? `, ${state.failure.detail}` : ''
    })`
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
            {message.action === 'sign-in' ? (
              <>
                <button
                  type="button"
                  onClick={handleSignIn}
                  className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Sign in
                </button>
                <button
                  type="button"
                  onClick={retry}
                  className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Try again
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={retry}
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

  const label =
    state.kind === 'redirecting' ? 'Opening your workspace...' : STEP_LABELS[state.step]
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-4 text-center">
        <div
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
        />
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </main>
  )
}
