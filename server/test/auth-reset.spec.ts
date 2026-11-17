// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Password reset route tests (kontrak-api-kanonis.md section 3.12;
// desain-auth.md section 3.6; V3-02 part 3). The app is the real
// buildApp with the real auth hook, the real envelope, and the real
// auth-core login routes; only the stores are fakes. The reset
// routes are registered onto the built app, the same way the L2
// reference harnesses register their stand-in routes, because the
// integrator owns the app.ts wiring (AD-57) and this task must not
// edit it. Login through the real routes is what makes the
// password-swap and session-kill assertions honest: no handler
// internals are consulted for those effects.
//
// Pinned behaviors asserted here (L2 reference harnesses in
// auth-negative.spec.ts and auth-negative-presession.spec.ts):
// reset-request answers one byte-identical generic 200 for known,
// unknown, disabled, malformed, and empty emails; unknown, expired,
// used, wrong-purpose, disabled-account, and email-mismatched
// tokens yield identical 400 invalid_action_token bodies; a token
// is single-use; a short new password answers validation_failed and
// leaves the token usable; a successful confirm bumps the epoch,
// kills sessions, sets no cookie, and swaps the password; GET on
// either path answers 404; a wrong or missing Origin answers 403.
// Rate limits (desain-auth.md section 6.4) and both SMTP branches
// (section 3.6) are asserted on top of those pins. The fake reset
// store mirrors the Drizzle store semantics the handlers depend on
// (prior-token invalidation, conditional claim); the Drizzle store
// itself has no live-database test in this file.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/auth/crypto.js';
import { registerAuthResetRoutes } from '../src/routes/auth-reset.js';
import {
  isUsableResetToken,
  mintResetToken,
  PASSWORD_RESET_COMPLETED_EVENT,
  PASSWORD_RESET_REQUESTED_EVENT,
  RESET_CONFIRM_MESSAGE,
  RESET_REQUEST_MESSAGE,
  RESET_TOKEN_MS,
  type ActionTokenRow,
  type CreateResetTokenInput,
  type PasswordResetStore,
} from '../src/services/auth/password-reset.js';
import {
  bodyOf,
  buildTestApp,
  loginAs,
  makeTestAuth,
  publicHeaders,
  TEST_NOW_MS,
  type TestAuth,
} from './auth/helpers.js';

const KNOWN_EMAIL = 'known@example.invalid';
const DISABLED_EMAIL = 'disabled@example.invalid';
const UNKNOWN_EMAIL = 'unknown@example.invalid';
const OLD_PASSWORD = 'fixture-old-password';
const NEW_PASSWORD = 'fixture-new-password';
const VALID_TOKEN = 'fixture-reset-token-valid';

class FakePasswordResetStore implements PasswordResetStore {
  rows = new Map<string, ActionTokenRow>();
  rowsByHash = new Map<string, ActionTokenRow>();

  async createResetToken(input: CreateResetTokenInput): Promise<ActionTokenRow> {
    for (const row of [...this.rows.values()]) {
      if (row.email === input.email && row.purpose === 'reset_password') {
        this.rows.delete(row.id);
        this.rowsByHash.delete(row.tokenHash);
      }
    }
    const row: ActionTokenRow = {
      id: randomUUID(),
      userId: input.userId,
      email: input.email,
      purpose: 'reset_password',
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      usedAt: null,
      createdAt: new Date(),
      createdByUserId: null,
    };
    this.rows.set(row.id, row);
    this.rowsByHash.set(row.tokenHash, row);
    return row;
  }

  async findActionTokenByHash(tokenHash: string): Promise<ActionTokenRow | null> {
    return this.rowsByHash.get(tokenHash) ?? null;
  }

  async claimActionToken(id: string, usedAt: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (row === undefined || row.usedAt !== null) {
      return false;
    }
    row.usedAt = usedAt;
    return true;
  }

  seed(input: {
    token: string;
    userId: string | null;
    email: string;
    purpose?: string;
    expiresAt?: Date;
    usedAt?: Date | null;
  }): ActionTokenRow {
    const row: ActionTokenRow = {
      id: randomUUID(),
      userId: input.userId,
      email: input.email,
      purpose: input.purpose ?? 'reset_password',
      tokenHash: hashToken(input.token),
      expiresAt: input.expiresAt ?? new Date(TEST_NOW_MS + RESET_TOKEN_MS),
      usedAt: input.usedAt ?? null,
      createdAt: new Date(TEST_NOW_MS),
      createdByUserId: null,
    };
    this.rows.set(row.id, row);
    this.rowsByHash.set(row.tokenHash, row);
    return row;
  }

