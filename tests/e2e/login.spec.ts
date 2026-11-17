// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-S1: login. A seeded test account signs in through the web login
// UI and reaches the authenticated app; a wrong password yields the
// generic failure alert with no account enumeration. Design sources:
// fase1/desain-auth.md section 3.1 (two-step login) and
// fase1/kontrak-api-kanonis.md auth group.
//
// Status: LIVE (converted by W4-FLOWS). Tags: @scaffold @smoke.
// Promoted to @smoke after green runs on tip 86ce4d03 (S1 6.5s,
// S1b 2.3s) under E2EDEBT conditions; the promotion is flagged
// for the coordinator in the W4-FLOWS report (P-5) and reverts
// by removing the @smoke tag. The @scaffold tag is kept so the
// scaffold inventory still lists these specs.
//
// Why the sessionless fixture: the backend fixture establishes a
// session via the API, so driving the login UI from that context
// would prove nothing. sessionlessBackendTest
// (harness/backend-fixture.ts) seeds the account without logging
// the browser in, and exposes the generated credentials in memory
// only (never logged, never hardcoded here). TOTP coverage is a
// separate variant, not part of this spec: the seeded account has
// no TOTP enrolled.
//
// Steps (happy path):
// 1. Open /login at the fixture gateway origin (LoginPage.gotoLogin)
//    and wait for the sign-in form by observation: the title text
//    appears only after the page's session probe finishes.
// 2. Fill the email and password fields and submit
//    (LoginPage.signInWithPassword). Wait for the authenticated
//    state by observation: the URL reaching /core/main and the file
//    tree becoming visible (AppPage.expectBooted), never by a
//    fixed sleep.
// 3. Assert the session is a browser session, not a token in web
//    storage (desain-auth section 5.4 / T5): read localStorage and
//    sessionStorage through page.evaluate and assert no stored
//    value has a JWT shape, no storage key names a token or
//    session, and the password value appears nowhere in storage.
//    The evaluate returns keys plus booleans ONLY; storage contents
//    are never logged or returned to the test process beyond the
//    boolean verdicts.
//
// Steps (failed login, second test, fresh backend per test so no
// rate-limit or lockout state accumulates):
// 1. Open /login, fill the seeded email with a wrong password, submit.
// 2. Assert the generic alert "Email or password is incorrect."
//    appears and the URL stays on /login: no account enumeration,
//    no redirect.

import { expect, sessionlessBackendTest } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'
import { LoginPage } from './harness/login-page'

sessionlessBackendTest(
  'E2E-S1 @scaffold @smoke login: seeded account signs in and reaches the app',
  async ({ page, sessionlessBackend }) => {
    const login = new LoginPage(page)
    await login.gotoLogin(sessionlessBackend.pageUrl)
    await login.signInWithPassword(
      sessionlessBackend.credentials.email,
      sessionlessBackend.credentials.password,
    )

    const app = new AppPage(page)
    await app.awaitHome()
    await app.expectBooted()

    const storageVerdict = await page.evaluate((password: string) => {
      const verdict = { keys: [] as string[], jwtShaped: false, tokenKey: false, hasPassword: false }
      const storages = [window.localStorage, window.sessionStorage]
      for (const storage of storages) {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index)
          if (key === null) continue
          verdict.keys.push(key)
          const value = storage.getItem(key) ?? ''
          if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
            verdict.jwtShaped = true
          }
          if (/token|session|jwt/i.test(key)) {
            verdict.tokenKey = true
          }
          if (value.includes(password)) {
            verdict.hasPassword = true
          }
        }
      }
      return verdict
    }, sessionlessBackend.credentials.password)
    expect(storageVerdict.jwtShaped, 'a JWT-shaped value was found in web storage').toBe(false)
    expect(storageVerdict.tokenKey, 'a token/session key was found in web storage').toBe(false)
    expect(storageVerdict.hasPassword, 'the password value was found in web storage').toBe(false)
  },
)

sessionlessBackendTest(
  'E2E-S1b @scaffold @smoke login: wrong password yields the generic failure alert',
  async ({ page, sessionlessBackend }) => {
    const login = new LoginPage(page)
    await login.gotoLogin(sessionlessBackend.pageUrl)
    await login.signInWithPassword(sessionlessBackend.credentials.email, 'wrong-password-e2e')
    await login.expectAlert('Email or password is incorrect.')
    expect(page.url(), 'failed login must stay on /login').toContain('/login')
  },
)
