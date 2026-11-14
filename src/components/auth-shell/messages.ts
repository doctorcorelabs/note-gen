// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Proposed message keys for the auth shell (namespace: auth).
//
// These English strings live here ONLY because the shell task forbids
// editing messages/*.json. They are the proposed values for the keys
// listed in fase1/laporan-auth-pages-shell.md. The i18n owner moves
// them into messages/en.json (and messages/zh.json) and wave 3 wiring
// replaces authText() with useTranslations("auth"). Until then, no
// string on the auth pages comes from the message catalogs, so a
// missing catalog key can never render as a raw key or as fallback
// text in another language on these pages.

export const AUTH_MESSAGE_KEYS = [
  "loginTitle",
  "loginDescription",
  "emailLabel",
  "emailPlaceholder",
  "passwordLabel",
  "passwordPlaceholder",
  "signInButton",
  "signingInButton",
  "verifyTitle",
  "verifyDescription",
  "verificationCodeLabel",
  "verificationCodePlaceholder",
  "recoveryCodeLabel",
  "recoveryCodePlaceholder",
  "useRecoveryCode",
  "useVerificationCode",
  "verifyButton",
  "verifyingButton",
  "backToSignIn",
  "setupTitle",
  "setupDescription",
  "setupTokenLabel",
  "setupTokenPlaceholder",
  "workspaceNameLabel",
  "workspaceNamePlaceholder",
  "confirmPasswordLabel",
  "confirmPasswordPlaceholder",
  "createAccountButton",
  "creatingAccountButton",
  "setupSuccessTitle",
  "setupSuccessDescription",
  "goToSignInButton",
  "sessionExpiredTitle",
  "sessionExpiredDescription",
  "shellNotice",
  "errorInvalidCredentials",
  "errorInvalidVerificationCode",
  "errorRateLimited",
  "errorRateLimitedRetry",
  "errorSessionExpired",
  "errorRequestRejected",
  "errorInvalidSetupToken",
  "errorInvalidActionToken",
  "errorNotFound",
  "errorValidationFailed",
  "errorNotConnected",
  "errorUnexpected",
  "validationEmailRequired",
  "validationEmailInvalid",
  "validationPasswordRequired",
  "validationPasswordTooShort",
  "validationPasswordTooLong",
  "validationPasswordsDoNotMatch",
  "validationCodeRequired",
  "validationCodeInvalid",
  "validationSetupTokenRequired",
  "validationRecoveryCodeRequired",
] as const;

export type AuthMessageKey = (typeof AUTH_MESSAGE_KEYS)[number];

const AUTH_MESSAGES: Record<AuthMessageKey, string> = {
  loginTitle: "Sign in",
  loginDescription: "Sign in to your NoteGen workspace.",
  emailLabel: "Email",
  emailPlaceholder: "you@example.com",
  passwordLabel: "Password",
  passwordPlaceholder: "Your password",
  signInButton: "Sign in",
  signingInButton: "Signing in...",
  verifyTitle: "Check your authenticator app",
  verifyDescription: "Enter the 6-digit code from your authenticator app to finish signing in.",
  verificationCodeLabel: "Verification code",
  verificationCodePlaceholder: "6-digit code",
  recoveryCodeLabel: "Recovery code",
  recoveryCodePlaceholder: "Enter a recovery code",
  useRecoveryCode: "Use a recovery code instead",
  useVerificationCode: "Use an authenticator code instead",
  verifyButton: "Verify and sign in",
  verifyingButton: "Verifying...",
  backToSignIn: "Back to sign in",
  setupTitle: "Set up the first account",
  setupDescription: "Create the first account for this installation. This page stops working after setup is complete.",
  setupTokenLabel: "Setup token",
  setupTokenPlaceholder: "Setup token from the server operator",
  workspaceNameLabel: "Workspace name",
  workspaceNamePlaceholder: "My workspace",
  confirmPasswordLabel: "Confirm password",
  confirmPasswordPlaceholder: "Repeat your password",
  createAccountButton: "Create account",
  creatingAccountButton: "Creating account...",
  setupSuccessTitle: "Account created",
  setupSuccessDescription: "The first account is ready. Sign in with the email and password you just created.",
  goToSignInButton: "Go to sign in",
  sessionExpiredTitle: "Your session has ended",
  sessionExpiredDescription: "Your session is no longer valid. Sign in again to continue.",
  shellNotice: "Sign-in is not connected yet. This page is a visual shell only and does not sign anyone in.",
  errorInvalidCredentials: "Email or password is incorrect.",
  errorInvalidVerificationCode: "The verification code is incorrect or has expired.",
  errorRateLimited: "Too many attempts. Try again later.",
  errorRateLimitedRetry: "Too many attempts. Try again in about {minutes} minutes.",
  errorSessionExpired: "The session is invalid or has ended. Please sign in again.",
  errorRequestRejected: "The request was rejected.",
  errorInvalidSetupToken: "The setup token is incorrect or setup is no longer available.",
  errorInvalidActionToken: "The link is invalid or has expired.",
  errorNotFound: "The requested item was not found.",
  errorValidationFailed: "Some fields need attention. Check the form and try again.",
  errorNotConnected: "Sign-in is not connected yet. This page is a visual shell only.",
  errorUnexpected: "Something went wrong. Please try again.",
  validationEmailRequired: "Email is required.",
  validationEmailInvalid: "Enter a valid email address.",
  validationPasswordRequired: "Password is required.",
  validationPasswordTooShort: "Password must be at least 12 characters.",
  validationPasswordTooLong: "Password must be at most 128 characters.",
  validationPasswordsDoNotMatch: "Passwords do not match.",
  validationCodeRequired: "Verification code is required.",
  validationCodeInvalid: "Enter the 6-digit code.",
  validationSetupTokenRequired: "Setup token is required.",
  validationRecoveryCodeRequired: "Recovery code is required.",
};

export function authText(key: AuthMessageKey, vars?: Record<string, string | number>): string {
  const template = AUTH_MESSAGES[key];
  if (!vars) return template;
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    template,
  );
}
