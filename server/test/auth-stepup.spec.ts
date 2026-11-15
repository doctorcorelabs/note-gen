// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Step-up tests (worker V3-02 part 1, wave 3B overlap).
//
// The step-up route module is registered directly onto the app built
// by buildTestApp, because overlap workers never edit
// server/src/app.ts (AD-57); the integrator wires
// registerAuthStepUpRoutes in buildApp at merge. Registration here
// happens before the first inject, so the frozen global hook
// (session, then Origin, then CSRF) covers the route exactly as it
// will in production.
//
// Pinned behaviors (kontrak-api-kanonis.md section 3.12,
// desain-auth.md section 3.5, L2 reference harness
// auth-negative-lifecycle.spec.ts): 15-minute freshness with an
// inclusive boundary, session rotation that preserves the absolute
// expiry and createdAt, one generic 401 invalid_credentials for
// every verification failure (wrong password, missing/wrong/
// replayed TOTP code, missing credential), a current TOTP code
// required for TOTP accounts, an own per-account failure bucket (5
// per 15 minutes) that never touches the login lockout, and
// step_up_required never answered by the step-up endpoint itself.

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveSealKey, sealTotpSecret } from '../src/auth/totp-seal.js';
import { currentTotpCounter, decodeBase32, totpCodeAt } from '../src/auth/totp-verify.js';
import { STEP_UP_WINDOW_MS } from '../src/auth/values.js';
import { registerAuthStepUpRoutes } from '../src/routes/auth-stepup.js';
import { isStepUpFreshForRow, requireFreshStepUp } from '../src/services/auth/step-up.js';
import {
  CANONICAL_ORIGIN,
  TEST_ENCRYPTION_KEY,
  bodyOf,
  buildTestApp,
  cookieFromResponse,
  loginAs,
  makeTestAuth,
  publicHeaders,
  seedLoggedInUser,
  sessionHeaders,
  setCookieHeader,
  type TestAuth,
} from './auth/helpers.js';

const USER_EMAIL = 'stepup-user@example.invalid';
const USER_PASSWORD = 'fixture-stepup-password-1';
const WRONG_PASSWORD = 'fixture-wrong-password-1';
const TOTP_EMAIL = 'stepup-totp@example.invalid';
const TOTP_PASSWORD = 'fixture-stepup-totp-password-1';
// RFC 6238 test-vector style Base32 secret, fixture only.
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const MINUTE_MS = 60_000;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app !== undefined) {
      await app.close();
    }
  }
});

async function setup(): Promise<{ fixture: TestAuth; app: FastifyInstance }> {
  const fixture = makeTestAuth();
  const app = await buildTestApp(fixture.auth);
  await registerAuthStepUpRoutes(app, { auth: fixture.auth });
  apps.push(app);
  return { fixture, app };
}

interface Creds {
  cookie: string;
  csrfToken: string;
  userId: string;
}

function stepUp(
  app: FastifyInstance,
  creds: Creds,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/step-up',
    headers: sessionHeaders(creds.cookie, creds.csrfToken, { 'content-type': 'application/json', ...extraHeaders }),
    payload: body,
  });
}

function currentCode(nowMs: number): string {
  return totpCodeAt(decodeBase32(TOTP_SECRET), currentTotpCounter(nowMs));
}

async function seedTotpUser(fixture: TestAuth): Promise<{ userId: string }> {
  const hash = await fixture.hasher.hash(TOTP_PASSWORD);
  const user = fixture.store.seedUser({ email: TOTP_EMAIL, passwordHash: hash, totpEnabled: true });
  const key = deriveSealKey(TEST_ENCRYPTION_KEY);
  if (key === null) {
    throw new Error('test encryption key did not derive');
  }
  fixture.store.seedTotp(user.id, { secretSealed: sealTotpSecret(TOTP_SECRET, key) });
  return { userId: user.id };
}

async function loginTotpUser(app: FastifyInstance, fixture: TestAuth): Promise<Creds> {
  const first = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: publicHeaders({ 'content-type': 'application/json' }),
    payload: { email: TOTP_EMAIL, password: TOTP_PASSWORD },
  });
  expect(first.statusCode).toBe(202);
  const challengeToken = (bodyOf(first).data as { challengeToken: string }).challengeToken;
  const second = await app.inject({
    method: 'POST',
    url: '/api/auth/login/totp',
    headers: publicHeaders({ 'content-type': 'application/json' }),
    payload: { challengeToken, code: currentCode(fixture.clock.nowMs) },
  });
  expect(second.statusCode).toBe(200);
  const data = bodyOf(second).data as { csrfToken: string; id: string };
  const cookie = cookieFromResponse(second);
  if (cookie === undefined) {
    throw new Error('TOTP login found no Set-Cookie header');
  }
  return { cookie, csrfToken: data.csrfToken, userId: data.id };
}

