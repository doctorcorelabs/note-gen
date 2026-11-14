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
// SELECTOR STATUS: NOT VERIFIABLE. No login UI exists in the reference
// repo (HEAD 4dcaa3f): the only credential-adjacent UI is the desktop
// app-lock gate (src/components/app-lock-gate.tsx) and sync token
// inputs, neither of which is a web login page. Desain-auth specifies
// the API endpoints and the /setup install page, but it does NOT
// specify a login page route, field labels, or button text. There are
// deliberately no login locators in harness/selectors.ts: the flow
// author must NOT guess a route or a selector. The UI owner must
// either ship the login page with accessible names or add a
// documented test hook, and the flow author then derives locators
// from that shipped UI.
//
// Intended steps (replace the notYetLanded call when the feature lands):
// 1. Seed a test account through the backend test harness (account
//    seeding has NOT landed). Credentials come from test-only
//    environment values supplied by the harness, never hardcoded in
//    this spec and never a real operator credential. Seed one account
//    without TOTP for the happy path; TOTP coverage is a separate
//    variant, not part of this spec.
// 2. Open the login page at the route the shipped UI defines. Do not
//    guess the route: read it from the shipped UI or the UI owner.
// 3. Fill the email and password fields (accessible names from the
//    shipped UI) and submit. Wait for the authenticated state by
//    observation: the URL reaching /core/main and the file tree
//    becoming visible (AppPage.gotoHome / expectBooted), never by a
//    fixed sleep.
// 4. Assert the session is a browser session, not a token in web
//    storage: after login, localStorage and sessionStorage hold no
//    value resembling a token (desain-auth section 5.4 / T5). Read
//    storage through page.evaluate and assert the auth key allowlist
//    the lint config defines; do not log storage contents.
// 5. Failed-login variant (same spec file, second test, when the
//    feature lands): a wrong password yields the generic failure
//    response with no account enumeration (same status, body shape,
//    and coarse timing for a known vs unknown email, desain-auth
//    section 3.7). CAUTION: login attempts count toward the login
//    rate-limit buckets and progressive lockout (desain-auth
//    section 6.3). Use a fresh seeded account per run and keep the
//    number of failed attempts small and fixed, so the suite cannot
//    lock its own test account.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-S1 @scaffold login: seeded account signs in and reaches the app', async () => {
  notYetLanded(
    'E2E-S1',
    'the web login page plus account seeding plus the session backend ' +
      'have not landed; no login route, field, or button exists in the ' +
      'shipped UI to drive yet.',
  )
})
