// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the four TOTP enrollment routes (kontrak-api-kanonis.md
// section 3.12; desain-auth.md section 1.4; V3-02 part 4), through
// buildApp with inject() and a fake store. The routes are registered
// on the built app because the integrator wires them into app.ts
// (AD-57: this batch must not edit app.ts); the frozen hook, the
// real session/CSRF verifiers, and the real auth-core login routes
// all run, so hook ordering and session rotation are exercised for
// real.
//
// Step-up is simulated the way the auth-core spec simulates it for
// logout-all: a session row created directly with stepUpAt set to
// the test clock. The step-up endpoint itself belongs to a sibling
// worker; what these tests pin is that the routes read stepUpAt
// freshness exactly as logout-all does, including the 15-minute
// boundary. The enrollment store is a fake over the FakeAuthStore
// maps implementing the same TotpEnrollmentStore port the Drizzle
// implementation serves in production.
//
// What is pinned here: start shows a fresh otpauth URL plus Base32
// secret once and stores only the sealed secret, in the stage
// table apart from the live credential row, so staging never
// disturbs TOTP login; confirm activates TOTP, rotates the current
// session, kills other sessions, and never bumps the epoch; a
// stage older than 15 minutes is deleted and answers the generic
// code error, for a first enrollment or a re-enrollment alike,
// leaving any live credential untouched; disable accepts a TOTP
// code or a recovery code, clears credential plus codes in one
// logical step, and answers success without proof when already
// disabled; regenerate replaces the whole batch with exactly 10
// fresh codes shown once and accepts only a TOTP code; every route
// without a fresh step-up answers 403 step_up_required; every
// proof failure shares one generic 401 invalid_verification_code;
// and start fails closed with 503 when no encryption key is
// configured.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveCsrfToken, hashToken, newOpaqueToken } from '../src/auth/crypto.js';
import { currentTotpCounter, decodeBase32, normalizeRecoveryCode, totpCodeAt } from '../src/auth/totp-verify.js';
import type { RecoveryCodeRow } from '../src/auth/store.js';
import { registerAuthTotpRoutes } from '../src/routes/auth-totp.js';
import {
  RECOVERY_CODE_COUNT,
  type ActivateEnrollmentInput,
  type RecoveryBatchInput,
  type StageCredentialInput,
  type TotpEnrollmentStageRow,
  type TotpEnrollmentStore,
} from '../src/services/auth/totp-enroll.js';
import { FakeAuthStore } from './auth/fake-store.js';
import {
  bodyOf,
  buildTestApp,
  cookieFromResponse,
  loginAs,
  makeTestAuth,
  publicHeaders,
  seedLoggedInUser,
  sessionHeaders,
  TEST_AUTH_SECRET,
  USER_AGENT,
  type TestAuth,
} from './auth/helpers.js';

const PASSWORD = 'a-long-enough-password';
const STEP_MS = 31 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function codeFor(secretBase32: string, nowMs: number): string {
  return totpCodeAt(decodeBase32(secretBase32), currentTotpCounter(nowMs));
}

function jsonPayload(payload: unknown): { payload: string; headers: Record<string, string> } {
  return { payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } };
}

// Fake TotpEnrollmentStore over the FakeAuthStore maps. It mirrors
// the Drizzle implementation's observable effects (upsert stage
// into the stages map, transactional activate/disable/replace,
// delete-other-sessions) without Postgres. Stages and live
// credentials are separate maps, exactly as they are separate
// tables in production.
class FakeTotpEnrollmentStore implements TotpEnrollmentStore {
  constructor(private readonly fake: FakeAuthStore) {}

  async stageCredential(input: StageCredentialInput): Promise<void> {
    this.fake.stages.set(input.userId, {
      userId: input.userId,
      secretSealed: input.secretSealed,
      keyVersion: input.keyVersion,
      stagedAt: input.stagedAt,
    });
  }

  async findStage(userId: string): Promise<TotpEnrollmentStageRow | null> {
    return this.fake.stages.get(userId) ?? null;
  }

  async deleteStage(userId: string): Promise<void> {
    this.fake.stages.delete(userId);
  }

