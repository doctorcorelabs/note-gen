// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Negative pre-session auth tests (worker V3-01cR, wave 3A).
//
// LAYER: L2 contract reference harness, same split as
// auth-negative-lifecycle.spec.ts: the app, the real auth hook, and
// the real envelope are production code; the handlers under
// /api/test-* and the stores behind them are test-only stand-ins for
// the V3-01b/V3-02 routes. A green run pins the assertions the real
// routes must satisfy; it does not prove the real routes satisfy
// them. The live probes in auth-negative-live.spec.ts are the honest
// check against real routes.
//
// This file covers the pre-session surface the lifecycle harness
// does not: register 404 by design in closed mode, conditional setup
// 404, and reset-request/reset-confirm genericity. Lockout, buckets,
// rotation, and step-up live in the lifecycle file; the minimal
// login here exists only so setup and reset effects can be observed
// end to end (no lockout or bucket logic is duplicated).
//
// Reference readings pinned here and needing V3-01b confirmation at
// merge: a missing or empty setup token answers 401
// invalid_setup_token (failed verification, not a validation error);
// reset-request answers the same 200 even for a malformed email.
//
// Sources: desain-auth.md sections 2.1-2.4, 3.6; kontrak-api-kanonis.md
// sections 1.2, 3.12, 6.

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { createOriginPreHandler, getPrincipal } from '../src/middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../src/plugins/envelope.js';

const CANONICAL_ORIGIN = 'https://app.example.invalid';
const VERSION = '0.39.2-fork.1';
const SETUP_TOKEN_FIXTURE = 'fixture-setup-token-only-not-real';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

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
    trustProxy: false,
    cookieSecure: true,
    cfAccessEnabled: false,
    cfAccessTeamDomain: undefined,
    cfAccessAud: undefined,
    cfAccessJwksCacheTtlSeconds: 3600,
    cfAccessServiceAud: undefined,
    jwtAudience: undefined,
    authSecretConfigured: false,
    authSecretLengthOk: false,
    encryptionKeyConfigured: false,
    setupTokenConfigured: false,
    setupTokenLengthOk: false,
    maxBodyBytes: 1048576,
    ...overrides,
  };
}

