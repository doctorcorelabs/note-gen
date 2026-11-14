// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Negative auth tests (F1-57, worker V3-01c, wave 3A).
//
// What this file proves, and what it does NOT prove, is stated per
// section. The auth routes and the database-backed verifiers belong
// to V3-01b (branch web-auth-core) and V3-02; at the time this file
// was written that branch had not landed, so no test here claims a
// green run against the real backend. The layers are:
//
// - L1, real hook with fake verifiers: buildApp plus the real
//   auth-hook from the trunk, with injected verifiers that model
//   session states (stale, revoked, epoch mismatch, disabled
//   account). The hook code under test is real; only the database
//   verdict is faked. These tests pin that every negative verdict
//   yields the same generic 401, that check order is session then
//   Origin then CSRF, and that failures fail closed.
// - L2, contract reference harnesses: small test-only routes that
//   implement the wire shape the contract requires (generic
//   anti-enumeration responses, 429 with Retry-After, show-once
//   secrets). They pin the ASSERTIONS the real routes must satisfy;
//   they are not proof that the real routes satisfy them.
// - L3, live probes: skipped while the real auth routes are absent
//   (detected at collection time by probing POST /api/auth/login).
//   When V3-01b lands and this suite runs against a merged tree, the
//   probes activate and assert no-session denials and Origin
//   rejections against the real routes.
//
// Cloudflare Access JWT verification is V3-02 work and is not
// implemented or tested here; it is recorded as debt in the worker
// report (fase1/laporan-v3-01c-auth-tests.md).
//
// Sources: kontrak-api-kanonis.md sections 1.2, 3.12, 6; desain-auth.md
// sections 3.1-3.7, 5.2, 5.3, 6.3-6.5, 12.4; amandemen D3 (11 no-session
// routes); bentuk-middleware-beku.md (AD-40). All fixture values in
// this file are obviously fake test data, never real credentials.

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import {
  createOriginPreHandler,
  getPrincipal,
  readCsrfTokenHeader,
  type VerifyCsrfTokenFn,
  type VerifySessionFn,
} from '../src/middleware/auth-hook.js';
import { ApiError, errorEnvelope, successEnvelope, toErrorEnvelope } from '../src/plugins/envelope.js';

const CANONICAL_ORIGIN = 'https://app.example.invalid';
const VERSION = '0.39.2-fork.1';

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
    publicBaseUrl: undefined,
    trustProxy: false,
    cookieSecure: true,
    cfAccessEnabled: false,
    cfAccessTeamDomain: undefined,
    cfAccessAud: undefined,
    cfAccessServiceAud: undefined,
    cfAccessJwksCacheTtlSeconds: 3600,
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

// Denial bodies compared with the request id blanked: identical
// denials must differ only by requestId, so that no denial leaks
// which negative case triggered it.
function normalizedDenial(res: InjectResponse): string {
  const parsed = JSON.parse(res.body) as ErrorEnvelopeBody;
  parsed.error.requestId = 'redacted';
  return JSON.stringify(parsed);
}

function sessionCookie(sessionId: string): Record<string, string> {
  return { cookie: `notegen_session=${sessionId}` };
}

function mutationHeaders(sessionId: string, csrfToken: string): Record<string, string> {
  return { ...sessionCookie(sessionId), origin: CANONICAL_ORIGIN, 'x-csrf-token': csrfToken };
}

// --- L1 fixture: a fake session store modelling the verifier verdicts
// described in desain-auth.md section 3.2. The epoch comparison lives
// in the verifier (V3-01b); the hook only ever sees a null verdict,
// and these tests pin what the hook does with it.

type FakeSessionState = 'valid' | 'stale' | 'revoked' | 'disabled';

interface FakeSessionRow {
  state: FakeSessionState;
  sessionEpoch: number;
  accountEpoch: number;
  csrfToken: string;
}

const ACCOUNT_EPOCH = 4;

function makeSessionStore(): Map<string, FakeSessionRow> {
  return new Map([
    ['session-valid', { state: 'valid', sessionEpoch: 4, accountEpoch: 4, csrfToken: 'csrf-valid' }],
    ['session-second', { state: 'valid', sessionEpoch: 4, accountEpoch: 4, csrfToken: 'csrf-second' }],
    ['session-stale', { state: 'stale', sessionEpoch: 4, accountEpoch: 4, csrfToken: 'csrf-stale' }],
    ['session-revoked', { state: 'revoked', sessionEpoch: 4, accountEpoch: 4, csrfToken: 'csrf-revoked' }],
    ['session-epoch-old', { state: 'valid', sessionEpoch: 3, accountEpoch: 4, csrfToken: 'csrf-epoch-old' }],
    ['session-disabled', { state: 'disabled', sessionEpoch: 4, accountEpoch: 4, csrfToken: 'csrf-disabled' }],
  ]);
}

function makeVerifySession(store: Map<string, FakeSessionRow>): VerifySessionFn {
  return async ({ sessionId }) => {
    if (sessionId === undefined) {
      return null;
    }
    const row = store.get(sessionId);
    if (row === undefined) {
      return null;
    }
    if (row.state !== 'valid') {
      return null;
    }
    if (row.sessionEpoch !== row.accountEpoch) {
      return null;
    }
    return { userId: 'user-1', role: 'user', sessionId };
  };
}