  async activateEnrollment(input: ActivateEnrollmentInput): Promise<boolean> {
    const stage = this.fake.stages.get(input.userId);
    if (stage === undefined) {
      return false;
    }
    this.fake.totp.set(input.userId, {
      userId: input.userId,
      secretSealed: stage.secretSealed,
      keyVersion: stage.keyVersion,
      lastUsedStep: input.totpStep,
      enrolledAt: input.enrolledAt,
      verifiedAt: input.verifiedAt,
    });
    const user = this.fake.users.get(input.userId);
    if (user !== undefined) {
      user.totpEnabled = true;
      user.updatedAt = input.enrolledAt;
    }
    this.insertBatch(input.userId, input.batch);
    this.fake.stages.delete(input.userId);
    return true;
  }

  async disableTotp(userId: string, at: Date): Promise<void> {
    this.fake.stages.delete(userId);
    this.fake.totp.delete(userId);
    this.fake.recovery = this.fake.recovery.filter((row) => row.userId !== userId);
    const user = this.fake.users.get(userId);
    if (user !== undefined) {
      user.totpEnabled = false;
      user.updatedAt = at;
    }
  }

  async replaceRecoveryCodes(userId: string, batch: RecoveryBatchInput): Promise<void> {
    this.insertBatch(userId, batch);
  }

  async deleteOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    let count = 0;
    for (const row of [...this.fake.sessions.values()]) {
      if (row.userId === userId && row.id !== keepSessionId) {
        this.fake.sessions.delete(row.id);
        this.fake.sessionsByHash.delete(row.sessionHash);
        count += 1;
      }
    }
    return count;
  }

  private insertBatch(userId: string, batch: RecoveryBatchInput): void {
    this.fake.recovery = this.fake.recovery.filter((row) => row.userId !== userId);
    for (const codeHash of batch.codeHashes) {
      const row: RecoveryCodeRow = {
        id: randomUUID(),
        userId,
        codeHash,
        batchId: batch.batchId,
        usedAt: null,
        createdAt: batch.createdAt,
      };
      this.fake.recovery.push(row);
    }
  }
}

interface SteppedSession {
  cookie: string;
  csrfToken: string;
  userId: string;
}

// A session with a fresh step-up at the current test clock, built
// the way the auth-core spec builds one for logout-all.
async function steppedUpSession(fixture: TestAuth, email: string): Promise<SteppedSession> {
  const hash = await fixture.hasher.hash(PASSWORD);
  const user = fixture.store.seedUser({ email, passwordHash: hash });
  const sessionId = newOpaqueToken();
  const sessionHash = hashToken(sessionId);
  const csrfToken = deriveCsrfToken(sessionHash, TEST_AUTH_SECRET);
  const now = new Date(fixture.clock.nowMs);
  await fixture.store.createSession({
    userId: user.id,
    sessionHash,
    csrfTokenHash: hashToken(csrfToken),
    credentialEpoch: user.credentialEpoch,
    deviceLabel: 'Stepped up device',
    userAgent: USER_AGENT,
    createdIp: '127.0.0.1',
    lastSeenIp: '127.0.0.1',
    createdAt: now,
    lastSeenAt: now,
    absoluteExpiresAt: new Date(fixture.clock.nowMs + 30 * 24 * 60 * 60 * 1000),
    stepUpAt: now,
  });
  return { cookie: `notegen_session=${sessionId}`, csrfToken, userId: user.id };
}

async function enrollStart(
  app: FastifyInstance,
  session: SteppedSession,
): Promise<{ otpauthUrl: string; secret: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/totp/enroll/start',
    headers: sessionHeaders(session.cookie, session.csrfToken),
  });
  expect(res.statusCode).toBe(200);
  return bodyOf(res).data as { otpauthUrl: string; secret: string };
}

// Runs start plus confirm for a stepped-up session and returns the
// staged secret plus the rotated session from the confirm response.
async function enrollFully(
  app: FastifyInstance,
  fixture: TestAuth,
  session: SteppedSession,
): Promise<{ secret: string; cookie: string; csrfToken: string }> {
  const started = await enrollStart(app, session);
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/totp/enroll/confirm',
    headers: { ...sessionHeaders(session.cookie, session.csrfToken), ...jsonPayload({}).headers },
    payload: JSON.stringify({ code: codeFor(started.secret, fixture.clock.nowMs) }),
  });
  expect(res.statusCode).toBe(200);
  const cookie = cookieFromResponse(res);
  expect(cookie).toBeDefined();
  const csrfToken = (bodyOf(res).data as { csrfToken: string }).csrfToken;
  return { secret: started.secret, cookie: cookie as string, csrfToken };
}

