// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// In-memory AuthStore for tests. It mirrors the DrizzleAuthStore
// semantics the handlers depend on (unique hashes, conditional
// claim/mark updates, composite bucket keys, installation
// completion, transactional first-account creation), so route and
// verifier tests exercise the real handler logic without Postgres.
// It is not a database emulator: no SQL, no advisory locks, no
// constraint errors beyond InstallationAlreadyCompletedError.

import { randomUUID } from 'node:crypto';
import {
  InstallationAlreadyCompletedError,
  type AccountLockoutRow,
  type AuditEventInput,
  type AuthSessionRow,
  type AuthStore,
  type AuthUserRow,
  type AuthWorkspaceRow,
  type CreateLoginChallengeInput,
  type CreateSessionInput,
  type LockoutFailureInput,
  type LoginChallengeRow,
  type RecoveryCodeRow,
  type TotpCredentialRow,
} from '../../src/auth/store.js';

export class FakeAuthStore implements AuthStore {
  users = new Map<string, AuthUserRow>();
  usersByEmail = new Map<string, AuthUserRow>();
  sessions = new Map<string, AuthSessionRow>();
  sessionsByHash = new Map<string, AuthSessionRow>();
  workspaces: AuthWorkspaceRow[] = [];
  members: Array<{ workspaceId: string; userId: string; role: string }> = [];
  challenges = new Map<string, LoginChallengeRow>();
  challengesByHash = new Map<string, LoginChallengeRow>();
  totp = new Map<string, TotpCredentialRow>();
  recovery: RecoveryCodeRow[] = [];
  lockouts = new Map<string, AccountLockoutRow>();
  buckets = new Map<string, number>();
  auditEvents: AuditEventInput[] = [];
  installationCompletedAt: Date | null = null;
  installationCompletedBy: string | null = null;

  // Fault injection for verifier failure tests.
  failFindSessionByHash = false;
  failFindSessionById = false;

  async getUserCount(): Promise<number> {
    return this.users.size;
  }

  async isInstallationCompleted(): Promise<boolean> {
    return this.installationCompletedAt !== null || this.users.size > 0;
  }

