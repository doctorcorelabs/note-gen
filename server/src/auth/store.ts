// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Auth persistence boundary. Handlers and verifiers depend on the
// AuthStore interface only, so unit tests run against an in-memory
// fake and the live server runs against DrizzleAuthStore. All table
// access goes through the canonical M8 definitions in
// ../db/schema/ (swap D-M8 applied at the V3-01b merge; the local
// mirror ./tables.ts was deleted). No raw SQL reaches
// the client (AD-26); the only sql fragments here are expression
// indexes and atomic increments inside the server.
//
// Transaction discipline (desain-auth.md): credential-changing
// operations that must be atomic (first-account setup, password
// change, session rotation, logout-all) run inside a single
// db.transaction. Audit writes for those operations are part of
// the same transaction, so a failed audit write fails the action.

import { createHash } from 'node:crypto';
import { and, count, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { INSTALLATION_LOCK_NAME } from './crypto.js';
import {
  accountLockouts,
  auditEvents,
  installationState,
  loginChallenges,
  rateLimitBuckets,
  recoveryCodes,
  sessions,
  totpCredentials,
  users,
  workspaceMembers,
  workspaces,
} from '../db/index.js';
import type { AuditEventType } from './values.js';

// Row types used by the AuthStore interface, defined from the canonical
// M8 schema (swap D-M8). Handlers and middleware import every store type
// from this module.
export type AccountLockoutRow = typeof accountLockouts.$inferSelect;
export type AuthSessionRow = typeof sessions.$inferSelect;
export type AuthUserRow = typeof users.$inferSelect;
export type AuthWorkspaceRow = typeof workspaces.$inferSelect;
export type LoginChallengeRow = typeof loginChallenges.$inferSelect;
export type RecoveryCodeRow = typeof recoveryCodes.$inferSelect;
export type TotpCredentialRow = typeof totpCredentials.$inferSelect;

export class InstallationAlreadyCompletedError extends Error {
  constructor() {
    super('Installation has already completed.');
    this.name = 'InstallationAlreadyCompletedError';
  }
}

export interface CreateSessionInput {
  userId: string;
  sessionHash: string;
  csrfTokenHash: string;
  credentialEpoch: number;
  // Canonical sessions.device_label is NOT NULL (swap D-M8); the service
  // always supplies a label via deviceLabelFromUserAgent.
  deviceLabel: string;
  userAgent: string | null;
  createdIp: string | null;
  lastSeenIp: string | null;
  createdAt: Date;
  // Optional: when absent the database default applies. The service
  // always passes it so session timestamps follow the application
  // clock (and the controllable test clock), not the database clock.
  lastSeenAt?: Date;
  absoluteExpiresAt: Date;
  stepUpAt: Date | null;
}

export interface CreateLoginChallengeInput {
  userId: string;
  challengeHash: string;
  createdIp: string | null;
  userAgentHash: string | null;
  expiresAt: Date;
}

export interface AuditEventInput {
  userId: string | null;
  actorUserId: string | null;
  eventType: AuditEventType;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

export interface LockoutFailureInput {
  consecutiveFailures: number;
  lockoutLevel: number;
  lockedUntil: Date | null;
  lastFailureAt: Date;
}

export interface AuthStore {
  getUserCount(): Promise<number>;
  isInstallationCompleted(): Promise<boolean>;
  createFirstAccount(input: { email: string; passwordHash: string; workspaceName: string; now: Date; ip: string | null; userAgent: string | null }): Promise<{ userId: string; workspaceId: string }>;

  findUserByEmail(email: string): Promise<AuthUserRow | null>;
  findUserById(id: string): Promise<AuthUserRow | null>;
  updateUserPasswordHash(userId: string, passwordHash: string): Promise<void>;
  updateUserLastLogin(userId: string, at: Date): Promise<void>;
  replaceUserPassword(userId: string, input: { passwordHash: string; passwordChangedAt: Date }): Promise<number>;
  // When an audit event is supplied it is written inside the same
  // transaction, so a failed audit write fails the revocation
  // (desain-auth.md transaction discipline for credential-changing
  // operations). Callers that have no audit event pass nothing.
  bumpEpochAndRevokeAllSessions(userId: string, audit?: AuditEventInput): Promise<number>;

  createSession(input: CreateSessionInput): Promise<AuthSessionRow>;
  findSessionByHash(sessionHash: string): Promise<AuthSessionRow | null>;
  findSessionById(id: string): Promise<AuthSessionRow | null>;
  listSessionsByUser(userId: string): Promise<AuthSessionRow[]>;
  deleteSessionById(id: string): Promise<boolean>;
  deleteSessionsByUser(userId: string): Promise<number>;
  updateSessionLastSeen(id: string, input: { lastSeenAt: Date; lastSeenIp: string | null }): Promise<void>;
  rotateSession(oldId: string, input: CreateSessionInput): Promise<AuthSessionRow>;

  createLoginChallenge(input: CreateLoginChallengeInput): Promise<LoginChallengeRow>;
  findChallengeByHash(challengeHash: string): Promise<LoginChallengeRow | null>;
  deleteChallengeById(id: string): Promise<void>;
  incrementChallengeAttempts(id: string): Promise<number>;

  findTotpCredential(userId: string): Promise<TotpCredentialRow | null>;
  claimTotpStep(userId: string, step: number, verifiedAt: Date): Promise<boolean>;
  findUnusedRecoveryCode(userId: string, codeHash: string): Promise<RecoveryCodeRow | null>;
  markRecoveryCodeUsed(id: string, usedAt: Date): Promise<boolean>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;

  getLockout(userId: string): Promise<AccountLockoutRow | null>;
  recordLockoutFailure(userId: string, input: LockoutFailureInput): Promise<void>;
  clearLockout(userId: string): Promise<void>;

  readBucketHits(scope: string, rateKey: string, windowStart: Date): Promise<number>;
  incrementBucket(scope: string, rateKey: string, windowStart: Date, expiresAt: Date): Promise<number>;

  findFirstWorkspaceByOwner(userId: string): Promise<AuthWorkspaceRow | null>;
  insertAuditEvent(event: AuditEventInput): Promise<void>;
}

function advisoryLockKeys(): [number, number] {
  const digest = createHash('sha256').update(INSTALLATION_LOCK_NAME, 'utf8').digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export class DrizzleAuthStore implements AuthStore {
  constructor(private readonly db: Database) {}

  async getUserCount(): Promise<number> {
    const rows = await this.db.select({ value: count() }).from(users);
    return rows[0]?.value ?? 0;
  }

  async isInstallationCompleted(): Promise<boolean> {
    const rows = await this.db
      .select({ completedAt: installationState.completedAt })
      .from(installationState)
      .where(eq(installationState.id, 1));
    if (rows[0]?.completedAt !== null && rows[0]?.completedAt !== undefined) {
      return true;
    }
    // Fail closed: accounts existing without a completed installation
    // row still mean setup is closed (for example a pre-M8 database).
    return (await this.getUserCount()) > 0;
  }

  async createFirstAccount(input: {
    email: string;
    passwordHash: string;
    workspaceName: string;
    now: Date;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ userId: string; workspaceId: string }> {
    const [key1, key2] = advisoryLockKeys();
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key1}, ${key2})`);
      const stateRows = await tx
        .select({ completedAt: installationState.completedAt })
        .from(installationState)
        .where(eq(installationState.id, 1));
      const stateCompleted = stateRows[0]?.completedAt !== null && stateRows[0]?.completedAt !== undefined;
      const userRows = await tx.select({ value: count() }).from(users);
      if (stateCompleted || (userRows[0]?.value ?? 0) > 0) {
        throw new InstallationAlreadyCompletedError();
      }
      const insertedUsers = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash: input.passwordHash,
          credentialEpoch: 1,
          role: 'admin',
          status: 'active',
          totpEnabled: false,
        })
        .returning({ id: users.id });
      const userId = insertedUsers[0]?.id;
      if (userId === undefined) {
        throw new Error('First-account user insert returned no row.');
      }
      const insertedWorkspaces = await tx
        .insert(workspaces)
        .values({ name: input.workspaceName, ownerUserId: userId })
        .returning({ id: workspaces.id });
      const workspaceId = insertedWorkspaces[0]?.id;
      if (workspaceId === undefined) {
        throw new Error('First-account workspace insert returned no row.');
      }
      await tx.insert(workspaceMembers).values({ workspaceId, userId, role: 'owner' });
      await tx
        .insert(installationState)
        .values({ id: 1, completedAt: input.now, completedByUserId: userId })
        .onConflictDoUpdate({
          target: installationState.id,
          set: { completedAt: input.now, completedByUserId: userId },
        });
      await tx.insert(auditEvents).values({
        userId,
        actorUserId: userId,
        eventType: 'installation_completed',
        ip: input.ip,
        userAgent: input.userAgent,
        metadata: {},
      });
      return { userId, workspaceId };
    });
  }

  async findUserByEmail(email: string): Promise<AuthUserRow | null> {
    const rows = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return rows[0] ?? null;
  }

  async findUserById(id: string): Promise<AuthUserRow | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async updateUserPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
  }

  async updateUserLastLogin(userId: string, at: Date): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: at, updatedAt: at }).where(eq(users.id, userId));
  }

  async replaceUserPassword(userId: string, input: { passwordHash: string; passwordChangedAt: Date }): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(users)
        .set({
          passwordHash: input.passwordHash,
          passwordChangedAt: input.passwordChangedAt,
          credentialEpoch: sql`${users.credentialEpoch} + 1`,
          updatedAt: input.passwordChangedAt,
        })
        .where(eq(users.id, userId))
        .returning({ epoch: users.credentialEpoch });
      const epoch = rows[0]?.epoch;
      if (epoch === undefined) {
        throw new Error('Password change found no user row.');
      }
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      return epoch;
    });
  }

  async bumpEpochAndRevokeAllSessions(userId: string, audit?: AuditEventInput): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(users)
        .set({ credentialEpoch: sql`${users.credentialEpoch} + 1`, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({ epoch: users.credentialEpoch });
      const epoch = rows[0]?.epoch;
      if (epoch === undefined) {
        throw new Error('Epoch bump found no user row.');
      }
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      if (audit !== undefined) {
        await tx.insert(auditEvents).values(audit);
      }
      return epoch;
    });
  }

  async createSession(input: CreateSessionInput): Promise<AuthSessionRow> {
    const rows = await this.db.insert(sessions).values(input).returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error('Session insert returned no row.');
    }
    return row;
  }

  async findSessionByHash(sessionHash: string): Promise<AuthSessionRow | null> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.sessionHash, sessionHash)).limit(1);
    return rows[0] ?? null;
  }

  async findSessionById(id: string): Promise<AuthSessionRow | null> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async listSessionsByUser(userId: string): Promise<AuthSessionRow[]> {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(sql`${sessions.lastSeenAt} DESC`);
  }

  async deleteSessionById(id: string): Promise<boolean> {
    const rows = await this.db.delete(sessions).where(eq(sessions.id, id)).returning({ id: sessions.id });
    return rows.length > 0;
  }

  async deleteSessionsByUser(userId: string): Promise<number> {
    const rows = await this.db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
    return rows.length;
  }

  async updateSessionLastSeen(id: string, input: { lastSeenAt: Date; lastSeenIp: string | null }): Promise<void> {
    await this.db.update(sessions).set({ lastSeenAt: input.lastSeenAt, lastSeenIp: input.lastSeenIp }).where(eq(sessions.id, id));
  }

  async rotateSession(oldId: string, input: CreateSessionInput): Promise<AuthSessionRow> {
    return this.db.transaction(async (tx) => {
      await tx.delete(sessions).where(eq(sessions.id, oldId));
      const rows = await tx.insert(sessions).values(input).returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error('Session rotation insert returned no row.');
      }
      return row;
    });
  }

  async createLoginChallenge(input: CreateLoginChallengeInput): Promise<LoginChallengeRow> {
    const rows = await this.db.insert(loginChallenges).values(input).returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error('Login challenge insert returned no row.');
    }
    return row;
  }

  async findChallengeByHash(challengeHash: string): Promise<LoginChallengeRow | null> {
    const rows = await this.db.select().from(loginChallenges).where(eq(loginChallenges.challengeHash, challengeHash)).limit(1);
    return rows[0] ?? null;
  }

  async deleteChallengeById(id: string): Promise<void> {
    await this.db.delete(loginChallenges).where(eq(loginChallenges.id, id));
  }

  async incrementChallengeAttempts(id: string): Promise<number> {
    const rows = await this.db
      .update(loginChallenges)
      .set({ attempts: sql`${loginChallenges.attempts} + 1` })
      .where(eq(loginChallenges.id, id))
      .returning({ attempts: loginChallenges.attempts });
    return rows[0]?.attempts ?? 0;
  }

  async findTotpCredential(userId: string): Promise<TotpCredentialRow | null> {
    const rows = await this.db.select().from(totpCredentials).where(eq(totpCredentials.userId, userId)).limit(1);
    return rows[0] ?? null;
  }

  async claimTotpStep(userId: string, step: number, verifiedAt: Date): Promise<boolean> {
    const rows = await this.db
      .update(totpCredentials)
      .set({ lastUsedStep: step, verifiedAt })
      .where(
        and(
          eq(totpCredentials.userId, userId),
          or(isNull(totpCredentials.lastUsedStep), lt(totpCredentials.lastUsedStep, step)),
        ),
      )
      .returning({ userId: totpCredentials.userId });
    return rows.length > 0;
  }

  async findUnusedRecoveryCode(userId: string, codeHash: string): Promise<RecoveryCodeRow | null> {
    const rows = await this.db
      .select()
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, codeHash), isNull(recoveryCodes.usedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async markRecoveryCodeUsed(id: string, usedAt: Date): Promise<boolean> {
    const rows = await this.db
      .update(recoveryCodes)
      .set({ usedAt })
      .where(and(eq(recoveryCodes.id, id), isNull(recoveryCodes.usedAt)))
      .returning({ id: recoveryCodes.id });
    return rows.length > 0;
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
    return rows[0]?.value ?? 0;
  }

  async getLockout(userId: string): Promise<AccountLockoutRow | null> {
    const rows = await this.db.select().from(accountLockouts).where(eq(accountLockouts.userId, userId)).limit(1);
    return rows[0] ?? null;
  }

  async recordLockoutFailure(userId: string, input: LockoutFailureInput): Promise<void> {
    await this.db
      .insert(accountLockouts)
      .values({ userId, ...input })
      .onConflictDoUpdate({
        target: accountLockouts.userId,
        set: { ...input },
      });
  }

  async clearLockout(userId: string): Promise<void> {
    await this.db.delete(accountLockouts).where(eq(accountLockouts.userId, userId));
  }

  async readBucketHits(scope: string, rateKey: string, windowStart: Date): Promise<number> {
    const rows = await this.db
      .select({ hits: rateLimitBuckets.hits })
      .from(rateLimitBuckets)
      .where(
        and(
          eq(rateLimitBuckets.scope, scope),
          eq(rateLimitBuckets.rateKey, rateKey),
          eq(rateLimitBuckets.windowStart, windowStart),
        ),
      )
      .limit(1);
    return rows[0]?.hits ?? 0;
  }

  async incrementBucket(scope: string, rateKey: string, windowStart: Date, expiresAt: Date): Promise<number> {
    const rows = await this.db
      .insert(rateLimitBuckets)
      .values({ scope, rateKey, windowStart, hits: 1, expiresAt })
      .onConflictDoUpdate({
        target: [rateLimitBuckets.scope, rateLimitBuckets.rateKey, rateLimitBuckets.windowStart],
        set: { hits: sql`${rateLimitBuckets.hits} + 1` },
      })
      .returning({ hits: rateLimitBuckets.hits });
    return rows[0]?.hits ?? 0;
  }

  async findFirstWorkspaceByOwner(userId: string): Promise<AuthWorkspaceRow | null> {
    const rows = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerUserId, userId))
      .orderBy(sql`${workspaces.createdAt} ASC`)
      .limit(1);
    return rows[0] ?? null;
  }

  async insertAuditEvent(event: AuditEventInput): Promise<void> {
    await this.db.insert(auditEvents).values(event);
  }
}
