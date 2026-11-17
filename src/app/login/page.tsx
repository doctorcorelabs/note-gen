// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Login page (Fase 1, V3-03a, wave 3D). Route decided by the boot
// guard: src/app/page.tsx navigates here with router.push('/login').
//
// Two-step flow (desain-auth section 3.1): email plus password
// first; when the server answers 202 the page shows the second step
// (a 6-digit authenticator code or a recovery code). The challenge
// token from step 1 lives only in this component state: it is never
// written to storage, never put in the URL, and never logged. After
// a successful sign-in the page navigates to the sanitized `next`
// query value, or to "/" so the boot guard redirects into the app.
//
// There is deliberately NO account-creation link on this page: the
// deployment runs in closed mode and the public account-creation
// endpoint answers 404 by design (desain-auth section 2.4). There
// is also no "forgot password" link promising an email: with no SMTP
// configured, reset emails cannot be sent, so the page points at the
// deployment owner instead (desain-auth section 3.6, branch B).
//
// The strings here are hardcoded English, following the boot guard
// precedent (src/lib/web/boot-guard.ts): no `auth` message catalog
// namespace exists yet, and claiming catalog keys needs the
// integrator registry decision (open question Q8 in the 3D prep
// notes). Moving these strings to the catalog is a follow-up for
// the i18n owner, not a behavior change.
//
// Query values are read from window.location inside an effect so
// the page stays safe under the static export build: no
// useSearchParams bailout, no Suspense dependency.
'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  AuthClientError,
  fetchCurrentAccount,
  getSharedAuthSession,
  loginWithPassword,
  loginWithTotp,
  resolvePostLoginTarget,
  type AuthClientErrorCode,
} from '@/lib/web/auth-client'

const ERROR_MESSAGES: Record<AuthClientErrorCode, string> = {
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  INVALID_VERIFICATION_CODE: 'The verification code is incorrect or has expired.',
  INVALID_SETUP_TOKEN: 'Something went wrong. Try again.',
  SETUP_CLOSED: 'Something went wrong. Try again.',
  VALIDATION_FAILED: 'Check the fields below and try again.',
  RATE_LIMITED: 'Too many attempts. Try again later.',
  SESSION_EXPIRED: 'Your session has expired. Sign in again.',
  REQUEST_REJECTED: 'The request was rejected. Reload the page and try again.',
  STEP_UP_REQUIRED: 'Something went wrong. Try again.',
  NETWORK_ERROR: 'Could not reach the server. Check your connection and try again.',
  SERVER_ERROR: 'Something went wrong. Try again.',
}

type Step = 'credentials' | 'totp'

