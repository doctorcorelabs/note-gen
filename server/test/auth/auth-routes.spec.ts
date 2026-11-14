// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// End-to-end tests for the ten core auth routes, through buildApp
// with inject() and a fake store. They pin the contract shapes
// (kontrak-api-kanonis.md section 3.12), the hook ordering (session
// before Origin before CSRF), anti-enumeration, the TOTP second
// step, and the boot-guard compatibility of GET /api/auth/me
// (200 with ok true means authenticated; 401 means unauthenticated).

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { deriveCsrfToken, hashToken, newOpaqueToken } from '../../src/auth/crypto.js';
import { sealTotpSecret, deriveSealKey } from '../../src/auth/totp-seal.js';
import { currentTotpCounter, decodeBase32, normalizeRecoveryCode, totpCodeAt } from '../../src/auth/totp-verify.js';
import {
  bodyOf,
  buildTestApp,
  cookieFromResponse,
  loginAs,
  makeTestAuth,
  publicHeaders,
  seedLoggedInUser,
  sessionHeaders,
  setCookieHeader,
  testConfig,
  TEST_AUTH_SECRET,
  TEST_ENCRYPTION_KEY,
  TEST_NOW_MS,
  TEST_SETUP_TOKEN,
  USER_AGENT,
  type TestAuth,
} from './helpers.js';

const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const PASSWORD = 'a-long-enough-password';

function jsonPayload(payload: unknown): { payload: string; headers: Record<string, string> } {
  return { payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } };
}

function totpCodeAtNow(nowMs: number): string {
  return totpCodeAt(decodeBase32(TOTP_SECRET), currentTotpCounter(nowMs));
}

async function seedTotpUser(fixture: TestAuth, email: string): Promise<string> {
  const hash = await fixture.hasher.hash(PASSWORD);
  const user = fixture.store.seedUser({ email, passwordHash: hash, totpEnabled: true });
  const key = deriveSealKey(TEST_ENCRYPTION_KEY) as Buffer;
  fixture.store.seedTotp(user.id, { secretSealed: sealTotpSecret(TOTP_SECRET, key) });
  return user.id;
}

async function startTotpLogin(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { ...publicHeaders(), ...jsonPayload({}).headers },
    payload: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.statusCode).toBe(202);
  const body = bodyOf(res);
  return (body.data as { challengeToken: string }).challengeToken;
}

