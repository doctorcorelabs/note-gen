// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Negative auth tests against the REAL auth core (worker V3-01cR2,
// wave 3A). Read the layer statement before citing any result.
//
// LAYER: L3-real. The Fastify app, the real auth routes
// (server/src/routes/auth-core.ts), the real session/CSRF verifiers,
// the real rate-limit and lockout logic, the real CSRF derivation,
// the real TOTP verification, and the real envelope are all
// production code from branch web-auth-core (V3-01b/V3-01bR). The
// ONLY stand-ins are: (1) an in-memory AuthStore implementing the
// store interface in server/src/auth/store.ts, (2) a fast
// deterministic test hasher standing in for Argon2id (one test pins
// the real Argon2 hasher round-trip), and (3) a controllable clock.
// A green run here proves the negative contract against the real
// route/handler/verifier code; it does NOT prove the Drizzle SQL,
// Postgres behavior, the advisory-lock setup race, or Argon2 timing
// parity. Those stay open debt for a database-backed run.
//
// GATING: the auth modules are resolved with a runtime-computed
// dynamic import, so this file typechecks and collects on a tree
// without web-auth-core (every gated test SKIPS with its reason in
// the suite name) and ACTIVATES on a merged tree. This replaces the
// collection-time HTTP probe in auth-negative-live.spec.ts, which
// cannot activate: buildApp registers auth routes only when an
// AuthContext is injected, so probing without a context always sees
// 404. The live probes are kept as registration documentation; this
// file is the activation-capable successor.
//
// Fixture values are obviously fake test data, never real
// credentials. The TOTP secret is the public RFC test vector
// secret. The setup token, auth secret, and encryption key are
// fixture strings that only exist inside this process.
//
// Sources: kontrak-api-kanonis.md sections 1.2, 3.12, 6;
// desain-auth.md sections 1.3-1.6, 2.1-2.4, 3.1-3.7, 5.2, 5.3,
// 6.3-6.5; bentuk-middleware-beku.md (AD-40).

import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Runtime resolution of the real auth modules (see the file header).
// ---------------------------------------------------------------------------

interface RealAuth {
  createAuthContext: (overrides: Record<string, unknown>) => Record<string, unknown> & {
    close: () => Promise<void>;
  };
  InstallationAlreadyCompletedError: new () => Error;
  rotateSessionForRow: (
    context: unknown,
    store: unknown,
    oldRow: FakeSessionRow,
    request: unknown,
    now: Date,
    stepUpAt: Date | null,
  ) => Promise<{ sessionId: string; csrfToken: string; row: FakeSessionRow }>;
  sealTotpSecret: (secret: string, key: Buffer) => string;
  deriveSealKey: (value: string | undefined) => Buffer | null;
  totpCodeAt: (secretBytes: Buffer, counter: number, digits?: number) => string;
  decodeBase32: (value: string) => Buffer;
  Argon2PasswordHasher: new () => {
    hash: (password: string) => Promise<string>;
    verify: (storedHash: string, password: string) => Promise<boolean>;
    needsRehash: (storedHash: string) => boolean;
  };
  LOCKOUT_DURATIONS_MS: readonly number[];
  LOGIN_CHALLENGE_MS: number;
  SESSION_ABSOLUTE_MS: number;
  SESSION_IDLE_MS: number;
  STEP_UP_WINDOW_MS: number;
  TOTP_SEAL_KEY_VERSION: number;
}

