// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-S1: login. A seeded test account signs in through the web login
// UI and reaches the authenticated app. Design sources: fase1/desain-auth.md
// section 3.1 (two-step login: POST /api/auth/login, then
// POST /api/auth/login/totp when TOTP is enabled) and
// fase1/kontrak-api-kanonis.md auth group.
//
// Status: TODO. This test fails explicitly with "fitur belum mendarat"
// until the feature lands. Do not convert it to skip/fixme and do not
// add placeholder assertions. This spec carries the @scaffold tag, not
// @smoke: it is outside the six @smoke flows of desain-pengujian
// section 4, and its justification is recorded in tests/e2e/README.md
// as section 4.4 requires.
//
// SELECTOR STATUS: VERIFIED (source) against trunk 69c77dac. The login
// page shipped in V3-03 (src/app/login/page.tsx, route /login): label
// associated Email/Password fields, a "Sign in" submit button, and a
// second TOTP step ("Two-step verification", "Verification code" /
// "Recovery code" fields, "Verify" button). Locators live in
// harness/selectors.ts and the page object is harness/login-page.ts.
// Runtime behavior is still unverified until a green run. The page
// carries no data-testid; the auth-* test ids the selector inventory
// asked for were not added by V3-03. Strings are hardcoded English in
// the page source (no auth catalog namespace yet). What still blocks
// this spec is the harness side, not the UI: account seeding, the
// backend test harness, and a path past the Cloudflare Access
// perimeter (inventaris-selector-e2e.md 3.1/11.5). The harness code
// has landed (harness/backend-fixture.ts: per-test backend, seed
// account, loopback test-only Access bypass) but has no live run
// yet. NOTE for the conversion author: the fixture establishes a
// session via the API, so this spec needs an unauthenticated
// browser variant (seed the account without logging the browser
// in) or a logout first; driving the login UI from an already
// authenticated context would prove nothing. This spec keeps
// the @scaffold tag until the coordinator promotes it after a green
// run proves the selectors.
//
// Intended steps (replace the notYetLanded call after the first live
// harness run proves the fixture):
// 1. Seed a test account through the backend fixture (account
//    seeding is harness/backend-fixture.ts plus harness/auth.ts;
//    credentials are generated per backend and live in memory
//    only, never hardcoded in this spec and never a real operator
//    credential; the environment-credential path in
//    readTestCredentials stays for runs against an external base
//    URL). Seed one account without TOTP for the happy path; TOTP
//    coverage is a separate variant, not part of this spec.
// 2. Open /login (LoginPage.gotoLogin) and wait for the sign-in form
//    by observation: the title text appears only after the page's
//    session probe finishes.
// 3. Fill the email and password fields and submit
//    (LoginPage.signInWithPassword). Wait for the authenticated state
//    by observation: the URL reaching /core/main and the file tree
//    becoming visible (AppPage.gotoHome / expectBooted), never by a
//    fixed sleep.
// 4. Assert the session is a browser session, not a token in web
//    storage: after login, localStorage and sessionStorage hold no
//    value resembling a token (desain-auth section 5.4 / T5). Read
//    storage through page.evaluate and assert the auth key allowlist
//    the lint config defines; do not log storage contents. (The page
//    itself keeps the TOTP challenge token in component state only,
//    never in storage or the URL, verified in source.)
// 5. Failed-login variant (same spec file, second test, when the
//    feature lands): a wrong password yields the generic failure
//    alert "Email or password is incorrect." with no account
//    enumeration (same status, body shape, and coarse timing for a
//    known vs unknown email, desain-auth section 3.7). CAUTION: login
//    attempts count toward the login rate-limit buckets and
//    progressive lockout (desain-auth section 6.3). Use a fresh
//    seeded account per run and keep the number of failed attempts
//    small and fixed, so the suite cannot lock its own test account.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-S1 @scaffold login: seeded account signs in and reaches the app', async () => {
  notYetLanded(
    'E2E-S1',
    'the backend test harness has no live run yet (code landed, ' +
      'including account seeding and the loopback test-only path ' +
      'past the Cloudflare Access perimeter, unproven against ' +
      'Postgres); no seeded account has signed in through the ' +
      'shipped /login page yet.',
  )
})