// Logs in through the real two-step login flow and returns the
// step-2 status code, so re-enrollment tests can prove from
// outside the enrollment routes that the live credential still
// verifies (or no longer does) while a stage is pending.
async function loginWithTotp(app: FastifyInstance, email: string, code: string): Promise<number> {
  const first = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: publicHeaders({ 'content-type': 'application/json' }),
    payload: { email, password: PASSWORD },
  });
  expect(first.statusCode).toBe(202);
  const challengeToken = (bodyOf(first).data as { challengeToken: string }).challengeToken;
  const second = await app.inject({
    method: 'POST',
    url: '/api/auth/login/totp',
    headers: publicHeaders({ 'content-type': 'application/json' }),
    payload: { challengeToken, code },
  });
  return second.statusCode;
}

describe('TOTP enrollment routes', () => {
  let fixture: TestAuth;
  let app: FastifyInstance;

  beforeEach(async () => {
    fixture = makeTestAuth();
    app = await buildTestApp(fixture.auth);
    await registerAuthTotpRoutes(app, { auth: fixture.auth, enrollment: new FakeTotpEnrollmentStore(fixture.store) });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /api/auth/totp/enroll/start', () => {
    it('shows a fresh otpauth URL plus Base32 secret once, sealed at rest, with no-store', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/start',
        headers: sessionHeaders(session.cookie, session.csrfToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const data = bodyOf(res).data as { otpauthUrl: string; secret: string };
      expect(data.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(data.otpauthUrl).toBe(
        `otpauth://totp/NoteGen:a%40example.invalid?secret=${data.secret}&issuer=NoteGen&digits=6&period=30`,
      );
      // The staged secret lives in the stage table, not in the live
      // credential row: no credential exists until confirm.
      expect(await fixture.store.findTotpCredential(session.userId)).toBeNull();
      const stage = fixture.store.stages.get(session.userId);
      expect(stage).toBeDefined();
      expect(stage?.secretSealed).not.toContain(data.secret);
      expect(stage?.keyVersion).toBe(1);
      expect((await fixture.store.findUserById(session.userId))?.totpEnabled).toBe(false);
      // Show-once: /me never carries the secret or the otpauth URL.
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.body).not.toContain(data.secret);
      expect(me.body).not.toContain('otpauth://');
    });

    it('generates a fresh secret on a repeat start instead of re-serving the staged one', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const first = await enrollStart(app, session);
      const second = await enrollStart(app, session);
      expect(second.secret).not.toBe(first.secret);
      expect(second.otpauthUrl).not.toBe(first.otpauthUrl);
    });

    it('requires a fresh step-up', async () => {
      const { cookie, csrfToken } = await seedLoggedInUser(fixture, app, {
        email: 'a@example.invalid',
        password: PASSWORD,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/start',
        headers: sessionHeaders(cookie, csrfToken),
      });
      expect(res.statusCode).toBe(403);
      expect(bodyOf(res).error?.code).toBe('step_up_required');
    });

    it('rejects a step-up older than 15 minutes', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      fixture.clock.advance(FIFTEEN_MINUTES_MS + 1000);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/start',
        headers: sessionHeaders(session.cookie, session.csrfToken),
      });
      expect(res.statusCode).toBe(403);
      expect(bodyOf(res).error?.code).toBe('step_up_required');
    });

    it('answers 401 without a session and 403 without a CSRF token', async () => {
      const noSession = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/start',
        headers: publicHeaders(),
      });
      expect(noSession.statusCode).toBe(401);
      expect(bodyOf(noSession).error?.code).toBe('unauthenticated');
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const noCsrf = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/start',
        headers: { cookie: session.cookie, origin: publicHeaders().origin },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(bodyOf(noCsrf).error?.code).toBe('csrf_invalid');
    });
  });

  describe('POST /api/auth/totp/enroll/confirm', () => {
    it('activates TOTP, rotates the session, kills other sessions, and keeps the epoch', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const other = await loginAs(app, 'a@example.invalid', PASSWORD);
      const started = await enrollStart(app, session);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/confirm',
        headers: { ...sessionHeaders(session.cookie, session.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: codeFor(started.secret, fixture.clock.nowMs) }),
      });
      expect(res.statusCode).toBe(200);
      const data = bodyOf(res).data as { totpEnabled: boolean; csrfToken: string };
      expect(data.totpEnabled).toBe(true);
      expect(typeof data.csrfToken).toBe('string');
      const user = await fixture.store.findUserById(session.userId);
      expect(user?.totpEnabled).toBe(true);
      expect(user?.credentialEpoch).toBe(1);
      const credential = await fixture.store.findTotpCredential(session.userId);
      expect(credential?.verifiedAt).not.toBeNull();
      const recovery = fixture.store.recovery.filter((row) => row.userId === session.userId);
      expect(recovery).toHaveLength(RECOVERY_CODE_COUNT);
      expect(new Set(recovery.map((row) => row.batchId)).size).toBe(1);
      expect(fixture.store.auditEvents.map((event) => event.eventType)).toContain('totp_enrolled');
      const rotatedCookie = cookieFromResponse(res);
      expect(rotatedCookie).toBeDefined();
      expect(rotatedCookie).not.toBe(session.cookie);
      const dead = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: other.cookie } });
      expect(dead.statusCode).toBe(401);
      const alive = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: rotatedCookie as string },
      });
      expect(alive.statusCode).toBe(200);
    });

    it('rejects a wrong code with the generic 401 and leaves TOTP disabled', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      await enrollStart(app, session);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/confirm',
        headers: { ...sessionHeaders(session.cookie, session.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: '000000' }),
      });
      expect(res.statusCode).toBe(401);
      expect(bodyOf(res).error?.code).toBe('invalid_verification_code');
      expect((await fixture.store.findUserById(session.userId))?.totpEnabled).toBe(false);
    });

    it('rejects a replayed confirmation code: the claimed step cannot confirm twice', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const started = await enrollStart(app, session);
      const code = codeFor(started.secret, fixture.clock.nowMs);
      const first = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/confirm',
        headers: { ...sessionHeaders(session.cookie, session.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code }),
      });
      expect(first.statusCode).toBe(200);
      // Same code, rotated session (step-up preserved): the stage
      // was consumed by the first confirm, so there is nothing
      // left to confirm and the generic 401 must answer. The
      // confirmed step is also recorded on the live credential,
      // so the same code cannot pass login either.
      const rotatedCookie = cookieFromResponse(first) as string;
      const rotatedCsrf = (bodyOf(first).data as { csrfToken: string }).csrfToken;
      const replay = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/confirm',
        headers: { ...sessionHeaders(rotatedCookie, rotatedCsrf), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code }),
      });
      expect(replay.statusCode).toBe(401);
      expect(bodyOf(replay).error?.code).toBe('invalid_verification_code');
      expect((await fixture.store.findUserById(session.userId))?.totpEnabled).toBe(true);
    });

    it('deletes an expired stage and answers the generic 401', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const started = await enrollStart(app, session);
      fixture.clock.advance(FIFTEEN_MINUTES_MS + 1000);
      // Re-establish a fresh step-up at the new clock so the failure
      // is the stage expiry, not step-up staleness.
      const steppedAgain = await steppedUpSessionForUser(fixture, session.userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/confirm',
        headers: { ...sessionHeaders(steppedAgain.cookie, steppedAgain.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: codeFor(started.secret, fixture.clock.nowMs) }),
      });
      expect(res.statusCode).toBe(401);
      expect(bodyOf(res).error?.code).toBe('invalid_verification_code');
      expect(fixture.store.stages.get(session.userId)).toBeUndefined();
      expect(await fixture.store.findTotpCredential(session.userId)).toBeNull();
      expect((await fixture.store.findUserById(session.userId))?.totpEnabled).toBe(false);
    });

    it('answers the generic 401 with no staged secret and requires step-up', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/confirm',
        headers: { ...sessionHeaders(session.cookie, session.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: '123456' }),
      });
      expect(res.statusCode).toBe(401);
      expect(bodyOf(res).error?.code).toBe('invalid_verification_code');
      const { cookie, csrfToken } = await seedLoggedInUser(fixture, app, {
        email: 'b@example.invalid',
        password: PASSWORD,
      });
      const noStepUp = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/confirm',
        headers: { ...sessionHeaders(cookie, csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: '123456' }),
      });
      expect(noStepUp.statusCode).toBe(403);
      expect(bodyOf(noStepUp).error?.code).toBe('step_up_required');
    });

    it('rejects unknown fields and a missing code with validation_failed', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/confirm',
        headers: { ...sessionHeaders(session.cookie, session.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: '123456', extra: true }),
      });
      expect(res.statusCode).toBe(400);
      expect(bodyOf(res).error?.code).toBe('validation_failed');
    });
  });

  describe('re-enrollment keeps the live credential (DA-02-F03)', () => {
    it('start stages a replacement without touching the live credential or TOTP login', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const enrolled = await enrollFully(app, fixture, session);
      const before = await fixture.store.findTotpCredential(session.userId);
      expect(before).not.toBeNull();
      const liveSealed = before?.secretSealed;
      fixture.clock.advance(STEP_MS);
      const stepped = await steppedUpSessionForUser(fixture, session.userId);
      const staged = await enrollStart(app, stepped);
      expect(staged.secret).not.toBe(enrolled.secret);
      const stage = fixture.store.stages.get(session.userId);
      expect(stage).toBeDefined();
      expect(stage?.secretSealed).not.toBe(liveSealed);
      const after = await fixture.store.findTotpCredential(session.userId);
      expect(after?.secretSealed).toBe(liveSealed);
      expect(after?.enrolledAt).toEqual(before?.enrolledAt);
      expect((await fixture.store.findUserById(session.userId))?.totpEnabled).toBe(true);
      // The old authenticator secret still logs in while a stage
      // is pending: login never reads the stage table.
      fixture.clock.advance(STEP_MS);
      expect(await loginWithTotp(app, 'a@example.invalid', codeFor(enrolled.secret, fixture.clock.nowMs))).toBe(
        200,
      );
    });

    it('an expired re-enrollment stage is deleted and the live credential survives', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const enrolled = await enrollFully(app, fixture, session);
      const liveSealed = (await fixture.store.findTotpCredential(session.userId))?.secretSealed;
      fixture.clock.advance(STEP_MS);
      const stepped = await steppedUpSessionForUser(fixture, session.userId);
      const staged = await enrollStart(app, stepped);
      fixture.clock.advance(FIFTEEN_MINUTES_MS + 1000);
      // Re-establish a fresh step-up at the new clock so the failure
      // is the stage expiry, not step-up staleness.
      const steppedAgain = await steppedUpSessionForUser(fixture, session.userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/confirm',
        headers: { ...sessionHeaders(steppedAgain.cookie, steppedAgain.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: codeFor(staged.secret, fixture.clock.nowMs) }),
      });
      expect(res.statusCode).toBe(401);
      expect(bodyOf(res).error?.code).toBe('invalid_verification_code');
      expect(fixture.store.stages.get(session.userId)).toBeUndefined();
      const credential = await fixture.store.findTotpCredential(session.userId);
      expect(credential?.secretSealed).toBe(liveSealed);
      expect((await fixture.store.findUserById(session.userId))?.totpEnabled).toBe(true);
      // The old secret still logs in after the abandoned stage
      // expired: nothing needs restoring, because nothing was
      // ever overwritten.
      fixture.clock.advance(STEP_MS);
      expect(await loginWithTotp(app, 'a@example.invalid', codeFor(enrolled.secret, fixture.clock.nowMs))).toBe(
        200,
      );
    });

    it('confirm proves the staged secret, not the live one, and replaces it on success', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const enrolled = await enrollFully(app, fixture, session);
      const liveSealed = (await fixture.store.findTotpCredential(session.userId))?.secretSealed;
      fixture.clock.advance(STEP_MS);
      const stepped = await steppedUpSessionForUser(fixture, session.userId);
      const staged = await enrollStart(app, stepped);
      const confirmHeaders = {
        ...sessionHeaders(stepped.cookie, stepped.csrfToken),
        ...jsonPayload({}).headers,
      };
      // A code from the OLD secret must not confirm the new stage,
      // and the failed proof leaves the stage in place for retry.
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/confirm',
        headers: confirmHeaders,
        payload: JSON.stringify({ code: codeFor(enrolled.secret, fixture.clock.nowMs) }),
      });
      expect(wrong.statusCode).toBe(401);
      expect(bodyOf(wrong).error?.code).toBe('invalid_verification_code');
      expect(fixture.store.stages.get(session.userId)).toBeDefined();
      expect((await fixture.store.findTotpCredential(session.userId))?.secretSealed).toBe(liveSealed);
      // A code from the STAGED secret confirms and replaces the
      // live secret in the same transaction that clears the stage.
      const ok = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enroll/confirm',
        headers: confirmHeaders,
        payload: JSON.stringify({ code: codeFor(staged.secret, fixture.clock.nowMs) }),
      });
      expect(ok.statusCode).toBe(200);
      expect(fixture.store.stages.get(session.userId)).toBeUndefined();
      const replaced = await fixture.store.findTotpCredential(session.userId);
      expect(replaced?.secretSealed).not.toBe(liveSealed);
      expect(replaced?.secretSealed).not.toContain(staged.secret);
      expect(replaced?.lastUsedStep).not.toBeNull();
      // The new secret logs in; the old one no longer does.
      fixture.clock.advance(STEP_MS);
      expect(await loginWithTotp(app, 'a@example.invalid', codeFor(staged.secret, fixture.clock.nowMs))).toBe(200);
      fixture.clock.advance(STEP_MS);
      expect(await loginWithTotp(app, 'a@example.invalid', codeFor(enrolled.secret, fixture.clock.nowMs))).toBe(
        401,
      );
    });
  });

  describe('POST /api/auth/totp/disable', () => {
    it('disables with a current TOTP code, clearing credential and codes, rotating the session', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const enrolled = await enrollFully(app, fixture, session);
      fixture.clock.advance(STEP_MS);
      // The rotated session keeps its step-up; refresh it at the new
      // clock by stepping up again on the same account.
      const stepped = await steppedUpSessionForUser(fixture, session.userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/disable',
        headers: { ...sessionHeaders(stepped.cookie, stepped.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: codeFor(enrolled.secret, fixture.clock.nowMs) }),
      });
      expect(res.statusCode).toBe(200);
      expect(bodyOf(res).data).toMatchObject({ totpEnabled: false });
      expect((await fixture.store.findUserById(session.userId))?.totpEnabled).toBe(false);
      expect(await fixture.store.findTotpCredential(session.userId)).toBeNull();
      expect(fixture.store.recovery.filter((row) => row.userId === session.userId)).toHaveLength(0);
      expect(fixture.store.auditEvents.map((event) => event.eventType)).toContain('totp_disabled');
      const rotatedCookie = cookieFromResponse(res);
      expect(rotatedCookie).not.toBe(stepped.cookie);
      const oldGone = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: enrolled.cookie },
      });
      expect(oldGone.statusCode).toBe(401);
    });

    it('disables with a recovery code and clears the whole recovery set', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const enrolled = await enrollFully(app, fixture, session);
      fixture.clock.advance(STEP_MS);
      const stepped = await steppedUpSessionForUser(fixture, session.userId);
      const regen = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/recovery-codes/regenerate',
        headers: { ...sessionHeaders(stepped.cookie, stepped.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: codeFor(enrolled.secret, fixture.clock.nowMs) }),
      });
      expect(regen.statusCode).toBe(200);
      const codes = (bodyOf(regen).data as { codes: string[] }).codes;
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/disable',
        headers: { ...sessionHeaders(stepped.cookie, stepped.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ recoveryCode: codes[0] }),
      });
      expect(res.statusCode).toBe(200);
      expect((await fixture.store.findUserById(session.userId))?.totpEnabled).toBe(false);
      expect(await fixture.store.findTotpCredential(session.userId)).toBeNull();
      expect(fixture.store.recovery.filter((row) => row.userId === session.userId)).toHaveLength(0);
    });

    it('is idempotent: disabling an already-disabled account succeeds without proof or rotation', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const first = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/disable',
        headers: sessionHeaders(session.cookie, session.csrfToken),
      });
      expect(first.statusCode).toBe(200);
      expect(bodyOf(first).data).toEqual({ totpEnabled: false, csrfToken: session.csrfToken });
      expect(first.headers['set-cookie']).toBeUndefined();
      const second = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/disable',
        headers: sessionHeaders(session.cookie, session.csrfToken),
      });
      expect(second.statusCode).toBe(200);
      const alive = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie } });
      expect(alive.statusCode).toBe(200);
    });

    it('rejects a wrong code, a used recovery code, and missing proof generically or by validation', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const enrolled = await enrollFully(app, fixture, session);
      fixture.clock.advance(STEP_MS);
      const stepped = await steppedUpSessionForUser(fixture, session.userId);
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/disable',
        headers: { ...sessionHeaders(stepped.cookie, stepped.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: '000000' }),
      });
      expect(wrong.statusCode).toBe(401);
      expect(bodyOf(wrong).error?.code).toBe('invalid_verification_code');
      expect((await fixture.store.findUserById(session.userId))?.totpEnabled).toBe(true);
      const bogusRecovery = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/disable',
        headers: { ...sessionHeaders(stepped.cookie, stepped.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ recoveryCode: 'aaaa-bbbb-cccc-dddd' }),
      });
      expect(bogusRecovery.statusCode).toBe(401);
      expect(bodyOf(bogusRecovery).error?.code).toBe('invalid_verification_code');
      const neither = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/disable',
        headers: { ...sessionHeaders(stepped.cookie, stepped.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({}),
      });
      expect(neither.statusCode).toBe(400);
      expect(bodyOf(neither).error?.code).toBe('validation_failed');
      const both = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/disable',
        headers: { ...sessionHeaders(stepped.cookie, stepped.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: codeFor(enrolled.secret, fixture.clock.nowMs), recoveryCode: 'aaaa-bbbb-cccc-dddd' }),
      });
      expect(both.statusCode).toBe(400);
      expect(bodyOf(both).error?.code).toBe('validation_failed');
    });

    it('requires a fresh step-up', async () => {
      const { cookie, csrfToken } = await seedLoggedInUser(fixture, app, {
        email: 'a@example.invalid',
        password: PASSWORD,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/disable',
        headers: { ...sessionHeaders(cookie, csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: '123456' }),
      });
      expect(res.statusCode).toBe(403);
      expect(bodyOf(res).error?.code).toBe('step_up_required');
    });
  });

  describe('POST /api/auth/totp/recovery-codes/regenerate', () => {
    it('replaces the whole batch with exactly 10 fresh codes shown once, hashed at rest', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const enrolled = await enrollFully(app, fixture, session);
      const oldHashes = new Set(
        fixture.store.recovery.filter((row) => row.userId === session.userId).map((row) => row.codeHash),
      );
      expect(oldHashes.size).toBe(RECOVERY_CODE_COUNT);
      fixture.clock.advance(STEP_MS);
      const stepped = await steppedUpSessionForUser(fixture, session.userId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/recovery-codes/regenerate',
        headers: { ...sessionHeaders(stepped.cookie, stepped.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: codeFor(enrolled.secret, fixture.clock.nowMs) }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const codes = (bodyOf(res).data as { codes: string[] }).codes;
      expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
      expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
      for (const code of codes) {
        expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
        expect(code).not.toMatch(/[l01o]/);
      }
      const rows = fixture.store.recovery.filter((row) => row.userId === session.userId);
      expect(rows).toHaveLength(RECOVERY_CODE_COUNT);
      expect(new Set(rows.map((row) => row.batchId)).size).toBe(1);
      for (const row of rows) {
        expect(oldHashes.has(row.codeHash)).toBe(false);
      }
      // Stored form is the hash of the normalized code; no plaintext.
      for (const code of codes) {
        const hashed = hashToken(normalizeRecoveryCode(code));
        expect(rows.some((row) => row.codeHash === hashed)).toBe(true);
        expect(await fixture.store.findUnusedRecoveryCode(session.userId, hashed)).not.toBeNull();
      }
      expect(fixture.store.auditEvents.map((event) => event.eventType)).toContain('recovery_codes_regenerated');
      // Show-once: a second regeneration yields a disjoint batch, and
      // /me never carries a code value.
      fixture.clock.advance(STEP_MS);
      const steppedAgain = await steppedUpSessionForUser(fixture, session.userId);
      const second = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/recovery-codes/regenerate',
        headers: { ...sessionHeaders(steppedAgain.cookie, steppedAgain.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: codeFor(enrolled.secret, fixture.clock.nowMs) }),
      });
      expect(second.statusCode).toBe(200);
      const secondCodes = (bodyOf(second).data as { codes: string[] }).codes;
      for (const code of codes) {
        expect(secondCodes).not.toContain(code);
      }
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: steppedAgain.cookie } });
      for (const code of secondCodes) {
        expect(me.body).not.toContain(code);
      }
    });

    it('rejects a wrong code, a replayed code, and a disabled account with the generic 401', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const enrolled = await enrollFully(app, fixture, session);
      fixture.clock.advance(STEP_MS);
      const stepped = await steppedUpSessionForUser(fixture, session.userId);
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/recovery-codes/regenerate',
        headers: { ...sessionHeaders(stepped.cookie, stepped.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: '000000' }),
      });
      expect(wrong.statusCode).toBe(401);
      expect(bodyOf(wrong).error?.code).toBe('invalid_verification_code');
      const code = codeFor(enrolled.secret, fixture.clock.nowMs);
      const first = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/recovery-codes/regenerate',
        headers: { ...sessionHeaders(stepped.cookie, stepped.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code }),
      });
      expect(first.statusCode).toBe(200);
      const replay = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/recovery-codes/regenerate',
        headers: { ...sessionHeaders(stepped.cookie, stepped.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code }),
      });
      expect(replay.statusCode).toBe(401);
      expect(bodyOf(replay).error?.code).toBe('invalid_verification_code');
      const disabled = await steppedUpSession(fixture, 'b@example.invalid');
      const disabledRes = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/recovery-codes/regenerate',
        headers: { ...sessionHeaders(disabled.cookie, disabled.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: '123456' }),
      });
      expect(disabledRes.statusCode).toBe(401);
      expect(bodyOf(disabledRes).error?.code).toBe('invalid_verification_code');
    });

    it('does not accept a recovery code as proof and requires step-up', async () => {
      const session = await steppedUpSession(fixture, 'a@example.invalid');
      const enrolled = await enrollFully(app, fixture, session);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/recovery-codes/regenerate',
        headers: { ...sessionHeaders(enrolled.cookie, enrolled.csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ recoveryCode: 'aaaa-bbbb-cccc-dddd' }),
      });
      expect(res.statusCode).toBe(400);
      expect(bodyOf(res).error?.code).toBe('validation_failed');
      const { cookie, csrfToken } = await seedLoggedInUser(fixture, app, {
        email: 'b@example.invalid',
        password: PASSWORD,
      });
      const noStepUp = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/recovery-codes/regenerate',
        headers: { ...sessionHeaders(cookie, csrfToken), ...jsonPayload({}).headers },
        payload: JSON.stringify({ code: '123456' }),
      });
      expect(noStepUp.statusCode).toBe(403);
      expect(bodyOf(noStepUp).error?.code).toBe('step_up_required');
    });
  });

  describe('encryption fail-closed', () => {
    it('start answers 503 and stages nothing when no encryption key is configured', async () => {
      const noKey = makeTestAuth({ encryptionKey: undefined });
      const keylessApp = await buildTestApp(noKey.auth);
      await registerAuthTotpRoutes(keylessApp, {
        auth: noKey.auth,
        enrollment: new FakeTotpEnrollmentStore(noKey.store),
      });
      try {
        const session = await steppedUpSession(noKey, 'a@example.invalid');
        const res = await keylessApp.inject({
          method: 'POST',
          url: '/api/auth/totp/enroll/start',
          headers: sessionHeaders(session.cookie, session.csrfToken),
        });
        expect(res.statusCode).toBe(503);
        expect(bodyOf(res).error?.code).toBe('service_unavailable');
        expect(await noKey.store.findTotpCredential(session.userId)).toBeNull();
        expect(noKey.store.stages.get(session.userId)).toBeUndefined();
      } finally {
        await keylessApp.close();
      }
    });
  });
});

