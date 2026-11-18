// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Auth value constants (Fase 1, V3-01b). Single source for the numeric
// security values from desain-auth.md section 8.2 (F1-06) and section 6
// (rate limits). These are code constants, not environment variables:
// changing a value that weakens security requires a recorded amendment
// (desain-auth.md section 8.2). The worker heartbeat values are recorded
// here for the runbook; the heartbeat itself belongs to the worker owner
// (V3-39 / T16), not to auth.

export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
export const LAST_SEEN_THROTTLE_MS = 15 * 60 * 1000;
export const STEP_UP_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_CHALLENGE_MS = 5 * 60 * 1000;
export const LOGIN_CHALLENGE_MAX_ATTEMPTS = 5;

export const TOTP_STEP_SECONDS = 30;
export const TOTP_WINDOW_STEPS = 1;
export const TOTP_DIGITS = 6;

export const WORKER_HEARTBEAT_INTERVAL_MS = 60 * 1000;
export const WORKER_STALE_MS = 5 * 60 * 1000;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const ARGON2_MEMORY_COST_KIB = 19456;
export const ARGON2_TIME_COST = 2;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_HASH_LENGTH = 32;
export const ARGON2_SALT_LENGTH = 16;

export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_ACCOUNT_IP_FAILURE_LIMIT = 5;
export const LOGIN_IP_FAILURE_LIMIT = 20;
export const LOCKOUT_FAILURE_THRESHOLD = 5;
export const LOCKOUT_DURATIONS_MS = [
  15 * 60 * 1000,
  60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
] as const;

export const SETUP_WINDOW_MS = 60 * 60 * 1000;
export const SETUP_IP_LIMIT = 5;
export const STEP_UP_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const STEP_UP_FAILURE_LIMIT = 5;
export const PASSWORD_CHANGE_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const PASSWORD_CHANGE_FAILURE_LIMIT = 5;
export const TOTP_PROOF_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const TOTP_PROOF_FAILURE_LIMIT = 5;

export const API_GENERAL_ACCOUNT_LIMIT_PER_MINUTE = 240;
export const API_GENERAL_IP_LIMIT_PER_MINUTE = 60;
export const API_UPLOAD_LIMIT_PER_MINUTE = 20;
export const API_EXPORT_LIMIT_PER_10_MINUTES = 5;

// Audit event types written by the auth core (desain-auth.md section
// 12.1). TOTP enrollment, reset, and admin event types belong to V3-02
// and are not listed here.
export const AUDIT_EVENT_TYPES = {
  installationCompleted: 'installation_completed',
  installationFailed: 'installation_failed',
  loginSucceeded: 'login_succeeded',
  loginFailed: 'login_failed',
  loginLocked: 'login_locked',
  logout: 'logout',
  logoutAll: 'logout_all',
  sessionRevoked: 'session_revoked',
  passwordChanged: 'password_changed',
  passwordChangeFailed: 'password_change_failed',
  recoveryCodeUsed: 'recovery_code_used',
  stepUpSucceeded: 'step_up_succeeded',
  stepUpFailed: 'step_up_failed',
} as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[keyof typeof AUDIT_EVENT_TYPES];
