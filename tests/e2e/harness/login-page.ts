// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Page object for the login page (/login, shipped in V3-03).
//
// Locators live in ./selectors.ts; this class only composes them into
// the reusable actions the login flow (E2E-S1) needs. It drives the
// login UI itself; establishing a session WITHOUT driving the UI
// stays in ./auth.ts (loginViaApi), which flows like E2E-01-auth use
// to reach an authenticated app state. Do not mix the two: a test of
// the login UI must go through this page object, and a test of
// something else must not depend on the login UI.
//
// Credentials are never stored here. The caller supplies test-only
// values from the harness environment (readTestCredentials in
// ./auth.ts) and never logs them.
//
// Anti-flaky rules (desain-pengujian 4.3) apply to every method here:
// no fixed sleeps, no waitForTimeout. Every wait is an observation:
// an element becoming visible or a URL changing. The login page
// starts in a "Checking your session..." state while it probes
// GET /api/auth/me; gotoLogin waits for the title text, which
// appears only after that probe finishes.

import { expect, type Page } from '@playwright/test'

import {
  loginAlertByText,
  loginEmailInput,
  loginPasswordInput,
  loginSubmitButton,
  loginTitleText,
  loginTotpCodeInput,
  loginTotpTitleText,
  loginVerifyButton,
  setupTitleText,
} from './selectors'

export class LoginPage {
  constructor(private readonly page: Page) {}

  /** Open /login and wait for the sign-in form to appear. */
  async gotoLogin(): Promise<void> {
    await this.page.goto('/login')
    await expect(loginTitleText(this.page)).toBeVisible()
  }

  /**
   * Fill the email and password fields and submit. Asserts nothing
   * about the outcome: the caller waits for the authenticated app
   * (AppPage) or for the expected error alert.
   */
  async signInWithPassword(email: string, password: string): Promise<void> {
    await loginEmailInput(this.page).fill(email)
    await loginPasswordInput(this.page).fill(password)
    await loginSubmitButton(this.page).click()
  }

  /** Wait until the second (TOTP) step is shown. */
  async expectTotpStep(): Promise<void> {
    await expect(loginTotpTitleText(this.page)).toBeVisible()
  }

  /** Fill the 6-digit authenticator code and submit the second step. */
  async submitTotpCode(code: string): Promise<void> {
    await loginTotpCodeInput(this.page).fill(code)
    await loginVerifyButton(this.page).click()
  }

  /** Assert a login alert carrying the given exact text is visible. */
  async expectAlert(text: string): Promise<void> {
    await expect(loginAlertByText(this.page, text)).toBeVisible()
  }

  /** Open /setup and wait for the first-account form to appear. */
  async gotoSetup(): Promise<void> {
    await this.page.goto('/setup')
    await expect(setupTitleText(this.page)).toBeVisible()
  }
}