// A fresh stepped-up session for an EXISTING user id, at the current
// test clock. Used after advancing the clock past a step or past
// the step-up window, where the original session's step-up is stale
// or its code step is claimed.
async function steppedUpSessionForUser(fixture: TestAuth, userId: string): Promise<SteppedSession> {
  const user = await fixture.store.findUserById(userId);
  if (user === null) {
    throw new Error('steppedUpSessionForUser: user not found');
  }
  const sessionId = newOpaqueToken();
  const sessionHash = hashToken(sessionId);
  const csrfToken = deriveCsrfToken(sessionHash, TEST_AUTH_SECRET);
  const now = new Date(fixture.clock.nowMs);
  await fixture.store.createSession({
    userId,
    sessionHash,
    csrfTokenHash: hashToken(csrfToken),
    credentialEpoch: user.credentialEpoch,
    deviceLabel: 'Stepped up device',
    userAgent: USER_AGENT,
    createdIp: '127.0.0.1',
    lastSeenIp: '127.0.0.1',
    createdAt: now,
    lastSeenAt: now,
    absoluteExpiresAt: new Date(fixture.clock.nowMs + 30 * 24 * 60 * 60 * 1000),
    stepUpAt: now,
  });
  return { cookie: `notegen_session=${sessionId}`, csrfToken, userId };
}
