// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Database-backed rate limiting and progressive lockout for auth
// (desain-auth.md section 6). Buckets live in Postgres
// (rate_limit_buckets) and survive restarts; keys are HMAC-SHA256
// values, never raw identifiers, so the database and the logs never
// hold an IP or an email in the clear.
//
// Login counting discipline (section 6.3, mechanism A/B): only
// FAILURES are counted, in the login code, not in a generic
// middleware. A check reads the current window; a failure then
// increments it atomically. The read-then-increment pair can race
// under perfectly concurrent failures and admit one or two extra
// attempts; that is accepted (the lockout, mechanism C, is the hard
// backstop) and is why the setup scope, which counts every attempt,
// uses a single atomic increment-and-check instead.
//
// The general API limits (240/min per account, 60/min per IP,
// section 6.5) are exposed here as checkGeneralApiLimit for the
// future global wiring. They are deliberately NOT wired globally by
// this task: a global hook belongs to the integrator once all route
// groups exist, and wiring it now would change the frozen hook order
// in app.ts. Auth-specific limits (login, setup, step-up, password
// change) are wired in the auth handlers themselves.

import type { FastifyReply } from 'fastify';
import { ApiError, errorEnvelope } from '../plugins/envelope.js';
import { rateLimitKey } from '../auth/crypto.js';
import { isUsableAuthSecret } from '../config/env.js';
import type { AuthStore } from '../auth/store.js';
import { unavailableOnDbError } from '../auth/service.js';
import {
  API_GENERAL_ACCOUNT_LIMIT_PER_MINUTE,
  API_GENERAL_IP_LIMIT_PER_MINUTE,
  LOCKOUT_DURATIONS_MS,
  LOCKOUT_FAILURE_THRESHOLD,
  LOGIN_ACCOUNT_IP_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_IP_FAILURE_LIMIT,
  SETUP_IP_LIMIT,
  SETUP_WINDOW_MS,
} from '../auth/values.js';

export const LOGIN_ACCOUNT_IP_SCOPE = 'login:account_ip';
export const LOGIN_IP_SCOPE = 'login:ip';
export const SETUP_IP_SCOPE = 'setup:ip';
export const STEP_UP_ACCOUNT_SCOPE = 'stepup:account';
export const PASSWORD_CHANGE_ACCOUNT_SCOPE = 'password_change:account';
export const API_ACCOUNT_SCOPE = 'api:account';
export const API_IP_SCOPE = 'api:ip';

