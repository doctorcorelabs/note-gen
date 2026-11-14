// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Shared auth service mechanics: session creation and rotation, the
// wire shapes for login success, session lists, and /api/auth/me,
// step-up freshness, and the database-error mapping shared by every
// auth handler. Route handlers stay thin: they validate, call the
// store through these helpers, and shape the envelope. V3-02 reuses
// the rotation helper for step-up and password change, so rotation
// semantics (desain-auth.md section 3.3) live in exactly one place.
//
// Wire time format for the auth group: ISO 8601 UTC strings. The
// contract (section 1.4, K-08) leaves the format per group and no
// upstream auth type constrains this new server code; the K3 auth
// shell stubs already type sessionExpiresAt as a string, and ISO
// strings keep the boot guard and the login UI free of epoch math.

import type { FastifyRequest } from 'fastify';
import { ApiError } from '../plugins/envelope.js';
import type { AuthContext } from './context.js';
import {
  clientIp,
  deriveCsrfToken,
  deviceLabelFromUserAgent,
  hashToken,
  newOpaqueToken,
  truncateUserAgent,
} from './crypto.js';
import type { AuthSessionRow, AuthStore, AuthUserRow } from './store.js';
import type { AuditEventInput } from './store.js';
import { SESSION_ABSOLUTE_MS, STEP_UP_WINDOW_MS } from './values.js';

// Database failures inside auth handlers answer 503 service_unavailable
// (retryable), not the generic 500 the global handler would produce
// for an unexpected throw: the database is a declared dependency and
// its outage is temporary by nature. ApiError values pass through
// untouched, so deliberate 400/401/403/404 outcomes are never masked.
export async function unavailableOnDbError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw ApiError.serviceUnavailable('The database is not available.');
  }
}

export type UserRole = 'user' | 'admin';

// The role column carries a database check constraint, so any other
// value means corrupted data: fail closed with a generic 500 rather
// than inventing a role.
export function assertRole(role: string): UserRole {
  if (role === 'user' || role === 'admin') {
    return role;
  }
  throw ApiError.internalError();
}

export interface LoginSuccessData {
  id: string;
  email: string;
  role: UserRole;
  totpEnabled: boolean;
  csrfToken: string;
  sessionExpiresAt: string;
}

export interface SessionListEntry {
  id: string;
  deviceLabel: string;
  userAgent: string | null;
  createdIp: string | null;
  lastSeenIp: string | null;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  isCurrent: boolean;
}

export function toSessionListEntry(row: AuthSessionRow, currentSessionId: string): SessionListEntry {
  return {
    id: row.id,
    deviceLabel: row.deviceLabel ?? 'Unknown device',
    userAgent: row.userAgent,
    createdIp: row.createdIp,
    lastSeenIp: row.lastSeenIp,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
    isCurrent: row.id === currentSessionId,
  };
}

export interface MeData {
  id: string;
  email: string;
  role: UserRole;
  totpEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  workspaceId: string | null;
  session: {
    id: string;
    deviceLabel: string;
    createdAt: string;
    lastSeenAt: string;
    absoluteExpiresAt: string;
    stepUpAt: string | null;
  };
}

// A step-up is fresh when the session recorded one within the last 15
// minutes (desain-auth.md section 3.5). Null means the session never
// stepped up. The boundary is inclusive: exactly 15 minutes still
// counts, so a client racing the clock is not punished for a
// millisecond.
export function isStepUpFresh(stepUpAt: Date | null, nowMs: number): boolean {
  if (stepUpAt === null) {
    return false;
  }
  return nowMs - stepUpAt.getTime() <= STEP_UP_WINDOW_MS;
}

// Cookie Max-Age in whole seconds for a session row: the remaining
// lifetime until its absolute expiry, never negative. Login creates a
// fresh session (full 30 days); rotation preserves the old absolute
// expiry, so a rotated cookie must not outlive it.
export function sessionCookieMaxAgeSeconds(absoluteExpiresAt: Date, nowMs: number): number {
  return Math.max(0, Math.floor((absoluteExpiresAt.getTime() - nowMs) / 1000));
}

export interface CreatedSession {
  sessionId: string;
  csrfToken: string;
  row: AuthSessionRow;
}

