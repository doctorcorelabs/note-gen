// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// End-to-end tests for POST /api/auth/password/change (V3-02 part 2),
// through buildApp with inject() and a fake store, with the password
// route registered the way the integrator will wire it in buildApp.
// They pin the L2 reference harness behaviors from
// test/auth-negative-lifecycle.spec.ts against the real route: the
// generic 401 for a wrong current password with no login lockout, the
// 400 for a new password equal to the old one or shorter than 12
// characters, the kill-other-sessions plus fresh-absolute-expiry
// rotation plus epoch bump on success, and old-password-rejected /
// new-password-accepted after a change. They also pin the route's
// own contract surface: the frozen hook order (session, Origin,
// CSRF), strict body validation, the per-account failure bucket
// (5 per 15 minutes, failures only, never the login lockout), the
// { csrfToken } response shape with a new session cookie, and the
// absence of any step_up_required gate (the current password is the
// step-up, desain-auth.md section 3.5).

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Argon2PasswordHasher } from '../src/auth/passwords.js';
import { registerAuthPasswordRoutes } from '../src/routes/auth-password.js';
import {
  bodyOf,
  buildTestApp,
  cookieFromResponse,
  loginAs,
  makeTestAuth,
  publicHeaders,
  seedLoggedInUser,
  sessionHeaders,
  type TestAuth,
} from './auth/helpers.js';

const EMAIL = 'user@example.invalid';
const OLD_PASSWORD = 'fixture-user-password';
const NEW_PASSWORD = 'fixture-user-password-2';
const HOUR_MS = 60 * 60 * 1000;

async function buildPasswordApp(fixture: TestAuth): Promise<FastifyInstance> {
  const app = await buildTestApp(fixture.auth);
  await registerAuthPasswordRoutes(app, { auth: fixture.auth });
  return app;
}

async function changeAs(
  app: FastifyInstance,
  login: { cookie: string; csrfToken: string },
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/password/change',
    headers: { ...sessionHeaders(login.cookie, login.csrfToken), 'content-type': 'application/json', ...headers },
    payload,
  });
}

