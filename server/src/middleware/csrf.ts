// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// CSRF verification: the VerifyCsrfTokenFn implementation that
// buildApp injects into the frozen auth hook (middleware/auth-hook.ts,
// AD-40). The header value (X-CSRF-Token) is hashed with SHA-256 and
// compared in constant time against the csrf_token_hash stored on
// the session row (desain-auth.md section 5.2). A missing header, an
// unknown session row, an ownership mismatch, an epoch mismatch, or
// a database failure all answer false: the hook turns false into the
// generic 403 csrf_invalid, and the session check that ran first
// already separates "cannot verify" (503) from "invalid token".
//
// The raw token is derived deterministically from the session hash
// and AUTH_SECRET (see crypto.ts: a random token could not be
// recovered from its stored hash for GET /api/auth/csrf without
// mutating state in a GET). csrfTokenForSession is the single place
// that derivation is exposed to handlers; it returns null when no
// usable secret is configured (missing, short, or placeholder),
// and handlers fail closed with 503.

import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/context.js';
import { deriveCsrfToken, hashToken, safeEqual } from '../auth/crypto.js';
import { isUsableAuthSecret } from '../config/env.js';
import { readCsrfTokenHeader, type SessionPrincipal, type VerifyCsrfTokenFn } from './auth-hook.js';

export function createCsrfVerifier(context: AuthContext): VerifyCsrfTokenFn {
  return async (request: FastifyRequest, principal: SessionPrincipal): Promise<boolean> => {
    const token = readCsrfTokenHeader(request);
    if (token === undefined) {
      return false;
    }
    const store = context.store;
    if (store === null) {
      return false;
    }
    let row;
    try {
      row = await store.findSessionById(principal.sessionId);
    } catch {
      return false;
    }
    if (row === null || row.userId !== principal.userId) {
      return false;
    }
    if (principal.credentialEpoch !== undefined && row.credentialEpoch !== principal.credentialEpoch) {
      return false;
    }
    return safeEqual(hashToken(token), row.csrfTokenHash);
  };
}

export function csrfTokenForSession(sessionHash: string, authSecret: string | undefined): string | null {
  if (!isUsableAuthSecret(authSecret)) {
    return null;
  }
  return deriveCsrfToken(sessionHash, authSecret as string);
}