function normalizedBody(res: { body: string }): string {
  const parsed = JSON.parse(res.body) as { error?: { requestId?: string } };
  if (parsed.error !== undefined) {
    parsed.error.requestId = 'redacted';
  }
  return JSON.stringify(parsed);
}

async function meStatus(app: FastifyInstance, cookie: string): Promise<number> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie, 'user-agent': 'test-agent/1.0 (TestOS)' },
  });
  return res.statusCode;
}

describe('step-up gating helper', () => {
  it('freshness is false without a step-up, true when fresh, inclusive at exactly 15 minutes', () => {
    const now = Date.UTC(2026, 10, 15, 4, 0, 0);
    expect(isStepUpFreshForRow({ stepUpAt: null }, now)).toBe(false);
    expect(isStepUpFreshForRow({ stepUpAt: new Date(now) }, now)).toBe(true);
    expect(isStepUpFreshForRow({ stepUpAt: new Date(now - STEP_UP_WINDOW_MS) }, now)).toBe(true);
    expect(isStepUpFreshForRow({ stepUpAt: new Date(now - STEP_UP_WINDOW_MS - 1) }, now)).toBe(false);
  });

  it('requireFreshStepUp throws step_up_required only when stale', () => {
    const now = Date.UTC(2026, 10, 15, 4, 0, 0);
    expect(() => requireFreshStepUp({ stepUpAt: new Date(now) }, now)).not.toThrow();
    expect(() => requireFreshStepUp({ stepUpAt: null }, now)).toThrowError(
      expect.objectContaining({ statusCode: 403, code: 'step_up_required' }),
    );
    expect(() => requireFreshStepUp({ stepUpAt: new Date(now - STEP_UP_WINDOW_MS - 1) }, now)).toThrowError(
      expect.objectContaining({ statusCode: 403, code: 'step_up_required' }),
    );
  });
});

