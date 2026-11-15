// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Password change logic (kontrak-api-kanonis.md section 3.12;
// desain-auth.md section 3.5; V3-02 part 2). The route handler in
// ../routes/auth-password.ts owns body validation, session loading,
// and the per-account failure bucket; this module owns the credential
// decision and its effects, in the order the L2 reference harness
// (test/auth-negative-lifecycle.spec.ts) pins:
//
// 1. Verify currentPassword against the stored hash with the
//    context hasher (Argon2id in production). A mismatch yields
//    invalid_current; the caller records the failure bucket entry
//    and the password_change_failed audit event and answers the
//    generic 401. No other check runs first, so a wrong current
//    password always wins over a malformed new password.
// 2. Validate the new password shape (12-128 code points, no NUL)
//    with passwordShapeIssue, then verify the new password against
//    the OLD hash: a match means the new password equals the old
//    one and yields invalid_new. The sameness check uses the hash,
//    never a stored plaintext (none exists).
// 3. Hash the new password, replace it through the store
//    (replaceUserPassword: new hash, passwordChangedAt = now,
//    credential epoch +1, ALL sessions of the account deleted, in
//    one transaction), then mint a fresh session for the requester
//    with a fresh absolute expiry, exactly as a login would: a
//    password change is a fully re-authenticated login equivalent
//    (desain-auth.md section 3.5 step 4), not a rotation that
//    preserves the old absolute expiry. The new session carries the
//    bumped epoch, so the epoch check in the session verifier
//    accepts it while every other device must log in again.
//
// The current password IS the step-up for this action
// (desain-auth.md section 3.5: "ganti password (password lama
// adalah step-up-nya)"), so this module never consults stepUpAt
// and the route never answers step_up_required. A session fresh
// from login (stepUpAt null) may change its password.
//
// This module throws only ApiError values that already carry the
// right wire meaning (503 from unavailableOnDbError when the
// database fails, 503 when AUTH_SECRET is missing so no session
// can be minted). Credential outcomes travel as the result union,
// so the caller decides the audit and rate-limit side effects.

import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../../auth/context.js';
import { passwordShapeIssue } from '../../auth/passwords.js';
import {
  createSessionForLogin,
  unavailableOnDbError,
  type CreatedSession,
} from '../../auth/service.js';
import type { AuthStore, AuthUserRow } from '../../auth/store.js';

export interface PasswordChangeInput {
  user: AuthUserRow;
  currentPassword: string;
  newPassword: string;
  request: FastifyRequest;
  now: Date;
}

export type PasswordChangeResult =
  | { outcome: 'changed'; created: CreatedSession; credentialEpoch: number }
  | { outcome: 'invalid_current' }
  | { outcome: 'invalid_new'; issue: string };

export async function changePassword(
  auth: AuthContext,
  store: AuthStore,
  input: PasswordChangeInput,
): Promise<PasswordChangeResult> {
  const currentOk = await auth.hasher.verify(input.user.passwordHash, input.currentPassword);
  if (!currentOk) {
    return { outcome: 'invalid_current' };
  }
  const shapeIssue = passwordShapeIssue(input.newPassword);
  if (shapeIssue !== null) {
    return { outcome: 'invalid_new', issue: shapeIssue };
  }
  const sameAsOld = await auth.hasher.verify(input.user.passwordHash, input.newPassword);
  if (sameAsOld) {
    return { outcome: 'invalid_new', issue: 'new password must be different from the current password' };
  }
  const newHash = await auth.hasher.hash(input.newPassword);
  const credentialEpoch = await unavailableOnDbError(() =>
    store.replaceUserPassword(input.user.id, { passwordHash: newHash, passwordChangedAt: input.now }),
  );
  const created = await createSessionForLogin(
    auth,
    store,
    { ...input.user, credentialEpoch },
    input.request,
    input.now,
  );
  return { outcome: 'changed', created, credentialEpoch };
}
