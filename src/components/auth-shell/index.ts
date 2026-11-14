// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
export { AuthErrorMessage, type AuthErrorCode, type AuthErrorMessageProps } from "./auth-error-message";
export { AuthShell, type AuthShellProps } from "./auth-shell";
export { LoginForm } from "./login-form";
export { authText, AUTH_MESSAGE_KEYS, type AuthMessageKey } from "./messages";
export { SessionExpiredBanner, SessionExpiredNotice } from "./session-expired-notice";
export { SetupForm } from "./setup-form";
export {
  AuthShellNotImplementedError,
  submitLoginIdentity,
  submitLoginVerification,
  submitSetup,
  type LoginIdentityRequest,
  type LoginIdentityResult,
  type LoginSuccess,
  type LoginVerificationRequest,
  type SetupRequest,
  type SetupResult,
} from "./stubs";