describe('POST /api/auth/password/change', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  it('a wrong current password answers the generic 401 and never touches the login lockout', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const login = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    const before = await fixture.store.findUserByEmail(EMAIL);
    const res = await changeAs(app, login, { currentPassword: 'fixture-wrong-password', newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res).error?.code).toBe('invalid_credentials');
    expect(bodyOf(res).error?.message).toBe('Email or password is incorrect.');
    expect(fixture.store.lockouts.size).toBe(0);
    const after = await fixture.store.findUserByEmail(EMAIL);
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.credentialEpoch).toBe(before?.credentialEpoch);
    expect(fixture.store.auditEvents.map((event) => event.eventType)).toContain('password_change_failed');
    expect(
      fixture.store.auditEvents.find((event) => event.eventType === 'password_change_failed')?.metadata,
    ).toEqual({ reason: 'invalid_current_password' });
  });

  it('a new password equal to the old one answers 400 validation_failed', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const login = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    const before = await fixture.store.findUserByEmail(EMAIL);
    const res = await changeAs(app, login, { currentPassword: OLD_PASSWORD, newPassword: OLD_PASSWORD });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error?.code).toBe('validation_failed');
    const fields = bodyOf(res).error?.details as { fields?: Array<{ field: string }> };
    expect(fields.fields?.map((entry) => entry.field)).toContain('newPassword');
    const after = await fixture.store.findUserByEmail(EMAIL);
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.credentialEpoch).toBe(before?.credentialEpoch);
  });

  it('a new password shorter than 12 characters answers 400 validation_failed', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const login = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    const res = await changeAs(app, login, { currentPassword: OLD_PASSWORD, newPassword: 'short' });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error?.code).toBe('validation_failed');
  });

  it('a new password longer than 128 characters answers 400 validation_failed', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const login = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    const res = await changeAs(app, login, { currentPassword: OLD_PASSWORD, newPassword: 'n'.repeat(129) });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error?.code).toBe('validation_failed');
  });

  it('a wrong current password wins over a malformed new password (L2 harness precedence)', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const login = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    const res = await changeAs(app, login, { currentPassword: 'fixture-wrong-password', newPassword: 'short' });
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res).error?.code).toBe('invalid_credentials');
  });

  it('a successful change kills other sessions, rotates the current one with a fresh absolute expiry, and bumps the epoch', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const first = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    const second = await loginAs(app, EMAIL, OLD_PASSWORD);
    const oldRows = await fixture.store.listSessionsByUser(first.userId);
    expect(oldRows).toHaveLength(2);
    const oldAbsolute = oldRows[0]?.absoluteExpiresAt.getTime() ?? 0;
    const epochBefore = (await fixture.store.findUserById(first.userId))?.credentialEpoch ?? 0;
    fixture.clock.advance(HOUR_MS);
    const res = await changeAs(app, first, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(bodyOf(res).data ?? {})).toEqual(['csrfToken']);
    const newCsrfToken = bodyOf(res).data?.csrfToken;
    expect(typeof newCsrfToken).toBe('string');
    const newCookie = cookieFromResponse(res);
    expect(newCookie).toBeDefined();
    expect(newCookie).not.toBe(first.cookie);
    const setCookie = res.headers['set-cookie'];
    expect(typeof setCookie).toBe('string');
    expect(setCookie as string).toContain('Path=/');
    expect(setCookie as string).toContain('HttpOnly');
    expect(setCookie as string).toContain('SameSite=Lax');
    expect(setCookie as string).toContain('Max-Age=2592000');
    const user = await fixture.store.findUserById(first.userId);
    expect(user?.credentialEpoch).toBe(epochBefore + 1);
    expect(user?.passwordChangedAt.getTime()).toBe(fixture.clock.nowMs);
    const newRows = await fixture.store.listSessionsByUser(first.userId);
    expect(newRows).toHaveLength(1);
    expect(newRows[0]?.absoluteExpiresAt.getTime()).toBeGreaterThan(oldAbsolute);
    expect(newRows[0]?.credentialEpoch).toBe(epochBefore + 1);
    expect(fixture.store.auditEvents.map((event) => event.eventType)).toContain('password_changed');
    for (const stale of [first.cookie, second.cookie]) {
      const denied = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { ...publicHeaders(), cookie: stale },
      });
      expect(denied.statusCode).toBe(401);
    }
    const served = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { ...publicHeaders(), cookie: newCookie as string },
    });
    expect(served.statusCode).toBe(200);
    const again = await changeAs(
      app,
      { cookie: newCookie as string, csrfToken: newCsrfToken as string },
      { currentPassword: NEW_PASSWORD, newPassword: 'fixture-user-password-3' },
    );
    expect(again.statusCode).toBe(200);
  });

  it('after a change, the old password fails and the new password works', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const login = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    const res = await changeAs(app, login, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(200);
    const old = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...publicHeaders(), 'content-type': 'application/json' },
      payload: { email: EMAIL, password: OLD_PASSWORD },
    });
    expect(old.statusCode).toBe(401);
    expect(bodyOf(old).error?.code).toBe('invalid_credentials');
    const relogin = await loginAs(app, EMAIL, NEW_PASSWORD);
    expect(relogin.userId).toBe(login.userId);
  });

  it('no separate step-up is required: a session fresh from login may change its password', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const login = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    const rows = await fixture.store.listSessionsByUser(login.userId);
    expect(rows[0]?.stepUpAt).toBeNull();
    const res = await changeAs(app, login, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(200);
  });

  it('without a session answers 401 unauthenticated', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password/change',
      headers: { ...publicHeaders(), 'content-type': 'application/json' },
      payload: { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res).error?.code).toBe('unauthenticated');
  });

  it('without a CSRF token answers 403 csrf_invalid, and with a wrong Origin answers 403 origin_rejected', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const login = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/auth/password/change',
      headers: { ...publicHeaders(), cookie: login.cookie, 'content-type': 'application/json' },
      payload: { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(bodyOf(noCsrf).error?.code).toBe('csrf_invalid');
    const badOrigin = await changeAs(
      app,
      login,
      { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
      { origin: 'https://evil.example.invalid' },
    );
    expect(badOrigin.statusCode).toBe(403);
    expect(bodyOf(badOrigin).error?.code).toBe('origin_rejected');
  });

  it('unknown fields and missing fields answer 400 validation_failed', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const login = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    const extra = await changeAs(app, login, {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      workspaceId: 'nope',
    });
    expect(extra.statusCode).toBe(400);
    expect(bodyOf(extra).error?.code).toBe('validation_failed');
    const fields = bodyOf(extra).error?.details as { fields?: Array<{ field: string }> };
    expect(fields.fields?.map((entry) => entry.field)).toContain('workspaceId');
    const missing = await changeAs(app, login, { currentPassword: OLD_PASSWORD });
    expect(missing.statusCode).toBe(400);
    expect(bodyOf(missing).error?.code).toBe('validation_failed');
  });

  it('five wrong attempts answer 401; the sixth answers 429 with Retry-After; the next window admits attempts again', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const login = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await changeAs(app, login, { currentPassword: 'fixture-wrong-password', newPassword: NEW_PASSWORD });
      expect(res.statusCode).toBe(401);
    }
    const limited = await changeAs(app, login, { currentPassword: 'fixture-wrong-password', newPassword: NEW_PASSWORD });
    expect(limited.statusCode).toBe(429);
    expect(bodyOf(limited).error?.code).toBe('rate_limited');
    expect(bodyOf(limited).error?.retryable).toBe(true);
    expect(limited.headers['retry-after']).toBeDefined();
    fixture.clock.advance(16 * 60 * 1000);
    const fresh = await changeAs(app, login, { currentPassword: 'fixture-wrong-password', newPassword: NEW_PASSWORD });
    expect(fresh.statusCode).toBe(401);
    expect(bodyOf(fresh).error?.code).toBe('invalid_credentials');
  });

  it('validation failures do not count toward the failure bucket', async () => {
    const fixture = makeTestAuth();
    app = await buildPasswordApp(fixture);
    const login = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await changeAs(app, login, { currentPassword: OLD_PASSWORD, newPassword: OLD_PASSWORD });
      expect(res.statusCode).toBe(400);
    }
    const res = await changeAs(app, login, { currentPassword: 'fixture-wrong-password', newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res).error?.code).toBe('invalid_credentials');
  });

  it('works end to end with the real Argon2id hasher', async () => {
    const fixture = makeTestAuth({ hasher: new Argon2PasswordHasher() });
    app = await buildPasswordApp(fixture);
    const login = await seedLoggedInUser(fixture, app, { email: EMAIL, password: OLD_PASSWORD });
    const wrong = await changeAs(app, login, { currentPassword: 'fixture-wrong-password', newPassword: NEW_PASSWORD });
    expect(wrong.statusCode).toBe(401);
    const res = await changeAs(app, login, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(200);
    await loginAs(app, EMAIL, NEW_PASSWORD);
  });
});