async function loadRealAuth(): Promise<{ real: RealAuth | null; reason: string }> {
  try {
    const path = (name: string): string => `../src/auth/${name}.js`;
    const contextMod = await import(/* @vite-ignore */ path('context'));
    const storeMod = await import(/* @vite-ignore */ path('store'));
    const serviceMod = await import(/* @vite-ignore */ path('service'));
    const sealMod = await import(/* @vite-ignore */ path('totp-seal'));
    const verifyMod = await import(/* @vite-ignore */ path('totp-verify'));
    const passwordsMod = await import(/* @vite-ignore */ path('passwords'));
    const valuesMod = await import(/* @vite-ignore */ path('values'));
    return {
      real: {
        createAuthContext: contextMod.createAuthContext as RealAuth['createAuthContext'],
        InstallationAlreadyCompletedError: storeMod.InstallationAlreadyCompletedError as RealAuth['InstallationAlreadyCompletedError'],
        rotateSessionForRow: serviceMod.rotateSessionForRow as RealAuth['rotateSessionForRow'],
        sealTotpSecret: sealMod.sealTotpSecret as RealAuth['sealTotpSecret'],
        deriveSealKey: sealMod.deriveSealKey as RealAuth['deriveSealKey'],
        totpCodeAt: verifyMod.totpCodeAt as RealAuth['totpCodeAt'],
        decodeBase32: verifyMod.decodeBase32 as RealAuth['decodeBase32'],
        Argon2PasswordHasher: passwordsMod.Argon2PasswordHasher as RealAuth['Argon2PasswordHasher'],
        LOCKOUT_DURATIONS_MS: valuesMod.LOCKOUT_DURATIONS_MS as readonly number[],
        LOGIN_CHALLENGE_MS: valuesMod.LOGIN_CHALLENGE_MS as number,
        SESSION_ABSOLUTE_MS: valuesMod.SESSION_ABSOLUTE_MS as number,
        SESSION_IDLE_MS: valuesMod.SESSION_IDLE_MS as number,
        STEP_UP_WINDOW_MS: valuesMod.STEP_UP_WINDOW_MS as number,
        TOTP_SEAL_KEY_VERSION: sealMod.TOTP_SEAL_KEY_VERSION as number,
      },
      reason: 'real auth modules resolved',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { real: null, reason: `real auth modules absent: ${message.slice(0, 120)}` };
  }
}

const LOADED = await loadRealAuth();
const REAL: RealAuth | null = LOADED.real;
const REAL_PRESENT = REAL !== null;
const SKIP_REASON = LOADED.reason;

function real(): RealAuth {
  if (REAL === null) {
    throw new Error(`real auth modules are absent (${SKIP_REASON}); gated test must not run`);
  }
  return REAL;
}

// ---------------------------------------------------------------------------
// Fixtures and constants.
// ---------------------------------------------------------------------------

const CANONICAL_ORIGIN = 'https://app.example.invalid';
const EVIL_ORIGIN = 'https://evil.example.invalid';
const VERSION = '0.39.2-fork.1';
const AUTH_SECRET_FIXTURE = 'fixture-auth-secret-only-not-real-0123456789abcdef';
const ENCRYPTION_KEY_FIXTURE = 'fixture-encryption-key-only-not-real-0123456789ab';
const SETUP_TOKEN_FIXTURE = 'fixture-setup-token-only-not-real-0123456789ab';
const PASSWORD_FIXTURE = 'fixture-password-only-1234';
const WRONG_PASSWORD_FIXTURE = 'fixture-wrong-password-5678';
const USER_AGENT_A = 'FixtureBrowser/1.0 (Test OS)';
const USER_AGENT_B = 'OtherFixtureBrowser/2.0 (Test OS)';
// Fixed clock start, aligned to every rate-limit window boundary
// (15 minutes, 1 hour) so window rollover is deterministic.
const START_MS = 1_800_000_000_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const TOTP_SECRET_BASE32 = 'JBSWY3DPEHPK3PXP';
const RECOVERY_CODE_FIXTURE = 'abcd-efgh-ijkl-mnop';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fakeHash(password: string): string {
  return `fake-phc:${password}`;
}

const fakeHasher = {
  hash: async (password: string): Promise<string> => fakeHash(password),
  verify: async (storedHash: string, password: string): Promise<boolean> => storedHash === fakeHash(password),
  needsRehash: (): boolean => false,
};

// ---------------------------------------------------------------------------
// In-memory AuthStore. Row shapes mirror the canonical M8 schema in
// server/src/db/schema/ (swap D-M8), and method semantics mirror
// DrizzleAuthStore in server/src/auth/store.ts
// (epoch starts at 1 for the first account, sessions ordered by
// lastSeenAt descending, bucket upsert, conditional TOTP step claim,
// single-use recovery codes). Test hooks are marked HOOK and are the
// only way to seed states the core routes cannot produce yet
// (a second account, a disabled account, an epoch bump without
// session deletion, a fresh step-up): the step-up endpoint itself is
// V3-02 work, so step-up states are seeded, never faked through a
// route.
// ---------------------------------------------------------------------------

interface FakeUserRow {
  id: string;
  email: string;
  passwordHash: string;
  credentialEpoch: number;
  role: string;
  status: string;
  totpEnabled: boolean;
  passwordChangedAt: Date | null;
  lastLoginAt: Date | null;
  disabledAt: Date | null;
  disabledReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeSessionRow {
  id: string;
  userId: string;
  sessionHash: string;
  csrfTokenHash: string;
  credentialEpoch: number;
  deviceLabel: string | null;
  userAgent: string | null;
  createdIp: string | null;
  lastSeenIp: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  stepUpAt: Date | null;
}

interface FakeWorkspaceRow {
  id: string;
  name: string;
  ownerUserId: string;
  config: Record<string, unknown>;
  storageQuotaBytes: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeChallengeRow {
  id: string;
  userId: string;
  challengeHash: string;
  attempts: number;
  createdIp: string | null;
  userAgentHash: string | null;
  expiresAt: Date;
  createdAt: Date;
}

interface FakeTotpRow {
  userId: string;
  secretSealed: string;
  keyVersion: number;
  lastUsedStep: number | null;
  enrolledAt: Date;
  verifiedAt: Date | null;
}

interface FakeRecoveryRow {
  id: string;
  userId: string;
  codeHash: string;
  batchId: string;
  usedAt: Date | null;
  createdAt: Date;
}

interface FakeLockoutRow {
  userId: string;
  consecutiveFailures: number;
  lockoutLevel: number;
  lockedUntil: Date | null;
  lastFailureAt: Date | null;
}

interface CreateSessionInput {
  userId: string;
  sessionHash: string;
  csrfTokenHash: string;
  credentialEpoch: number;
  deviceLabel: string | null;
  userAgent: string | null;
  createdIp: string | null;
  lastSeenIp: string | null;
  createdAt: Date;
  lastSeenAt?: Date;
  absoluteExpiresAt: Date;
  stepUpAt: Date | null;
}

class FakeAuthStore {
  private users = new Map<string, FakeUserRow>();
  private sessions = new Map<string, FakeSessionRow>();
  private workspaces = new Map<string, FakeWorkspaceRow>();
  private challenges = new Map<string, FakeChallengeRow>();
  private totp = new Map<string, FakeTotpRow>();
  private recoveryCodes = new Map<string, FakeRecoveryRow>();
  private lockouts = new Map<string, FakeLockoutRow>();
  private buckets = new Map<string, { hits: number; expiresAt: Date }>();
  private audit: Array<Record<string, unknown>> = [];
  private installationCompleted = false;
  private installationCompletedBy: string | null = null;
  private auditSeq = 0;

  constructor(private readonly clock: () => number) {}

  private now(): Date {
    return new Date(this.clock());
  }

  async getUserCount(): Promise<number> {
    return this.users.size;
  }

  async isInstallationCompleted(): Promise<boolean> {
    return this.installationCompleted || this.users.size > 0;
  }

  async createFirstAccount(input: {
    email: string;
    passwordHash: string;
    workspaceName: string;
    now: Date;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ userId: string; workspaceId: string }> {
    if (this.installationCompleted || this.users.size > 0) {
      throw new (real().InstallationAlreadyCompletedError)();
    }
    const userId = randomUUID();
    const workspaceId = randomUUID();
    this.users.set(userId, {
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
    });
    this.workspaces.set(workspaceId, {
      id: workspaceId,
      name: input.workspaceName,
      ownerUserId: userId,
      config: {},
      storageQuotaBytes: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    this.installationCompleted = true;
    this.installationCompletedBy = userId;
    await this.insertAuditEvent({
      userId,
      actorUserId: userId,
      eventType: 'installation_completed',
      ip: input.ip,
      userAgent: input.userAgent,
      metadata: {},
    });
    return { userId, workspaceId };
  }

  async findUserByEmail(email: string): Promise<FakeUserRow | null> {
    for (const user of this.users.values()) {
      if (user.email === email) {
        return { ...user };
      }
    }
    return null;
  }

  async findUserById(id: string): Promise<FakeUserRow | null> {
    const user = this.users.get(id);
    return user === undefined ? null : { ...user };
  }

  async updateUserPasswordHash(userId: string, passwordHash: string): Promise<void> {
    const user = this.users.get(userId);
    if (user !== undefined) {
      user.passwordHash = passwordHash;
      user.updatedAt = this.now();
    }
  }

  async updateUserLastLogin(userId: string, at: Date): Promise<void> {
    const user = this.users.get(userId);
    if (user !== undefined) {
      user.lastLoginAt = at;
      user.updatedAt = at;
    }
  }

  async replaceUserPassword(
    userId: string,
    input: { passwordHash: string; passwordChangedAt: Date },
  ): Promise<number> {
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

  async bumpEpochAndRevokeAllSessions(
    userId: string,
    audit?: Record<string, unknown>,
  ): Promise<number> {
    const user = this.users.get(userId);
    if (user === undefined) {
      throw new Error('Epoch bump found no user row.');
    }
    user.credentialEpoch += 1;
    user.updatedAt = this.now();
    await this.deleteSessionsByUser(userId);
    if (audit !== undefined) {
      await this.insertAuditEvent(audit as unknown as Parameters<FakeAuthStore['insertAuditEvent']>[0]);
    }
    return user.credentialEpoch;
  }

  async createSession(input: CreateSessionInput): Promise<FakeSessionRow> {
    const row: FakeSessionRow = {
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
    return { ...row };
  }

  async findSessionByHash(sessionHash: string): Promise<FakeSessionRow | null> {
    for (const row of this.sessions.values()) {
      if (row.sessionHash === sessionHash) {
        return { ...row };
      }
    }
    return null;
  }

  async findSessionById(id: string): Promise<FakeSessionRow | null> {
    const row = this.sessions.get(id);
    return row === undefined ? null : { ...row };
  }

  async listSessionsByUser(userId: string): Promise<FakeSessionRow[]> {
    return [...this.sessions.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .map((row) => ({ ...row }));
  }

  async deleteSessionById(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async deleteSessionsByUser(userId: string): Promise<number> {
    let count = 0;
    for (const [id, row] of [...this.sessions.entries()]) {
      if (row.userId === userId) {
        this.sessions.delete(id);
        count += 1;
      }
    }
    return count;
  }

  async updateSessionLastSeen(
    id: string,
    input: { lastSeenAt: Date; lastSeenIp: string | null },
  ): Promise<void> {
    const row = this.sessions.get(id);
    if (row !== undefined) {
      row.lastSeenAt = input.lastSeenAt;
      row.lastSeenIp = input.lastSeenIp;
    }
  }

  async rotateSession(oldId: string, input: CreateSessionInput): Promise<FakeSessionRow> {
    this.sessions.delete(oldId);
    return this.createSession(input);
  }

  async createLoginChallenge(input: {
    userId: string;
    challengeHash: string;
    createdIp: string | null;
    userAgentHash: string | null;
    expiresAt: Date;
  }): Promise<FakeChallengeRow> {
    // One active challenge per account, mirroring DrizzleAuthStore:
    // a fresh login invalidates every earlier challenge of the
    // same account before the new row is stored.
    for (const [id, row] of this.challenges) {
      if (row.userId === input.userId) {
        this.challenges.delete(id);
      }
    }
    const row: FakeChallengeRow = {
      id: randomUUID(),
      userId: input.userId,
      challengeHash: input.challengeHash,
      attempts: 0,
      createdIp: input.createdIp,
      userAgentHash: input.userAgentHash,
      expiresAt: input.expiresAt,
      createdAt: this.now(),
    };
    this.challenges.set(row.id, row);
    return { ...row };
  }

  async findChallengeByHash(challengeHash: string): Promise<FakeChallengeRow | null> {
    for (const row of this.challenges.values()) {
      if (row.challengeHash === challengeHash) {
        return { ...row };
      }
    }
    return null;
  }

  async deleteChallengeById(id: string): Promise<void> {
    this.challenges.delete(id);
  }

  async incrementChallengeAttempts(id: string): Promise<number> {
    const row = this.challenges.get(id);
    if (row === undefined) {
      return 0;
    }
    row.attempts += 1;
    return row.attempts;
  }

  async findTotpCredential(userId: string): Promise<FakeTotpRow | null> {
    const row = this.totp.get(userId);
    return row === undefined ? null : { ...row };
  }

  async claimTotpStep(userId: string, step: number, verifiedAt: Date): Promise<boolean> {
    const row = this.totp.get(userId);
    if (row === undefined) {
      return false;
    }
    if (row.lastUsedStep !== null && row.lastUsedStep >= step) {
      return false;
    }
    row.lastUsedStep = step;
    row.verifiedAt = verifiedAt;
    return true;
  }

  async findUnusedRecoveryCode(userId: string, codeHash: string): Promise<FakeRecoveryRow | null> {
    for (const row of this.recoveryCodes.values()) {
      if (row.userId === userId && row.codeHash === codeHash && row.usedAt === null) {
        return { ...row };
      }
    }
    return null;
  }

  async markRecoveryCodeUsed(id: string, usedAt: Date): Promise<boolean> {
    const row = this.recoveryCodes.get(id);
    if (row === undefined || row.usedAt !== null) {
      return false;
    }
    row.usedAt = usedAt;
    return true;
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    let count = 0;
    for (const row of this.recoveryCodes.values()) {
      if (row.userId === userId && row.usedAt === null) {
        count += 1;
      }
    }
    return count;
  }

  async getLockout(userId: string): Promise<FakeLockoutRow | null> {
    const row = this.lockouts.get(userId);
    return row === undefined ? null : { ...row };
  }

  async recordLockoutFailure(
    userId: string,
    input: {
      consecutiveFailures: number;
      lockoutLevel: number;
      lockedUntil: Date | null;
      lastFailureAt: Date;
    },
  ): Promise<void> {
    this.lockouts.set(userId, { userId, ...input });
  }

  async recordLockoutFailureAtomic(
    userId: string,
    input: {
      now: Date;
      threshold: number;
      lockedUntilByNextLevel: readonly [Date, Date, Date, Date];
    },
  ): Promise<void> {
    // Sequential in-memory mirror of the single-statement upsert:
    // the same transition, applied to the current row without an
    // interleaving read.
    const previous = this.lockouts.get(userId) ?? null;
    const nowMs = input.now.getTime();
    if (previous !== null && previous.lockedUntil !== null && previous.lockedUntil.getTime() > nowMs) {
      return;
    }
    const expired = previous !== null && previous.lockedUntil !== null && previous.lockedUntil.getTime() <= nowMs;
    const baseFailures = expired || previous === null ? 0 : previous.consecutiveFailures;
    const level = previous?.lockoutLevel ?? 0;
    const failures = baseFailures + 1;
    if (failures >= input.threshold) {
      const nextLevel = level + 1;
      const candidate = input.lockedUntilByNextLevel[Math.min(Math.max(nextLevel, 1), 4) - 1] as Date;
      this.lockouts.set(userId, {
        userId,
        consecutiveFailures: failures,
        lockoutLevel: nextLevel,
        lockedUntil: candidate,
        lastFailureAt: input.now,
      });
      return;
    }
    this.lockouts.set(userId, {
      userId,
      consecutiveFailures: failures,
      lockoutLevel: level,
      lockedUntil: null,
      lastFailureAt: input.now,
    });
  }

  async clearLockout(userId: string): Promise<void> {
    this.lockouts.delete(userId);
  }

  async readBucketHits(scope: string, rateKey: string, windowStart: Date): Promise<number> {
    const bucket = this.buckets.get(`${scope}\0${rateKey}\0${windowStart.getTime()}`);
    return bucket?.hits ?? 0;
  }

  async incrementBucket(
    scope: string,
    rateKey: string,
    windowStart: Date,
    expiresAt: Date,
  ): Promise<number> {
    const key = `${scope}\0${rateKey}\0${windowStart.getTime()}`;
    const bucket = this.buckets.get(key) ?? { hits: 0, expiresAt };
    bucket.hits += 1;
    bucket.expiresAt = expiresAt;
    this.buckets.set(key, bucket);
    return bucket.hits;
  }

  async findFirstWorkspaceByOwner(userId: string): Promise<FakeWorkspaceRow | null> {
    for (const row of this.workspaces.values()) {
      if (row.ownerUserId === userId) {
        return { ...row };
      }
    }
    return null;
  }

  async insertAuditEvent(event: {
    userId: string | null;
    actorUserId: string | null;
    eventType: string;
    ip: string | null;
    userAgent: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    this.auditSeq += 1;
    this.audit.push({ id: this.auditSeq, ...event, createdAt: this.now() });
  }

  // -- Test hooks (HOOK). See the class header. --

  insertUser(input: {
    email: string;
    password: string;
    role?: string;
    status?: string;
    totpEnabled?: boolean;
  }): FakeUserRow {
    const id = randomUUID();
    const row: FakeUserRow = {
      id,
      email: input.email,
      passwordHash: fakeHash(input.password),
      credentialEpoch: 1,
      role: input.role ?? 'user',
      status: input.status ?? 'active',
      totpEnabled: input.totpEnabled ?? false,
      passwordChangedAt: null,
      lastLoginAt: null,
      disabledAt: null,
      disabledReason: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.users.set(id, row);
    return { ...row };
  }

  setUserStatus(userId: string, status: string): void {
    const user = this.users.get(userId);
    if (user !== undefined) {
      user.status = status;
    }
  }

  setUserEpoch(userId: string, epoch: number): void {
    const user = this.users.get(userId);
    if (user !== undefined) {
      user.credentialEpoch = epoch;
    }
  }

  getUserEpoch(userId: string): number | null {
    return this.users.get(userId)?.credentialEpoch ?? null;
  }

  seedTotpCredential(userId: string, secretSealed: string, keyVersion: number): void {
    this.totp.set(userId, {
      userId,
      secretSealed,
      keyVersion,
      lastUsedStep: null,
      enrolledAt: this.now(),
      verifiedAt: null,
    });
    const user = this.users.get(userId);
    if (user !== undefined) {
      user.totpEnabled = true;
    }
  }

  seedRecoveryCode(userId: string, codeHash: string): void {
    const id = randomUUID();
    this.recoveryCodes.set(id, {
      id,
      userId,
      codeHash,
      batchId: randomUUID(),
      usedAt: null,
      createdAt: this.now(),
    });
  }

  setSessionStepUp(sessionId: string, stepUpAt: Date | null): void {
    const row = this.sessions.get(sessionId);
    if (row !== undefined) {
      row.stepUpAt = stepUpAt;
    }
  }

  sessionCountForUser(userId: string): number {
    let count = 0;
    for (const row of this.sessions.values()) {
      if (row.userId === userId) {
        count += 1;
      }
    }
    return count;
  }

  auditCount(): number {
    return this.audit.length;
  }
}

// ---------------------------------------------------------------------------
// App factory and HTTP helpers.
// ---------------------------------------------------------------------------

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3001,
    databaseUrl: 'postgres://placeholder/placeholder',
    workspaceRoot: '/tmp',
    nodeEnv: 'development',
    logLevel: 'silent',
    checkTimeoutMs: 2000,
    overallTimeoutMs: 5000,
    warnings: [],
    registrationMode: 'closed',
    publicBaseUrl: CANONICAL_ORIGIN,
    trustProxy: true,
    cookieSecure: false,
    cfAccessEnabled: false,
    cfAccessTeamDomain: undefined,
    cfAccessAud: undefined,
    cfAccessJwksCacheTtlSeconds: 3600,
    cfAccessServiceAud: undefined,
    jwtAudience: undefined,
    authSecretConfigured: true,
    authSecretLengthOk: true,
    encryptionKeyConfigured: true,
    setupTokenConfigured: true,
    setupTokenLengthOk: true,
    maxBodyBytes: 1048576,
    ...overrides,
  };
}

interface RealApp {
  app: FastifyInstance;
  store: FakeAuthStore;
  context: Record<string, unknown> & { close: () => Promise<void> };
  nowMs: () => number;
  advance: (ms: number) => void;
  close: () => Promise<void>;
}

async function makeRealApp(): Promise<RealApp> {
  let nowMs = START_MS;
  const store = new FakeAuthStore(() => nowMs);
  const context = real().createAuthContext({
    store,
    hasher: fakeHasher,
    authSecret: AUTH_SECRET_FIXTURE,
    setupToken: SETUP_TOKEN_FIXTURE,
    encryptionKey: ENCRYPTION_KEY_FIXTURE,
    canonicalOrigin: CANONICAL_ORIGIN,
    trustProxy: true,
    cookieSecure: false,
    registrationMode: 'closed',
    clock: () => nowMs,
  });
  // The auth field exists only on a tree with web-auth-core; the cast
  // keeps this file typechecking on the trunk-only tree, where the
  // gated tests never reach this factory.
  const deps = {
    config: testConfig(),
    pool: null,
    version: VERSION,
    auth: context,
  } as unknown as Parameters<typeof buildApp>[0];
  const app = await buildApp(deps);
  return {
    app,
    store,
    context,
    nowMs: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    close: async () => {
      await app.close();
    },
  };
}

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; requestId: string; retryable: boolean; details: Record<string, unknown> };
}

function errorOf(res: InjectResponse): ErrorBody['error'] {
  return (res.json() as ErrorBody).error;
}

function dataOf<T>(res: InjectResponse): T {
  return (res.json() as { ok: true; data: T }).data;
}

function redactRequestId(res: InjectResponse): unknown {
  const body = res.json() as Record<string, unknown>;
  const error = body.error as Record<string, unknown> | undefined;
  if (error !== undefined) {
    return { ...body, error: { ...error, requestId: 'redacted' } };
  }
  return body;
}

function setCookieHeader(res: InjectResponse): string | undefined {
  const header = res.headers['set-cookie'];
  if (typeof header === 'string') {
    return header;
  }
  if (Array.isArray(header)) {
    return header[0];
  }
  return undefined;
}

function cookiePair(res: InjectResponse): string {
  const header = setCookieHeader(res);
  if (header === undefined) {
    throw new Error('expected a Set-Cookie header');
  }
  const pair = header.split(';')[0];
  if (pair === undefined || pair === '') {
    throw new Error('malformed Set-Cookie header');
  }
  return pair.trim();
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': USER_AGENT_A, ...extra };
}

function forwardedFor(n: number): string {
  return `203.0.113.${n}`;
}

interface LoginResult {
  res: InjectResponse;
  cookie: string;
  csrfToken: string;
  userId: string;
}

async function setupFirstAccount(
  app: FastifyInstance,
  email: string,
  password: string = PASSWORD_FIXTURE,
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1) }),
    payload: JSON.stringify({ setupToken: SETUP_TOKEN_FIXTURE, email, password }),
  });
}

async function login(
  app: FastifyInstance,
  email: string,
  password: string,
  extra: Record<string, string> = {},
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1), ...extra }),
    payload: JSON.stringify({ email, password }),
  });
}

