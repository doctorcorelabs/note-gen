// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Session verification: the VerifySessionFn implementation that
// buildApp injects into the frozen auth hook (middleware/auth-hook.ts,
// AD-40). It performs exactly the checks of desain-auth.md section
// 3.2, in order: cookie present, session row found by hash, owning
// account active, credential epoch matching, absolute expiry, idle
// expiry. Every rejection answers with the same generic 401; the
// verifier returns null for all of them and never distinguishes the
// reason to the client.
//
// Two failure modes are NOT null: a missing store or a database error
// throws 503 service_unavailable, because "cannot verify" is not
// "invalid session" and must not be reported as an expired login.
// Only a missing cookie skips the database entirely and returns null
// at once. Expired, revoked, and epoch-mismatched rows are deleted
// opportunistically (best effort: a failed cleanup never changes the
// 401 outcome).
//
// last_seen_at is updated with a 15-minute throttle so frequent reads
// do not write on every request; the throttle never extends the
// absolute expiry.

import type { FastifyRequest } from 'fastify';
import { ApiError } from '../plugins/envelope.js';
import type { AuthContext } from '../auth/context.js';
import { clientIp, hashToken } from '../auth/crypto.js';
import { unavailableOnDbError } from '../auth/service.js';
import type { AuthSessionRow, AuthUserRow } from '../auth/store.js';
import { LAST_SEEN_THROTTLE_MS, SESSION_IDLE_MS } from '../auth/values.js';
import type { SessionPrincipal, VerifySessionFn } from './auth-hook.js';

export function createSessionVerifier(context: AuthContext): VerifySessionFn {
  return async ({ request, sessionId }): Promise<SessionPrincipal | null> => {
    if (sessionId === undefined || sessionId === '') {
      return null;
    }
    const store = context.store;
    if (store === null) {
      throw ApiError.serviceUnavailable('The database is not available.');
    }
    const row = await unavailableOnDbError(() => store.findSessionByHash(hashToken(sessionId)));
    if (row === null) {
      return null;
    }
    const nowMs = context.clock();
    const cleanup = async (): Promise<void> => {
      try {
        await store.deleteSessionById(row.id);
      } catch {
        // Cleanup failure never changes the rejection.
      }
    };
    const user = await unavailableOnDbError(() => store.findUserById(row.userId));
    if (user === null || user.status !== 'active') {
      await cleanup();
      return null;
    }
    if (row.credentialEpoch !== user.credentialEpoch) {
      await cleanup();
      return null;
    }
    if (nowMs > row.absoluteExpiresAt.getTime()) {
      await cleanup();
      return null;
    }
    if (nowMs - row.lastSeenAt.getTime() > SESSION_IDLE_MS) {
      await cleanup();
      return null;
    }
    if (user.role !== 'user' && user.role !== 'admin') {
      await cleanup();
      return null;
    }
    if (nowMs - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      try {
        await store.updateSessionLastSeen(row.id, {
          lastSeenAt: new Date(nowMs),
          lastSeenIp: clientIp(request, context.trustProxy) ?? row.lastSeenIp,
        });
      } catch {
        // A stale last_seen_at must not fail authentication.
      }
    }
    return {
      userId: user.id,
      role: user.role,
      sessionId: row.id,
      credentialEpoch: user.credentialEpoch,
    };
  };
}

export interface LoadedSession {
  row: AuthSessionRow;
  user: AuthUserRow;
}

// Re-loads the session row and its owner for handlers that need more
// than the principal (me, csrf, sessions, logout-all). The global
// hook already validated this session moments earlier, so a null
// result here means only a race (the row was revoked between the hook
// and the handler); handlers answer 401 in that case. Throws 503
// when the store is missing or the database fails, like the
// verifier. The caller passes the request only for symmetry with the
// hook; no request field is read.
export async function loadSessionAndUser(
  context: AuthContext,
  _request: FastifyRequest,
  principal: SessionPrincipal,
): Promise<LoadedSession | null> {
  void _request;
  const store = context.store;
  if (store === null) {
    throw ApiError.serviceUnavailable('The database is not available.');
  }
  const row = await unavailableOnDbError(() => store.findSessionById(principal.sessionId));
  if (row === null || row.userId !== principal.userId) {
    return null;
  }
  const user = await unavailableOnDbError(() => store.findUserById(row.userId));
  if (user === null || user.status !== 'active' || row.credentialEpoch !== user.credentialEpoch) {
    return null;
  }
  return { row, user };
}