  resetTokens(): ActionTokenRow[] {
    return [...this.rows.values()];
  }
}

interface ResetApp {
  app: FastifyInstance;
  fixture: TestAuth;
  resetStore: FakePasswordResetStore;
}

async function buildResetApp(options: {
  smtpConfigured?: boolean;
  trustProxy?: boolean;
  storeNull?: boolean;
} = {}): Promise<ResetApp> {
  const fixture = makeTestAuth({
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
    ...(options.storeNull === true ? { store: null } : {}),
  });
  const app = await buildTestApp(fixture.auth);
  const resetStore = new FakePasswordResetStore();
  await registerAuthResetRoutes(app, {
    auth: fixture.auth,
    resetStore,
    smtpConfigured: options.smtpConfigured ?? false,
  });
  return { app, fixture, resetStore };
}

async function seedKnownUser(fixture: TestAuth, email: string, password: string, status = 'active') {
  const hash = await fixture.hasher.hash(password);
  return fixture.store.seedUser({ email, passwordHash: hash, status });
}

function postJson(url: string, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return {
    method: 'POST' as const,
    url,
    headers: publicHeaders({ 'content-type': 'application/json', ...extraHeaders }),
    payload,
  };
}

function errorOf(res: LightMyRequestResponse): { code: string; message: string } {
  return (res.json() as { error: { code: string; message: string } }).error;
}

function normalizedDenial(res: LightMyRequestResponse): string {
  const parsed = JSON.parse(res.body) as { error: { requestId: string } };
  parsed.error.requestId = 'redacted';
  return JSON.stringify(parsed);
}

describe('password reset service units', () => {
  it('mintResetToken produces a 43 character opaque token, its SHA-256 hash, and a 60 minute expiry', () => {
    const minted = mintResetToken(TEST_NOW_MS);
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.tokenHash).toBe(hashToken(minted.token));
    expect(minted.expiresAt.getTime()).toBe(TEST_NOW_MS + RESET_TOKEN_MS);
    expect(mintResetToken(TEST_NOW_MS).token).not.toBe(minted.token);
  });

  it('isUsableResetToken requires reset purpose, unused, and unexpired, with expiry at now already expired', () => {
    const store = new FakePasswordResetStore();
    const usable = store.seed({ token: 'u1', userId: 'user-1', email: KNOWN_EMAIL });
    expect(isUsableResetToken(usable, TEST_NOW_MS)).toBe(true);
    const invitation = store.seed({ token: 'u2', userId: 'user-1', email: KNOWN_EMAIL, purpose: 'invitation' });
    expect(isUsableResetToken(invitation, TEST_NOW_MS)).toBe(false);
    const used = store.seed({ token: 'u3', userId: 'user-1', email: KNOWN_EMAIL, usedAt: new Date(TEST_NOW_MS) });
    expect(isUsableResetToken(used, TEST_NOW_MS)).toBe(false);
    const expired = store.seed({
      token: 'u4',
      userId: 'user-1',
      email: KNOWN_EMAIL,
      expiresAt: new Date(TEST_NOW_MS - 1),
    });
    expect(isUsableResetToken(expired, TEST_NOW_MS)).toBe(false);
    const boundary = store.seed({
      token: 'u5',
      userId: 'user-1',
      email: KNOWN_EMAIL,
      expiresAt: new Date(TEST_NOW_MS),
    });
    expect(isUsableResetToken(boundary, TEST_NOW_MS)).toBe(false);
  });
});