async function loginOk(
  app: FastifyInstance,
  email: string,
  password: string = PASSWORD_FIXTURE,
  extra: Record<string, string> = {},
): Promise<LoginResult> {
  const res = await login(app, email, password, extra);
  expect(res.statusCode).toBe(200);
  const data = dataOf<{ id: string; csrfToken: string }>(res);
  return { res, cookie: cookiePair(res), csrfToken: data.csrfToken, userId: data.id };
}

function mutationHeaders(cookie: string, csrfToken: string, extra: Record<string, string> = {}): Record<string, string> {
  return jsonHeaders({ cookie, 'x-csrf-token': csrfToken, 'x-forwarded-for': forwardedFor(1), ...extra });
}

// DELETE carries no body: sending a JSON content type with an empty
// body makes the Fastify JSON parser answer 400 before the handler
// runs, which would mask the route behavior under test.
function deleteHeaders(cookie: string, csrfToken: string): Record<string, string> {
  return { origin: CANONICAL_ORIGIN, cookie, 'x-csrf-token': csrfToken, 'x-forwarded-for': forwardedFor(1), 'user-agent': USER_AGENT_A };
}

// ---------------------------------------------------------------------------
// Presence recording (always runs).
// ---------------------------------------------------------------------------

describe(`L3-real presence: real auth modules (present: ${String(REAL_PRESENT)}; ${SKIP_REASON})`, () => {
  it('records whether the real auth modules resolved instead of assuming it', () => {
    expect(typeof REAL_PRESENT).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });

  it('records the frozen lockout ladder from the real values module when present', () => {
    if (!REAL_PRESENT) {
      expect(REAL).toBeNull();
      return;
    }
    expect(real().LOCKOUT_DURATIONS_MS).toEqual([15 * MINUTE_MS, HOUR_MS, 4 * HOUR_MS, 24 * HOUR_MS]);
    expect(real().LOGIN_CHALLENGE_MS).toBe(5 * MINUTE_MS);
    expect(real().SESSION_ABSOLUTE_MS).toBe(30 * 24 * HOUR_MS);
    expect(real().SESSION_IDLE_MS).toBe(24 * HOUR_MS);
    expect(real().STEP_UP_WINDOW_MS).toBe(15 * MINUTE_MS);
  });
});