// Fixed-window start: now rounded down to a multiple of the window
// length (UTC epoch math, no timezone involved).
export function windowStartMs(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

// Whole seconds until the current window ends, rounded up, at least 1.
// This is the Retry-After value for bucket rejections.
export function secondsUntilWindowEnd(nowMs: number, windowMs: number): number {
  const end = windowStartMs(nowMs, windowMs) + windowMs;
  return Math.max(1, Math.ceil((end - nowMs) / 1000));
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

function requireAuthSecret(authSecret: string | undefined): string {
  if (!isUsableAuthSecret(authSecret)) {
    // Bucket keys cannot be keyed without a usable AUTH_SECRET;
    // fail closed rather than keying on a raw identifier or on a
    // weak or placeholder secret (G11a).
    throw ApiError.serviceUnavailable('Authentication is not configured.');
  }
  return authSecret as string;
}

// Reads the failure count for one bucket. Allowed while hits are
// strictly below the limit. Throws when the secret is missing or the
// database fails; callers map those to 503 through
// unavailableOnDbError.
export async function checkFailureBucket(input: {
  store: AuthStore;
  scope: string;
  rawKey: string;
  authSecret: string | undefined;
  limit: number;
  windowMs: number;
  nowMs: number;
}): Promise<RateLimitDecision> {
  const secret = requireAuthSecret(input.authSecret);
  const start = new Date(windowStartMs(input.nowMs, input.windowMs));
  const hits = await unavailableOnDbError(() =>
    input.store.readBucketHits(input.scope, rateLimitKey(input.scope, input.rawKey, secret), start),
  );
  return {
    allowed: hits < input.limit,
    retryAfterSeconds: secondsUntilWindowEnd(input.nowMs, input.windowMs),
  };
}

// Atomically adds one failure to a bucket. Returns the new hit count.
export async function recordFailureBucket(input: {
  store: AuthStore;
  scope: string;
  rawKey: string;
  authSecret: string | undefined;
  windowMs: number;
  nowMs: number;
}): Promise<number> {
  const secret = requireAuthSecret(input.authSecret);
  const startMs = windowStartMs(input.nowMs, input.windowMs);
  return unavailableOnDbError(() =>
    input.store.incrementBucket(
      input.scope,
      rateLimitKey(input.scope, input.rawKey, secret),
      new Date(startMs),
      new Date(startMs + input.windowMs),
    ),
  );
}

// Login bucket pair (section 6.3): 5 failures per 15 minutes per
// (account, IP), 20 failures per 15 minutes per IP across accounts.
// Both must allow; the first failing decision wins.
export async function checkLoginBuckets(input: {
  store: AuthStore;
  email: string;
  ip: string | undefined;
  authSecret: string | undefined;
  nowMs: number;
}): Promise<RateLimitDecision> {
  const ipKey = input.ip ?? 'unknown';
  const accountIp = await checkFailureBucket({
    store: input.store,
    scope: LOGIN_ACCOUNT_IP_SCOPE,
    rawKey: `${input.email}|${ipKey}`,
    authSecret: input.authSecret,
    limit: LOGIN_ACCOUNT_IP_FAILURE_LIMIT,
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    nowMs: input.nowMs,
  });
  if (!accountIp.allowed) {
    return accountIp;
  }
  return checkFailureBucket({
    store: input.store,
    scope: LOGIN_IP_SCOPE,
    rawKey: ipKey,
    authSecret: input.authSecret,
    limit: LOGIN_IP_FAILURE_LIMIT,
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    nowMs: input.nowMs,
  });
}

export async function recordLoginFailureBuckets(input: {
  store: AuthStore;
  email: string;
  ip: string | undefined;
  authSecret: string | undefined;
  nowMs: number;
}): Promise<void> {
  const ipKey = input.ip ?? 'unknown';
  await recordFailureBucket({
    store: input.store,
    scope: LOGIN_ACCOUNT_IP_SCOPE,
    rawKey: `${input.email}|${ipKey}`,
    authSecret: input.authSecret,
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    nowMs: input.nowMs,
  });
  await recordFailureBucket({
    store: input.store,
    scope: LOGIN_IP_SCOPE,
    rawKey: ipKey,
    authSecret: input.authSecret,
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    nowMs: input.nowMs,
  });
}

// Records only the IP-wide failure (used when a login/totp challenge
// is unknown, so no account is identified).
export async function recordLoginIpFailureBucket(input: {
  store: AuthStore;
  ip: string | undefined;
  authSecret: string | undefined;
  nowMs: number;
}): Promise<void> {
  await recordFailureBucket({
    store: input.store,
    scope: LOGIN_IP_SCOPE,
    rawKey: input.ip ?? 'unknown',
    authSecret: input.authSecret,
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    nowMs: input.nowMs,
  });
}

// Setup scope (section 6.4): 5 attempts per hour per IP, counting
// every attempt. One atomic increment decides: the Nth attempt in
// the window is allowed exactly when the new count is within the
// limit, so concurrent attempts cannot overshoot.
export async function checkAndCountSetupAttempt(input: {
  store: AuthStore;
  ip: string | undefined;
  authSecret: string | undefined;
  nowMs: number;
}): Promise<RateLimitDecision> {
  const hits = await recordFailureBucket({
    store: input.store,
    scope: SETUP_IP_SCOPE,
    rawKey: input.ip ?? 'unknown',
    authSecret: input.authSecret,
    windowMs: SETUP_WINDOW_MS,
    nowMs: input.nowMs,
  });
  return {
    allowed: hits <= SETUP_IP_LIMIT,
    retryAfterSeconds: secondsUntilWindowEnd(input.nowMs, SETUP_WINDOW_MS),
  };
}

// Per-account failure buckets for step-up and password change
// (section 6.4): 5 failures per 15 minutes per account. V3-02 wires
// these; the helpers live here so both workers share one counting
// implementation.
export async function checkAccountFailureBucket(input: {
  store: AuthStore;
  scope: string;
  userId: string;
  authSecret: string | undefined;
  limit: number;
  windowMs: number;
  nowMs: number;
}): Promise<RateLimitDecision> {
  return checkFailureBucket({
    store: input.store,
    scope: input.scope,
    rawKey: input.userId,
    authSecret: input.authSecret,
    limit: input.limit,
    windowMs: input.windowMs,
    nowMs: input.nowMs,
  });
}

export async function recordAccountFailureBucket(input: {
  store: AuthStore;
  scope: string;
  userId: string;
  authSecret: string | undefined;
  windowMs: number;
  nowMs: number;
}): Promise<void> {
  await recordFailureBucket({
    store: input.store,
    scope: input.scope,
    rawKey: input.userId,
    authSecret: input.authSecret,
    windowMs: input.windowMs,
    nowMs: input.nowMs,
  });
}

// General API limits (section 6.5), for the future global wiring.
// Account-scoped when a principal exists, IP-scoped otherwise. Not
// wired by this task; see the module header.
export async function checkGeneralApiLimit(input: {
  store: AuthStore;
  userId: string | undefined;
  ip: string | undefined;
  authSecret: string | undefined;
  nowMs: number;
}): Promise<RateLimitDecision> {
  if (input.userId !== undefined) {
    return checkFailureBucket({
      store: input.store,
      scope: API_ACCOUNT_SCOPE,
      rawKey: input.userId,
      authSecret: input.authSecret,
      limit: API_GENERAL_ACCOUNT_LIMIT_PER_MINUTE,
      windowMs: 60 * 1000,
      nowMs: input.nowMs,
    });
  }
  return checkFailureBucket({
    store: input.store,
    scope: API_IP_SCOPE,
    rawKey: input.ip ?? 'unknown',
    authSecret: input.authSecret,
    limit: API_GENERAL_IP_LIMIT_PER_MINUTE,
    windowMs: 60 * 1000,
    nowMs: input.nowMs,
  });
}

// Lockout ladder (section 6.3, mechanism C): level 1 is 15 minutes,
// 2 is 1 hour, 3 is 4 hours, 4 and above cap at 24 hours.
export function lockoutDurationMs(level: number): number {
  const index = Math.min(Math.max(level, 1), LOCKOUT_DURATIONS_MS.length) - 1;
  return LOCKOUT_DURATIONS_MS[index] as number;
}

export interface LockoutState {
  locked: boolean;
  retryAfterSeconds: number;
  // Lockout ladder rung and full ladder duration for the audit
  // event (desain-auth.md section 12.1): 0 when not locked. The
  // duration is the rung duration, not the remaining time; the
  // remaining time stays coarse in retryAfterSeconds.
  lockoutLevel: number;
  lockoutDurationMs: number;
}

// Reads the lockout row. Retry-After is rounded UP to whole minutes
// (desain-auth.md section 3.7): lockout durations are coarse by
// design, and a second-precise value would leak the exact failure
// time. A missing row means never locked.
export async function checkLockout(store: AuthStore, userId: string, nowMs: number): Promise<LockoutState> {
  const row = await unavailableOnDbError(() => store.getLockout(userId));
  if (row === null || row.lockedUntil === null || row.lockedUntil.getTime() <= nowMs) {
    return { locked: false, retryAfterSeconds: 0, lockoutLevel: 0, lockoutDurationMs: 0 };
  }
  const remainingMs = row.lockedUntil.getTime() - nowMs;
  return {
    locked: true,
    retryAfterSeconds: Math.max(60, Math.ceil(remainingMs / 60000) * 60),
    lockoutLevel: row.lockoutLevel,
    lockoutDurationMs: lockoutDurationMs(row.lockoutLevel),
  };
}

// Records one login failure against the progressive lockout. Attempts
// made while already locked are a no-op (an attacker must not be able
// to extend a lockout forever). After a lockout expires, the failure
// count restarts at zero but the level is kept, so the next series
// climbs one rung. A successful login clears the row entirely
// (store.clearLockout). TOTP failures count here too (section 3.1,
// step 3 of the second step).
export async function recordLoginFailureLockout(store: AuthStore, userId: string, now: Date): Promise<void> {
  const nowMs = now.getTime();
  const previous = await unavailableOnDbError(() => store.getLockout(userId));
  if (previous !== null && previous.lockedUntil !== null && previous.lockedUntil.getTime() > nowMs) {
    return;
  }
  const expired = previous !== null && previous.lockedUntil !== null && previous.lockedUntil.getTime() <= nowMs;
  const baseFailures = expired || previous === null ? 0 : previous.consecutiveFailures;
  const level = previous?.lockoutLevel ?? 0;
  const failures = baseFailures + 1;
  if (failures >= LOCKOUT_FAILURE_THRESHOLD) {
    const nextLevel = level + 1;
    await unavailableOnDbError(() =>
      store.recordLockoutFailure(userId, {
        consecutiveFailures: failures,
        lockoutLevel: nextLevel,
        lockedUntil: new Date(nowMs + lockoutDurationMs(nextLevel)),
        lastFailureAt: now,
      }),
    );
    return;
  }
  await unavailableOnDbError(() =>
    store.recordLockoutFailure(userId, {
      consecutiveFailures: failures,
      lockoutLevel: level,
      lockedUntil: null,
      lastFailureAt: now,
    }),
  );
}

// Sends a 429 rate_limited envelope with the Retry-After header.
// Handlers call this directly instead of throwing, because the header
// must travel with the envelope and the global error handler does not
// set it (see ApiError.rateLimited in envelope.ts). No X-RateLimit-*
// headers are sent (section 6.5): the exact threshold is not
// advertised.
export function sendRateLimited(reply: FastifyReply, requestId: string, retryAfterSeconds: number): void {
  reply
    .code(429)
    .header('Retry-After', String(Math.max(1, Math.floor(retryAfterSeconds))))
    .send(errorEnvelope('rate_limited', 'Too many requests.', requestId, { retryable: true }));
}
