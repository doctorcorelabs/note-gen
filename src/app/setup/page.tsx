// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// First-account setup page (Fase 1, V3-03a, wave 3D). Route decided
// by desain-auth section 2.2: the operator opens the install page at
// /setup.
//
// Setup creates the first (admin) account and its workspace. It does
// NOT create a session: after a 201 the operator signs in through
// the normal login flow, and this page says so instead of promising
// an immediate session (desain-auth section 2.2, kontrak 3.12).
// When installation is already finished the server answers 404 and
// this page shows a generic "not available" panel with a sign-in
// direction; it never claims to know the installation state beyond
// that, and it is never a way in without signing in.
//
// There is deliberately NO registration link on this page: the
// deployment runs in closed registration mode (desain-auth section
// 2.4). The only link is to the sign-in page.
//
// The strings here are hardcoded English, following the boot guard
// precedent (src/lib/web/boot-guard.ts): no `auth` message catalog
// namespace exists yet, and claiming catalog keys needs the
// integrator registry decision (open question Q8 in the 3D prep
// notes). Moving these strings to the catalog is a follow-up for
// the i18n owner, not a behavior change.
'use client'

import { useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  AuthClientError,
  createFirstAccount,
  getSharedAuthSession,
  isValidSetupPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type AuthClientErrorCode,
} from '@/lib/web/auth-client'

const ERROR_MESSAGES: Record<AuthClientErrorCode, string> = {
  INVALID_CREDENTIALS: 'Something went wrong. Try again.',
  INVALID_VERIFICATION_CODE: 'Something went wrong. Try again.',
  INVALID_SETUP_TOKEN: 'The setup token is incorrect.',
  SETUP_CLOSED: 'Setup is not available.',
  VALIDATION_FAILED: 'Check the fields below and try again.',
  RATE_LIMITED: 'Too many attempts. Try again later.',
  SESSION_EXPIRED: 'Something went wrong. Try again.',
  REQUEST_REJECTED: 'The request was rejected. Reload the page and try again.',
  STEP_UP_REQUIRED: 'Something went wrong. Try again.',
  NETWORK_ERROR: 'Could not reach the server. Check your connection and try again.',
  SERVER_ERROR: 'Something went wrong. Try again.',
}

type Phase = 'form' | 'done' | 'closed'

export default function SetupPage() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('form')
  const [setupToken, setSetupToken] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [errorCode, setErrorCode] = useState<AuthClientErrorCode | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const tokenRef = useRef<HTMLInputElement>(null)

  function validate(): string | null {
    if (setupToken.trim() === '') {
      return 'Enter the setup token from the deployment.'
    }
    if (email.trim() === '' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return 'Enter a valid email address.'
    }
    if (!isValidSetupPassword(password)) {
      return `Use a password between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`
    }
    if (password !== confirmPassword) {
      return 'The passwords do not match.'
    }
    return null
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) {
      return
    }
    const problem = validate()
    if (problem !== null) {
      setFieldError(problem)
      return
    }
    setBusy(true)
    setErrorCode(null)
    setFieldError(null)
    try {
      await createFirstAccount(getSharedAuthSession(), {
        setupToken,
        email,
        password,
        workspaceName: workspaceName.trim() === '' ? undefined : workspaceName,
      })
      setSetupToken('')
      setPassword('')
      setConfirmPassword('')
      setPhase('done')
    } catch (error) {
      if (error instanceof AuthClientError) {
        if (error.code === 'SETUP_CLOSED') {
          setPhase('closed')
        } else {
          setErrorCode(error.code)
        }
      } else {
        setErrorCode('SERVER_ERROR')
      }
    } finally {
      setBusy(false)
    }
  }

  if (phase === 'done') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>First account created</CardTitle>
            <CardDescription>
              Your account is ready. Sign in with the email and password you just used.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" onClick={() => router.push('/login')} className="w-full">
              Go to sign in
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  if (phase === 'closed') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Setup is not available</CardTitle>
            <CardDescription>
              This deployment may already be set up. Sign in instead.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" onClick={() => router.push('/login')} className="w-full">
              Go to sign in
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Set up NoteGen</CardTitle>
          <CardDescription>
            Create the first account for this deployment. You will sign in afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {errorCode !== null && (
            <p role="alert" className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {ERROR_MESSAGES[errorCode]}
            </p>
          )}
          <form onSubmit={handleSubmit} noValidate>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label htmlFor="setup-token" className="text-sm font-medium">
                  Setup token
                </label>
                <Input
                  ref={tokenRef}
                  id="setup-token"
                  name="setupToken"
                  type="password"
                  autoComplete="off"
                  placeholder="Setup token from the deployment"
                  value={setupToken}
                  onChange={(event) => setSetupToken(event.target.value)}
                  disabled={busy}
                  aria-invalid={fieldError !== null}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="setup-email" className="text-sm font-medium">
                  Email
                </label>
                <Input
                  id="setup-email"
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
                <label htmlFor="setup-password" className="text-sm font-medium">
                  Password
                </label>
                <Input
                  id="setup-password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={`${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                  aria-invalid={fieldError !== null}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="setup-confirm-password" className="text-sm font-medium">
                  Confirm password
                </label>
                <Input
                  id="setup-confirm-password"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  disabled={busy}
                  aria-invalid={fieldError !== null}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="setup-workspace-name" className="text-sm font-medium">
                  Workspace name (optional)
                </label>
                <Input
                  id="setup-workspace-name"
                  name="workspaceName"
                  type="text"
                  autoComplete="off"
                  placeholder="My workspace"
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  disabled={busy}
                />
              </div>
              {fieldError !== null && (
                <p role="alert" className="text-sm text-destructive">
                  {fieldError}
                </p>
              )}
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? 'Creating account...' : 'Create first account'}
              </Button>
            </div>
          </form>
          <p className="mt-6 text-center text-sm text-muted-foreground">
            Already set up?{' '}
            <a href="/login" className="underline underline-offset-4 hover:text-foreground">
              Sign in
            </a>
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
