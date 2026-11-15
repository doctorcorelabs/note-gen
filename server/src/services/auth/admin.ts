// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Admin account service (kontrak-api-kanonis.md section 3.13; V3-02
// part 5; desain-auth.md sections 2.3, 3.3, 3.5, 9.4, 12.1).
//
// What an admin can do here, and nothing more: list account metadata,
// disable an account, restore an account, and revoke one session of
// another account. An admin gets no content-reading exception
// (AD-08): there is no endpoint, flag, or branch in this module that
// reads another account's workspace, and no role change and no
// impersonation endpoint exists in the MVP.
//
// Store boundary. This module depends on the narrow AdminAccountStore
// interface below, not on AuthStore: the frozen AuthStore has no
// list-users or set-status operation, and this overlap task (AD-57)
// must not edit frozen files. The integrator supplies a Drizzle
// adapter for AdminAccountStore at merge time; the adapter contract
// is spelled out on each method, including the single-transaction
// rule for status changes. Until that adapter lands, the routes in
// routes/auth-admin.ts are registered only with an injected store,
// so nothing here can run against an unwired database.
//
// Status semantics (desain-auth.md sections 3.3 and 3.5):
// - A status CHANGE bumps the credential epoch and deletes every
//   session of the account, in one transaction with the audit write.
//   The epoch bump alone kills sessions: the session verifier
//   rejects any row whose epoch no longer matches the account, so
//   even a session row that survived deletion could never be used
//   again. Restore bumps the epoch again, so sessions from before
//   the disable are never resurrected.
// - A repeat of the current status (disabling an already disabled
//   account, restoring an already active one) answers success with
//   no change: no epoch bump, no session deletion, no audit write.
//   That is the contract's "natural idempotence" for these actions
//   (kontrak section 3.13).
// - Disable stamps disabled_at; restore clears disabled_at and the
//   disabled reason. The contract defines no reason body field, so
//   no reason is accepted from the request; the adapter stores a
//   null reason.
//
// Audit event names are the desain-auth.md section 12.1 names
// (account_disabled, account_restored, session_revoked). They are
// declared locally here because the frozen AUDIT_EVENT_TYPES catalog
// in auth/values.ts does not list admin types yet; the integrator
// extends that catalog (or the adapter maps these names) at merge
// time. Audit metadata carries no secret: only the target account
// id and the actor, which the audit row already records.
//
// Anti-enumeration: an unknown account id, a malformed id, and a
// session id owned by a different account all answer the same
// generic 404. A non-admin answers 403 forbidden on every admin
// operation, before any store lookup that could leak existence.

import { ApiError } from '../../plugins/envelope.js';
import type { SessionPrincipal } from '../../middleware/auth-hook.js';
import { unavailableOnDbError, type UserRole } from '../../auth/service.js';

export type AccountStatus = 'active' | 'disabled';

// The ONLY account fields an admin list may expose. This exact key
// set is pinned by the L2 reference harness
// (auth-negative-lifecycle.spec.ts): id, email, role, status. No
// timestamps, no hashes, no TOTP state, no workspace ids.
export interface AccountMetadata {
  id: string;
  email: string;
  role: UserRole;
  status: AccountStatus;
}

export type AdminAuditEventType = 'account_disabled' | 'account_restored' | 'session_revoked';

