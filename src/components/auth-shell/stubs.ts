// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Typed stubs for the auth shell. UI ONLY: every stub throws
// AuthShellNotImplementedError. There is no fetch, no cookie handling,
// no session logic, and no CSRF handling here. Wave 3 auth wiring
// replaces these stubs with real calls to the canonical endpoints in
// fase1/kontrak-api-kanonis.md section 3.12. The stub signatures mirror
// that contract so the replacement is a drop-in change at these call
// sites and nowhere else in the shell components.

export class AuthShellNotImplementedError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string) {
    super(`Auth shell stub is not implemented: ${endpoint}. Wave 3 auth wiring owns this call.`);
    this.name = "AuthShellNotImplementedError";
    this.endpoint = endpoint;
  }
}

export interface LoginIdentityRequest {
  email: string;
  password: string;
}

export interface LoginSuccess {
  id: string;
  email: string;
  role: "user" | "admin";
  totpEnabled: boolean;
  csrfToken: string;
  sessionExpiresAt: string;
}

export type LoginIdentityResult =
  | { outcome: "authenticated"; session: LoginSuccess }
  | { outcome: "totp_required"; challengeToken: string };

export type LoginVerificationRequest =
  | { challengeToken: string; code: string; recoveryCode?: undefined }
  | { challengeToken: string; recoveryCode: string; code?: undefined };

export interface SetupRequest {
  setupToken: string;
  email: string;
  password: string;
  workspaceName?: string;
}

export interface SetupResult {
  id: string;
  email: string;
  workspaceId: string;
}

/** POST /api/auth/login (step 1: identity). Wave 3 wiring owns this call. */
export async function submitLoginIdentity(
  _request: LoginIdentityRequest,
): Promise<LoginIdentityResult> {
  throw new AuthShellNotImplementedError("POST /api/auth/login");
}

/** POST /api/auth/login/totp (step 2: verification). Wave 3 wiring owns this call. */
export async function submitLoginVerification(
  _request: LoginVerificationRequest,
): Promise<LoginSuccess> {
  throw new AuthShellNotImplementedError("POST /api/auth/login/totp");
}

/** POST /api/auth/setup (first account). Wave 3 wiring owns this call. */
export async function submitSetup(_request: SetupRequest): Promise<SetupResult> {
  throw new AuthShellNotImplementedError("POST /api/auth/setup");
}
