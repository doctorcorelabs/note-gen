// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
import { Alert, AlertDescription } from "@/components/ui/alert";
import { authText, type AuthMessageKey } from "./messages";

// Display error codes for the auth shell. Most names match the wire
// codes in fase1/kontrak-api-kanonis.md section 3.12; three are
// display-only mappings and never arrive on the wire as named here:
// request_rejected covers both csrf_invalid and origin_rejected
// (one generic text, per desain-auth.md section 3.7), session_expired
// covers unauthenticated, and not_connected/unexpected are shell-only.
// TODO(wave-3-auth-wiring): map each wire error code to one of these
// display codes at the call site. The displayed text is always the
// generic anti-enumeration message from desain-auth.md section 3.7: a
// failed sign-in never says whether the email exists, the password was
// wrong, or the account is disabled.
export type AuthErrorCode =
  | "invalid_credentials"
  | "invalid_verification_code"
  | "rate_limited"
  | "invalid_setup_token"
  | "invalid_action_token"
  | "not_found"
  | "validation_failed"
  | "request_rejected"
  | "session_expired"
  | "not_connected"
  | "unexpected";

const ERROR_MESSAGE_KEYS: Record<AuthErrorCode, AuthMessageKey> = {
  invalid_credentials: "errorInvalidCredentials",
  invalid_verification_code: "errorInvalidVerificationCode",
  rate_limited: "errorRateLimited",
  invalid_setup_token: "errorInvalidSetupToken",
  invalid_action_token: "errorInvalidActionToken",
  not_found: "errorNotFound",
  validation_failed: "errorValidationFailed",
  request_rejected: "errorRequestRejected",
  session_expired: "errorSessionExpired",
  not_connected: "errorNotConnected",
  unexpected: "errorUnexpected",
};

export interface AuthErrorMessageProps {
  code: AuthErrorCode;
  // Whole minutes from the Retry-After header, when wave 3 wiring passes
  // it through. The shell never reads headers itself.
  retryAfterMinutes?: number;
}

export function AuthErrorMessage({ code, retryAfterMinutes }: AuthErrorMessageProps) {
  const text =
    code === "rate_limited" && retryAfterMinutes !== undefined
      ? authText("errorRateLimitedRetry", { minutes: retryAfterMinutes })
      : authText(ERROR_MESSAGE_KEYS[code]);
  return (
    <Alert variant="destructive" role="alert" aria-live="assertive">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}