interface ErrorEnvelopeBody {
  ok: false;
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

function errorOf(res: InjectResponse): ErrorEnvelopeBody['error'] {
  return (res.json() as ErrorEnvelopeBody).error;
}

function normalizedDenial(res: InjectResponse): string {
  const parsed = JSON.parse(res.body) as ErrorEnvelopeBody;
  parsed.error.requestId = 'redacted';
  return JSON.stringify(parsed);
}

interface PresessionAccount {
  id: string;
  email: string;
  password: string;
  status: 'active' | 'disabled';
  credentialEpoch: number;
}

interface PresessionState {
  accountsByEmail: Map<string, PresessionAccount>;
  sessions: Map<string, { userId: string; sessionEpoch: number }>;
  setupComplete: boolean;
  actionTokens: Map<string, { email: string; purpose: string; expired: boolean; used: boolean }>;
  sentEmails: string[];
  nextId: number;
}

function newPresessionState(): PresessionState {
  return {
    accountsByEmail: new Map([
      ['known@example.invalid', { id: 'user-1', email: 'known@example.invalid', password: 'fixture-known-password', status: 'active', credentialEpoch: 0 }],
      ['disabled@example.invalid', { id: 'user-2', email: 'disabled@example.invalid', password: 'fixture-known-password', status: 'disabled', credentialEpoch: 0 }],
    ]),
    sessions: new Map(),
    setupComplete: false,
    actionTokens: new Map([
      ['token-good', { email: 'known@example.invalid', purpose: 'reset_password', expired: false, used: false }],
      ['token-expired', { email: 'known@example.invalid', purpose: 'reset_password', expired: true, used: false }],
      ['token-used', { email: 'known@example.invalid', purpose: 'reset_password', expired: false, used: true }],
      ['token-invitation', { email: 'known@example.invalid', purpose: 'invitation', expired: false, used: false }],
      ['token-disabled', { email: 'disabled@example.invalid', purpose: 'reset_password', expired: false, used: false }],
    ]),
    sentEmails: [],
    nextId: 0,
  };
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

async function buildPresessionApp(): Promise<{ app: FastifyInstance; state: PresessionState }> {
  const state = newPresessionState();
  const app = await buildApp({
    config: testConfig(),
    pool: null,
    version: VERSION,
    verifySession: async ({ sessionId }) => {
      if (sessionId === undefined) {
        return null;
      }
      const row = state.sessions.get(sessionId);
      if (row === undefined) {
        return null;
      }
      const account = [...state.accountsByEmail.values()].find((candidate) => candidate.id === row.userId);
      if (account === undefined || account.status !== 'active' || row.sessionEpoch !== account.credentialEpoch) {
        return null;
      }
      return { userId: account.id, role: 'user', sessionId };
    },
  });
  const originOnly = {
    config: { requiresAuth: false },
    preHandler: createOriginPreHandler(CANONICAL_ORIGIN),
  };

  app.post('/api/test-register', originOnly, async () => {
    throw ApiError.notFound();
  });

  app.post('/api/test-setup', originOnly, async (request, reply) => {
    // The completed check runs first: after installation, a wrong
    // token must still answer 404, never 401, so completion is not
    // observable through the token verdict.
    if (state.setupComplete) {
      throw ApiError.notFound();
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (stringField(body, 'setupToken') !== SETUP_TOKEN_FIXTURE) {
      throw ApiError.invalidSetupToken();
    }
    const email = stringField(body, 'email').trim().toLowerCase();
    const password = stringField(body, 'password');
    if (email === '' || password.length < 12 || password.length > 128) {
      throw ApiError.validation();
    }
    state.nextId += 1;
    state.accountsByEmail.set(email, {
      id: `user-setup-${state.nextId}`,
      email,
      password,
      status: 'active',
      credentialEpoch: 0,
    });
    state.setupComplete = true;
    reply.code(201);
    return successEnvelope({ id: `user-setup-${state.nextId}`, email, workspaceId: 'workspace-1' });
  });

  app.post('/api/test-reset-request', originOnly, async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = stringField(body, 'email').trim().toLowerCase();
    const account = state.accountsByEmail.get(email);
    // Only a live difference, server-side: an email is recorded only
    // for an existing active account. The wire response never varies.
    if (account !== undefined && account.status === 'active') {
      state.sentEmails.push(email);
    }
    return successEnvelope({ message: 'If the email is registered, a reset link has been sent.' });
  });

  app.post('/api/test-reset-confirm', originOnly, async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = stringField(body, 'token');
    const next = stringField(body, 'newPassword');
    const entry = state.actionTokens.get(token);
    const account = entry === undefined ? undefined : state.accountsByEmail.get(entry.email);
    if (
      entry === undefined ||
      entry.expired ||
      entry.used ||
      entry.purpose !== 'reset_password' ||
      account === undefined ||
      account.status !== 'active'
    ) {
      throw new ApiError(400, 'invalid_action_token', 'The link is not valid or has expired.');
    }
    if (next.length < 12 || next.length > 128) {
      throw ApiError.validation();
    }
    entry.used = true;
    account.password = next;
    account.credentialEpoch += 1;
    for (const [id, row] of state.sessions) {
      if (row.userId === account.id) {
        state.sessions.delete(id);
      }
    }
    return successEnvelope({ message: 'Password updated. Please log in again.' });
  });

  // Minimal login, only so setup/reset effects are observable. No
  // lockout, no buckets: those live in the lifecycle harness.
  app.post('/api/test-presession-login', originOnly, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = stringField(body, 'email').trim().toLowerCase();
    const password = stringField(body, 'password');
    const account = state.accountsByEmail.get(email);
    if (account === undefined || account.status !== 'active' || account.password !== password) {
      throw ApiError.invalidCredentials();
    }
    state.nextId += 1;
    const sessionId = `presess-${state.nextId}`;
    state.sessions.set(sessionId, { userId: account.id, sessionEpoch: account.credentialEpoch });
    reply.header('Set-Cookie', `notegen_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
    return successEnvelope({ id: account.id, email: account.email });
  });

  app.get('/api/test-presession-me', async (request) => {
    const principal = getPrincipal(request);
    if (principal === undefined) {
      throw ApiError.unauthenticated();
    }
    return successEnvelope({ userId: principal.userId });
  });

  return { app, state };
}

function postJson(url: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  payload: string;
} {
  return {
    method: 'POST',
    url,
    headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', ...extraHeaders },
    payload: JSON.stringify(body),
  };
}

describe('L2: register 404 by design in closed mode [reference harness]', () => {
  it('register 404 is byte-identical to an unknown-route 404 except requestId: the route looks absent', async () => {
    const { app } = await buildPresessionApp();
    const register = await app.inject(postJson('/api/test-register', { email: 'new@example.invalid', password: 'fixture-new-password' }));
    expect(register.statusCode).toBe(404);
    const unknown = await app.inject({ method: 'GET', url: '/api/test-definitely-absent' });
    expect(unknown.statusCode).toBe(404);
    expect(normalizedDenial(register)).toBe(normalizedDenial(unknown));
    await app.close();
  });

  it('register 404 is identical for valid, empty, and garbage bodies: no mode oracle', async () => {
    const { app } = await buildPresessionApp();
    const denials: string[] = [];
    for (const body of [
      { email: 'new@example.invalid', password: 'fixture-new-password' },
      {},
      { email: 42, password: ['x'] },
      { email: 'not-an-email', password: 'x' },
    ]) {
      const res = await app.inject(postJson('/api/test-register', body as Record<string, unknown>));
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('not_found');
      expect(res.body).not.toContain('closed');
      expect(res.body).not.toContain('registration');
      denials.push(normalizedDenial(res));
    }
    for (const denial of denials.slice(1)) {
      expect(denial).toBe(denials[0]);
    }
    await app.close();
  });

  it('register creates no account: a later login with that email answers the same 401 as a never-seen email', async () => {
    const { app } = await buildPresessionApp();
    await app.inject(postJson('/api/test-register', { email: 'fresh@example.invalid', password: 'fixture-new-password' }));
    const denials: string[] = [];
    for (const email of ['fresh@example.invalid', 'never-seen@example.invalid']) {
      const res = await app.inject(postJson('/api/test-presession-login', { email, password: 'fixture-new-password' }));
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('invalid_credentials');
      denials.push(normalizedDenial(res));
    }
    expect(denials[1]).toBe(denials[0]);
    await app.close();
  });

  it('register with a wrong Origin, or no Origin, answers 403 origin_rejected: Origin is checked before the 404', async () => {
    const { app } = await buildPresessionApp();
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/test-register',
      headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'new@example.invalid', password: 'fixture-new-password' }),
    });
    expect(wrong.statusCode).toBe(403);
    expect(errorOf(wrong).code).toBe('origin_rejected');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/test-register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'new@example.invalid', password: 'fixture-new-password' }),
    });
    expect(missing.statusCode).toBe(403);
    expect(errorOf(missing).code).toBe('origin_rejected');
    await app.close();
  });

  it('GET on the register path answers 405: the route is POST-only', async () => {
    const { app } = await buildPresessionApp();
    const res = await app.inject({ method: 'GET', url: '/api/test-register' });
    expect(res.statusCode).toBe(405);
    expect(errorOf(res).code).toBe('method_not_allowed');
    await app.close();
  });
});

describe('L2: setup answers 404 conditionally after installation [reference harness]', () => {
  function setupBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { setupToken: SETUP_TOKEN_FIXTURE, email: 'first@example.invalid', password: 'fixture-first-password', ...overrides };
  }

  it('a second setup with the correct token answers 404 once installation has completed', async () => {
    const { app } = await buildPresessionApp();
    const first = await app.inject(postJson('/api/test-setup', setupBody()));
    expect(first.statusCode).toBe(201);
    const second = await app.inject(postJson('/api/test-setup', setupBody({ email: 'second@example.invalid' })));
    expect(second.statusCode).toBe(404);
    expect(errorOf(second).code).toBe('not_found');
    await app.close();
  });

  it('a wrong token after completion answers 404, not 401: completion is checked before the token', async () => {
    const { app } = await buildPresessionApp();
    const first = await app.inject(postJson('/api/test-setup', setupBody()));
    expect(first.statusCode).toBe(201);
    const wrong = await app.inject(postJson('/api/test-setup', setupBody({ setupToken: 'fixture-wrong-setup-token' })));
    expect(wrong.statusCode).toBe(404);
    expect(errorOf(wrong).code).toBe('not_found');
    await app.close();
  });

  it('setup 404 after completion is byte-identical to an unknown-route 404 except requestId', async () => {
    const { app } = await buildPresessionApp();
    await app.inject(postJson('/api/test-setup', setupBody()));
    const done = await app.inject(postJson('/api/test-setup', setupBody()));
    const unknown = await app.inject({ method: 'GET', url: '/api/test-definitely-absent' });
    expect(normalizedDenial(done)).toBe(normalizedDenial(unknown));
    await app.close();
  });

  it('setup success sets no session cookie: setup is not a login, the operator logs in normally', async () => {
    const { app } = await buildPresessionApp();
    const first = await app.inject(postJson('/api/test-setup', setupBody()));
    expect(first.statusCode).toBe(201);
    expect(first.headers['set-cookie']).toBeUndefined();
    const data = (first.json() as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(['email', 'id', 'workspaceId']);
    const login = await app.inject(postJson('/api/test-presession-login', { email: 'first@example.invalid', password: 'fixture-first-password' }));
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toBeDefined();
    await app.close();
  });

  it('setup with a wrong Origin, or no Origin, answers 403 origin_rejected', async () => {
    const { app } = await buildPresessionApp();
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/test-setup',
      headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify(setupBody()),
    });
    expect(wrong.statusCode).toBe(403);
    expect(errorOf(wrong).code).toBe('origin_rejected');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/test-setup',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(setupBody()),
    });
    expect(missing.statusCode).toBe(403);
    await app.close();
  });

  it('a bad token while open answers 401 invalid_setup_token and leaves installation open', async () => {
    const { app } = await buildPresessionApp();
    const bad = await app.inject(postJson('/api/test-setup', setupBody({ setupToken: 'fixture-wrong-setup-token' })));
    expect(bad.statusCode).toBe(401);
    expect(errorOf(bad).code).toBe('invalid_setup_token');
    const good = await app.inject(postJson('/api/test-setup', setupBody()));
    expect(good.statusCode).toBe(201);
    await app.close();
  });

  it('a missing or empty setup token answers 401 invalid_setup_token (reference reading)', async () => {
    const { app } = await buildPresessionApp();
    for (const body of [{ email: 'a@example.invalid', password: 'fixture-first-password' }, setupBody({ setupToken: '' })]) {
      const res = await app.inject(postJson('/api/test-setup', body));
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('invalid_setup_token');
    }
    const good = await app.inject(postJson('/api/test-setup', setupBody()));
    expect(good.statusCode).toBe(201);
    await app.close();
  });

  it('a short password with a good token answers 400 validation_failed and leaves installation open', async () => {
    const { app } = await buildPresessionApp();
    const bad = await app.inject(postJson('/api/test-setup', setupBody({ password: 'short' })));
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).code).toBe('validation_failed');
    const good = await app.inject(postJson('/api/test-setup', setupBody()));
    expect(good.statusCode).toBe(201);
    await app.close();
  });

  it('two concurrent setups yield exactly one 201 and one 404 in this harness; the real race needs the database lock test', async () => {
    const { app, state } = await buildPresessionApp();
    const [first, second] = await Promise.all([
      app.inject(postJson('/api/test-setup', setupBody())),
      app.inject(postJson('/api/test-setup', setupBody({ email: 'race@example.invalid' }))),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 404]);
    expect(state.accountsByEmail.has('race@example.invalid') !== state.accountsByEmail.has('first@example.invalid')).toBe(true);
    await app.close();
  });

  it('GET on the setup path answers 405: the route is POST-only', async () => {
    const { app } = await buildPresessionApp();
    const res = await app.inject({ method: 'GET', url: '/api/test-setup' });
    expect(res.statusCode).toBe(405);
    expect(errorOf(res).code).toBe('method_not_allowed');
    await app.close();
  });
});

describe('L2: reset request and reset confirm [reference harness]', () => {
  it('reset-request answers the same 200 for known, unknown, disabled, and malformed emails', async () => {
    const { app, state } = await buildPresessionApp();
    const bodies: string[] = [];
    for (const email of ['known@example.invalid', 'unknown@example.invalid', 'disabled@example.invalid', 'not-an-email', '']) {
      const res = await app.inject(postJson('/api/test-reset-request', { email }));
      expect(res.statusCode).toBe(200);
      bodies.push(res.body);
    }
    for (const body of bodies.slice(1)) {
      expect(body).toBe(bodies[0]);
    }
    // The only difference is server-side and unobservable on the wire.
    expect(state.sentEmails).toEqual(['known@example.invalid']);
    await app.close();
  });

  it('reset-request with a wrong Origin answers 403 origin_rejected', async () => {
    const { app } = await buildPresessionApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-reset-request',
      headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'known@example.invalid' }),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it('unknown, expired, used, and wrong-purpose tokens yield identical 400 invalid_action_token bodies', async () => {
    const { app } = await buildPresessionApp();
    const denials: string[] = [];
    for (const token of ['token-unknown', 'token-expired', 'token-used', 'token-invitation']) {
      const res = await app.inject(postJson('/api/test-reset-confirm', { token, newPassword: 'fixture-reset-password' }));
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('invalid_action_token');
      denials.push(normalizedDenial(res));
    }
    for (const denial of denials.slice(1)) {
      expect(denial).toBe(denials[0]);
    }
    await app.close();
  });

  it('a reset token for a disabled account answers the same 400: the account must be active at confirm time', async () => {
    const { app } = await buildPresessionApp();
    const disabled = await app.inject(postJson('/api/test-reset-confirm', { token: 'token-disabled', newPassword: 'fixture-reset-password' }));
    const unknown = await app.inject(postJson('/api/test-reset-confirm', { token: 'token-unknown', newPassword: 'fixture-reset-password' }));
    expect(disabled.statusCode).toBe(400);
    expect(normalizedDenial(disabled)).toBe(normalizedDenial(unknown));
    await app.close();
  });

  it('a successful confirm bumps the epoch, kills sessions, sets no cookie, and swaps the password', async () => {
    const { app, state } = await buildPresessionApp();
    const login = await app.inject(postJson('/api/test-presession-login', { email: 'known@example.invalid', password: 'fixture-known-password' }));
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'] as string;
    const sessionId = /^notegen_session=([^;]*)/.exec(cookie)?.[1] ?? '';
    expect(sessionId).not.toBe('');
    const confirm = await app.inject(postJson('/api/test-reset-confirm', { token: 'token-good', newPassword: 'fixture-reset-password' }));
    expect(confirm.statusCode).toBe(200);
    expect(confirm.headers['set-cookie']).toBeUndefined();
    expect(state.accountsByEmail.get('known@example.invalid')?.credentialEpoch).toBe(1);
    expect(state.sessions.has(sessionId)).toBe(false);
    const dead = await app.inject({ method: 'GET', url: '/api/test-presession-me', headers: { cookie: `notegen_session=${sessionId}` } });
    expect(dead.statusCode).toBe(401);
    const oldPassword = await app.inject(postJson('/api/test-presession-login', { email: 'known@example.invalid', password: 'fixture-known-password' }));
    expect(oldPassword.statusCode).toBe(401);
    const newPassword = await app.inject(postJson('/api/test-presession-login', { email: 'known@example.invalid', password: 'fixture-reset-password' }));
    expect(newPassword.statusCode).toBe(200);
    await app.close();
  });

  it('reset-confirm with a short new password answers 400 validation_failed and leaves the token usable', async () => {
    const { app, state } = await buildPresessionApp();
    const bad = await app.inject(postJson('/api/test-reset-confirm', { token: 'token-good', newPassword: 'short' }));
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).code).toBe('validation_failed');
    expect(state.actionTokens.get('token-good')?.used).toBe(false);
    const good = await app.inject(postJson('/api/test-reset-confirm', { token: 'token-good', newPassword: 'fixture-reset-password' }));
    expect(good.statusCode).toBe(200);
    await app.close();
  });

  it('GET on the reset paths answers 405: confirmation never happens over GET', async () => {
    const { app } = await buildPresessionApp();
    for (const url of ['/api/test-reset-request', '/api/test-reset-confirm']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(405);
      expect(errorOf(res).code).toBe('method_not_allowed');
    }
    await app.close();
  });
});