describe('POST /api/auth/password/reset-request', () => {
  it('answers one byte-identical generic 200 for known, unknown, disabled, malformed, empty, and missing emails', async () => {
    const { app, fixture, resetStore } = await buildResetApp();
    await seedKnownUser(fixture, KNOWN_EMAIL, OLD_PASSWORD);
    await seedKnownUser(fixture, DISABLED_EMAIL, OLD_PASSWORD, 'disabled');
    const bodies: string[] = [];
    const payloads: Record<string, unknown>[] = [
      { email: KNOWN_EMAIL },
      { email: UNKNOWN_EMAIL },
      { email: DISABLED_EMAIL },
      { email: 'not-an-email' },
      { email: '' },
      {},
      { email: 42 },
      { email: ['x'] },
    ];
    for (const payload of payloads) {
      const res = await app.inject(postJson('/api/auth/password/reset-request', payload));
      expect(res.statusCode).toBe(200);
      bodies.push(res.body);
      // Roll the rate-limit windows so the genericity comparison is
      // not polluted by the IP bucket tripping mid-loop.
      fixture.clock.advance(61 * 60 * 1000);
    }
    for (const body of bodies.slice(1)) {
      expect(body).toBe(bodies[0]);
    }
    expect(bodyOf(await app.inject(postJson('/api/auth/password/reset-request', { email: KNOWN_EMAIL }))).data).toEqual({
      message: RESET_REQUEST_MESSAGE,
    });
    await app.close();
    // No-SMTP branch: nothing observable was created anywhere.
    expect(resetStore.resetTokens()).toHaveLength(0);
    expect(fixture.store.auditEvents).toHaveLength(0);
  });

  it('no-SMTP branch: a known active email still creates no token and no audit event', async () => {
    const { app, fixture, resetStore } = await buildResetApp({ smtpConfigured: false });
    await seedKnownUser(fixture, KNOWN_EMAIL, OLD_PASSWORD);
    const res = await app.inject(postJson('/api/auth/password/reset-request', { email: KNOWN_EMAIL }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(resetStore.resetTokens()).toHaveLength(0);
    expect(fixture.store.auditEvents).toHaveLength(0);
    await app.close();
  });

  it('SMTP branch: a known active email stores only a hash, audits once, and the wire body stays generic', async () => {
    const { app, fixture, resetStore } = await buildResetApp({ smtpConfigured: true });
    const user = await seedKnownUser(fixture, KNOWN_EMAIL, OLD_PASSWORD);
    await seedKnownUser(fixture, DISABLED_EMAIL, OLD_PASSWORD, 'disabled');
    const known = await app.inject(postJson('/api/auth/password/reset-request', { email: KNOWN_EMAIL }));
    expect(known.statusCode).toBe(200);
    expect(known.body).not.toMatch(/[0-9a-f]{64}/);
    const rows = resetStore.resetTokens();
    expect(rows).toHaveLength(1);
    const row = rows[0] as ActionTokenRow;
    expect(row.purpose).toBe('reset_password');
    expect(row.userId).toBe(user.id);
    expect(row.email).toBe(KNOWN_EMAIL);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expiresAt.getTime()).toBe(TEST_NOW_MS + RESET_TOKEN_MS);
    expect(row.usedAt).toBeNull();
    expect(row.createdByUserId).toBeNull();
    expect(fixture.store.auditEvents.map((event) => event.eventType)).toEqual([PASSWORD_RESET_REQUESTED_EVENT]);
    expect(fixture.store.auditEvents[0]?.userId).toBe(user.id);
    fixture.clock.advance(61 * 60 * 1000);
    const unknown = await app.inject(postJson('/api/auth/password/reset-request', { email: UNKNOWN_EMAIL }));
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toBe(known.body);
    fixture.clock.advance(61 * 60 * 1000);
    const disabled = await app.inject(postJson('/api/auth/password/reset-request', { email: DISABLED_EMAIL }));
    expect(disabled.statusCode).toBe(200);
    expect(disabled.body).toBe(known.body);
    expect(resetStore.resetTokens()).toHaveLength(1);
    expect(fixture.store.auditEvents).toHaveLength(1);
    await app.close();
  });

  it('SMTP branch: a second request invalidates the first token, leaving exactly one row', async () => {
    const { app, fixture, resetStore } = await buildResetApp({ smtpConfigured: true });
    await seedKnownUser(fixture, KNOWN_EMAIL, OLD_PASSWORD);
    await app.inject(postJson('/api/auth/password/reset-request', { email: KNOWN_EMAIL }));
    const firstHash = resetStore.resetTokens()[0]?.tokenHash;
    fixture.clock.advance(61 * 60 * 1000);
    await app.inject(postJson('/api/auth/password/reset-request', { email: KNOWN_EMAIL }));
    const rows = resetStore.resetTokens();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(firstHash);
    await app.close();
  });

  it('rate limit: the 4th request from one IP in an hour answers 429 with Retry-After and no X-RateLimit headers', async () => {
    const { app } = await buildResetApp();
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject(
        postJson('/api/auth/password/reset-request', { email: `probe-${i}@example.invalid` }),
      );
      expect(res.statusCode).toBe(200);
    }
    const limited = await app.inject(postJson('/api/auth/password/reset-request', { email: 'probe-3@example.invalid' }));
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers).not.toHaveProperty('x-ratelimit-limit');
    expect(limited.headers).not.toHaveProperty('x-ratelimit-remaining');
    expect(limited.headers).not.toHaveProperty('x-ratelimit-reset');
    await app.close();
  });

  it('rate limit: a tripped account bucket still answers 200 but creates no new token', async () => {
    const { app, fixture, resetStore } = await buildResetApp({ smtpConfigured: true, trustProxy: true });
    await seedKnownUser(fixture, KNOWN_EMAIL, OLD_PASSWORD);
    const bodies: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await app.inject(
        postJson('/api/auth/password/reset-request', { email: KNOWN_EMAIL }, { 'x-forwarded-for': `203.0.113.${i + 1}` }),
      );
      expect(res.statusCode).toBe(200);
      bodies.push(res.body);
    }
    for (const body of bodies.slice(1)) {
      expect(body).toBe(bodies[0]);
    }
    // Requests 1-3 each minted (invalidating the last); request 4
    // minted nothing, so the stored hash is the third mint's hash
    // and exactly one row exists.
    expect(resetStore.resetTokens()).toHaveLength(1);
    expect(fixture.store.auditEvents).toHaveLength(3);
    await app.close();
  });

  it('a wrong or missing Origin answers 403 origin_rejected, and no session is required', async () => {
    const { app } = await buildResetApp();
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset-request',
      headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: KNOWN_EMAIL }),
    });
    expect(wrong.statusCode).toBe(403);
    expect(errorOf(wrong).code).toBe('origin_rejected');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset-request',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: KNOWN_EMAIL }),
    });
    expect(missing.statusCode).toBe(403);
    expect(errorOf(missing).code).toBe('origin_rejected');
    const noSession = await app.inject(postJson('/api/auth/password/reset-request', { email: KNOWN_EMAIL }));
    expect(noSession.statusCode).toBe(200);
    await app.close();
  });

  it('GET on the reset-request path answers 405', async () => {
    const { app } = await buildResetApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/password/reset-request' });
    expect(res.statusCode).toBe(405);
    expect(errorOf(res).code).toBe('method_not_allowed');
    await app.close();
  });

  it('without a store the route answers 503, never 401 or 404', async () => {
    const { app } = await buildResetApp({ storeNull: true });
    const res = await app.inject(postJson('/api/auth/password/reset-request', { email: KNOWN_EMAIL }));
    expect(res.statusCode).toBe(503);
    expect(errorOf(res).code).toBe('service_unavailable');
    const confirm = await app.inject(
      postJson('/api/auth/password/reset-confirm', { token: VALID_TOKEN, newPassword: NEW_PASSWORD }),
    );
    expect(confirm.statusCode).toBe(503);
    expect(errorOf(confirm).code).toBe('service_unavailable');
    await app.close();
  });
});

