// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Password reset logic (kontrak-api-kanonis.md section 3.12;
// desain-auth.md section 3.6; V3-02 part 3). The route handler in
// ../routes/auth-reset.ts owns Origin enforcement (via the frozen
// preHandler), rate-limit buckets, and audit side effects; this
// module owns token minting, token verification, token consumption,
// and the password replacement effects, in the order the L2
// reference harness (test/auth-negative-presession.spec.ts) pins:
//
// 1. Request: look the account up by normalized email. Only when
//    SMTP is configured AND the account exists AND is active, mint
//    a single-use reset token and store its hash, invalidating any
//    prior reset token for the same email in the same transaction.
//    Every other case creates nothing. The wire response is always
//    the same generic 200; that genericity is the route's job.
// 2. Confirm: find the token by its hash, then require purpose
//    reset_password, unexpired, unused, a non-null account id, an
//    existing account whose email matches the token, and an active
//    account. Any failure is one identical 400 invalid_action_token.
//    Only then is the new password shape checked, so a shape
//    failure leaves the token usable. Only then is the token
//    claimed with a conditional update (single-use under races),
//    the password replaced (new hash, epoch bump, all sessions
//    deleted, in one AuthStore transaction), and the caller audits.
//
// The two SMTP branches (desain-auth.md section 3.6):
//
// - Branch A (SMTP configured): the token above is created and, in
//   a full deployment, delivered by email as a link that opens a
//   page which POSTs the confirmation. There is NO email sending
//   in the MVP: no mailer, no SMTP client, and no SMTP
//   configuration exists in ServerConfig. The raw token therefore
//   never leaves this module (it is hashed and dropped inside
//   requestPasswordReset) and is never returned over HTTP or
//   written to any log. The smtpConfigured flag is a deploy-time
//   route dependency, default false; the integrator must wire a
//   mailer before ever enabling it, or minted tokens are created
//   but undeliverable while still invalidating prior tokens.
// - Branch B (SMTP not configured; the default until decided
//   otherwise, assumption A5): reset-request returns the same
//   generic 200 but does nothing observable: no email, no token
//   created, no audit event. Account recovery uses the operator
//   procedure in desain-auth.md section 2.5 (a server-side CLI,
//   not an HTTP endpoint). There is deliberately no
//   operator-visible token delivery over HTTP in this branch.
//
// Constants in this file are V3-02-local because auth/values.ts is
// frozen at the 3B overlap base (its header says reset values
// belong to V3-02); the integrator may relocate them to values.ts
// at merge. The numbers themselves are desain-auth.md section 1.6
// (60 minute token life) and section 6.4 (rate limits), not
// inventions. One gap is recorded, not filled silently: section
// 6.2 names no scope for reset-confirm, so RESET_CONFIRM_IP_SCOPE
// is a V3-02 naming decision documented here and in the worker
// report. Reusing the reset:ip scope would be wrong: the confirm
// bucket has a different limit and window from the request bucket.
//
// The audit event names are desain-auth.md section 12.1. They are
// not members of the frozen AuditEventType union (values.ts), so
// they travel as plain strings here and the route asserts them at
// the AuthStore boundary. The audit_events.event_type column is
// unconstrained text, so the asserted value is stored verbatim.
// The V3-02 values amendment removes the assertion.

import { and, eq, isNull } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { accountActionTokens, type Database } from '../../db/index.js';
import { hashToken, newOpaqueToken } from '../../auth/crypto.js';
import { passwordShapeIssue, type PasswordHasher } from '../../auth/passwords.js';
import { unavailableOnDbError } from '../../auth/service.js';
import type { AuthStore, AuthUserRow } from '../../auth/store.js';
import { validationFailed } from '../../auth/validation.js';

export const RESET_TOKEN_MS = 60 * 60 * 1000;
export const RESET_PURPOSE = 'reset_password';

export const RESET_REQUEST_WINDOW_MS = 60 * 60 * 1000;
export const RESET_REQUEST_IP_LIMIT = 3;
export const RESET_REQUEST_ACCOUNT_LIMIT = 3;
export const RESET_CONFIRM_WINDOW_MS = 15 * 60 * 1000;
export const RESET_CONFIRM_IP_LIMIT = 5;