  async createFirstAccount(input: {
    email: string;
    passwordHash: string;
    workspaceName: string;
    now: Date;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ userId: string; workspaceId: string }> {
    if (this.installationCompletedAt !== null || this.users.size > 0) {
      throw new InstallationAlreadyCompletedError();
    }
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const user: AuthUserRow = {
      id: userId,
      email: input.email,
      passwordHash: input.passwordHash,
      credentialEpoch: 1,
      role: 'admin',
      status: 'active',
      totpEnabled: false,
      passwordChangedAt: null,
      lastLoginAt: null,
      disabledAt: null,
      disabledReason: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.users.set(userId, user);
    this.usersByEmail.set(input.email, user);
    this.workspaces.push({
      id: workspaceId,
      name: input.workspaceName,
      ownerUserId: userId,
      config: {},
      storageQuotaBytes: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    this.members.push({ workspaceId, userId, role: 'owner' });
    this.installationCompletedAt = input.now;
    this.installationCompletedBy = userId;
    this.auditEvents.push({
      userId,
      actorUserId: userId,
      eventType: 'installation_completed',
      ip: input.ip,
      userAgent: input.userAgent,
      metadata: {},
    });
    return { userId, workspaceId };
  }

  async findUserByEmail(email: string): Promise<AuthUserRow | null> {
    return this.usersByEmail.get(email) ?? null;
  }

  async findUserById(id: string): Promise<AuthUserRow | null> {
    return this.users.get(id) ?? null;
  }

  async updateUserPasswordHash(userId: string, passwordHash: string): Promise<void> {
    const user = this.users.get(userId);
    if (user !== undefined) {
      user.passwordHash = passwordHash;
      user.updatedAt = new Date();
    }
  }

  async updateUserLastLogin(userId: string, at: Date): Promise<void> {
    const user = this.users.get(userId);
    if (user !== undefined) {
      user.lastLoginAt = at;
      user.updatedAt = at;
    }
  }

  async replaceUserPassword(userId: string, input: { passwordHash: string; passwordChangedAt: Date }): Promise<number> {
    const user = this.users.get(userId);
    if (user === undefined) {
      throw new Error('Password change found no user row.');
    }
    user.passwordHash = input.passwordHash;
    user.passwordChangedAt = input.passwordChangedAt;
    user.credentialEpoch += 1;
    user.updatedAt = input.passwordChangedAt;
    await this.deleteSessionsByUser(userId);
    return user.credentialEpoch;
  }

  async bumpEpochAndRevokeAllSessions(userId: string, audit?: AuditEventInput): Promise<number> {
    const user = this.users.get(userId);
    if (user === undefined) {
      throw new Error('Epoch bump found no user row.');
    }
    user.credentialEpoch += 1;
    user.updatedAt = new Date();
    await this.deleteSessionsByUser(userId);
    if (audit !== undefined) {
      this.auditEvents.push(audit);
    }
    return user.credentialEpoch;
  }

  async createSession(input: CreateSessionInput): Promise<AuthSessionRow> {
    const row: AuthSessionRow = {
      id: randomUUID(),
      userId: input.userId,
      sessionHash: input.sessionHash,
      csrfTokenHash: input.csrfTokenHash,
      credentialEpoch: input.credentialEpoch,
      deviceLabel: input.deviceLabel,
      userAgent: input.userAgent,
      createdIp: input.createdIp,
      lastSeenIp: input.lastSeenIp,
      createdAt: input.createdAt,
      lastSeenAt: input.lastSeenAt ?? input.createdAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
      revokedAt: null,
      stepUpAt: input.stepUpAt,
    };
    this.sessions.set(row.id, row);
    this.sessionsByHash.set(row.sessionHash, row);
    return row;
  }

  async findSessionByHash(sessionHash: string): Promise<AuthSessionRow | null> {
    if (this.failFindSessionByHash) {
      throw new Error('injected database failure');
    }
    return this.sessionsByHash.get(sessionHash) ?? null;
  }

  async findSessionById(id: string): Promise<AuthSessionRow | null> {
    if (this.failFindSessionById) {
      throw new Error('injected database failure');
    }
    return this.sessions.get(id) ?? null;
  }

  async listSessionsByUser(userId: string): Promise<AuthSessionRow[]> {
    return [...this.sessions.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  }

  async deleteSessionById(id: string): Promise<boolean> {
    const row = this.sessions.get(id);
    if (row === undefined) {
      return false;
    }
    this.sessions.delete(id);
    this.sessionsByHash.delete(row.sessionHash);
    return true;
  }

  async deleteSessionsByUser(userId: string): Promise<number> {
    let count = 0;
    for (const row of [...this.sessions.values()]) {
      if (row.userId === userId) {
        this.sessions.delete(row.id);
        this.sessionsByHash.delete(row.sessionHash);
        count += 1;
      }
    }
    return count;
  }

  async updateSessionLastSeen(id: string, input: { lastSeenAt: Date; lastSeenIp: string | null }): Promise<void> {
    const row = this.sessions.get(id);
    if (row !== undefined) {
      row.lastSeenAt = input.lastSeenAt;
      row.lastSeenIp = input.lastSeenIp;
    }
  }

  async rotateSession(oldId: string, input: CreateSessionInput): Promise<AuthSessionRow> {
    await this.deleteSessionById(oldId);
    return this.createSession(input);
  }

  async createLoginChallenge(input: CreateLoginChallengeInput): Promise<LoginChallengeRow> {
    const row: LoginChallengeRow = {
      id: randomUUID(),
      userId: input.userId,
      challengeHash: input.challengeHash,
      attempts: 0,
      createdIp: input.createdIp,
      userAgentHash: input.userAgentHash,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
    };
    this.challenges.set(row.id, row);
    this.challengesByHash.set(row.challengeHash, row);
    return row;
  }

  async findChallengeByHash(challengeHash: string): Promise<LoginChallengeRow | null> {
    return this.challengesByHash.get(challengeHash) ?? null;
  }

  async deleteChallengeById(id: string): Promise<void> {
    const row = this.challenges.get(id);
    if (row !== undefined) {
      this.challenges.delete(id);
      this.challengesByHash.delete(row.challengeHash);
    }
  }

  async incrementChallengeAttempts(id: string): Promise<number> {
    const row = this.challenges.get(id);
    if (row === undefined) {
      return 0;
    }
    row.attempts += 1;
    return row.attempts;
  }

  async findTotpCredential(userId: string): Promise<TotpCredentialRow | null> {
    return this.totp.get(userId) ?? null;
  }

  async claimTotpStep(userId: string, step: number, verifiedAt: Date): Promise<boolean> {
    const credential = this.totp.get(userId);
    if (credential === undefined) {
      return false;
    }
    if (credential.lastUsedStep !== null && credential.lastUsedStep >= step) {
      return false;
    }
    credential.lastUsedStep = step;
    credential.verifiedAt = verifiedAt;
    return true;
  }

  async findUnusedRecoveryCode(userId: string, codeHash: string): Promise<RecoveryCodeRow | null> {
    return (
      this.recovery.find((row) => row.userId === userId && row.codeHash === codeHash && row.usedAt === null) ?? null
    );
  }

  async markRecoveryCodeUsed(id: string, usedAt: Date): Promise<boolean> {
    const row = this.recovery.find((entry) => entry.id === id);
    if (row === undefined || row.usedAt !== null) {
      return false;
    }
    row.usedAt = usedAt;
    return true;
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    return this.recovery.filter((row) => row.userId === userId && row.usedAt === null).length;
  }

  async getLockout(userId: string): Promise<AccountLockoutRow | null> {
    return this.lockouts.get(userId) ?? null;
  }

  async recordLockoutFailure(userId: string, input: LockoutFailureInput): Promise<void> {
    this.lockouts.set(userId, { userId, ...input });
  }

  async clearLockout(userId: string): Promise<void> {
    this.lockouts.delete(userId);
  }

  private bucketKey(scope: string, rateKey: string, windowStart: Date): string {
    return `${scope}\0${rateKey}\0${windowStart.toISOString()}`;
  }

  async readBucketHits(scope: string, rateKey: string, windowStart: Date): Promise<number> {
    return this.buckets.get(this.bucketKey(scope, rateKey, windowStart)) ?? 0;
  }

  async incrementBucket(scope: string, rateKey: string, windowStart: Date, _expiresAt: Date): Promise<number> {
    void _expiresAt;
    const key = this.bucketKey(scope, rateKey, windowStart);
    const next = (this.buckets.get(key) ?? 0) + 1;
    this.buckets.set(key, next);
    return next;
  }

  async findFirstWorkspaceByOwner(userId: string): Promise<AuthWorkspaceRow | null> {
    const owned = this.workspaces.filter((row) => row.ownerUserId === userId);
    owned.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return owned[0] ?? null;
  }

  async insertAuditEvent(event: AuditEventInput): Promise<void> {
    this.auditEvents.push(event);
  }

  // Seed helpers. Tests build rows directly instead of going through
  // HTTP when the row itself (not the endpoint) is the fixture.

  seedUser(input: {
    email: string;
    passwordHash: string;
    role?: string;
    status?: string;
    totpEnabled?: boolean;
    credentialEpoch?: number;
    createdAt?: Date;
  }): AuthUserRow {
    const now = input.createdAt ?? new Date();
    const user: AuthUserRow = {
      id: randomUUID(),
      email: input.email,
      passwordHash: input.passwordHash,
      credentialEpoch: input.credentialEpoch ?? 1,
      role: input.role ?? 'user',
      status: input.status ?? 'active',
      totpEnabled: input.totpEnabled ?? false,
      passwordChangedAt: null,
      lastLoginAt: null,
      disabledAt: null,
      disabledReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email, user);
    return user;
  }

  seedWorkspace(ownerUserId: string, name = 'Workspace', createdAt = new Date()): AuthWorkspaceRow {
    const row: AuthWorkspaceRow = {
      id: randomUUID(),
      name,
      ownerUserId,
      config: {},
      storageQuotaBytes: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.workspaces.push(row);
    this.members.push({ workspaceId: row.id, userId: ownerUserId, role: 'owner' });
    return row;
  }

  seedTotp(userId: string, input: { sealedSecret: string; keyVersion?: number; lastUsedStep?: number | null }): TotpCredentialRow {
    const row: TotpCredentialRow = {
      userId,
      sealedSecret: input.sealedSecret,
      keyVersion: input.keyVersion ?? 1,
      lastUsedStep: input.lastUsedStep ?? null,
      verifiedAt: null,
      createdAt: new Date(),
    };
    this.totp.set(userId, row);
    return row;
  }

  seedRecoveryCode(userId: string, codeHash: string): RecoveryCodeRow {
    const row: RecoveryCodeRow = {
      id: randomUUID(),
      userId,
      codeHash,
      batchId: randomUUID(),
      usedAt: null,
      createdAt: new Date(),
    };
    this.recovery.push(row);
    return row;
  }
}