function makeVerifyCsrf(store: Map<string, FakeSessionRow>): VerifyCsrfTokenFn {
  return async (request, principal) => {
    const row = store.get(principal.sessionId);
    if (row === undefined) {
      return false;
    }
    return readCsrfTokenHeader(request) === row.csrfToken;
  };
}

async function buildSessionApp(store: Map<string, FakeSessionRow> = makeSessionStore()): Promise<FastifyInstance> {
  const app = await buildApp({
    config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
    pool: null,
    version: VERSION,
    verifySession: makeVerifySession(store),
    verifyCsrf: makeVerifyCsrf(store),
  });
  app.get('/api/test-read', async (request) => successEnvelope({ userId: getPrincipal(request)?.userId ?? null }));
  app.post('/api/test-mutate', async (request) => successEnvelope({ userId: getPrincipal(request)?.userId ?? null }));
  app.put('/api/test-mutate', async () => successEnvelope({ ok: true }));
  app.patch('/api/test-mutate', async () => successEnvelope({ ok: true }));
  app.delete('/api/test-mutate', async () => successEnvelope({ ok: true }));
  return app;
}

describe('L1: negative session states are denied identically [real hook, fake verifier]', () => {
  const deniedIds = ['session-stale', 'session-revoked', 'session-epoch-old', 'session-disabled', 'session-unknown'];

  it.each(deniedIds)('GET with session %s answers 401 unauthenticated with a generic envelope', async (id) => {
    const app = await buildSessionApp();
    const res = await app.inject({ method: 'GET', url: '/api/test-read', headers: sessionCookie(id) });
    expect(res.statusCode).toBe(401);
    const error = errorOf(res);
    expect(error.code).toBe('unauthenticated');
    expect(error.message).toBe('Authentication is required.');
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({});
    expect(typeof error.requestId).toBe('string');
    await app.close();
  });

  it('stale, revoked, epoch-mismatched, disabled, unknown, and missing sessions yield byte-identical denials except requestId', async () => {
    const app = await buildSessionApp();
    const denials: string[] = [];
    for (const id of deniedIds) {
      const res = await app.inject({ method: 'GET', url: '/api/test-read', headers: sessionCookie(id) });
      expect(res.statusCode).toBe(401);
      denials.push(normalizedDenial(res));
    }
    const noCookie = await app.inject({ method: 'GET', url: '/api/test-read' });
    expect(noCookie.statusCode).toBe(401);
    denials.push(normalizedDenial(noCookie));
    for (const denial of denials.slice(1)) {
      expect(denial).toBe(denials[0]);
    }
    await app.close();
  });

  it('a mutation without a cookie answers 401, never 403', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({ method: 'POST', url: '/api/test-mutate' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
    await app.close();
  });

  it('an empty session cookie value answers 401', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({ method: 'GET', url: '/api/test-read', headers: { cookie: 'notegen_session=' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('a malformed Cookie header answers 401', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: { cookie: 'not-a-cookie;;;' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('a Bearer token alone answers 401: Bearer is not accepted in MVP', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: { authorization: 'Bearer fixture-token-value' },
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
    await app.close();
  });

  it('a Bearer header is ignored when a valid cookie is present: the cookie decides', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: { ...sessionCookie('session-valid'), authorization: 'Bearer fixture-token-value' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('a throwing session verifier fails closed with a generic 500 and leaks nothing', async () => {
    const marker = 'MARKER_SESSION_BOOM_3f8a';
    const app = await buildApp({
      config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
      pool: null,
      version: VERSION,
      verifySession: async () => {
        throw new Error(`verifier exploded: ${marker}`);
      },
    });
    app.get('/api/test-read', async () => successEnvelope({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/api/test-read', headers: sessionCookie('session-valid') });
    expect(res.statusCode).toBe(500);
    expect(errorOf(res).code).toBe('internal_error');
    expect(res.body).not.toContain(marker);
    await app.close();
  });

  it('a throwing CSRF verifier fails closed with a generic 500 and leaks nothing', async () => {
    const marker = 'MARKER_CSRF_BOOM_7c21';
    const store = makeSessionStore();
    const app = await buildApp({
      config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
      pool: null,
      version: VERSION,
      verifySession: makeVerifySession(store),
      verifyCsrf: async () => {
        throw new Error(`csrf check exploded: ${marker}`);
      },
    });
    app.post('/api/test-mutate', async () => successEnvelope({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: mutationHeaders('session-valid', 'csrf-valid'),
    });
    expect(res.statusCode).toBe(500);
    expect(errorOf(res).code).toBe('internal_error');
    expect(res.body).not.toContain(marker);
    await app.close();
  });

  it('a throwing Origin verifier fails closed with a generic 500 and leaks nothing', async () => {
    const marker = 'MARKER_ORIGIN_BOOM_91d4';
    const store = makeSessionStore();
    const app = await buildApp({
      config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
      pool: null,
      version: VERSION,
      verifySession: makeVerifySession(store),
      verifyCsrf: makeVerifyCsrf(store),
      verifyOrigin: async () => {
        throw new Error(`origin check exploded: ${marker}`);
      },
    });
    app.post('/api/test-mutate', async () => successEnvelope({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: mutationHeaders('session-valid', 'csrf-valid'),
    });
    expect(res.statusCode).toBe(500);
    expect(errorOf(res).code).toBe('internal_error');
    expect(res.body).not.toContain(marker);
    await app.close();
  });

  it('the __Host- cookie wins over the development cookie, so a revoked __Host- session cannot be bypassed', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: { cookie: 'notegen_session=session-valid; __Host-notegen_session=session-revoked' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('a valid __Host- cookie still passes when the development cookie is revoked', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: { cookie: 'notegen_session=session-revoked; __Host-notegen_session=session-valid' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('an admin principal passes the hook: role authorization is the handler job, not the hook job', async () => {
    const app = await buildApp({
      config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
      pool: null,
      version: VERSION,
      verifySession: async ({ sessionId }) =>
        sessionId === 'session-admin' ? { userId: 'admin-1', role: 'admin', sessionId } : null,
    });
    app.get('/api/test-read', async (request) => successEnvelope({ userId: getPrincipal(request)?.userId ?? null }));
    const res = await app.inject({ method: 'GET', url: '/api/test-read', headers: sessionCookie('session-admin') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, data: { userId: 'admin-1' } });
    await app.close();
  });

  it('a rotated-away session id dies at once: no grace period', async () => {
    const store = makeSessionStore();
    store.set('session-old', { state: 'valid', sessionEpoch: 4, accountEpoch: 4, csrfToken: 'csrf-old' });
    const app = await buildSessionApp(store);
    const before = await app.inject({ method: 'GET', url: '/api/test-read', headers: sessionCookie('session-old') });
    expect(before.statusCode).toBe(200);
    // Rotation: delete the old row, create the new row.
    store.delete('session-old');
    store.set('session-new', { state: 'valid', sessionEpoch: 4, accountEpoch: 4, csrfToken: 'csrf-new' });
    const oldRes = await app.inject({ method: 'GET', url: '/api/test-read', headers: sessionCookie('session-old') });
    expect(oldRes.statusCode).toBe(401);
    const newRes = await app.inject({ method: 'GET', url: '/api/test-read', headers: sessionCookie('session-new') });
    expect(newRes.statusCode).toBe(200);
    await app.close();
  });

  it('denial bodies never echo the submitted session id, CSRF token, or body secret', async () => {
    const sessionMarker = 'marker-session-value-7f3a';
    const csrfMarker = 'marker-csrf-value-9c1e';
    const bodyMarker = 'marker-body-secret-5d2b';
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: {
        ...sessionCookie(sessionMarker),
        origin: 'https://marker-origin-8e4a.invalid',
        'x-csrf-token': csrfMarker,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ password: bodyMarker }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(sessionMarker);
    expect(res.body).not.toContain(csrfMarker);
    expect(res.body).not.toContain(bodyMarker);
    expect(res.body).not.toContain('marker-origin-8e4a');
    await app.close();
  });
});

describe('L1: CSRF mismatch and Origin rejection [real hook, fake verifier]', () => {
  it('Origin is checked before CSRF: a wrong Origin plus a bad token yields origin_rejected', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: {
        ...sessionCookie('session-valid'),
        origin: 'https://evil.example.invalid',
        'x-csrf-token': 'wrong-token',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it.each([
    ['suffix attack', 'https://app.example.invalid.evil.invalid'],
    ['different port', 'https://app.example.invalid:8443'],
    ['http scheme', 'http://app.example.invalid'],
    ['opaque origin', 'null'],
    ['unrelated host', 'https://evil.example.invalid'],
    ['subdomain', 'https://sub.app.example.invalid'],
  ])('Origin %s is rejected with origin_rejected', async (_label, origin) => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { ...sessionCookie('session-valid'), origin, 'x-csrf-token': 'csrf-valid' },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it('a mutation with no Origin and no Referer is rejected with origin_rejected (fail closed)', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { ...sessionCookie('session-valid'), 'x-csrf-token': 'csrf-valid' },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it('a mutation with no Origin but a matching Referer passes (Referer fallback)', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: {
        ...sessionCookie('session-valid'),
        referer: `${CANONICAL_ORIGIN}/core/main`,
        'x-csrf-token': 'csrf-valid',
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('a mutation with no Origin and a wrong Referer is rejected with origin_rejected', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: {
        ...sessionCookie('session-valid'),
        referer: 'https://evil.example.invalid/x',
        'x-csrf-token': 'csrf-valid',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it('a missing CSRF token yields csrf_invalid with a matching Origin', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { ...sessionCookie('session-valid'), origin: CANONICAL_ORIGIN },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('csrf_invalid');
    await app.close();
  });

  it('a CSRF token bound to another session yields csrf_invalid', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: mutationHeaders('session-valid', 'csrf-second'),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('csrf_invalid');
    await app.close();
  });

  it('a CSRF token sent only in the query string yields csrf_invalid: the header is the canonical channel', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate?csrfToken=csrf-valid',
      headers: { ...sessionCookie('session-valid'), origin: CANONICAL_ORIGIN },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('csrf_invalid');
    await app.close();
  });

  it('a CSRF token sent only in the JSON body yields csrf_invalid', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { ...sessionCookie('session-valid'), origin: CANONICAL_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ csrfToken: 'csrf-valid' }),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('csrf_invalid');
    await app.close();
  });

  it.each(['PUT', 'PATCH', 'DELETE'] as const)('%s without a CSRF token yields csrf_invalid', async (method) => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method,
      url: '/api/test-mutate',
      headers: { ...sessionCookie('session-valid'), origin: CANONICAL_ORIGIN },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('csrf_invalid');
    await app.close();
  });

  it.each(['PUT', 'PATCH', 'DELETE'] as const)('%s without an Origin yields origin_rejected', async (method) => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method,
      url: '/api/test-mutate',
      headers: { ...sessionCookie('session-valid'), 'x-csrf-token': 'csrf-valid' },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it('GET is exempt from CSRF and Origin checks: a wrong Origin and no token still serve a valid session', async () => {
    const app = await buildSessionApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: { ...sessionCookie('session-valid'), origin: 'https://evil.example.invalid' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('Origin and CSRF failures share one generic message and differ only by code', async () => {
    const app = await buildSessionApp();
    const originRes = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { ...sessionCookie('session-valid'), 'x-csrf-token': 'csrf-valid' },
    });
    const csrfRes = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { ...sessionCookie('session-valid'), origin: CANONICAL_ORIGIN, 'x-csrf-token': 'stale-token' },
    });
    const originError = errorOf(originRes);
    const csrfError = errorOf(csrfRes);
    expect(originError.message).toBe(csrfError.message);
    expect(originError.message).toBe('The request was rejected.');
    expect(originError.code).toBe('origin_rejected');
    expect(csrfError.code).toBe('csrf_invalid');
    expect(originError.retryable).toBe(false);
    expect(csrfError.retryable).toBe(false);
    await app.close();
  });

  it('a stale CSRF token after rotation yields csrf_invalid while the new token passes', async () => {
    const store = makeSessionStore();
    const app = await buildSessionApp(store);
    const staleRes = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: mutationHeaders('session-valid', 'csrf-old-rotated-away'),
    });
    expect(staleRes.statusCode).toBe(403);
    expect(errorOf(staleRes).code).toBe('csrf_invalid');
    const freshRes = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: mutationHeaders('session-valid', 'csrf-valid'),
    });
    expect(freshRes.statusCode).toBe(200);
    await app.close();
  });
});

// --- L2 fixture: fake public auth routes implementing the contract wire
// shape. These handlers are test-only stand-ins for V3-01b/V3-02 routes.
// They exist so the assertions below pin exact wire behavior; a green
// run here does NOT mean the real routes behave this way (see L3).

interface PublicFakes {
  challenges: Map<string, { attempts: number; code: string }>;
  actionTokens: Map<string, { used: boolean; expired: boolean }>;
  setupState: { complete: boolean };
}

async function buildPublicApp(): Promise<{ app: FastifyInstance; fakes: PublicFakes }> {
  const challenges: PublicFakes['challenges'] = new Map([['challenge-good', { attempts: 0, code: '654321' }]]);
  const actionTokens: PublicFakes['actionTokens'] = new Map([['token-good', { used: false, expired: false }]]);
  const setupState: PublicFakes['setupState'] = { complete: false };
  const accounts = new Map([
    ['known@example.invalid', { password: 'fixture-correct-password', disabled: false }],
    ['disabled@example.invalid', { password: 'fixture-correct-password', disabled: true }],
  ]);

  const app = await buildApp({
    config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
    pool: null,
    version: VERSION,
  });
  const originOnly = {
    config: { requiresAuth: false },
    preHandler: createOriginPreHandler(CANONICAL_ORIGIN),
  };

  app.post('/api/test-login', originOnly, async (request) => {
    const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const account = accounts.get(email);
    if (account === undefined || account.disabled || account.password !== password) {
      throw ApiError.invalidCredentials();
    }
    return successEnvelope({
      id: 'user-1',
      email,
      role: 'user',
      totpEnabled: false,
      csrfToken: 'csrf-valid',
      sessionExpiresAt: 0,
    });
  });

  app.post('/api/test-login-totp', originOnly, async (request) => {
    const body = (request.body ?? {}) as { challengeToken?: unknown; code?: unknown };
    const token = typeof body.challengeToken === 'string' ? body.challengeToken : '';
    const code = typeof body.code === 'string' ? body.code : '';
    const challenge = challenges.get(token);
    if (challenge === undefined || challenge.attempts >= 5) {
      throw ApiError.invalidVerificationCode();
    }
    if (code !== challenge.code) {
      challenge.attempts += 1;
      throw ApiError.invalidVerificationCode();
    }
    challenges.delete(token);
    return successEnvelope({ id: 'user-1', email: 'known@example.invalid', role: 'user', totpEnabled: true });
  });

  app.post('/api/test-reset-request', originOnly, async () =>
    successEnvelope({ message: 'If the email is registered, a reset link has been sent.' }),
  );

  app.post('/api/test-reset-confirm', originOnly, async (request) => {
    const body = (request.body ?? {}) as { token?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';
    const entry = actionTokens.get(token);
    if (entry === undefined || entry.expired || entry.used) {
      throw new ApiError(400, 'invalid_action_token', 'The link is not valid or has expired.');
    }
    entry.used = true;
    return successEnvelope({ message: 'Password updated. Please log in again.' });
  });

  app.post('/api/test-setup', originOnly, async (request, reply) => {
    if (setupState.complete) {
      throw ApiError.notFound();
    }
    const body = (request.body ?? {}) as { setupToken?: unknown };
    if (body.setupToken !== 'fixture-setup-token') {
      throw ApiError.invalidSetupToken();
    }
    setupState.complete = true;
    reply.code(201);
    return successEnvelope({ id: 'user-1', email: 'known@example.invalid', workspaceId: 'workspace-1' });
  });

  app.post('/api/test-register', originOnly, async () => {
    throw ApiError.notFound();
  });

  return { app, fakes: { challenges, actionTokens, setupState } };
}

function jsonPayload(body: Record<string, unknown>): { headers: Record<string, string>; payload: string } {
  return { headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json' }, payload: JSON.stringify(body) };
}

describe('L2: anti-enumeration responses are generic [contract reference harness]', () => {
  it('unknown email, wrong password, and disabled account yield identical 401 invalid_credentials bodies', async () => {
    const { app } = await buildPublicApp();
    const cases = [
      { email: 'unknown@example.invalid', password: 'fixture-correct-password' },
      { email: 'known@example.invalid', password: 'fixture-wrong-password' },
      { email: 'disabled@example.invalid', password: 'fixture-correct-password' },
    ];
    const denials: string[] = [];
    for (const body of cases) {
      const { headers, payload } = jsonPayload(body);
      const res = await app.inject({ method: 'POST', url: '/api/test-login', headers, payload });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('invalid_credentials');
      denials.push(normalizedDenial(res));
    }
    expect(denials[1]).toBe(denials[0]);
    expect(denials[2]).toBe(denials[0]);
    await app.close();
  });

  it('login failure bodies leak no hint about which cause applied', async () => {
    const { app } = await buildPublicApp();
    const { headers, payload } = jsonPayload({
      email: 'disabled@example.invalid',
      password: 'fixture-wrong-password',
    });
    const res = await app.inject({ method: 'POST', url: '/api/test-login', headers, payload });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('disabled');
    expect(res.body).not.toContain('disabled@example.invalid');
    expect(res.body).not.toContain('no account');
    expect(res.body).not.toContain('fixture-wrong-password');
    await app.close();
  });

  it('login with a good Origin and no CSRF header reaches the handler: 401, not 403', async () => {
    const { app } = await buildPublicApp();
    const { headers, payload } = jsonPayload({ email: 'unknown@example.invalid', password: 'x' });
    const res = await app.inject({ method: 'POST', url: '/api/test-login', headers, payload });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('invalid_credentials');
    await app.close();
  });

  it('login with a wrong Origin, or with no Origin and no Referer, yields 403 origin_rejected', async () => {
    const { app } = await buildPublicApp();
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'known@example.invalid', password: 'fixture-correct-password' }),
    });
    expect(wrong.statusCode).toBe(403);
    expect(errorOf(wrong).code).toBe('origin_rejected');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'known@example.invalid', password: 'fixture-correct-password' }),
    });
    expect(missing.statusCode).toBe(403);
    expect(errorOf(missing).code).toBe('origin_rejected');
    await app.close();
  });

  it('login success is a control: known email plus the fixture password yields 200', async () => {
    const { app } = await buildPublicApp();
    const { headers, payload } = jsonPayload({ email: 'known@example.invalid', password: 'fixture-correct-password' });
    const res = await app.inject({ method: 'POST', url: '/api/test-login', headers, payload });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data['email']).toBe('known@example.invalid');
    await app.close();
  });

  it('wrong TOTP code, unknown challenge, and exhausted challenge yield identical 401 bodies', async () => {
    const { app, fakes } = await buildPublicApp();
    fakes.challenges.set('challenge-spent', { attempts: 5, code: '654321' });
    const cases = [
      { challengeToken: 'challenge-good', code: '000000' },
      { challengeToken: 'challenge-unknown', code: '654321' },
      { challengeToken: 'challenge-spent', code: '654321' },
    ];
    const denials: string[] = [];
    for (const body of cases) {
      const { headers, payload } = jsonPayload(body);
      const res = await app.inject({ method: 'POST', url: '/api/test-login-totp', headers, payload });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('invalid_verification_code');
      denials.push(normalizedDenial(res));
    }
    expect(denials[1]).toBe(denials[0]);
    expect(denials[2]).toBe(denials[0]);
    await app.close();
  });

  it('TOTP success is a control: the good challenge plus the fixture code yields 200', async () => {
    const { app } = await buildPublicApp();
    const { headers, payload } = jsonPayload({ challengeToken: 'challenge-good', code: '654321' });
    const res = await app.inject({ method: 'POST', url: '/api/test-login-totp', headers, payload });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('reset-request always answers the same 200 generic body, for existing, unknown, and disabled emails', async () => {
    const { app } = await buildPublicApp();
    const bodies: string[] = [];
    for (const email of ['known@example.invalid', 'unknown@example.invalid', 'disabled@example.invalid']) {
      const { headers, payload } = jsonPayload({ email });
      const res = await app.inject({ method: 'POST', url: '/api/test-reset-request', headers, payload });
      expect(res.statusCode).toBe(200);
      bodies.push(res.body);
    }
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
    await app.close();
  });

  it('unknown, expired, and already-used reset tokens yield identical 400 invalid_action_token bodies', async () => {
    const { app, fakes } = await buildPublicApp();
    fakes.actionTokens.set('token-expired', { used: false, expired: true });
    fakes.actionTokens.set('token-used', { used: true, expired: false });
    const denials: string[] = [];
    for (const token of ['token-unknown', 'token-expired', 'token-used']) {
      const { headers, payload } = jsonPayload({ token, newPassword: 'fixture-new-password' });
      const res = await app.inject({ method: 'POST', url: '/api/test-reset-confirm', headers, payload });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('invalid_action_token');
      denials.push(normalizedDenial(res));
    }
    expect(denials[1]).toBe(denials[0]);
    expect(denials[2]).toBe(denials[0]);
    await app.close();
  });

  it('a reset token is single-use: the second confirmation with the same token yields 400', async () => {
    const { app } = await buildPublicApp();
    const first = jsonPayload({ token: 'token-good', newPassword: 'fixture-new-password' });
    const ok = await app.inject({ method: 'POST', url: '/api/test-reset-confirm', headers: first.headers, payload: first.payload });
    expect(ok.statusCode).toBe(200);
    const second = jsonPayload({ token: 'token-good', newPassword: 'fixture-new-password' });
    const again = await app.inject({
      method: 'POST',
      url: '/api/test-reset-confirm',
      headers: second.headers,
      payload: second.payload,
    });
    expect(again.statusCode).toBe(400);
    expect(errorOf(again).code).toBe('invalid_action_token');
    await app.close();
  });

  it('setup after installation completes yields 404, and a bad setup token while open yields 401 invalid_setup_token', async () => {
    const { app, fakes } = await buildPublicApp();
    const bad = jsonPayload({ setupToken: 'fixture-wrong-setup-token', email: 'a@example.invalid' });
    const badRes = await app.inject({ method: 'POST', url: '/api/test-setup', headers: bad.headers, payload: bad.payload });
    expect(badRes.statusCode).toBe(401);
    expect(errorOf(badRes).code).toBe('invalid_setup_token');
    fakes.setupState.complete = true;
    const done = jsonPayload({ setupToken: 'fixture-setup-token', email: 'a@example.invalid' });
    const doneRes = await app.inject({ method: 'POST', url: '/api/test-setup', headers: done.headers, payload: done.payload });
    expect(doneRes.statusCode).toBe(404);
    expect(errorOf(doneRes).code).toBe('not_found');
    await app.close();
  });

  it('setup success is a control: the fixture token while open yields 201', async () => {
    const { app } = await buildPublicApp();
    const good = jsonPayload({ setupToken: 'fixture-setup-token', email: 'known@example.invalid' });
    const res = await app.inject({ method: 'POST', url: '/api/test-setup', headers: good.headers, payload: good.payload });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('register in closed mode yields 404 not_found with a generic body', async () => {
    const { app } = await buildPublicApp();
    const { headers, payload } = jsonPayload({ email: 'new@example.invalid', password: 'fixture-new-password' });
    const res = await app.inject({ method: 'POST', url: '/api/test-register', headers, payload });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe('not_found');
    expect(res.body).not.toContain('closed');
    expect(res.body).not.toContain('registration');
    await app.close();
  });
});

describe('L2: auth error catalog shape [pure contract]', () => {
  const catalogCases: Array<{ name: string; make: () => ApiError; status: number; code: string; retryable: boolean }> = [
    { name: 'unauthenticated', make: () => ApiError.unauthenticated(), status: 401, code: 'unauthenticated', retryable: false },
    { name: 'invalid_credentials', make: () => ApiError.invalidCredentials(), status: 401, code: 'invalid_credentials', retryable: false },
    { name: 'invalid_verification_code', make: () => ApiError.invalidVerificationCode(), status: 401, code: 'invalid_verification_code', retryable: false },
    { name: 'invalid_setup_token', make: () => ApiError.invalidSetupToken(), status: 401, code: 'invalid_setup_token', retryable: false },
    {
      name: 'invalid_action_token',
      make: () => new ApiError(400, 'invalid_action_token', 'The link is not valid or has expired.'),
      status: 400,
      code: 'invalid_action_token',
      retryable: false,
    },
    { name: 'forbidden', make: () => ApiError.forbidden(), status: 403, code: 'forbidden', retryable: false },
    { name: 'csrf_invalid', make: () => ApiError.csrfInvalid(), status: 403, code: 'csrf_invalid', retryable: false },
    { name: 'origin_rejected', make: () => ApiError.originRejected(), status: 403, code: 'origin_rejected', retryable: false },
    { name: 'step_up_required', make: () => ApiError.stepUpRequired(), status: 403, code: 'step_up_required', retryable: false },
    { name: 'rate_limited', make: () => ApiError.rateLimited(), status: 429, code: 'rate_limited', retryable: true },
    { name: 'not_found', make: () => ApiError.notFound(), status: 404, code: 'not_found', retryable: false },
  ];

  it.each(catalogCases)('$name maps to $status with retryable=$retryable', ({ make, status, code, retryable }) => {
    const error = make();
    expect(error.statusCode).toBe(status);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.details).toEqual({});
    expect(error.message.length).toBeGreaterThan(0);
  });

  it.each(catalogCases)('$name survives toErrorEnvelope with status, code, and retryable intact', ({ make, status, code, retryable }) => {
    const { statusCode, envelope } = toErrorEnvelope(make(), 'req-test-1');
    expect(statusCode).toBe(status);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe(code);
    expect(envelope.error.retryable).toBe(retryable);
    expect(envelope.error.requestId).toBe('req-test-1');
    expect(envelope.error.details).toEqual({});
  });

  it('csrf_invalid and origin_rejected share one generic message', () => {
    expect(ApiError.csrfInvalid().message).toBe(ApiError.originRejected().message);
  });

  it('only rate_limited is retryable among the auth catalog codes', () => {
    const retryable = catalogCases.filter((entry) => entry.make().retryable).map((entry) => entry.code);
    expect(retryable).toEqual(['rate_limited']);
  });
});

describe('L2: rate limit and lockout wire shape [contract reference harness]', () => {
  async function buildLimitedApp(limit: number): Promise<FastifyInstance> {
    let count = 0;
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    app.get(
      '/api/test-limited',
      {
        config: { requiresAuth: false },
        preHandler: async (request, reply) => {
          count += 1;
          if (count > limit) {
            reply
              .code(429)
              .header('Retry-After', '60')
              .send(errorEnvelope('rate_limited', 'Too many requests.', request.id, { retryable: true }));
          }
        },
      },
      async () => successEnvelope({ ok: true }),
    );
    return app;
  }

  it('requests up to the limit pass; the next answers 429 rate_limited with a Retry-After header', async () => {
    const app = await buildLimitedApp(3);
    for (let i = 0; i < 3; i += 1) {
      const ok = await app.inject({ method: 'GET', url: '/api/test-limited' });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'GET', url: '/api/test-limited' });
    expect(limited.statusCode).toBe(429);
    const error = errorOf(limited);
    expect(error.code).toBe('rate_limited');
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({});
    expect(typeof error.requestId).toBe('string');
    expect(limited.headers['retry-after']).toBe('60');
    await app.close();
  });

  it('Retry-After is a positive integer on every 429, and no X-RateLimit headers are sent', async () => {
    const app = await buildLimitedApp(1);
    await app.inject({ method: 'GET', url: '/api/test-limited' });
    for (let i = 0; i < 3; i += 1) {
      const limited = await app.inject({ method: 'GET', url: '/api/test-limited' });
      expect(limited.statusCode).toBe(429);
      const raw = limited.headers['retry-after'];
      expect(typeof raw).toBe('string');
      const seconds = Number.parseInt(raw as string, 10);
      expect(Number.isInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThan(0);
      expect(limited.headers).not.toHaveProperty('x-ratelimit-limit');
      expect(limited.headers).not.toHaveProperty('x-ratelimit-remaining');
      expect(limited.headers).not.toHaveProperty('x-ratelimit-reset');
    }
    await app.close();
  });

  it('a bare thrown rate_limited carries no Retry-After: setting the header is the rate-limit middleware job', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    app.get(
      '/api/test-throw-limited',
      { config: { requiresAuth: false } },
      async () => {
        throw ApiError.rateLimited();
      },
    );
    const res = await app.inject({ method: 'GET', url: '/api/test-throw-limited' });
    expect(res.statusCode).toBe(429);
    expect(errorOf(res).code).toBe('rate_limited');
    expect(res.headers['retry-after']).toBeUndefined();
    await app.close();
  });

  it('health live stays reachable while the reference limiter blocks its own route: exemption is a registration property', async () => {
    const app = await buildLimitedApp(0);
    const limited = await app.inject({ method: 'GET', url: '/api/test-limited' });
    expect(limited.statusCode).toBe(429);
    for (let i = 0; i < 10; i += 1) {
      const live = await app.inject({ method: 'GET', url: '/api/health/live' });
      expect(live.statusCode).toBe(200);
    }
    await app.close();
  });

  it('a locked account answers 429 with Retry-After before any password check: correct and wrong passwords look identical', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    app.post(
      '/api/test-locked-login',
      { config: { requiresAuth: false }, preHandler: createOriginPreHandler(CANONICAL_ORIGIN) },
      async (request, reply) => {
        const body = (request.body ?? {}) as { email?: unknown };
        if (body.email === 'locked@example.invalid') {
          reply
            .code(429)
            .header('Retry-After', '900')
            .send(errorEnvelope('rate_limited', 'Too many requests.', request.id, { retryable: true }));
          return;
        }
        throw ApiError.invalidCredentials();
      },
    );
    const denials: string[] = [];
    for (const password of ['fixture-correct-password', 'fixture-wrong-password']) {
      const { headers, payload } = jsonPayload({ email: 'locked@example.invalid', password });
      const res = await app.inject({ method: 'POST', url: '/api/test-locked-login', headers, payload });
      expect(res.statusCode).toBe(429);
      expect(errorOf(res).code).toBe('rate_limited');
      expect(res.headers['retry-after']).toBe('900');
      denials.push(normalizedDenial(res));
    }
    expect(denials[1]).toBe(denials[0]);
    await app.close();
  });
});

describe('L2: show-once secrets are never returned twice [contract reference harness]', () => {
  const FAKE_SECRET = 'JBSWY3DPEHPK3PXP-test-only-secret';
  const FAKE_CODES = Array.from({ length: 10 }, (_v, i) => `RC-TEST-${String(i + 1).padStart(4, '0')}`);

  async function buildShowOnceApp(): Promise<FastifyInstance> {
    const secrets = new Map([['enroll-1', FAKE_SECRET]]);
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    app.get('/api/test-totp-secret/:id', { config: { requiresAuth: false } }, async (request) => {
      const params = request.params as { id: string };
      const secret = secrets.get(params.id);
      if (secret === undefined) {
        throw ApiError.notFound();
      }
      secrets.delete(params.id);
      return successEnvelope({ secret });
    });
    app.post('/api/test-recovery-codes/regenerate', { config: { requiresAuth: false } }, async () =>
      successEnvelope({ codes: [...FAKE_CODES] }),
    );
    app.get('/api/test-recovery-codes/status', { config: { requiresAuth: false } }, async () =>
      successEnvelope({ count: 10, hasCodes: true }),
    );
    app.post('/api/test-totp-confirm', { config: { requiresAuth: false } }, async () => {
      throw ApiError.invalidVerificationCode();
    });
    return app;
  }

  it('the first reveal returns the secret; the second reveal answers 404 and never contains the secret', async () => {
    const app = await buildShowOnceApp();
    const first = await app.inject({ method: 'GET', url: '/api/test-totp-secret/enroll-1' });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain(FAKE_SECRET);
    const second = await app.inject({ method: 'GET', url: '/api/test-totp-secret/enroll-1' });
    expect(second.statusCode).toBe(404);
    expect(errorOf(second).code).toBe('not_found');
    expect(second.body).not.toContain(FAKE_SECRET);
    await app.close();
  });

  it('a second reveal is indistinguishable from an unknown id: no oracle for whether a secret existed', async () => {
    const app = await buildShowOnceApp();
    await app.inject({ method: 'GET', url: '/api/test-totp-secret/enroll-1' });
    const second = await app.inject({ method: 'GET', url: '/api/test-totp-secret/enroll-1' });
    const unknown = await app.inject({ method: 'GET', url: '/api/test-totp-secret/enroll-never' });
    expect(second.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(normalizedDenial(second)).toBe(normalizedDenial(unknown));
    await app.close();
  });

  it('regenerated recovery codes appear once; the status endpoint never contains any code value', async () => {
    const app = await buildShowOnceApp();
    const generated = await app.inject({ method: 'POST', url: '/api/test-recovery-codes/regenerate' });
    expect(generated.statusCode).toBe(200);
    const body = generated.json() as { data: { codes: string[] } };
    expect(body.data.codes).toHaveLength(10);
    const status = await app.inject({ method: 'GET', url: '/api/test-recovery-codes/status' });
    expect(status.statusCode).toBe(200);
    for (const code of FAKE_CODES) {
      expect(status.body).not.toContain(code);
    }
    await app.close();
  });

  it('a failed TOTP confirmation never echoes the enrollment secret', async () => {
    const app = await buildShowOnceApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-totp-confirm',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ code: '000000' }),
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('invalid_verification_code');
    expect(res.body).not.toContain(FAKE_SECRET);
    await app.close();
  });
});

// --- L3: live probes. Detection runs at collection time so skipIf can
// decide honestly. On the trunk the probe gets 404 and every live test
// skips; against a tree with V3-01b routes the same tests run.

const LIVE_PROBE: { present: boolean; status: number | null } = await (async () => {
  try {
    const probe = await buildApp({
      config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
      pool: null,
      version: VERSION,
    });
    const res = await probe.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'probe@example.invalid', password: 'probe-only-value' }),
    });
    const status = res.statusCode;
    await probe.close();
    return { present: status !== 404, status };
  } catch {
    return { present: false, status: null };
  }
})();

describe(`L3: live auth routes against the real backend (present: ${String(LIVE_PROBE.present)}, probe status: ${String(LIVE_PROBE.status)})`, () => {
  it('records the live-route probe outcome instead of assuming it', () => {
    expect(typeof LIVE_PROBE.present).toBe('boolean');
    expect(LIVE_PROBE.status === null || typeof LIVE_PROBE.status === 'number').toBe(true);
  });

  it.skipIf(!LIVE_PROBE.present)('GET /api/auth/me without a session answers 401 unauthenticated', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
    await app.close();
  });

  it.skipIf(!LIVE_PROBE.present)('GET /api/auth/sessions without a session answers 401 unauthenticated', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    const res = await app.inject({ method: 'GET', url: '/api/auth/sessions' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
    await app.close();
  });

  it.skipIf(!LIVE_PROBE.present)('GET /api/auth/csrf without a session answers 401 unauthenticated', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    const res = await app.inject({ method: 'GET', url: '/api/auth/csrf' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
    await app.close();
  });

  it.skipIf(!LIVE_PROBE.present)('POST /api/auth/logout without a session answers 401, not 403', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
    await app.close();
  });

  it.skipIf(!LIVE_PROBE.present)('POST /api/auth/register answers 404 not_found in closed mode', async () => {
    const app = await buildApp({ config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }), pool: null, version: VERSION });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'new@example.invalid', password: 'probe-only-value' }),
    });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe('not_found');
    await app.close();
  });

  it.skipIf(!LIVE_PROBE.present)('POST /api/auth/login with a wrong Origin answers 403 origin_rejected', async () => {
    const app = await buildApp({ config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }), pool: null, version: VERSION });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'probe@example.invalid', password: 'probe-only-value' }),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it.skipIf(!LIVE_PROBE.present)('POST /api/auth/login with no Origin answers 403 origin_rejected', async () => {
    const app = await buildApp({ config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }), pool: null, version: VERSION });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'probe@example.invalid', password: 'probe-only-value' }),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it.skipIf(!LIVE_PROBE.present)('POST /api/auth/login/totp with a wrong Origin answers 403 origin_rejected', async () => {
    const app = await buildApp({ config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }), pool: null, version: VERSION });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ challengeToken: 'probe-only-value', code: '000000' }),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it.skipIf(!LIVE_PROBE.present)('POST /api/auth/password/reset-request with a wrong Origin answers 403 origin_rejected', async () => {
    const app = await buildApp({ config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }), pool: null, version: VERSION });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset-request',
      headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'probe@example.invalid' }),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it.skipIf(!LIVE_PROBE.present)('POST /api/auth/password/reset-request never answers 401 or 404: 200 generic, or 503 when its database is down', async () => {
    const app = await buildApp({ config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }), pool: null, version: VERSION });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset-request',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'probe@example.invalid' }),
    });
    expect([200, 503]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect((res.json() as { ok: boolean }).ok).toBe(true);
    }
    await app.close();
  });
});