export const RESET_IP_SCOPE = 'reset:ip';
export const RESET_ACCOUNT_SCOPE = 'reset:account';
export const RESET_CONFIRM_IP_SCOPE = 'reset-confirm:ip';

// L2-pinned wire texts (auth-negative-presession.spec.ts and
// auth-negative.spec.ts reference harnesses). The request text must
// be byte-identical for every email; the confirm text is the
// login-again instruction desain-auth.md section 3.6 requires.
export const RESET_REQUEST_MESSAGE = 'If the email is registered, a reset link has been sent.';
export const RESET_CONFIRM_MESSAGE = 'Password updated. Please log in again.';

// Plain strings on purpose: see the module header on the frozen
// AuditEventType union.
export const PASSWORD_RESET_REQUESTED_EVENT: string = 'password_reset_requested';
export const PASSWORD_RESET_COMPLETED_EVENT: string = 'password_reset_completed';

export type ActionTokenRow = typeof accountActionTokens.$inferSelect;

export interface CreateResetTokenInput {
  userId: string;
  email: string;
  tokenHash: string;
  expiresAt: Date;
}

// Persistence boundary for account_action_tokens. The frozen
// AuthStore at the 3B overlap base has no action-token methods, and
// this task may add files only, so the reset routes depend on this
// narrow interface instead of growing AuthStore. Tests use an
// in-memory fake; production uses DrizzlePasswordResetStore, built
// by the integrator from the database handle at wiring time.
export interface PasswordResetStore {
  // Deletes every prior reset_password row for the email and
  // inserts the new row, in one transaction (desain-auth.md
  // section 1.6: a new reset token invalidates the previous ones).
  // createdByUserId is always null for self-requested resets.
  createResetToken(input: CreateResetTokenInput): Promise<ActionTokenRow>;
  findActionTokenByHash(tokenHash: string): Promise<ActionTokenRow | null>;
  // Marks the token used only when it is still unused. Returns
  // false when the row is missing or already used, so concurrent
  // confirmations cannot both succeed.
  claimActionToken(id: string, usedAt: Date): Promise<boolean>;
}

export class DrizzlePasswordResetStore implements PasswordResetStore {
  constructor(private readonly db: Database) {}

