// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-D-S0: the S0 boot step of the A10 demo sequence, as a
// committed spec artifact (D-DEMO-5, W5-DEMOCODE). The demo
// acceptance run in wave 5 phase 5D cites this file and test
// name as the S0 definition; the step no longer lives only in
// out-of-repo probe specs.
//
// Source, verbatim in substance: the S0 block of the W4-DEMO
// probe spec (fase1 evidence w4-demo-r12/specs/w4-demo.spec.ts):
// goto /login with domcontentloaded, then check the "Sign in to
// NoteGen" text is visible and the gateway answered 200. That
// check ran immediately after domcontentloaded, before React
// hydration, so it reported TERHALANG on every run even though
// the very next login step succeeded on the same page (W4-DEMO
// report section 5.1; gate-closure re-measurement reproduced the
// artifact verbatim). AD-123 item 5 assigned the spec fix: wait
// for hydration/text. The fix already landed in the harness as
// LoginPage.gotoLogin (title wait plus the React fiber-key
// hydration observation); this spec reuses it verbatim instead
// of re-implementing the wait, and adds the gateway 200 probe
// the S0 verdict needs.
//
// What this proves: the gateway serves /login with HTTP 200; the
// sign-in title renders; React hydrates the form (fiber key on
// the submit button, observed by gotoLogin); the Email and
// Password fields and the idle Sign in button are visible and
// the button is enabled.
//
// What this does NOT prove: a successful login (that is S1 /
// E2E-S1); the authenticated shell boot (E2E-01-auth); the
// session probe outcome beyond the form being displayed; any
// behavior past the login form. A green S0 plus a green S1 is
// still two separate claims, and this spec makes only the first.
//
// Tag @demo (not @smoke): the S0 step composes the demo
// sequence, following the @demo precedent in tests/e2e/README.md
// and demo.spec.ts. The e2e-smoke gate definition is unchanged.
// Run by file until E2E-D1/E2E-D2 land: a bare --grep @demo run
// still fails on those two TODO skeletons by design.
//
// Anti-flaky rules (desain-pengujian 4.3) apply: no fixed
// sleeps. Every wait is an observation (HTTP response, visible
// text, hydration key, visible/enabled controls).

import { expect, sessionlessBackendTest } from './harness/backend-fixture'
import { LoginPage } from './harness/login-page'
import { loginEmailInput, loginPasswordInput, loginSubmitButton } from './harness/selectors'

sessionlessBackendTest(
  'E2E-D-S0 @demo S0 boot: gateway serves /login 200 and the sign-in form hydrates',
  async ({ page, sessionlessBackend }) => {
    // Gateway leg of S0: the login page is served, not a gateway
    // error. The sessionless fixture holds no session, so this
    // GET proves the unauthenticated boot surface only.
    const probe = await page.request.get(`${sessionlessBackend.pageUrl}/login`, {
      timeout: 10_000,
    })
    expect(probe.status(), 'gateway must serve /login with HTTP 200').toBe(200)

    // Hydration leg of S0: title visible AND React attached
    // (LoginPage.gotoLogin waits for both; the title alone would
    // let a fill-and-click land on an unhydrated form).
    const login = new LoginPage(page)
    await login.gotoLogin(sessionlessBackend.pageUrl)

    // Form leg of S0: the controls the next step (S1) drives are
    // rendered and operable. No credential is entered here: the
    // login itself belongs to S1, not to S0.
    await expect(loginEmailInput(page)).toBeVisible()
    await expect(loginPasswordInput(page)).toBeVisible()
    await expect(loginSubmitButton(page)).toBeVisible()
    await expect(loginSubmitButton(page)).toBeEnabled()
  },
)