export interface AdminAuditEventInput {
  userId: string;
  actorUserId: string;
  eventType: AdminAuditEventType;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

export interface AccountStatusRow {
  id: string;
  status: AccountStatus;
  credentialEpoch: number;
}

export interface AccountSessionRow {
  id: string;
  userId: string;
}

export interface SetUserStatusInput {
  userId: string;
  status: AccountStatus;
  now: Date;
  audit: AdminAuditEventInput;
}

export interface SetUserStatusResult {
  status: AccountStatus;
  credentialEpoch: number;
  changed: boolean;
}

// Narrow persistence boundary for admin account operations. The
// Drizzle adapter (integrator-owned) implements each method as
// follows:
// - listUsers: select id, email, role, status from users, ordered by
//   created_at ascending, then id ascending, for a deterministic
//   list. Never select password_hash or any secret column.
// - findUserStatus: select id, status, credential_epoch by id; null
//   when the id is unknown.
// - setUserStatus: in ONE transaction, when the stored status differs
//   from the requested status: update status, disabled_at (now on
//   disable, null on restore), disabled_reason (null), and
//   credential_epoch (+1); delete every session row of the account;
//   insert the audit event. When the stored status already equals
//   the requested status, change nothing and return changed: false
//   with the current epoch. Return null when the id is unknown.
// - findSessionById / deleteSessionById: the sessions table, by
//   primary key; delete returns false when no row existed.
// - insertAdminAuditEvent: one audit_events row. Used only for the
//   session-revoke path, whose audit write is best-effort after the
//   revocation (mirroring the own-session revoke in auth-core.ts);
//   status-change audits travel inside setUserStatus instead.
export interface AdminAccountStore {
  listUsers(): Promise<AccountMetadata[]>;
  findUserStatus(id: string): Promise<AccountStatusRow | null>;
  setUserStatus(input: SetUserStatusInput): Promise<SetUserStatusResult | null>;
  findSessionById(id: string): Promise<AccountSessionRow | null>;
  deleteSessionById(id: string): Promise<boolean>;
  insertAdminAuditEvent(event: AdminAuditEventInput): Promise<void>;
}

export interface AdminRequestFacts {
  ip: string | null;
  userAgent: string | null;
  now: Date;
}

// Map a full user row to the admin-visible metadata shape. Role and
// status values outside the database CHECK constraints mean
// corrupted data: fail closed with a generic 500 rather than
// inventing a value (mirrors assertRole in auth/service.ts).
export function toAccountMetadata(row: {
  id: string;
  email: string;
  role: string;
  status: string;
}): AccountMetadata {
  if (row.role !== 'user' && row.role !== 'admin') {
    throw ApiError.internalError();
  }
  if (row.status !== 'active' && row.status !== 'disabled') {
    throw ApiError.internalError();
  }
  return { id: row.id, email: row.email, role: row.role, status: row.status };
}

function requireAdminPrincipal(principal: SessionPrincipal | undefined): SessionPrincipal {
  if (principal === undefined) {
    throw ApiError.unauthenticated();
  }
  if (principal.role !== 'admin') {
    throw ApiError.forbidden();
  }
  return principal;
}

export async function listAccounts(
  store: AdminAccountStore,
  principal: SessionPrincipal | undefined,
): Promise<AccountMetadata[]> {
  requireAdminPrincipal(principal);
  return unavailableOnDbError(() => store.listUsers());
}

async function changeAccountStatus(
  store: AdminAccountStore,
  principal: SessionPrincipal | undefined,
  targetId: string,
  status: AccountStatus,
  facts: AdminRequestFacts,
): Promise<SetUserStatusResult> {
  const actor = requireAdminPrincipal(principal);
  const result = await unavailableOnDbError(() =>
    store.setUserStatus({
      userId: targetId,
      status,
      now: facts.now,
      audit: {
        userId: targetId,
        actorUserId: actor.userId,
        eventType: status === 'disabled' ? 'account_disabled' : 'account_restored',
        ip: facts.ip,
        userAgent: facts.userAgent,
        metadata: {},
      },
    }),
  );
  if (result === null) {
    throw ApiError.notFound();
  }
  return result;
}

export async function disableAccount(
  store: AdminAccountStore,
  principal: SessionPrincipal | undefined,
  targetId: string,
  facts: AdminRequestFacts,
): Promise<SetUserStatusResult> {
  return changeAccountStatus(store, principal, targetId, 'disabled', facts);
}

export async function restoreAccount(
  store: AdminAccountStore,
  principal: SessionPrincipal | undefined,
  targetId: string,
  facts: AdminRequestFacts,
): Promise<SetUserStatusResult> {
  return changeAccountStatus(store, principal, targetId, 'active', facts);
}

// Revoke one session of another account. A missing session id, a
// session owned by a different account, and an unknown account id
// all answer the same generic 404. Revoking a session of the
// admin's own account through this route is allowed: it is the same
// revocation the admin could perform on the own-session route, and
// the audit row records the actor either way.
export async function revokeAccountSession(
  store: AdminAccountStore,
  principal: SessionPrincipal | undefined,
  targetId: string,
  sessionId: string,
  facts: AdminRequestFacts,
): Promise<void> {
  const actor = requireAdminPrincipal(principal);
  const target = await unavailableOnDbError(() => store.findUserStatus(targetId));
  if (target === null) {
    throw ApiError.notFound();
  }
  const session = await unavailableOnDbError(() => store.findSessionById(sessionId));
  if (session === null || session.userId !== targetId) {
    throw ApiError.notFound();
  }
  const deleted = await unavailableOnDbError(() => store.deleteSessionById(sessionId));
  if (!deleted) {
    // Lost a race with another revocation: the session is gone, so
    // the repeat answers 404 like the contract's own-session rule.
    throw ApiError.notFound();
  }
  // Best-effort audit: a failed audit write must not undo a
  // revocation that already happened (mirrors recordAudit in
  // auth/service.ts).
  try {
    await store.insertAdminAuditEvent({
      userId: targetId,
      actorUserId: actor.userId,
      eventType: 'session_revoked',
      ip: facts.ip,
      userAgent: facts.userAgent,
      metadata: { revokedSessionId: sessionId },
    });
  } catch {
    // The revocation stands; the route logs the audit failure.
  }
}
