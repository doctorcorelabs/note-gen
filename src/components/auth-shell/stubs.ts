// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Typed stubs for the auth shell. UI ONLY: every stub throws
// AuthShellNotImplementedError. There is no fetch, no cookie handling,
// no session logic, and no CSRF handling here.
// TODO(wave-3-auth-wiring): replace each stub below with a real call to
// its canonical endpoint in fase1/kontrak-api-kanonis.md section 3.12.
// The stub signatures mirror that contract so the replacement is a
// drop-in change at these call sites and nowhere else in the shell
// components. The local `outcome` discriminant maps from the wire
// response: HTTP 200 means "authenticated", HTTP 202 with
// step "totp" means "totp_required" (kontrak-api-kanonis.md 3.12).

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

/** TODO(wave-3-auth-wiring): POST /api/auth/login (step 1: identity). Replace this stub with the real call. */
export async function submitLoginIdentity(
  _request: LoginIdentityRequest,
): Promise<LoginIdentityResult> {
  throw new AuthShellNotImplementedError("POST /api/auth/login");
}

/** TODO(wave-3-auth-wiring): POST /api/auth/login/totp (step 2: verification). Replace this stub with the real call. */
export async function submitLoginVerification(
  _request: LoginVerificationRequest,
): Promise<LoginSuccess> {
  throw new AuthShellNotImplementedError("POST /api/auth/login/totp");
}

/** TODO(wave-3-auth-wiring): POST /api/auth/setup (first account). Replace this stub with the real call. */
export async function submitSetup(_request: SetupRequest): Promise<SetupResult> {
  throw new AuthShellNotImplementedError("POST /api/auth/setup");
}