  async createResetToken(input: CreateResetTokenInput): Promise<ActionTokenRow> {
    return this.db.transaction(async (tx) => {
      await tx
        .delete(accountActionTokens)
        .where(
          and(
            eq(accountActionTokens.email, input.email),
            eq(accountActionTokens.purpose, RESET_PURPOSE),
          ),
        );
      const rows = await tx
        .insert(accountActionTokens)
        .values({
          userId: input.userId,
          email: input.email,
          purpose: RESET_PURPOSE,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error('Action token insert returned no row.');
      }
      return row;
    });
  }

  async findActionTokenByHash(tokenHash: string): Promise<ActionTokenRow | null> {
    const rows = await this.db
      .select()
      .from(accountActionTokens)
      .where(eq(accountActionTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  async claimActionToken(id: string, usedAt: Date): Promise<boolean> {
    const rows = await this.db
      .update(accountActionTokens)
      .set({ usedAt })
      .where(and(eq(accountActionTokens.id, id), isNull(accountActionTokens.usedAt)))
      .returning({ id: accountActionTokens.id });
    return rows.length > 0;
  }
}

// The one invalid-action-token error. There is no ApiError factory
// for this code in the frozen envelope module, so it is built
// directly, exactly as the L2 reference harnesses build it. Every
// token failure in this module throws this identical value: unknown,
// expired, used, wrong purpose, missing account, email mismatch,
// and disabled account are indistinguishable on the wire.
export function invalidActionToken(): ApiError {
  return new ApiError(400, 'invalid_action_token', 'The link is not valid or has expired.');
}

// Mints a raw reset token: 32 CSPRNG bytes, base64url (43
// characters), with its SHA-256 hash and a 60 minute expiry. Only
// the hash is ever stored. Callers must never return the raw token
// over HTTP or log it.
export function mintResetToken(nowMs: number): { token: string; tokenHash: string; expiresAt: Date } {
  const token = newOpaqueToken();
  return { token, tokenHash: hashToken(token), expiresAt: new Date(nowMs + RESET_TOKEN_MS) };
}

// Pure token usability: purpose, unused, and unexpired. The expiry
// boundary matches the login challenge rule: a token whose expiry
// equals now is already expired. Account existence, email match,
// and account status need the AuthStore and live in
// validateResetToken, not here.
export function isUsableResetToken(row: ActionTokenRow, nowMs: number): boolean {
  return row.purpose === RESET_PURPOSE && row.usedAt === null && row.expiresAt.getTime() > nowMs;
}

export interface PasswordResetRequestOutcome {
  tokenCreated: boolean;
  userId: string | null;
}

// Request side (desain-auth.md section 3.6). The account lookup
// always runs, so a database outage surfaces as 503 in both SMTP
// branches instead of a misleading generic 200. In the no-SMTP
// branch nothing else happens. In the SMTP branch a token is
// created only for an existing active account; the raw token is
// dropped inside this function (see the module header: no mailer
// exists in the MVP).
export async function requestPasswordReset(input: {
  store: AuthStore;
  resetStore: PasswordResetStore;
  email: string;
  smtpConfigured: boolean;
  nowMs: number;
}): Promise<PasswordResetRequestOutcome> {
  const user = await unavailableOnDbError(() => input.store.findUserByEmail(input.email));
  if (!input.smtpConfigured || user === null || user.status !== 'active') {
    return { tokenCreated: false, userId: null };
  }
  const minted = mintResetToken(input.nowMs);
  await unavailableOnDbError(() =>
    input.resetStore.createResetToken({
      userId: user.id,
      email: user.email,
      tokenHash: minted.tokenHash,
      expiresAt: minted.expiresAt,
    }),
  );
  return { tokenCreated: true, userId: user.id };
}

export interface ValidatedResetToken {
  tokenRow: ActionTokenRow;
  user: AuthUserRow;
}

// Confirm side, step 1: token verification. Every failure throws
// the identical invalid_action_token error, including a token whose
// account was disabled between request and confirm (the account
// must be active at confirm time).
export async function validateResetToken(input: {
  store: AuthStore;
  resetStore: PasswordResetStore;
  token: string;
  nowMs: number;
}): Promise<ValidatedResetToken> {
  const row = await unavailableOnDbError(() => input.resetStore.findActionTokenByHash(hashToken(input.token)));
  if (row === null || !isUsableResetToken(row, input.nowMs) || row.userId === null) {
    throw invalidActionToken();
  }
  const userId = row.userId;
  const user = await unavailableOnDbError(() => input.store.findUserById(userId));
  if (user === null || user.email !== row.email || user.status !== 'active') {
    throw invalidActionToken();
  }
  return { tokenRow: row, user };
}

// Confirm side, step 2: shape check, claim, replace. The shape
// check runs before the claim so a malformed new password leaves
// the token usable (L2 pin). The claim runs before the password
// replacement so a losing race fails without paying Argon2 cost
// and without changing the password. A database failure between
// the claim and the replacement consumes the token without
// changing the password; the account keeps its old password and
// the owner requests a fresh token. No session is created: a
// reset is not a login.
export async function completePasswordReset(input: {
  store: AuthStore;
  resetStore: PasswordResetStore;
  hasher: PasswordHasher;
  tokenRow: ActionTokenRow;
  user: AuthUserRow;
  newPassword: string;
  now: Date;
}): Promise<AuthUserRow> {
  const shapeIssue = passwordShapeIssue(input.newPassword);
  if (shapeIssue !== null) {
    throw validationFailed([{ field: 'newPassword', issue: shapeIssue }]);
  }
  const claimed = await unavailableOnDbError(() => input.resetStore.claimActionToken(input.tokenRow.id, input.now));
  if (!claimed) {
    throw invalidActionToken();
  }
  const passwordHash = await input.hasher.hash(input.newPassword);
  await unavailableOnDbError(() =>
    input.store.replaceUserPassword(input.user.id, { passwordHash, passwordChangedAt: input.now }),
  );
  return input.user;
}