describe('POST /api/auth/step-up success', () => {
  it('rotates the session, stamps stepUpAt, returns only the new CSRF token, and kills the old session id', async () => {
    const { fixture, app } = await setup();
    const before = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const meBefore = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: before.cookie } });
    const sessionBefore = (bodyOf(meBefore).data as { session: Record<string, unknown> }).session;
    expect(sessionBefore['stepUpAt']).toBeNull();

    const res = await stepUp(app, before, { password: USER_PASSWORD });
    expect(res.statusCode).toBe(200);
    const data = bodyOf(res).data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['csrfToken']);
    expect(typeof data['csrfToken']).toBe('string');
    expect(data['csrfToken']).not.toBe(before.csrfToken);
    const afterCookie = cookieFromResponse(res);
    expect(afterCookie).toBeDefined();
    expect(afterCookie).not.toBe(before.cookie);
    expect(setCookieHeader(res)).toContain('HttpOnly');

    expect(await meStatus(app, before.cookie)).toBe(401);
    const meAfter = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: afterCookie as string } });
    expect(meAfter.statusCode).toBe(200);
    const sessionAfter = (bodyOf(meAfter).data as { session: Record<string, unknown> }).session;
    expect(sessionAfter['stepUpAt']).toBe(new Date(fixture.clock.nowMs).toISOString());
    expect(sessionAfter['absoluteExpiresAt']).toBe(sessionBefore['absoluteExpiresAt']);
    expect(sessionAfter['createdAt']).toBe(sessionBefore['createdAt']);
    expect(fixture.store.sessions.size).toBe(1);
    expect(fixture.store.auditEvents.some((event) => event.eventType === 'step_up_succeeded')).toBe(true);
    const user = await fixture.store.findUserById(before.userId);
    expect(user?.credentialEpoch).toBe(1);
  });

  it('the old CSRF token is rejected for the rotated session', async () => {
    const { fixture, app } = await setup();
    const before = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const res = await stepUp(app, before, { password: USER_PASSWORD });
    const afterCookie = cookieFromResponse(res) as string;
    const afterCsrf = (bodyOf(res).data as { csrfToken: string }).csrfToken;
    const stale = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: sessionHeaders(afterCookie, before.csrfToken, { 'content-type': 'application/json' }),
      payload: {},
    });
    expect(stale.statusCode).toBe(403);
    expect(bodyOf(stale).error?.code).toBe('csrf_invalid');
    const fresh = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: sessionHeaders(afterCookie, afterCsrf, { 'content-type': 'application/json' }),
      payload: {},
    });
    expect(fresh.statusCode).toBe(200);
  });

  it('other sessions of the same account survive a step-up', async () => {
    const { fixture, app } = await setup();
    const first = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const second = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    await stepUp(app, first, { password: USER_PASSWORD });
    expect(await meStatus(app, second.cookie)).toBe(200);
    expect(fixture.store.sessions.size).toBe(2);
  });

  it('a fresh step-up unlocks logout-all', async () => {
    const { fixture, app } = await setup();
    const before = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const res = await stepUp(app, before, { password: USER_PASSWORD });
    const creds: Creds = {
      cookie: cookieFromResponse(res) as string,
      csrfToken: (bodyOf(res).data as { csrfToken: string }).csrfToken,
      userId: before.userId,
    };
    const all = await app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: sessionHeaders(creds.cookie, creds.csrfToken, { 'content-type': 'application/json' }),
      payload: {},
    });
    expect(all.statusCode).toBe(200);
    expect(fixture.store.sessions.size).toBe(0);
    expect(await meStatus(app, creds.cookie)).toBe(401);
  });

  it('a code field is ignored for accounts without TOTP', async () => {
    const { fixture, app } = await setup();
    const creds = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const res = await stepUp(app, creds, { password: USER_PASSWORD, code: '000000' });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/auth/step-up freshness expiry', () => {
  it('logout-all answers 403 step_up_required 1 ms past 15 minutes and the session survives', async () => {
    const { fixture, app } = await setup();
    const before = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const res = await stepUp(app, before, { password: USER_PASSWORD });
    const creds: Creds = {
      cookie: cookieFromResponse(res) as string,
      csrfToken: (bodyOf(res).data as { csrfToken: string }).csrfToken,
      userId: before.userId,
    };
    fixture.clock.advance(STEP_UP_WINDOW_MS + 1);
    const all = await app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: sessionHeaders(creds.cookie, creds.csrfToken, { 'content-type': 'application/json' }),
      payload: {},
    });
    expect(all.statusCode).toBe(403);
    expect(bodyOf(all).error?.code).toBe('step_up_required');
    expect(fixture.store.sessions.size).toBe(1);
    expect(await meStatus(app, creds.cookie)).toBe(200);
  });

  it('logout-all still succeeds at exactly 15 minutes', async () => {
    const { fixture, app } = await setup();
    const before = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const res = await stepUp(app, before, { password: USER_PASSWORD });
    const creds: Creds = {
      cookie: cookieFromResponse(res) as string,
      csrfToken: (bodyOf(res).data as { csrfToken: string }).csrfToken,
      userId: before.userId,
    };
    fixture.clock.advance(STEP_UP_WINDOW_MS);
    const all = await app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: sessionHeaders(creds.cookie, creds.csrfToken, { 'content-type': 'application/json' }),
      payload: {},
    });
    expect(all.statusCode).toBe(200);
  });

  it('step-up can be renewed after expiry', async () => {
    const { fixture, app } = await setup();
    const before = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const first = await stepUp(app, before, { password: USER_PASSWORD });
    const creds: Creds = {
      cookie: cookieFromResponse(first) as string,
      csrfToken: (bodyOf(first).data as { csrfToken: string }).csrfToken,
      userId: before.userId,
    };
    fixture.clock.advance(16 * MINUTE_MS);
    const renewed = await stepUp(app, creds, { password: USER_PASSWORD });
    expect(renewed.statusCode).toBe(200);
    const renewedCreds: Creds = {
      cookie: cookieFromResponse(renewed) as string,
      csrfToken: (bodyOf(renewed).data as { csrfToken: string }).csrfToken,
      userId: before.userId,
    };
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: renewedCreds.cookie } });
    const session = (bodyOf(me).data as { session: Record<string, unknown> }).session;
    expect(session['stepUpAt']).toBe(new Date(fixture.clock.nowMs).toISOString());
  });
});