function newSessionSecrets(
  authSecret: string | undefined,
): { sessionId: string; sessionHash: string; csrfToken: string; csrfTokenHash: string } {
  if (authSecret === undefined || authSecret === '') {
    // CSRF tokens are derived from AUTH_SECRET (see crypto.ts). Without
    // it no session can be created honestly, so fail closed.
    throw ApiError.serviceUnavailable('Authentication is not configured.');
  }
  const sessionId = newOpaqueToken();
  const sessionHash = hashToken(sessionId);
  const csrfToken = deriveCsrfToken(sessionHash, authSecret);
  return { sessionId, sessionHash, csrfToken, csrfTokenHash: hashToken(csrfToken) };
}

interface SessionRequestFacts {
  deviceLabel: string;
  userAgent: string | null;
  ip: string | null;
}

function requestFacts(request: FastifyRequest, trustProxy: boolean): SessionRequestFacts {
  const userAgent = request.headers['user-agent'];
  return {
    deviceLabel: deviceLabelFromUserAgent(typeof userAgent === 'string' ? userAgent : undefined),
    userAgent: truncateUserAgent(typeof userAgent === 'string' ? userAgent : undefined),
    ip: clientIp(request, trustProxy) ?? null,
  };
}

// Creates a brand-new session for a fully authenticated login
// (desain-auth.md section 3.3): fresh session id, fresh CSRF token,
// absolute expiry 30 days from now, step-up unset. The caller sets
// the cookie and returns the CSRF token; this helper never touches
// the reply, so unit tests exercise it without Fastify.
export async function createSessionForLogin(
  context: AuthContext,
  store: AuthStore,
  user: AuthUserRow,
  request: FastifyRequest,
  now: Date,
): Promise<CreatedSession> {
  const secrets = newSessionSecrets(context.authSecret);
  const facts = requestFacts(request, context.trustProxy);
  const row = await unavailableOnDbError(() =>
    store.createSession({
      userId: user.id,
      sessionHash: secrets.sessionHash,
      csrfTokenHash: secrets.csrfTokenHash,
      credentialEpoch: user.credentialEpoch,
      deviceLabel: facts.deviceLabel,
      userAgent: facts.userAgent,
      createdIp: facts.ip,
      lastSeenIp: facts.ip,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
      stepUpAt: null,
    }),
  );
  return { sessionId: secrets.sessionId, csrfToken: secrets.csrfToken, row };
}

// Rotates a session (desain-auth.md section 3.3): the old row dies in
// the same transaction that creates the new one, with no grace
// period. Rotation PRESERVES the old absolute expiry and creation
// time: rotation is not a lifetime extension. The caller supplies
// the new stepUpAt (now for a step-up rotation, the old value when
// rotation is not a step-up). Owned by the auth core; V3-02 calls
// this from step-up and password change.
export async function rotateSessionForRow(
  context: AuthContext,
  store: AuthStore,
  oldRow: AuthSessionRow,
  request: FastifyRequest,
  now: Date,
  stepUpAt: Date | null,
): Promise<CreatedSession> {
  const secrets = newSessionSecrets(context.authSecret);
  const facts = requestFacts(request, context.trustProxy);
  const row = await unavailableOnDbError(() =>
    store.rotateSession(oldRow.id, {
      userId: oldRow.userId,
      sessionHash: secrets.sessionHash,
      csrfTokenHash: secrets.csrfTokenHash,
      credentialEpoch: oldRow.credentialEpoch,
      deviceLabel: facts.deviceLabel,
      userAgent: facts.userAgent,
      createdIp: oldRow.createdIp,
      lastSeenIp: facts.ip,
      createdAt: oldRow.createdAt,
      lastSeenAt: now,
      absoluteExpiresAt: oldRow.absoluteExpiresAt,
      stepUpAt,
    }),
  );
  return { sessionId: secrets.sessionId, csrfToken: secrets.csrfToken, row };
}

// Best-effort audit write for handlers. Audit failures must never undo
// a security effect that already happened (a logout that revoked the
// session stays revoked) and must never leak: the failure callback
// receives no values, only the knowledge that a write failed. The one
// exception is first-account setup, whose audit write is inside the
// setup transaction in the store, so a failed audit there fails the
// setup (desain-auth.md section 1.6 discipline, honored in store.ts).
export async function recordAudit(
  store: AuthStore,
  event: AuditEventInput,
  onError?: () => void,
): Promise<void> {
  try {
    await store.insertAuditEvent(event);
  } catch {
    onError?.();
  }
}