export default function LoginPage() {
  const router = useRouter()
  const [checking, setChecking] = useState(true)
  const [step, setStep] = useState<Step>('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [useRecovery, setUseRecovery] = useState(false)
  const [challengeToken, setChallengeToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorCode, setErrorCode] = useState<AuthClientErrorCode | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [expiredNotice, setExpiredNotice] = useState(false)
  const [target, setTarget] = useState('/')
  const emailRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const next = params.get('next')
    const resolved = resolvePostLoginTarget(next)
    setTarget(resolved)
    const expired = params.get('expired')
    if (expired === '1' || expired === 'true') {
      setExpiredNotice(true)
    }
    let cancelled = false
    async function probe() {
      try {
        const account = await fetchCurrentAccount(getSharedAuthSession())
        if (cancelled) {
          return
        }
        if (account !== null) {
          router.replace(resolved)
          return
        }
        setChecking(false)
      } catch (error) {
        if (cancelled) {
          return
        }
        if (error instanceof AuthClientError) {
          setErrorCode(error.code)
        } else {
          setErrorCode('SERVER_ERROR')
        }
        setChecking(false)
      }
    }
    void probe()
    return () => {
      cancelled = true
    }
  }, [router])

  useEffect(() => {
    if (!checking && step === 'credentials') {
      emailRef.current?.focus()
    }
    if (step === 'totp') {
      codeRef.current?.focus()
    }
  }, [checking, step])

  async function handleCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) {
      return
    }
    if (email.trim() === '' || password === '') {
      setFieldError('Enter your email and password.')
      return
    }
    setBusy(true)
    setErrorCode(null)
    setFieldError(null)
    try {
      const result = await loginWithPassword(getSharedAuthSession(), { email, password })
      if (result.outcome === 'totp_required') {
        setChallengeToken(result.challenge.challengeToken)
        setPassword('')
        setStep('totp')
      } else {
        setPassword('')
        setChallengeToken(null)
        router.replace(target)
      }
    } catch (error) {
      if (error instanceof AuthClientError) {
        setErrorCode(error.code)
      } else {
        setErrorCode('SERVER_ERROR')
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || challengeToken === null) {
      return
    }
    if (useRecovery) {
      if (recoveryCode.trim() === '') {
        setFieldError('Enter a recovery code.')
        return
      }
    } else if (!/^\d{6}$/.test(code.trim())) {
      setFieldError('Enter the 6-digit code from your authenticator app.')
      return
    }
    setBusy(true)
    setErrorCode(null)
    setFieldError(null)
    try {
      if (useRecovery) {
        await loginWithTotp(getSharedAuthSession(), { challengeToken, recoveryCode })
      } else {
        await loginWithTotp(getSharedAuthSession(), { challengeToken, code })
      }
      setCode('')
      setRecoveryCode('')
      setChallengeToken(null)
      router.replace(target)
    } catch (error) {
      if (error instanceof AuthClientError) {
        setErrorCode(error.code)
      } else {
        setErrorCode('SERVER_ERROR')
      }
    } finally {
      setBusy(false)
    }
  }

  function startOver() {
    setChallengeToken(null)
    setCode('')
    setRecoveryCode('')
    setUseRecovery(false)
    setErrorCode(null)
    setFieldError(null)
    setStep('credentials')
  }

  if (checking) {
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

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            {step === 'credentials' ? 'Sign in to NoteGen' : 'Two-step verification'}
          </CardTitle>
          <CardDescription>
            {step === 'credentials'
              ? 'Enter your email and password to continue.'
              : useRecovery
                ? 'Enter one of your recovery codes.'
                : 'Enter the 6-digit code from your authenticator app.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {expiredNotice && step === 'credentials' && (
            <p role="status" className="mb-4 rounded-md bg-muted px-3 py-2 text-sm">
              Your session has expired. Sign in again to continue.
            </p>
          )}
          {errorCode !== null && (
            <p role="alert" data-testid="auth-error" className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {ERROR_MESSAGES[errorCode]}
            </p>
          )}
          {step === 'credentials' ? (
            <form onSubmit={handleCredentials} noValidate>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <label htmlFor="login-email" className="text-sm font-medium">
                    Email
                  </label>
                  <Input
                    ref={emailRef}
                    id="login-email"
                    data-testid="auth-email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={busy}
                    aria-invalid={fieldError !== null}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label htmlFor="login-password" className="text-sm font-medium">
                    Password
                  </label>
                  <Input
                    id="login-password"
                    data-testid="auth-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={busy}
                    aria-invalid={fieldError !== null}
                  />
                </div>
                {fieldError !== null && (
                  <p role="alert" className="text-sm text-destructive">
                    {fieldError}
                  </p>
                )}
                <Button type="submit" disabled={busy} data-testid="auth-submit" className="w-full">
                  {busy ? 'Signing in...' : 'Sign in'}
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleTotp} noValidate>
              <div className="flex flex-col gap-4">
                {useRecovery ? (
                  <div className="flex flex-col gap-2">
                    <label htmlFor="login-recovery-code" className="text-sm font-medium">
                      Recovery code
                    </label>
                    <Input
                      ref={codeRef}
                      id="login-recovery-code"
                      data-testid="auth-recovery-code"
                      name="recoveryCode"
                      type="text"
                      autoComplete="off"
                      placeholder="Enter a recovery code"
                      value={recoveryCode}
                      onChange={(event) => setRecoveryCode(event.target.value)}
                      disabled={busy}
                      aria-invalid={fieldError !== null}
                    />
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <label htmlFor="login-code" className="text-sm font-medium">
                      Verification code
                    </label>
                    <Input
                      ref={codeRef}
                      id="login-code"
                      data-testid="auth-totp-code"
                      name="code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6-digit code"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      disabled={busy}
                      aria-invalid={fieldError !== null}
                    />
                  </div>
                )}
                {fieldError !== null && (
                  <p role="alert" className="text-sm text-destructive">
                    {fieldError}
                  </p>
                )}
                <Button type="submit" disabled={busy} className="w-full">
                  {busy ? 'Verifying...' : 'Verify'}
                </Button>
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => {
                      setUseRecovery(!useRecovery)
                      setFieldError(null)
                      setErrorCode(null)
                    }}
                    disabled={busy}
                    className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-50"
                  >
                    {useRecovery ? 'Use an authenticator code instead' : 'Use a recovery code instead'}
                  </button>
                  <button
                    type="button"
                    onClick={startOver}
                    disabled={busy}
                    className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-50"
                  >
                    Start over
                  </button>
                </div>
              </div>
            </form>
          )}
          <p className="mt-6 text-center text-sm text-muted-foreground">
            If you cannot sign in, contact the person who set up this deployment.
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