describe('POST /api/auth/step-up generic failures', () => {
  it('a wrong password answers the generic 401, keeps the session, and audits the failure', async () => {
    const { fixture, app } = await setup();
    const creds = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const res = await stepUp(app, creds, { password: WRONG_PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res).error?.code).toBe('invalid_credentials');
    expect(bodyOf(res).error?.message).toBe('Email or password is incorrect.');
    expect(bodyOf(res).error?.retryable).toBe(false);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await meStatus(app, creds.cookie)).toBe(200);
    expect(fixture.store.sessions.size).toBe(1);
    expect(fixture.store.auditEvents.some((event) => event.eventType === 'step_up_failed')).toBe(true);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: creds.cookie } });
    expect((bodyOf(me).data as { session: Record<string, unknown> }).session['stepUpAt']).toBeNull();
  });

  it('wrong password, missing TOTP code, and wrong TOTP code produce byte-identical denials', async () => {
    const { fixture, app } = await setup();
    const plain = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const wrongPassword = await stepUp(app, plain, { password: WRONG_PASSWORD });
    await seedTotpUser(fixture);
    const totp = await loginTotpUser(app, fixture);
    fixture.clock.advance(31_000);
    const freshCreds: Creds = { ...totp };
    const missingCode = await stepUp(app, freshCreds, { password: TOTP_PASSWORD });
    const wrongCode = await stepUp(app, freshCreds, { password: TOTP_PASSWORD, code: '000000' });
    expect(missingCode.statusCode).toBe(401);
    expect(wrongCode.statusCode).toBe(401);
    expect(normalizedBody(missingCode)).toBe(normalizedBody(wrongPassword));
    expect(normalizedBody(wrongCode)).toBe(normalizedBody(wrongPassword));
    expect(missingCode.body).not.toContain('step_up_required');
    expect(wrongCode.body).not.toContain('verification');
  });

  it('malformed bodies answer 400 validation_failed and do not count toward the bucket', async () => {
    const { fixture, app } = await setup();
    const creds = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const cases: Array<Record<string, unknown>> = [
      {},
      { password: 42 },
      { password: '' },
      { password: USER_PASSWORD, extra: 'nope' },
      { password: USER_PASSWORD, code: 123456 },
      { password: 'x'.repeat(129) },
    ];
    for (const body of cases) {
      const res = await stepUp(app, creds, body);
      expect(res.statusCode).toBe(400);
      expect(bodyOf(res).error?.code).toBe('validation_failed');
    }
    const ok = await stepUp(app, creds, { password: USER_PASSWORD });
    expect(ok.statusCode).toBe(200);
  });

  it('without a session the hook answers 401 unauthenticated, never 403', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.invalid' },
      payload: { password: USER_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res).error?.code).toBe('unauthenticated');
  });

  it('a wrong Origin answers 403 origin_rejected and a wrong CSRF token answers 403 csrf_invalid', async () => {
    const { fixture, app } = await setup();
    const creds = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const wrongOrigin = await app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: sessionHeaders(creds.cookie, creds.csrfToken, {
        'content-type': 'application/json',
        origin: 'https://evil.example.invalid',
      }),
      payload: { password: USER_PASSWORD },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(bodyOf(wrongOrigin).error?.code).toBe('origin_rejected');
    const wrongCsrf = await stepUp(app, { ...creds, csrfToken: 'stale-token-value' }, { password: USER_PASSWORD });
    expect(wrongCsrf.statusCode).toBe(403);
    expect(bodyOf(wrongCsrf).error?.code).toBe('csrf_invalid');
    expect(await meStatus(app, creds.cookie)).toBe(200);
  });

  it('a disabled account answers 401 unauthenticated through the hook', async () => {
    const { fixture, app } = await setup();
    const creds = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    const user = await fixture.store.findUserById(creds.userId);
    if (user !== null) {
      user.status = 'disabled';
    }
    const res = await stepUp(app, creds, { password: USER_PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res).error?.code).toBe('unauthenticated');
  });
});