// ---------------------------------------------------------------------------
// Setup: conditional 404, token failure, rate limit (real routes).
// ---------------------------------------------------------------------------

describe('L3-real setup: first account and conditional 404 [real routes]', () => {
  it.skipIf(!REAL_PRESENT)('setup success answers 201 with no session cookie and no secret echo', async () => {
    const t = await makeRealApp();
    try {
      const res = await setupFirstAccount(t.app, 'owner@example.invalid');
      expect(res.statusCode).toBe(201);
      const data = dataOf<{ id: string; email: string; workspaceId: string }>(res);
      expect(data.email).toBe('owner@example.invalid');
      expect(typeof data.id).toBe('string');
      expect(typeof data.workspaceId).toBe('string');
      expect(setCookieHeader(res)).toBeUndefined();
      expect(res.body).not.toContain(PASSWORD_FIXTURE);
      expect(res.body).not.toContain(SETUP_TOKEN_FIXTURE);
      expect(t.store.sessionCountForUser(data.id)).toBe(0);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a second setup with the correct token answers 404 once installation completed', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const res = await setupFirstAccount(t.app, 'second@example.invalid');
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('not_found');
      expect(setCookieHeader(res)).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a wrong token after completion answers 404, not 401: completion is checked first', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(2) }),
        payload: JSON.stringify({ setupToken: 'fixture-wrong-setup-token', email: 'x@example.invalid', password: PASSWORD_FIXTURE }),
      });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('not_found');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a wrong token while installation is open answers 401 invalid_setup_token', async () => {
    const t = await makeRealApp();
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({ setupToken: 'fixture-wrong-setup-token', email: 'x@example.invalid', password: PASSWORD_FIXTURE }),
      });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('invalid_setup_token');
      expect(setCookieHeader(res)).toBeUndefined();
      expect(res.body).not.toContain('fixture-wrong-setup-token');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a missing setup token answers 400 validation_failed (real validation boundary)', async () => {
    const t = await makeRealApp();
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({ email: 'x@example.invalid', password: PASSWORD_FIXTURE }),
      });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('validation_failed');
      // NOTE: the L2 reference harness pinned 401 for this case and
      // flagged it as needing V3-01b confirmation. The real route
      // validates presence as 400; the L2 reading was wrong and the
      // real behavior is what this test pins.
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('setup with a wrong Origin, or no Origin at all, answers 403 origin_rejected', async () => {
    const t = await makeRealApp();
    try {
      const wrong = await t.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: jsonHeaders({ origin: EVIL_ORIGIN, 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({ setupToken: SETUP_TOKEN_FIXTURE, email: 'x@example.invalid', password: PASSWORD_FIXTURE }),
      });
      expect(wrong.statusCode).toBe(403);
      expect(errorOf(wrong).code).toBe('origin_rejected');
      const none = await t.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor(1) },
        payload: JSON.stringify({ setupToken: SETUP_TOKEN_FIXTURE, email: 'x@example.invalid', password: PASSWORD_FIXTURE }),
      });
      expect(none.statusCode).toBe(403);
      expect(errorOf(none).code).toBe('origin_rejected');
      // Neither attempt consumed the installation: a correct setup still works.
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('setup attempts are rate limited: 5 per hour per IP, then 429 with Retry-After', async () => {
    const t = await makeRealApp();
    try {
      for (let i = 0; i < 5; i += 1) {
        const res = await t.app.inject({
          method: 'POST',
          url: '/api/auth/setup',
          headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(9) }),
          payload: JSON.stringify({ setupToken: 'fixture-wrong-setup-token', email: 'x@example.invalid', password: PASSWORD_FIXTURE }),
        });
        expect(res.statusCode).toBe(401);
      }
      const limited = await t.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(9) }),
        payload: JSON.stringify({ setupToken: 'fixture-wrong-setup-token', email: 'x@example.invalid', password: PASSWORD_FIXTURE }),
      });
      expect(limited.statusCode).toBe(429);
      expect(errorOf(limited).code).toBe('rate_limited');
      expect(errorOf(limited).retryable).toBe(true);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.headers['x-ratelimit-limit']).toBeUndefined();
      expect(limited.headers['x-ratelimit-remaining']).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('setup 404 after completion is identical to an unknown-route 404 except requestId', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const setup404 = await setupFirstAccount(t.app, 'second@example.invalid');
      const unknown404 = await t.app.inject({
        method: 'POST',
        url: '/api/no-such-route-fixture',
        headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({}),
      });
      expect(unknown404.statusCode).toBe(404);
      expect(redactRequestId(setup404)).toEqual(redactRequestId(unknown404));
    } finally {
      await t.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Register: 404 by design in closed mode (real route).
// ---------------------------------------------------------------------------

describe('L3-real register: 404 by design in closed mode [real route]', () => {
  it.skipIf(!REAL_PRESENT)('register answers 404 not_found and advertises nothing about the mode', async () => {
    const t = await makeRealApp();
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({ email: 'new@example.invalid', password: PASSWORD_FIXTURE }),
      });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('not_found');
      expect(res.body).not.toContain('closed');
      expect(setCookieHeader(res)).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('register 404 is identical to an unknown-route 404 except requestId', async () => {
    const t = await makeRealApp();
    try {
      const register404 = await t.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({ email: 'new@example.invalid', password: PASSWORD_FIXTURE }),
      });
      const unknown404 = await t.app.inject({
        method: 'POST',
        url: '/api/no-such-route-fixture',
        headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({}),
      });
      expect(redactRequestId(register404)).toEqual(redactRequestId(unknown404));
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('register with a wrong Origin answers 403 origin_rejected before the 404', async () => {
    const t = await makeRealApp();
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: jsonHeaders({ origin: EVIL_ORIGIN, 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({ email: 'new@example.invalid', password: PASSWORD_FIXTURE }),
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('origin_rejected');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('register creates no account: a later login answers the same 401 as a never-seen email', async () => {
    const t = await makeRealApp();
    try {
      const registered = await t.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({ email: 'new@example.invalid', password: PASSWORD_FIXTURE }),
      });
      expect(registered.statusCode).toBe(404);
      const afterRegister = await login(t.app, 'new@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(2) });
      const neverSeen = await login(t.app, 'never-seen@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(3) });
      expect(afterRegister.statusCode).toBe(401);
      expect(redactRequestId(afterRegister)).toEqual(redactRequestId(neverSeen));
      expect(await t.store.getUserCount()).toBe(0);
    } finally {
      await t.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Login: anti-enumeration, validation boundary, Bearer rejection.
// ---------------------------------------------------------------------------

describe('L3-real login: generic failures do not distinguish accounts [real route]', () => {
  it.skipIf(!REAL_PRESENT)('unknown email, wrong password, and disabled account share one identical 401', async () => {
    const t = await makeRealApp();
    try {
      const setup = await setupFirstAccount(t.app, 'owner@example.invalid');
      expect(setup.statusCode).toBe(201);
      const ownerId = dataOf<{ id: string }>(setup).id;
      const unknown = await login(t.app, 'nobody@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(11) });
      const wrongPassword = await login(t.app, 'owner@example.invalid', WRONG_PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(12) });
      t.store.setUserStatus(ownerId, 'disabled');
      const disabled = await login(t.app, 'owner@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(13) });
      for (const res of [unknown, wrongPassword, disabled]) {
        expect(res.statusCode).toBe(401);
        expect(errorOf(res).code).toBe('invalid_credentials');
        expect(setCookieHeader(res)).toBeUndefined();
      }
      expect(redactRequestId(unknown)).toEqual(redactRequestId(wrongPassword));
      expect(redactRequestId(unknown)).toEqual(redactRequestId(disabled));
      expect(unknown.body).not.toContain('nobody@example.invalid');
      expect(wrongPassword.body).not.toContain('owner@example.invalid');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a successful login sets a guarded cookie and leaks no secret in the body', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const res = await login(t.app, 'owner@example.invalid', PASSWORD_FIXTURE);
      expect(res.statusCode).toBe(200);
      const data = dataOf<{ id: string; email: string; role: string; totpEnabled: boolean; csrfToken: string; sessionExpiresAt: string }>(res);
      expect(data.email).toBe('owner@example.invalid');
      expect(data.role).toBe('admin');
      expect(data.totpEnabled).toBe(false);
      expect(data.csrfToken.length).toBeGreaterThan(20);
      expect(res.body).not.toContain(PASSWORD_FIXTURE);
      expect(res.body).not.toContain('passwordHash');
      expect(res.body).not.toContain('sessionHash');
      const setCookie = setCookieHeader(res);
      expect(setCookie).toBeDefined();
      expect(setCookie as string).toContain('notegen_session=');
      expect(setCookie as string).toContain('HttpOnly');
      expect(setCookie as string).toContain('SameSite=Lax');
      expect(setCookie as string).toContain('Path=/');
      const maxAge = Number((setCookie as string).match(/Max-Age=(\d+)/)?.[1] ?? '0');
      expect(maxAge).toBeGreaterThan(0);
      expect(maxAge).toBeLessThanOrEqual(30 * 24 * 3600);
      const expiresAt = Date.parse(data.sessionExpiresAt);
      expect(expiresAt - t.nowMs()).toBe(30 * 24 * HOUR_MS);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a request carrying only a Bearer token answers 401 like a request with no credentials', async () => {
    const t = await makeRealApp();
    try {
      const bearer = await t.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: 'Bearer fixture-bearer-only-not-real', 'user-agent': USER_AGENT_A },
      });
      const bare = await t.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { 'user-agent': USER_AGENT_A },
      });
      expect(bearer.statusCode).toBe(401);
      expect(errorOf(bearer).code).toBe('unauthenticated');
      expect(redactRequestId(bearer)).toEqual(redactRequestId(bare));
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a malformed email answers 400 validation_failed, not the generic 401', async () => {
    const t = await makeRealApp();
    try {
      const res = await login(t.app, 'not-an-email', PASSWORD_FIXTURE);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('validation_failed');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('an unknown body field answers 400 validation_failed naming the field', async () => {
    const t = await makeRealApp();
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({ email: 'x@example.invalid', password: PASSWORD_FIXTURE, workspaceId: 'fixture-unknown-field' }),
      });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('validation_failed');
      expect(JSON.stringify(errorOf(res).details)).toContain('workspaceId');
    } finally {
      await t.close();
    }
  });
});

// ---------------------------------------------------------------------------
// No-session denials on every real auth data route.
// ---------------------------------------------------------------------------

describe('L3-real no-session: every real auth data route answers 401 [real routes]', () => {
  const routes: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string }> = [
    { method: 'GET', url: '/api/auth/me' },
    { method: 'GET', url: '/api/auth/sessions' },
    { method: 'GET', url: '/api/auth/csrf' },
    { method: 'POST', url: '/api/auth/logout' },
    { method: 'POST', url: '/api/auth/logout-all' },
    { method: 'DELETE', url: `/api/auth/sessions/${randomUUID()}` },
  ];
  for (const route of routes) {
    it.skipIf(!REAL_PRESENT)(`${route.method} ${route.url} without a session answers 401 unauthenticated`, async () => {
      const t = await makeRealApp();
      try {
        const res = await t.app.inject({
          method: route.method,
          url: route.url,
          headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1) }),
          payload: route.method === 'GET' ? undefined : JSON.stringify({}),
        });
        expect(res.statusCode).toBe(401);
        expect(errorOf(res).code).toBe('unauthenticated');
        expect(errorOf(res).retryable).toBe(false);
        expect(setCookieHeader(res)).toBeUndefined();
      } finally {
        await t.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// CSRF versus Origin: distinct codes, fixed check order (real hook).
// ---------------------------------------------------------------------------

describe('L3-real CSRF and Origin: distinct 403 codes in fixed order [real hook]', () => {
  async function loggedIn(): Promise<{ t: RealApp; session: LoginResult }> {
    const t = await makeRealApp();
    expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
    const session = await loginOk(t.app, 'owner@example.invalid');
    return { t, session };
  }

  it.skipIf(!REAL_PRESENT)('a mutation without a CSRF header answers 403 csrf_invalid', async () => {
    const { t, session } = await loggedIn();
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: jsonHeaders({ cookie: session.cookie, 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('csrf_invalid');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a mutation with a wrong CSRF token answers 403 csrf_invalid', async () => {
    const { t, session } = await loggedIn();
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: mutationHeaders(session.cookie, 'fixture-wrong-csrf-token'),
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('csrf_invalid');
      // The failed mutation did not kill the session.
      const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie, 'user-agent': USER_AGENT_A } });
      expect(me.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a mutation with a correct CSRF token but a wrong Origin answers 403 origin_rejected', async () => {
    const { t, session } = await loggedIn();
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: mutationHeaders(session.cookie, session.csrfToken, { origin: EVIL_ORIGIN }),
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('origin_rejected');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('Origin is checked before CSRF: both wrong answers origin_rejected', async () => {
    const { t, session } = await loggedIn();
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: mutationHeaders(session.cookie, 'fixture-wrong-csrf-token', { origin: EVIL_ORIGIN }),
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('origin_rejected');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('session is checked first: no session plus wrong Origin and CSRF answers 401', async () => {
    const t = await makeRealApp();
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: jsonHeaders({ origin: EVIL_ORIGIN, 'x-csrf-token': 'fixture-wrong-csrf-token', 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('unauthenticated');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a GET with a wrong Origin and no CSRF token still succeeds: GET is exempt', async () => {
    const { t, session } = await loggedIn();
    try {
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: session.cookie, origin: EVIL_ORIGIN, 'user-agent': USER_AGENT_A },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('GET /api/auth/csrf returns the login CSRF token with no-store', async () => {
    const { t, session } = await loggedIn();
    try {
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/auth/csrf',
        headers: { cookie: session.cookie, 'user-agent': USER_AGENT_A },
      });
      expect(res.statusCode).toBe(200);
      expect(dataOf<{ csrfToken: string }>(res).csrfToken).toBe(session.csrfToken);
      expect(res.headers['cache-control']).toContain('no-store');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a CSRF token from another session answers 403 csrf_invalid', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const first = await loginOk(t.app, 'owner@example.invalid');
      const second = await loginOk(t.app, 'owner@example.invalid');
      expect(first.csrfToken).not.toBe(second.csrfToken);
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: mutationHeaders(second.cookie, first.csrfToken),
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('csrf_invalid');
    } finally {
      await t.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Buckets and progressive lockout (real rate-limit logic).
// ---------------------------------------------------------------------------

describe('L3-real buckets and lockout: progressive lockout ladder [real logic]', () => {
  it.skipIf(!REAL_PRESENT)('5 failures per account and IP, then the 6th attempt answers 429 even with the right password', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      for (let i = 0; i < 5; i += 1) {
        const res = await login(t.app, 'owner@example.invalid', WRONG_PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(21) });
        expect(res.statusCode).toBe(401);
      }
      const limited = await login(t.app, 'owner@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(21) });
      expect(limited.statusCode).toBe(429);
      expect(errorOf(limited).code).toBe('rate_limited');
      expect(errorOf(limited).retryable).toBe(true);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.headers['x-ratelimit-limit']).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('lockout level 1 lasts 15 minutes and attempts during lockout do not extend it', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      for (let i = 0; i < 5; i += 1) {
        const res = await login(t.app, 'owner@example.invalid', WRONG_PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(30 + i) });
        expect(res.statusCode).toBe(401);
      }
      const locked = await login(t.app, 'owner@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(40) });
      expect(locked.statusCode).toBe(429);
      expect(limited_retryAfter(locked)).toBe(900);
      t.advance(14 * MINUTE_MS);
      const during = await login(t.app, 'owner@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(41) });
      expect(during.statusCode).toBe(429);
      t.advance(MINUTE_MS + 1000);
      const after = await login(t.app, 'owner@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(42) });
      expect(after.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('lockout level 2 lasts 1 hour after the first lockout expires', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      for (let i = 0; i < 5; i += 1) {
        expect((await login(t.app, 'owner@example.invalid', WRONG_PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(50 + i) })).statusCode).toBe(401);
      }
      expect((await login(t.app, 'owner@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(60) })).statusCode).toBe(429);
      t.advance(15 * MINUTE_MS + 1000);
      for (let i = 0; i < 5; i += 1) {
        expect((await login(t.app, 'owner@example.invalid', WRONG_PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(70 + i) })).statusCode).toBe(401);
      }
      const locked = await login(t.app, 'owner@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(80) });
      expect(locked.statusCode).toBe(429);
      expect(limited_retryAfter(locked)).toBe(3600);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a successful login clears the lockout count: 5 fresh failures are 401s again', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      for (let i = 0; i < 4; i += 1) {
        expect((await login(t.app, 'owner@example.invalid', WRONG_PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(90 + i) })).statusCode).toBe(401);
      }
      expect((await login(t.app, 'owner@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(100) })).statusCode).toBe(200);
      for (let i = 0; i < 5; i += 1) {
        expect((await login(t.app, 'owner@example.invalid', WRONG_PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(110 + i) })).statusCode).toBe(401);
      }
      expect((await login(t.app, 'owner@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(120) })).statusCode).toBe(429);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('password spraying is capped per IP: 20 failures across accounts, then 429', async () => {
    const t = await makeRealApp();
    try {
      for (let i = 0; i < 20; i += 1) {
        const res = await login(t.app, `spray-${i}@example.invalid`, WRONG_PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(130) });
        expect(res.statusCode).toBe(401);
      }
      const limited = await login(t.app, 'spray-20@example.invalid', WRONG_PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(130) });
      expect(limited.statusCode).toBe(429);
      expect(errorOf(limited).code).toBe('rate_limited');
    } finally {
      await t.close();
    }
  });
});

function limited_retryAfter(res: InjectResponse): number {
  return Number(res.headers['retry-after']);
}

// ---------------------------------------------------------------------------
// Sessions: rotation, idle and absolute expiry, epoch, logout-all, revoke.
// ---------------------------------------------------------------------------

describe('L3-real sessions: rotation, expiry, epoch, logout-all, revoke [real routes]', () => {
  it.skipIf(!REAL_PRESENT)('two logins mint distinct sessions; logging out one leaves the other valid', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const first = await loginOk(t.app, 'owner@example.invalid');
      const second = await loginOk(t.app, 'owner@example.invalid');
      expect(first.cookie).not.toBe(second.cookie);
      const logout = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: mutationHeaders(first.cookie, first.csrfToken),
        payload: JSON.stringify({}),
      });
      expect(logout.statusCode).toBe(200);
      const dead = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first.cookie, 'user-agent': USER_AGENT_A } });
      expect(dead.statusCode).toBe(401);
      const alive = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: second.cookie, 'user-agent': USER_AGENT_A } });
      expect(alive.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a pre-login cookie is never adopted: login mints a fresh session id (no fixation)', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: jsonHeaders({ cookie: 'notegen_session=fixture-planted-cookie-value', 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({ email: 'owner@example.invalid', password: PASSWORD_FIXTURE }),
      });
      expect(res.statusCode).toBe(200);
      expect(cookiePair(res)).not.toContain('fixture-planted-cookie-value');
      const planted = await t.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: 'notegen_session=fixture-planted-cookie-value', 'user-agent': USER_AGENT_A },
      });
      expect(planted.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('logout clears the cookie with Max-Age 0 and the session stays dead', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const session = await loginOk(t.app, 'owner@example.invalid');
      const logout = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: mutationHeaders(session.cookie, session.csrfToken),
        payload: JSON.stringify({}),
      });
      expect(logout.statusCode).toBe(200);
      const cleared = setCookieHeader(logout);
      expect(cleared).toBeDefined();
      expect(cleared as string).toContain('Max-Age=0');
      expect(cleared as string).toContain('HttpOnly');
      expect(cleared as string).toContain('SameSite=Lax');
      const again = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: mutationHeaders(session.cookie, session.csrfToken),
        payload: JSON.stringify({}),
      });
      expect(again.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('an idle session dies after 24 hours without activity', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const session = await loginOk(t.app, 'owner@example.invalid');
      t.advance(24 * HOUR_MS + 1000);
      const res = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie, 'user-agent': USER_AGENT_A } });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('unauthenticated');
      expect(t.store.sessionCountForUser(session.userId)).toBe(0);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('absolute expiry kills a session after 30 days despite regular activity', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const session = await loginOk(t.app, 'owner@example.invalid');
      for (let step = 0; step < 31; step += 1) {
        t.advance(23 * HOUR_MS);
        const res = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie, 'user-agent': USER_AGENT_A } });
        expect(res.statusCode).toBe(200);
      }
      t.advance(23 * HOUR_MS);
      const expired = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie, 'user-agent': USER_AGENT_A } });
      expect(expired.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a credential epoch bump invalidates every session at once', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const first = await loginOk(t.app, 'owner@example.invalid');
      const second = await loginOk(t.app, 'owner@example.invalid');
      const epochBefore = t.store.getUserEpoch(first.userId);
      t.store.setUserEpoch(first.userId, (epochBefore ?? 1) + 1);
      for (const session of [first, second]) {
        const res = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie, 'user-agent': USER_AGENT_A } });
        expect(res.statusCode).toBe(401);
        expect(errorOf(res).code).toBe('unauthenticated');
      }
      expect(t.store.sessionCountForUser(first.userId)).toBe(0);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('logout-all without a fresh step-up answers 403 step_up_required and sessions survive', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const session = await loginOk(t.app, 'owner@example.invalid');
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout-all',
        headers: mutationHeaders(session.cookie, session.csrfToken),
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('step_up_required');
      const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie, 'user-agent': USER_AGENT_A } });
      expect(me.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('logout-all with a fresh step-up revokes all sessions, bumps the epoch, and clears the cookie', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const first = await loginOk(t.app, 'owner@example.invalid');
      const second = await loginOk(t.app, 'owner@example.invalid');
      const rows = await t.store.listSessionsByUser(first.userId);
      const current = rows.find((row) => row.sessionHash === sha256Hex(first.cookie.split('=')[1] ?? ''));
      expect(current).toBeDefined();
      t.store.setSessionStepUp((current as FakeSessionRow).id, new Date(t.nowMs()));
      const epochBefore = t.store.getUserEpoch(first.userId);
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout-all',
        headers: mutationHeaders(first.cookie, first.csrfToken),
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(200);
      expect(setCookieHeader(res)).toContain('Max-Age=0');
      expect(t.store.getUserEpoch(first.userId)).toBe((epochBefore ?? 1) + 1);
      expect(t.store.sessionCountForUser(first.userId)).toBe(0);
      for (const session of [first, second]) {
        const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie, 'user-agent': USER_AGENT_A } });
        expect(me.statusCode).toBe(401);
      }
      const relogin = await login(t.app, 'owner@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(2) });
      expect(relogin.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('logout-all step-up freshness is inclusive at exactly 15 minutes', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const session = await loginOk(t.app, 'owner@example.invalid');
      const rows = await t.store.listSessionsByUser(session.userId);
      t.store.setSessionStepUp((rows[0] as FakeSessionRow).id, new Date(t.nowMs()));
      t.advance(15 * MINUTE_MS);
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout-all',
        headers: mutationHeaders(session.cookie, session.csrfToken),
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('logout-all step-up freshness expires 1 ms past 15 minutes', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const session = await loginOk(t.app, 'owner@example.invalid');
      const rows = await t.store.listSessionsByUser(session.userId);
      t.store.setSessionStepUp((rows[0] as FakeSessionRow).id, new Date(t.nowMs()));
      t.advance(15 * MINUTE_MS + 1);
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout-all',
        headers: mutationHeaders(session.cookie, session.csrfToken),
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('step_up_required');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('revoking another own session kills only that session', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const first = await loginOk(t.app, 'owner@example.invalid');
      const second = await loginOk(t.app, 'owner@example.invalid');
      const list = await t.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: first.cookie, 'user-agent': USER_AGENT_A } });
      const entries = dataOf<Array<{ id: string; isCurrent: boolean }>>(list);
      const other = entries.find((entry) => !entry.isCurrent);
      expect(other).toBeDefined();
      const revoke = await t.app.inject({
        method: 'DELETE',
        url: `/api/auth/sessions/${(other as { id: string }).id}`,
        headers: deleteHeaders(first.cookie, first.csrfToken),
      });
      expect(revoke.statusCode).toBe(200);
      const dead = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: second.cookie, 'user-agent': USER_AGENT_A } });
      expect(dead.statusCode).toBe(401);
      const alive = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first.cookie, 'user-agent': USER_AGENT_A } });
      expect(alive.statusCode).toBe(200);
      const repeat = await t.app.inject({
        method: 'DELETE',
        url: `/api/auth/sessions/${(other as { id: string }).id}`,
        headers: deleteHeaders(first.cookie, first.csrfToken),
      });
      expect(repeat.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('revoking an unknown id and another account id share one identical 404', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const first = await loginOk(t.app, 'owner@example.invalid');
      t.store.insertUser({ email: 'other@example.invalid', password: PASSWORD_FIXTURE });
      const other = await loginOk(t.app, 'other@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(2) });
      const otherList = await t.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: other.cookie, 'user-agent': USER_AGENT_A } });
      const otherId = (dataOf<Array<{ id: string }>>(otherList)[0] as { id: string }).id;
      const foreign = await t.app.inject({
        method: 'DELETE',
        url: `/api/auth/sessions/${otherId}`,
        headers: deleteHeaders(first.cookie, first.csrfToken),
      });
      const unknown = await t.app.inject({
        method: 'DELETE',
        url: `/api/auth/sessions/${randomUUID()}`,
        headers: deleteHeaders(first.cookie, first.csrfToken),
      });
      const malformed = await t.app.inject({
        method: 'DELETE',
        url: '/api/auth/sessions/not-a-uuid',
        headers: deleteHeaders(first.cookie, first.csrfToken),
      });
      expect(foreign.statusCode).toBe(404);
      expect(redactRequestId(foreign)).toEqual(redactRequestId(unknown));
      expect(redactRequestId(foreign)).toEqual(redactRequestId(malformed));
      const otherAlive = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: other.cookie, 'user-agent': USER_AGENT_A } });
      expect(otherAlive.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('the session list leaks no hashes or tokens and flags only the current session', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const first = await loginOk(t.app, 'owner@example.invalid');
      await loginOk(t.app, 'owner@example.invalid');
      t.store.insertUser({ email: 'other@example.invalid', password: PASSWORD_FIXTURE });
      await loginOk(t.app, 'other@example.invalid', PASSWORD_FIXTURE, { 'x-forwarded-for': forwardedFor(2) });
      const list = await t.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: first.cookie, 'user-agent': USER_AGENT_A } });
      expect(list.statusCode).toBe(200);
      const entries = dataOf<Array<{ id: string; isCurrent: boolean; deviceLabel: string }>>(list);
      expect(entries).toHaveLength(2);
      expect(entries.filter((entry) => entry.isCurrent)).toHaveLength(1);
      expect(list.body).not.toContain('sessionHash');
      expect(list.body).not.toContain('csrfToken');
      expect(list.body).not.toContain('csrf_token');
      expect(entries[0]?.deviceLabel).toBeDefined();
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('disabling an account kills its sessions immediately and re-enabling does not revive them', async () => {
    const t = await makeRealApp();
    try {
      const setup = await setupFirstAccount(t.app, 'owner@example.invalid');
      const ownerId = dataOf<{ id: string }>(setup).id;
      const session = await loginOk(t.app, 'owner@example.invalid');
      t.store.setUserStatus(ownerId, 'disabled');
      const disabled = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie, 'user-agent': USER_AGENT_A } });
      expect(disabled.statusCode).toBe(401);
      t.store.setUserStatus(ownerId, 'active');
      const revived = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie, 'user-agent': USER_AGENT_A } });
      expect(revived.statusCode).toBe(401);
      expect(t.store.sessionCountForUser(ownerId)).toBe(0);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('rotation kills the old session id, keeps the absolute expiry, and mints a new CSRF token', async () => {
    const t = await makeRealApp();
    try {
      expect((await setupFirstAccount(t.app, 'owner@example.invalid')).statusCode).toBe(201);
      const session = await loginOk(t.app, 'owner@example.invalid');
      const rows = await t.store.listSessionsByUser(session.userId);
      const oldRow = rows[0] as FakeSessionRow;
      const fakeRequest = { headers: { 'user-agent': USER_AGENT_A }, ip: '127.0.0.1' };
      const rotated = await real().rotateSessionForRow(t.context, t.store, oldRow, fakeRequest, new Date(t.nowMs()), new Date(t.nowMs()));
      expect(rotated.row.id).not.toBe(oldRow.id);
      expect(rotated.row.absoluteExpiresAt.getTime()).toBe(oldRow.absoluteExpiresAt.getTime());
      expect(rotated.row.createdAt.getTime()).toBe(oldRow.createdAt.getTime());
      expect(rotated.csrfToken).not.toBe(session.csrfToken);
      expect(rotated.sessionId).not.toBe(session.cookie.split('=')[1]);
      expect(rotated.row.stepUpAt?.getTime()).toBe(t.nowMs());
      const oldDead = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie, 'user-agent': USER_AGENT_A } });
      expect(oldDead.statusCode).toBe(401);
      const newAlive = await t.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: `notegen_session=${rotated.sessionId}`, 'user-agent': USER_AGENT_A },
      });
      expect(newAlive.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Login step 2: TOTP challenge and recovery codes (real routes).
// ---------------------------------------------------------------------------

describe('L3-real TOTP step: challenges, replay, recovery codes [real routes]', () => {
  async function totpUser(): Promise<{ t: RealApp; userId: string }> {
    const t = await makeRealApp();
    const user = t.store.insertUser({ email: 'totp@example.invalid', password: PASSWORD_FIXTURE, totpEnabled: true });
    const key = real().deriveSealKey(ENCRYPTION_KEY_FIXTURE);
    expect(key).not.toBeNull();
    const sealed = real().sealTotpSecret(TOTP_SECRET_BASE32, key as Buffer);
    t.store.seedTotpCredential(user.id, sealed, real().TOTP_SEAL_KEY_VERSION);
    return { t, userId: user.id };
  }

  function currentCode(t: RealApp): string {
    const counter = Math.floor(t.nowMs() / 30000);
    return real().totpCodeAt(real().decodeBase32(TOTP_SECRET_BASE32), counter);
  }

  async function startChallenge(app: FastifyInstance, extra: Record<string, string> = {}): Promise<string> {
    const res = await login(app, 'totp@example.invalid', PASSWORD_FIXTURE, extra);
    expect(res.statusCode).toBe(202);
    expect(setCookieHeader(res)).toBeUndefined();
    return dataOf<{ challengeToken: string; step: string }>(res).challengeToken;
  }

  async function submitCode(
    app: FastifyInstance,
    challengeToken: string,
    code: string,
    extra: Record<string, string> = {},
  ): Promise<InjectResponse> {
    return app.inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1), ...extra }),
      payload: JSON.stringify({ challengeToken, code }),
    });
  }

  it.skipIf(!REAL_PRESENT)('password success with TOTP on answers 202 with a challenge and no cookie or session', async () => {
    const { t, userId } = await totpUser();
    try {
      const challenge = await startChallenge(t.app);
      expect(challenge.length).toBeGreaterThan(20);
      expect(t.store.sessionCountForUser(userId)).toBe(0);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('an unknown challenge answers 401 invalid_verification_code', async () => {
    const { t } = await totpUser();
    try {
      const res = await submitCode(t.app, 'fixture-unknown-challenge-token', '123456');
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('invalid_verification_code');
      expect(setCookieHeader(res)).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('an expired challenge answers 401 invalid_verification_code', async () => {
    const { t } = await totpUser();
    try {
      const challenge = await startChallenge(t.app);
      t.advance(real().LOGIN_CHALLENGE_MS + 1);
      const res = await submitCode(t.app, challenge, currentCode(t));
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('invalid_verification_code');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('five wrong codes delete the challenge: a correct code afterwards still answers 401', async () => {
    const { t } = await totpUser();
    try {
      const challenge = await startChallenge(t.app);
      for (let i = 0; i < 5; i += 1) {
        const res = await submitCode(t.app, challenge, '000000');
        expect(res.statusCode).toBe(401);
        expect(errorOf(res).code).toBe('invalid_verification_code');
      }
      const after = await submitCode(t.app, challenge, currentCode(t));
      expect(after.statusCode).toBe(401);
      expect(errorOf(after).code).toBe('invalid_verification_code');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a correct code answers 200 with a session, and replaying it answers 401', async () => {
    const { t } = await totpUser();
    try {
      const challenge = await startChallenge(t.app);
      const ok = await submitCode(t.app, challenge, currentCode(t));
      expect(ok.statusCode).toBe(200);
      expect(setCookieHeader(ok)).toBeDefined();
      const second = await startChallenge(t.app);
      const replay = await submitCode(t.app, second, currentCode(t));
      expect(replay.statusCode).toBe(401);
      expect(errorOf(replay).code).toBe('invalid_verification_code');
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a User-Agent change between steps answers 401 and deletes the challenge', async () => {
    const { t } = await totpUser();
    try {
      const challenge = await startChallenge(t.app);
      const mismatched = await submitCode(t.app, challenge, currentCode(t), { 'user-agent': USER_AGENT_B });
      expect(mismatched.statusCode).toBe(401);
      expect(errorOf(mismatched).code).toBe('invalid_verification_code');
      const after = await submitCode(t.app, challenge, currentCode(t));
      expect(after.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it.skipIf(!REAL_PRESENT)('a recovery code works once, normalizes formatting, and cannot be reused', async () => {
    const { t, userId } = await totpUser();
    try {
      t.store.seedRecoveryCode(userId, sha256Hex(RECOVERY_CODE_FIXTURE.replace(/[\\s-]/g, '')));
      const challenge = await startChallenge(t.app);
      const ok = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({ challengeToken: challenge, recoveryCode: 'ABCD EFGH IJKL MNOP' }),
      });
      expect(ok.statusCode).toBe(200);
      const second = await startChallenge(t.app);
      const reuse = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: jsonHeaders({ 'x-forwarded-for': forwardedFor(1) }),
        payload: JSON.stringify({ challengeToken: second, recoveryCode: RECOVERY_CODE_FIXTURE }),
      });
      expect(reuse.statusCode).toBe(401);
      expect(errorOf(reuse).code).toBe('invalid_verification_code');
    } finally {
      await t.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Real Argon2id hasher round-trip (the one place the real hasher runs).
// ---------------------------------------------------------------------------

describe('L3-real Argon2id: the production hasher verifies and rejects [real code]', () => {
  it.skipIf(!REAL_PRESENT)('the real Argon2 hasher round-trips a password and rejects a wrong one', async () => {
    const hasher = new (real().Argon2PasswordHasher)();
    const hash = await hasher.hash(PASSWORD_FIXTURE);
    expect(hash).toContain('$argon2id$');
    expect(await hasher.verify(hash, PASSWORD_FIXTURE)).toBe(true);
    expect(await hasher.verify(hash, WRONG_PASSWORD_FIXTURE)).toBe(false);
    expect(await hasher.verify('not-a-phc-hash', PASSWORD_FIXTURE)).toBe(false);
    expect(hasher.needsRehash(hash)).toBe(false);
  });
});