describe('POST /api/auth/password/reset-confirm', () => {
  it('a valid confirm bumps the epoch, kills sessions, sets no cookie, and swaps the password', async () => {
    const { app, fixture, resetStore } = await buildResetApp({ smtpConfigured: false });
    const user = await seedKnownUser(fixture, KNOWN_EMAIL, OLD_PASSWORD);
    const epochBefore = user.credentialEpoch;
    const login = await loginAs(app, KNOWN_EMAIL, OLD_PASSWORD);
    const tokenRow = resetStore.seed({ token: VALID_TOKEN, userId: user.id, email: KNOWN_EMAIL });
    const confirm = await app.inject(
      postJson('/api/auth/password/reset-confirm', { token: VALID_TOKEN, newPassword: NEW_PASSWORD }),
    );
    expect(confirm.statusCode).toBe(200);
    expect(bodyOf(confirm).data).toEqual({ message: RESET_CONFIRM_MESSAGE });
    expect(confirm.headers['set-cookie']).toBeUndefined();
    expect(tokenRow.usedAt).not.toBeNull();
    const after = await fixture.store.findUserById(user.id);
    expect(after?.credentialEpoch).toBe(epochBefore + 1);
    expect(fixture.store.auditEvents.map((event) => event.eventType)).toContain(PASSWORD_RESET_COMPLETED_EVENT);
    const dead = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: login.cookie },
    });
    expect(dead.statusCode).toBe(401);
    const oldPassword = await app.inject(
      postJson('/api/auth/login', { email: KNOWN_EMAIL, password: OLD_PASSWORD }),
    );
    expect(oldPassword.statusCode).toBe(401);
    const newPassword = await loginAs(app, KNOWN_EMAIL, NEW_PASSWORD);
    expect(newPassword.userId).toBe(user.id);
    await app.close();
  }, 15000);

  it('a reset token is single-use: the second confirmation answers 400 and the password does not change again', async () => {
    const { app, fixture, resetStore } = await buildResetApp();
    const user = await seedKnownUser(fixture, KNOWN_EMAIL, OLD_PASSWORD);
    resetStore.seed({ token: VALID_TOKEN, userId: user.id, email: KNOWN_EMAIL });
    const first = await app.inject(
      postJson('/api/auth/password/reset-confirm', { token: VALID_TOKEN, newPassword: NEW_PASSWORD }),
    );
    expect(first.statusCode).toBe(200);
    const again = await app.inject(
      postJson('/api/auth/password/reset-confirm', { token: VALID_TOKEN, newPassword: 'fixture-other-password' }),
    );
    expect(again.statusCode).toBe(400);
    expect(errorOf(again).code).toBe('invalid_action_token');
    const stillFirst = await loginAs(app, KNOWN_EMAIL, NEW_PASSWORD);
    expect(stillFirst.userId).toBe(user.id);
    await app.close();
  }, 15000);

  it('unknown, expired, used, wrong-purpose, disabled, mismatched, and orphan tokens yield identical 400 bodies', async () => {
    const { app, fixture, resetStore } = await buildResetApp();
    const user = await seedKnownUser(fixture, KNOWN_EMAIL, OLD_PASSWORD);
    const disabled = await seedKnownUser(fixture, DISABLED_EMAIL, OLD_PASSWORD, 'disabled');
    resetStore.seed({ token: 't-expired', userId: user.id, email: KNOWN_EMAIL, expiresAt: new Date(TEST_NOW_MS - 1) });
    resetStore.seed({ token: 't-used', userId: user.id, email: KNOWN_EMAIL, usedAt: new Date(TEST_NOW_MS) });
    resetStore.seed({ token: 't-invitation', userId: user.id, email: KNOWN_EMAIL, purpose: 'invitation' });
    resetStore.seed({ token: 't-disabled', userId: disabled.id, email: DISABLED_EMAIL });
    resetStore.seed({ token: 't-mismatch', userId: user.id, email: 'other@example.invalid' });
    resetStore.seed({ token: 't-orphan', userId: randomUUID(), email: KNOWN_EMAIL });
    resetStore.seed({ token: 't-nouser', userId: null, email: KNOWN_EMAIL });
    const denials: string[] = [];
    for (const token of ['t-unknown', 't-expired', 't-used', 't-invitation', 't-disabled', 't-mismatch', 't-orphan', 't-nouser']) {
      const res = await app.inject(postJson('/api/auth/password/reset-confirm', { token, newPassword: NEW_PASSWORD }));
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('invalid_action_token');
      denials.push(normalizedDenial(res));
      fixture.clock.advance(16 * 60 * 1000);
    }
    for (const denial of denials.slice(1)) {
      expect(denial).toBe(denials[0]);
    }
    await app.close();
  });

  it('a token expiring exactly now answers 400', async () => {
    const { app, fixture, resetStore } = await buildResetApp();
    const user = await seedKnownUser(fixture, KNOWN_EMAIL, OLD_PASSWORD);
    resetStore.seed({ token: VALID_TOKEN, userId: user.id, email: KNOWN_EMAIL, expiresAt: new Date(TEST_NOW_MS) });
    const res = await app.inject(
      postJson('/api/auth/password/reset-confirm', { token: VALID_TOKEN, newPassword: NEW_PASSWORD }),
    );
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('invalid_action_token');
    await app.close();
  });

  it('a short new password answers 400 validation_failed and leaves the token usable', async () => {
    const { app, fixture, resetStore } = await buildResetApp();
    const user = await seedKnownUser(fixture, KNOWN_EMAIL, OLD_PASSWORD);
    const tokenRow = resetStore.seed({ token: VALID_TOKEN, userId: user.id, email: KNOWN_EMAIL });
    const bad = await app.inject(postJson('/api/auth/password/reset-confirm', { token: VALID_TOKEN, newPassword: 'short' }));
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).code).toBe('validation_failed');
    expect(tokenRow.usedAt).toBeNull();
    const good = await app.inject(
      postJson('/api/auth/password/reset-confirm', { token: VALID_TOKEN, newPassword: NEW_PASSWORD }),
    );
    expect(good.statusCode).toBe(200);
    await app.close();
  });

  it('a missing token answers invalid_action_token, a missing new password answers validation_failed, and unknown fields are ignored', async () => {
    const { app, fixture, resetStore } = await buildResetApp();
    const user = await seedKnownUser(fixture, KNOWN_EMAIL, OLD_PASSWORD);
    const tokenRow = resetStore.seed({ token: VALID_TOKEN, userId: user.id, email: KNOWN_EMAIL });
    const noToken = await app.inject(postJson('/api/auth/password/reset-confirm', { newPassword: NEW_PASSWORD }));
    expect(noToken.statusCode).toBe(400);
    expect(errorOf(noToken).code).toBe('invalid_action_token');
    const noPassword = await app.inject(postJson('/api/auth/password/reset-confirm', { token: VALID_TOKEN }));
    expect(noPassword.statusCode).toBe(400);
    expect(errorOf(noPassword).code).toBe('validation_failed');
    expect(tokenRow.usedAt).toBeNull();
    const extra = await app.inject(
      postJson('/api/auth/password/reset-confirm', { token: VALID_TOKEN, newPassword: NEW_PASSWORD, extra: 'ignored' }),
    );
    expect(extra.statusCode).toBe(200);
    await app.close();
  });

  it('rate limit: the 6th confirm attempt from one IP answers 429 and the valid token stays usable after the window', async () => {
    const { app, fixture, resetStore } = await buildResetApp();
    const user = await seedKnownUser(fixture, KNOWN_EMAIL, OLD_PASSWORD);
    const tokenRow = resetStore.seed({ token: VALID_TOKEN, userId: user.id, email: KNOWN_EMAIL });
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject(
        postJson('/api/auth/password/reset-confirm', { token: `bad-token-${i}`, newPassword: NEW_PASSWORD }),
      );
      expect(res.statusCode).toBe(400);
    }
    const limited = await app.inject(
      postJson('/api/auth/password/reset-confirm', { token: VALID_TOKEN, newPassword: NEW_PASSWORD }),
    );
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(tokenRow.usedAt).toBeNull();
    fixture.clock.advance(16 * 60 * 1000);
    const good = await app.inject(
      postJson('/api/auth/password/reset-confirm', { token: VALID_TOKEN, newPassword: NEW_PASSWORD }),
    );
    expect(good.statusCode).toBe(200);
    await app.close();
  });

  it('a wrong or missing Origin answers 403 origin_rejected, and GET answers 404', async () => {
    const { app } = await buildResetApp();
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset-confirm',
      headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ token: VALID_TOKEN, newPassword: NEW_PASSWORD }),
    });
    expect(wrong.statusCode).toBe(403);
    expect(errorOf(wrong).code).toBe('origin_rejected');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset-confirm',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token: VALID_TOKEN, newPassword: NEW_PASSWORD }),
    });
    expect(missing.statusCode).toBe(403);
    expect(errorOf(missing).code).toBe('origin_rejected');
    const get = await app.inject({ method: 'GET', url: '/api/auth/password/reset-confirm' });
    expect(get.statusCode).toBe(405);
    expect(errorOf(get).code).toBe('method_not_allowed');
    await app.close();
  });
});