describe('POST /api/auth/step-up rate limiting', () => {
  it('five failures answer 401; the sixth, even with the correct password, answers 429 with Retry-After 900', async () => {
    const { fixture, app } = await setup();
    const creds = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    for (let i = 0; i < 5; i += 1) {
      const res = await stepUp(app, creds, { password: WRONG_PASSWORD });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await stepUp(app, creds, { password: USER_PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(bodyOf(blocked).error?.code).toBe('rate_limited');
    expect(bodyOf(blocked).error?.retryable).toBe(true);
    expect(blocked.headers['retry-after']).toBe('900');
    expect(blocked.headers).not.toHaveProperty('x-ratelimit-limit');
    expect(await meStatus(app, creds.cookie)).toBe(200);
    expect(fixture.store.lockouts.size).toBe(0);
  });

  it('the bucket is the step-up bucket only: login still works after step-up failures', async () => {
    const { fixture, app } = await setup();
    const creds = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    for (let i = 0; i < 5; i += 1) {
      await stepUp(app, creds, { password: WRONG_PASSWORD });
    }
    const wrongLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: publicHeaders({ 'content-type': 'application/json' }),
      payload: { email: USER_EMAIL, password: WRONG_PASSWORD },
    });
    expect(wrongLogin.statusCode).toBe(401);
    const goodLogin = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    expect(goodLogin.userId).toBe(creds.userId);
  });

  it('the bucket resets in the next window', async () => {
    const { fixture, app } = await setup();
    const creds = await seedLoggedInUser(fixture, app, { email: USER_EMAIL, password: USER_PASSWORD });
    for (let i = 0; i < 5; i += 1) {
      await stepUp(app, creds, { password: WRONG_PASSWORD });
    }
    expect((await stepUp(app, creds, { password: USER_PASSWORD })).statusCode).toBe(429);
    fixture.clock.advance(15 * MINUTE_MS + 1000);
    const ok = await stepUp(app, creds, { password: USER_PASSWORD });
    expect(ok.statusCode).toBe(200);
  });

  it('TOTP code failures count in the same bucket', async () => {
    const { fixture, app } = await setup();
    await seedTotpUser(fixture);
    const totp = await loginTotpUser(app, fixture);
    fixture.clock.advance(31_000);
    for (let i = 0; i < 5; i += 1) {
      const res = await stepUp(app, totp, { password: TOTP_PASSWORD, code: '000000' });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await stepUp(app, totp, { password: TOTP_PASSWORD, code: currentCode(fixture.clock.nowMs) });
    expect(blocked.statusCode).toBe(429);
  });
});

describe('POST /api/auth/step-up with TOTP', () => {
  it('succeeds with the password plus the current code', async () => {
    const { fixture, app } = await setup();
    await seedTotpUser(fixture);
    const totp = await loginTotpUser(app, fixture);
    fixture.clock.advance(31_000);
    const res = await stepUp(app, totp, { password: TOTP_PASSWORD, code: currentCode(fixture.clock.nowMs) });
    expect(res.statusCode).toBe(200);
    const cookie = cookieFromResponse(res) as string;
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect((bodyOf(me).data as { session: Record<string, unknown> }).session['stepUpAt']).toBe(
      new Date(fixture.clock.nowMs).toISOString(),
    );
    expect(fixture.store.auditEvents.some((event) => event.eventType === 'step_up_succeeded')).toBe(true);
  });

  it('a replayed code answers the generic 401', async () => {
    const { fixture, app } = await setup();
    await seedTotpUser(fixture);
    const totp = await loginTotpUser(app, fixture);
    fixture.clock.advance(31_000);
    const code = currentCode(fixture.clock.nowMs);
    const first = await stepUp(app, totp, { password: TOTP_PASSWORD, code });
    expect(first.statusCode).toBe(200);
    const rotated: Creds = {
      cookie: cookieFromResponse(first) as string,
      csrfToken: (bodyOf(first).data as { csrfToken: string }).csrfToken,
      userId: totp.userId,
    };
    const replay = await stepUp(app, rotated, { password: TOTP_PASSWORD, code });
    expect(replay.statusCode).toBe(401);
    expect(bodyOf(replay).error?.code).toBe('invalid_credentials');
  });

  it('a valid code is not consumed when the password is wrong', async () => {
    const { fixture, app } = await setup();
    await seedTotpUser(fixture);
    const totp = await loginTotpUser(app, fixture);
    fixture.clock.advance(31_000);
    const code = currentCode(fixture.clock.nowMs);
    const failed = await stepUp(app, totp, { password: WRONG_PASSWORD, code });
    expect(failed.statusCode).toBe(401);
    const ok = await stepUp(app, totp, { password: TOTP_PASSWORD, code });
    expect(ok.statusCode).toBe(200);
  });

  it('a TOTP account without a credential row answers the generic 401', async () => {
    const { fixture, app } = await setup();
    await seedTotpUser(fixture);
    const totp = await loginTotpUser(app, fixture);
    fixture.store.totp.delete(totp.userId);
    fixture.clock.advance(31_000);
    const res = await stepUp(app, totp, { password: TOTP_PASSWORD, code: currentCode(fixture.clock.nowMs) });
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res).error?.code).toBe('invalid_credentials');
  });
});