describe('auth core routes', () => {
  let fixture: TestAuth;
  let app: FastifyInstance;

  beforeEach(async () => {
    fixture = makeTestAuth();
    app = await buildTestApp(fixture.auth);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /api/auth/setup', () => {
    it('creates the first account with 201 and no session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({
          setupToken: TEST_SETUP_TOKEN,
          email: '  Admin@Example.invalid ',
          password: PASSWORD,
          workspaceName: 'Main',
        }),
      });
      expect(res.statusCode).toBe(201);
      const body = bodyOf(res);
      expect(body.ok).toBe(true);
      expect(body.data?.email).toBe('admin@example.invalid');
      expect(typeof body.data?.id).toBe('string');
      expect(typeof body.data?.workspaceId).toBe('string');
      expect(res.headers['set-cookie']).toBeUndefined();
      const user = await fixture.store.findUserByEmail('admin@example.invalid');
      expect(user?.role).toBe('admin');
    });

    it('answers 404 once installation is complete', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ setupToken: TEST_SETUP_TOKEN, email: 'a@example.invalid', password: PASSWORD }),
      });
      const again = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ setupToken: TEST_SETUP_TOKEN, email: 'b@example.invalid', password: PASSWORD }),
      });
      expect(again.statusCode).toBe(404);
      expect(bodyOf(again).error?.code).toBe('not_found');
      expect(await fixture.store.getUserCount()).toBe(1);
    });

    it('answers 401 invalid_setup_token for a wrong token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ setupToken: 'wrong-token', email: 'a@example.invalid', password: PASSWORD }),
      });
      expect(res.statusCode).toBe(401);
      expect(bodyOf(res).error?.code).toBe('invalid_setup_token');
      expect(await fixture.store.getUserCount()).toBe(0);
      expect(fixture.store.auditEvents.map((event) => event.eventType)).toContain('installation_failed');
    });

    it('rate-limits setup attempts per IP with Retry-After', async () => {
      for (let i = 0; i < 5; i += 1) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/setup',
          headers: { ...publicHeaders(), ...jsonPayload({}).headers },
          payload: JSON.stringify({ setupToken: 'wrong-token', email: 'a@example.invalid', password: PASSWORD }),
        });
        expect(res.statusCode).toBe(401);
      }
      const limited = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ setupToken: 'wrong-token', email: 'a@example.invalid', password: PASSWORD }),
      });
      expect(limited.statusCode).toBe(429);
      expect(bodyOf(limited).error?.code).toBe('rate_limited');
      expect(bodyOf(limited).error?.retryable).toBe(true);
      expect(limited.headers['retry-after']).toBeDefined();
    });

    it('rejects unknown fields and bad shapes with details.fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({
          setupToken: TEST_SETUP_TOKEN,
          email: 'a@example.invalid',
          password: 'short',
          nickname: 'x',
        }),
      });
      expect(res.statusCode).toBe(400);
      const body = bodyOf(res);
      expect(body.error?.code).toBe('validation_failed');
      const fields = (body.error?.details as { fields: Array<{ field: string }> }).fields;
      expect(fields.map((entry) => entry.field)).toContain('nickname');
      expect(fields.map((entry) => entry.field)).toContain('password');
    });

    it('requires a matching Origin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: { 'user-agent': USER_AGENT, ...jsonPayload({}).headers },
        payload: JSON.stringify({ setupToken: TEST_SETUP_TOKEN, email: 'a@example.invalid', password: PASSWORD }),
      });
      expect(res.statusCode).toBe(403);
      expect(bodyOf(res).error?.code).toBe('origin_rejected');
    });
  });

  describe('POST /api/auth/login', () => {
    it('logs in with 200, a session cookie, and the contract shape', async () => {
      const hash = await fixture.hasher.hash(PASSWORD);
      fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: hash });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ email: 'a@example.invalid', password: PASSWORD }),
      });
      expect(res.statusCode).toBe(200);
      const body = bodyOf(res);
      expect(body.data?.email).toBe('a@example.invalid');
      expect(body.data?.role).toBe('user');
      expect(body.data?.totpEnabled).toBe(false);
      expect(typeof body.data?.csrfToken).toBe('string');
      expect(body.data?.sessionExpiresAt).toBe(new Date(TEST_NOW_MS + 30 * 24 * 60 * 60 * 1000).toISOString());
      const cookie = setCookieHeader(res);
      expect(cookie).toContain('notegen_session=');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Max-Age=2592000');
      expect(res.body).not.toContain('passwordHash');
      expect(res.body).not.toContain('sessionHash');
      const user = await fixture.store.findUserByEmail('a@example.invalid');
      expect(user?.lastLoginAt?.getTime()).toBe(TEST_NOW_MS);
    });

    it('does not distinguish unknown emails, wrong passwords, and disabled accounts', async () => {
      const hash = await fixture.hasher.hash(PASSWORD);
      fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: hash });
      fixture.store.seedUser({ email: 'd@example.invalid', passwordHash: hash, status: 'disabled' });
      const attempt = async (email: string, password: string) => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { ...publicHeaders(), ...jsonPayload({}).headers },
          payload: JSON.stringify({ email, password }),
        });
        expect(res.statusCode).toBe(401);
        const body = bodyOf(res);
        return { code: body.error?.code, message: body.error?.message, details: body.error?.details };
      };
      const unknown = await attempt('nobody@example.invalid', PASSWORD);
      const wrong = await attempt('a@example.invalid', 'wrong-password-1');
      const disabled = await attempt('d@example.invalid', PASSWORD);
      expect(wrong).toEqual(unknown);
      expect(disabled).toEqual(unknown);
      expect(unknown.code).toBe('invalid_credentials');
    });

    it('answers 429 after 5 failures in the window', async () => {
      const hash = await fixture.hasher.hash(PASSWORD);
      fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: hash });
      for (let i = 0; i < 5; i += 1) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { ...publicHeaders(), ...jsonPayload({}).headers },
          payload: JSON.stringify({ email: 'a@example.invalid', password: 'wrong-password-1' }),
        });
        expect(res.statusCode).toBe(401);
      }
      const limited = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ email: 'a@example.invalid', password: PASSWORD }),
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
    });

    it('re-hashes opportunistically when the hasher demands it', async () => {
      const hash = await fixture.hasher.hash(PASSWORD);
      fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: hash });
      fixture.hasher.rehash = true;
      let updates = 0;
      const original = fixture.store.updateUserPasswordHash.bind(fixture.store);
      fixture.store.updateUserPasswordHash = async (id, next) => {
        updates += 1;
        return original(id, next);
      };
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ email: 'a@example.invalid', password: PASSWORD }),
      });
      expect(res.statusCode).toBe(200);
      expect(updates).toBe(1);
    });

    it('rejects a workspaceId field in the body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ email: 'a@example.invalid', password: PASSWORD, workspaceId: 'w-1' }),
      });
      expect(res.statusCode).toBe(400);
      const fields = (bodyOf(res).error?.details as { fields: Array<{ field: string }> }).fields;
      expect(fields.map((entry) => entry.field)).toContain('workspaceId');
    });
  });

  describe('POST /api/auth/login/totp', () => {
    it('issues a 202 challenge with no cookie, then a session on a valid code', async () => {
      await seedTotpUser(fixture, 'a@example.invalid');
      const first = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ email: 'a@example.invalid', password: PASSWORD }),
      });
      expect(first.statusCode).toBe(202);
      expect(bodyOf(first).data).toEqual({ challengeToken: expect.any(String), step: 'totp' });
      expect(first.headers['set-cookie']).toBeUndefined();
      const challengeToken = (bodyOf(first).data as { challengeToken: string }).challengeToken;
      const second = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ challengeToken, code: totpCodeAtNow(TEST_NOW_MS) }),
      });
      expect(second.statusCode).toBe(200);
      expect(bodyOf(second).data?.totpEnabled).toBe(true);
      expect(cookieFromResponse(second)).toBeDefined();
      expect(await fixture.store.findChallengeByHash(hashToken(challengeToken))).toBeNull();
    });

    it('rejects wrong codes generically and deletes the challenge after 5 attempts', async () => {
      await seedTotpUser(fixture, 'a@example.invalid');
      const challengeToken = await startTotpLogin(app, 'a@example.invalid');
      for (let i = 0; i < 5; i += 1) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login/totp',
          headers: { ...publicHeaders(), ...jsonPayload({}).headers },
          payload: JSON.stringify({ challengeToken, code: '000000' }),
        });
        expect(res.statusCode).toBe(401);
        expect(bodyOf(res).error?.code).toBe('invalid_verification_code');
      }
      expect(await fixture.store.findChallengeByHash(hashToken(challengeToken))).toBeNull();
    });

    it('rejects replayed codes across challenges', async () => {
      await seedTotpUser(fixture, 'a@example.invalid');
      const first = await startTotpLogin(app, 'a@example.invalid');
      const code = totpCodeAtNow(TEST_NOW_MS);
      const ok = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ challengeToken: first, code }),
      });
      expect(ok.statusCode).toBe(200);
      const second = await startTotpLogin(app, 'a@example.invalid');
      const replay = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ challengeToken: second, code }),
      });
      expect(replay.statusCode).toBe(401);
      expect(bodyOf(replay).error?.code).toBe('invalid_verification_code');
    });

    it('accepts a recovery code once and audits its use', async () => {
      const userId = await seedTotpUser(fixture, 'a@example.invalid');
      fixture.store.seedRecoveryCode(userId, hashToken(normalizeRecoveryCode('AAAA-BBBB-CCCC-DDDD')));
      const challengeToken = await startTotpLogin(app, 'a@example.invalid');
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ challengeToken, recoveryCode: 'aaaa bbbb cccc dddd' }),
      });
      expect(res.statusCode).toBe(200);
      expect(fixture.store.auditEvents.map((event) => event.eventType)).toContain('recovery_code_used');
      const again = await startTotpLogin(app, 'a@example.invalid');
      const reuse = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ challengeToken: again, recoveryCode: 'AAAA-BBBB-CCCC-DDDD' }),
      });
      expect(reuse.statusCode).toBe(401);
    });

    it('rejects expired challenges and User-Agent binding mismatches', async () => {
      await seedTotpUser(fixture, 'a@example.invalid');
      const expired = await startTotpLogin(app, 'a@example.invalid');
      fixture.clock.advance(6 * 60 * 1000);
      const stale = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ challengeToken: expired, code: totpCodeAtNow(fixture.clock.nowMs) }),
      });
      expect(stale.statusCode).toBe(401);
      expect(await fixture.store.findChallengeByHash(hashToken(expired))).toBeNull();

      fixture.clock.nowMs = TEST_NOW_MS;
      const first = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...publicHeaders({ 'user-agent': 'agent-one' }), ...jsonPayload({}).headers },
        payload: JSON.stringify({ email: 'a@example.invalid', password: PASSWORD }),
      });
      const challengeToken = (bodyOf(first).data as { challengeToken: string }).challengeToken;
      const mismatched = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { ...publicHeaders({ 'user-agent': 'agent-two' }), ...jsonPayload({}).headers },
        payload: JSON.stringify({ challengeToken, code: totpCodeAtNow(TEST_NOW_MS) }),
      });
      expect(mismatched.statusCode).toBe(401);
      expect(await fixture.store.findChallengeByHash(hashToken(challengeToken))).toBeNull();
    });

    it('requires exactly one of code and recoveryCode', async () => {
      const both = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ challengeToken: 'x', code: '123456', recoveryCode: 'abcd' }),
      });
      expect(both.statusCode).toBe(400);
      const neither = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ challengeToken: 'x' }),
      });
      expect(neither.statusCode).toBe(400);
    });
  });

  describe('GET /api/auth/me and GET /api/auth/csrf', () => {
    it('answers the boot-guard shape: 200 with ok true and session info', async () => {
      const hash = await fixture.hasher.hash(PASSWORD);
      const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: hash });
      const workspace = fixture.store.seedWorkspace(user.id);
      const { cookie } = await loginAs(app, 'a@example.invalid', PASSWORD);
      const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie, 'user-agent': USER_AGENT } });
      expect(res.statusCode).toBe(200);
      const body = bodyOf(res);
      expect(body.ok).toBe(true);
      expect(body.data?.email).toBe('a@example.invalid');
      expect(body.data?.totpEnabled).toBe(false);
      expect(body.data?.workspaceId).toBe(workspace.id);
      const session = body.data?.session as Record<string, unknown>;
      expect(typeof session.id).toBe('string');
      expect(session.stepUpAt).toBeNull();
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).not.toContain('passwordHash');
    });

    it('answers 401 unauthenticated without a session, including Bearer-only requests', async () => {
      const bare = await app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(bare.statusCode).toBe(401);
      expect(bodyOf(bare).error?.code).toBe('unauthenticated');
      expect(typeof bodyOf(bare).error?.requestId).toBe('string');
      expect(bodyOf(bare).error?.details).toEqual({});
      const bearer = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: 'Bearer some-agent-token' },
      });
      expect(bearer.statusCode).toBe(401);
      expect(bodyOf(bearer).error?.code).toBe('unauthenticated');
    });

    it('serves the CSRF token for the current session without mutating state', async () => {
      const { cookie, csrfToken } = await seedLoggedInUser(fixture, app, { email: 'a@example.invalid', password: PASSWORD });
      const res = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie, 'user-agent': USER_AGENT } });
      expect(res.statusCode).toBe(200);
      expect(bodyOf(res).data).toEqual({ csrfToken });
      expect(res.headers['cache-control']).toBe('no-store');
      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: sessionHeaders(cookie, (bodyOf(res).data as { csrfToken: string }).csrfToken),
      });
      expect(logout.statusCode).toBe(200);
      const noSession = await app.inject({ method: 'GET', url: '/api/auth/csrf' });
      expect(noSession.statusCode).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('deletes the session and clears the cookie', async () => {
      const { cookie, csrfToken } = await seedLoggedInUser(fixture, app, { email: 'a@example.invalid', password: PASSWORD });
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: sessionHeaders(cookie, csrfToken) });
      expect(res.statusCode).toBe(200);
      expect(bodyOf(res)).toEqual({ ok: true, data: null });
      expect(setCookieHeader(res)).toContain('Max-Age=0');
      const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(after.statusCode).toBe(401);
      expect(fixture.store.auditEvents.map((event) => event.eventType)).toContain('logout');
    });

    it('checks session, then Origin, then CSRF, with distinct codes', async () => {
      const { cookie, csrfToken } = await seedLoggedInUser(fixture, app, { email: 'a@example.invalid', password: PASSWORD });
      const noCookie = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: publicHeaders() });
      expect(noCookie.statusCode).toBe(401);
      const noCsrf = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { ...publicHeaders(), cookie },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(bodyOf(noCsrf).error?.code).toBe('csrf_invalid');
      const badOrigin = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: sessionHeaders(cookie, csrfToken, { origin: 'https://evil.example.invalid' }),
      });
      expect(badOrigin.statusCode).toBe(403);
      expect(bodyOf(badOrigin).error?.code).toBe('origin_rejected');
      const badOriginNoCsrf = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie, origin: 'https://evil.example.invalid', 'user-agent': USER_AGENT },
      });
      expect(badOriginNoCsrf.statusCode).toBe(403);
      expect(bodyOf(badOriginNoCsrf).error?.code).toBe('origin_rejected');
      const wrongToken = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: sessionHeaders(cookie, 'wrong-token'),
      });
      expect(wrongToken.statusCode).toBe(403);
      expect(bodyOf(wrongToken).error?.code).toBe('csrf_invalid');
    });

    it('does not mutate on GET', async () => {
      const { cookie } = await seedLoggedInUser(fixture, app, { email: 'a@example.invalid', password: PASSWORD });
      const res = await app.inject({ method: 'GET', url: '/api/auth/logout', headers: { cookie } });
      expect(res.statusCode).toBe(404);
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(me.statusCode).toBe(200);
    });
  });

  describe('sessions list and revoke', () => {
    it('lists own sessions with isCurrent and no secret material', async () => {
      const hash = await fixture.hasher.hash(PASSWORD);
      fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: hash });
      const first = await loginAs(app, 'a@example.invalid', PASSWORD);
      const second = await loginAs(app, 'a@example.invalid', PASSWORD);
      const res = await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: first.cookie } });
      expect(res.statusCode).toBe(200);
      const data = bodyOf(res).data as unknown as Array<Record<string, unknown>>;
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(2);
      expect(data.filter((entry) => entry.isCurrent === true)).toHaveLength(1);
      for (const entry of data) {
        expect(entry).not.toHaveProperty('sessionHash');
        expect(entry).not.toHaveProperty('csrfTokenHash');
        expect(entry).toHaveProperty('deviceLabel');
        expect(entry).toHaveProperty('absoluteExpiresAt');
      }
      void second;
    });

    it('revokes one own session, 404s for others, and clears the cookie for the current one', async () => {
      const hash = await fixture.hasher.hash(PASSWORD);
      fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: hash });
      fixture.store.seedUser({ email: 'b@example.invalid', passwordHash: hash });
      const a = await loginAs(app, 'a@example.invalid', PASSWORD);
      const b = await loginAs(app, 'b@example.invalid', PASSWORD);
      const listB = await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: b.cookie } });
      const bSessionId = (bodyOf(listB).data as unknown as Array<{ id: string }>)[0]?.id as string;
      const foreign = await app.inject({
        method: 'DELETE',
        url: `/api/auth/sessions/${bSessionId}`,
        headers: sessionHeaders(a.cookie, a.csrfToken),
      });
      expect(foreign.statusCode).toBe(404);
      expect(bodyOf(foreign).error?.code).toBe('not_found');
      const bogus = await app.inject({
        method: 'DELETE',
        url: '/api/auth/sessions/not-a-uuid',
        headers: sessionHeaders(a.cookie, a.csrfToken),
      });
      expect(bogus.statusCode).toBe(404);
      const current = await app.inject({
        method: 'DELETE',
        url: `/api/auth/sessions/${(bodyOf(await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: a.cookie } })).data as unknown as Array<{ id: string }>)[0]?.id}`,
        headers: sessionHeaders(a.cookie, a.csrfToken),
      });
      expect(current.statusCode).toBe(200);
      expect(setCookieHeader(current)).toContain('Max-Age=0');
      const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: a.cookie } });
      expect(after.statusCode).toBe(401);
      expect(fixture.store.auditEvents.map((event) => event.eventType)).toContain('session_revoked');
    });
  });

  describe('POST /api/auth/logout-all', () => {
    it('requires a fresh step-up', async () => {
      const { cookie, csrfToken } = await seedLoggedInUser(fixture, app, { email: 'a@example.invalid', password: PASSWORD });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout-all',
        headers: sessionHeaders(cookie, csrfToken),
      });
      expect(res.statusCode).toBe(403);
      expect(bodyOf(res).error?.code).toBe('step_up_required');
    });

    it('revokes every session and bumps the epoch after a fresh step-up', async () => {
      const hash = await fixture.hasher.hash(PASSWORD);
      const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: hash });
      const other = await loginAs(app, 'a@example.invalid', PASSWORD);
      const sessionId = newOpaqueToken();
      const sessionHash = hashToken(sessionId);
      const csrfToken = deriveCsrfToken(sessionHash, TEST_AUTH_SECRET);
      await fixture.store.createSession({
        userId: user.id,
        sessionHash,
        csrfTokenHash: hashToken(csrfToken),
        credentialEpoch: user.credentialEpoch,
        deviceLabel: 'Stepped up device',
        userAgent: USER_AGENT,
        createdIp: '127.0.0.1',
        lastSeenIp: '127.0.0.1',
        createdAt: new Date(TEST_NOW_MS),
        lastSeenAt: new Date(TEST_NOW_MS),
        absoluteExpiresAt: new Date(TEST_NOW_MS + 30 * 24 * 60 * 60 * 1000),
        stepUpAt: new Date(TEST_NOW_MS),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout-all',
        headers: sessionHeaders(`notegen_session=${sessionId}`, csrfToken),
      });
      expect(res.statusCode).toBe(200);
      expect(setCookieHeader(res)).toContain('Max-Age=0');
      expect(await fixture.store.listSessionsByUser(user.id)).toHaveLength(0);
      expect((await fixture.store.findUserById(user.id))?.credentialEpoch).toBe(2);
      expect(fixture.store.auditEvents.map((event) => event.eventType)).toContain('logout_all');
      const otherMe = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: other.cookie } });
      expect(otherMe.statusCode).toBe(401);
    });
  });

  describe('POST /api/auth/register', () => {
    it('answers 404 by design and creates nothing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { ...publicHeaders(), ...jsonPayload({}).headers },
        payload: JSON.stringify({ email: 'new@example.invalid', password: PASSWORD }),
      });
      expect(res.statusCode).toBe(404);
      expect(bodyOf(res).error?.code).toBe('not_found');
      expect(await fixture.store.getUserCount()).toBe(0);
    });

    it('still enforces the Origin check', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { 'user-agent': USER_AGENT, ...jsonPayload({}).headers },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(403);
      expect(bodyOf(res).error?.code).toBe('origin_rejected');
    });
  });
});

describe('deny by default without an injected auth context', () => {
  it('registers no auth route and keeps protected routes at 401', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: 'test' });
    app.get('/api/test-read', async () => ({ ok: true, data: {} }));
    try {
      const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(me.statusCode).toBe(404);
      const gated = await app.inject({ method: 'GET', url: '/api/test-read' });
      expect(gated.statusCode).toBe(401);
      expect(bodyOf(gated).error?.code).toBe('unauthenticated');
    } finally {
      await app.close();
    }
  });
});
