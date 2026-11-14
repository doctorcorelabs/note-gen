// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Middleware contract tests (desain-auth.md section 12.4, items 1-4
// and 8, adapted to the foundation: no feature endpoint exists yet, so
// the protected routes under test are test-only routes registered on
// the app inside each test. They are never shipped.)
//
// What is pinned here: health passes without credentials while data
// routes reject; session is checked before CSRF/Origin; Origin and
// CSRF failures share one message but carry different codes; unmatched
// paths answer 404, never 401 or a health 503; request ids are echoed
// on every reply and carried by error envelopes.
//
// File name note: the root .gitignore ignores "*.test.*", which would
// silently drop a file named auth-hook.test.ts from git. This file
// uses the .spec.ts suffix instead, which Vitest also picks up by
// default.

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import {
  createOriginPreHandler,
  defaultVerifyOrigin,
  getPrincipal,
  isPublicNoSessionRequest,
  matchCanonicalOrigin,
  parseSessionCookieId,
  PUBLIC_HEALTH_PATHS,
  readCsrfTokenHeader,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';
import { successEnvelope } from '../src/plugins/envelope.js';
import { HEALTH_PATHS } from '../src/routes/health.js';

const CANONICAL_ORIGIN = 'https://app.example.invalid';
const PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'good-session' };

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

function fakeRequest(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('public path list', () => {
  it('exempts exactly the health paths owned by the route module', () => {
    expect([...PUBLIC_HEALTH_PATHS].sort()).toEqual([...HEALTH_PATHS].sort());
    expect(PUBLIC_HEALTH_PATHS).toContain('/api/health/live');
    expect(PUBLIC_HEALTH_PATHS).toContain('/api/health/ready');
    expect(PUBLIC_HEALTH_PATHS).toContain('/api/health');
  });

  it('exempts CSP reports only for POST and download tokens only for single-segment GET', () => {
    expect(isPublicNoSessionRequest('POST', '/api/csp-reports')).toBe(true);
    expect(isPublicNoSessionRequest('GET', '/api/csp-reports')).toBe(false);
    expect(isPublicNoSessionRequest('GET', '/api/backups/downloads/token-1')).toBe(true);
    expect(isPublicNoSessionRequest('GET', '/api/backups/downloads/')).toBe(false);
    expect(isPublicNoSessionRequest('GET', '/api/backups/downloads/a/b')).toBe(false);
    expect(isPublicNoSessionRequest('POST', '/api/backups/downloads/token-1')).toBe(false);
    expect(isPublicNoSessionRequest('GET', '/api/backups/downloads')).toBe(false);
    expect(isPublicNoSessionRequest('GET', '/api/marks')).toBe(false);
  });
});

describe('cookie and header parsing', () => {
  it('prefers the __Host- session cookie over the development name', () => {
    const request = fakeRequest({ cookie: 'notegen_session=dev-id; __Host-notegen_session=prod-id' });
    expect(parseSessionCookieId(request)).toBe('prod-id');
  });

  it('falls back to the development cookie name', () => {
    expect(parseSessionCookieId(fakeRequest({ cookie: 'other=x; notegen_session=dev-id' }))).toBe('dev-id');
  });

  it('returns undefined without a session cookie and ignores empty values', () => {
    expect(parseSessionCookieId(fakeRequest({}))).toBeUndefined();
    expect(parseSessionCookieId(fakeRequest({ cookie: '' }))).toBeUndefined();
    expect(parseSessionCookieId(fakeRequest({ cookie: 'notegen_session=' }))).toBeUndefined();
    expect(parseSessionCookieId(fakeRequest({ cookie: 'session=abc' }))).toBeUndefined();
  });

  it('keeps the first value when a cookie name repeats', () => {
    expect(
      parseSessionCookieId(fakeRequest({ cookie: 'notegen_session=first; notegen_session=second' })),
    ).toBe('first');
  });

  it('percent-decodes cookie values when possible', () => {
    expect(parseSessionCookieId(fakeRequest({ cookie: 'notegen_session=abc%2Bdef' }))).toBe('abc+def');
  });

  it('reads the CSRF token header and rejects missing, empty, or duplicated values', () => {
    expect(readCsrfTokenHeader(fakeRequest({ 'x-csrf-token': 'tok-1' }))).toBe('tok-1');
    expect(readCsrfTokenHeader(fakeRequest({}))).toBeUndefined();
    expect(readCsrfTokenHeader(fakeRequest({ 'x-csrf-token': '' }))).toBeUndefined();
    expect(readCsrfTokenHeader(fakeRequest({ 'x-csrf-token': ['a', 'b'] }))).toBeUndefined();
  });
});

describe('Origin matching', () => {
  it('matches the canonical origin exactly, ignoring the default port', () => {
    expect(matchCanonicalOrigin('https://app.example.invalid', undefined, CANONICAL_ORIGIN)).toBe(true);
    expect(matchCanonicalOrigin('https://app.example.invalid:443', undefined, CANONICAL_ORIGIN)).toBe(true);
    expect(matchCanonicalOrigin('https://app.example.invalid:8443', undefined, CANONICAL_ORIGIN)).toBe(false);
    expect(matchCanonicalOrigin('https://evil.example.invalid', undefined, CANONICAL_ORIGIN)).toBe(false);
    expect(matchCanonicalOrigin('https://app.example.invalid.evil.invalid', undefined, CANONICAL_ORIGIN)).toBe(false);
  });

  it('falls back to the Referer origin when Origin is absent', () => {
    expect(
      matchCanonicalOrigin(undefined, 'https://app.example.invalid/notes/a', CANONICAL_ORIGIN),
    ).toBe(true);
    expect(matchCanonicalOrigin(undefined, 'https://evil.example.invalid/x', CANONICAL_ORIGIN)).toBe(false);
  });

  it('fails closed without an origin, without a referer, or without a canonical origin', () => {
    expect(matchCanonicalOrigin(undefined, undefined, CANONICAL_ORIGIN)).toBe(false);
    expect(matchCanonicalOrigin('null', undefined, CANONICAL_ORIGIN)).toBe(false);
    expect(matchCanonicalOrigin('https://app.example.invalid', undefined, undefined)).toBe(false);
    expect(matchCanonicalOrigin(['https://app.example.invalid'], undefined, CANONICAL_ORIGIN)).toBe(false);
  });

  it('reads Origin and Referer from request headers', () => {
    expect(defaultVerifyOrigin(fakeRequest({ origin: CANONICAL_ORIGIN }), CANONICAL_ORIGIN)).toBe(true);
    expect(defaultVerifyOrigin(fakeRequest({ referer: `${CANONICAL_ORIGIN}/x` }), CANONICAL_ORIGIN)).toBe(true);
    expect(defaultVerifyOrigin(fakeRequest({}), CANONICAL_ORIGIN)).toBe(false);
  });
});

describe('deny by default without injected verifiers', () => {
  it('answers 401 unauthenticated for a protected GET without a cookie', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    app.get('/api/test-read', async () => successEnvelope({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/api/test-read' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { ok: boolean; error: Record<string, unknown> };
    expect(body.ok).toBe(false);
    expect(body.error['code']).toBe('unauthenticated');
    expect(body.error['details']).toEqual({});
    expect(typeof body.error['requestId']).toBe('string');
    await app.close();
  });

  it('answers 401, not 403, for a protected mutation without a cookie', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    app.post('/api/test-mutate', async () => successEnvelope({ ok: true }));
    const res = await app.inject({ method: 'POST', url: '/api/test-mutate' });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('unauthenticated');
    await app.close();
  });

  it('answers 401 for an unknown session cookie', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    app.get('/api/test-read', async () => successEnvelope({ ok: true }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: { cookie: 'notegen_session=unknown-session' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('lets health pass without credentials and never answers 401 for it', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const live = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(live.statusCode).toBe(200);
    await app.close();
  });

  it('lets a route with requiresAuth false pass without credentials', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    app.get('/api/test-open', { config: { requiresAuth: false } }, async () => successEnvelope({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/api/test-open' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('lets a non-API route without config pass without credentials', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    app.get('/outside', async () => successEnvelope({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/outside' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('unmatched paths', () => {
  it('answers 404 not_found for an unknown /api path, never 401', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { ok: boolean; error: Record<string, unknown> };
    expect(body.error['code']).toBe('not_found');
    expect(body.error['details']).toEqual({});
    await app.close();
  });

  it('answers 404 with the generic envelope for an unknown health-like path, never a 503', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const res = await app.inject({ method: 'GET', url: '/api/health/unknown' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('not_found');
    expect(body).not.toHaveProperty('checks');
    await app.close();
  });

  it('answers 404 for a wrong method on an existing path', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    app.get('/api/test-read', async () => successEnvelope({ ok: true }));
    const res = await app.inject({ method: 'POST', url: '/api/test-read' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('authenticated requests with injected verifiers', () => {
  async function authedApp() {
    const app = await buildApp({
      config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
      pool: null,
      version: '0.39.2-fork.1',
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? PRINCIPAL : null),
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    });
    app.get('/api/test-read', async (request) => successEnvelope({ userId: getPrincipal(request)?.userId }));
    app.post('/api/test-mutate', async (request) => successEnvelope({ userId: getPrincipal(request)?.userId }));
    return app;
  }

  it('serves a GET with a valid session and no CSRF or Origin checks', async () => {
    const app = await authedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: { cookie: 'notegen_session=good-session' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, data: { userId: 'user-1' } });
    await app.close();
  });

  it('serves a mutation with a valid session, matching Origin, and a valid CSRF token', async () => {
    const app = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { cookie: 'notegen_session=good-session', origin: CANONICAL_ORIGIN, 'x-csrf-token': 'good-csrf' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a mutation without Origin or Referer with origin_rejected', async () => {
    const app = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { cookie: 'notegen_session=good-session', 'x-csrf-token': 'good-csrf' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('origin_rejected');
    await app.close();
  });

  it('rejects a mutation with a wrong Origin with origin_rejected', async () => {
    const app = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: {
        cookie: 'notegen_session=good-session',
        origin: 'https://evil.example.invalid',
        'x-csrf-token': 'good-csrf',
      },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('origin_rejected');
    await app.close();
  });

  it('rejects a mutation with a matching Origin but a bad CSRF token with csrf_invalid', async () => {
    const app = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { cookie: 'notegen_session=good-session', origin: CANONICAL_ORIGIN, 'x-csrf-token': 'stale' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('csrf_invalid');
    await app.close();
  });

  it('gives Origin and CSRF failures the same message', async () => {
    const app = await authedApp();
    const originRes = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { cookie: 'notegen_session=good-session', 'x-csrf-token': 'good-csrf' },
    });
    const csrfRes = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { cookie: 'notegen_session=good-session', origin: CANONICAL_ORIGIN },
    });
    const originBody = originRes.json() as { error: Record<string, unknown> };
    const csrfBody = csrfRes.json() as { error: Record<string, unknown> };
    expect(originBody.error['message']).toBe(csrfBody.error['message']);
    expect(originBody.error['code']).not.toBe(csrfBody.error['code']);
    await app.close();
  });

  it('fails closed when no CSRF verifier is injected, even with a valid session and Origin', async () => {
    const app = await buildApp({
      config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
      pool: null,
      version: '0.39.2-fork.1',
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? PRINCIPAL : null),
    });
    app.post('/api/test-mutate', async () => successEnvelope({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { cookie: 'notegen_session=good-session', origin: CANONICAL_ORIGIN, 'x-csrf-token': 'good-csrf' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('csrf_invalid');
    await app.close();
  });

  it('fails closed when no canonical origin is configured', async () => {
    const app = await buildApp({
      config: testConfig(),
      pool: null,
      version: '0.39.2-fork.1',
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? PRINCIPAL : null),
      verifyCsrf: async () => true,
    });
    app.post('/api/test-mutate', async () => successEnvelope({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { cookie: 'notegen_session=good-session', origin: CANONICAL_ORIGIN },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('origin_rejected');
    await app.close();
  });

  it('fails closed with a generic 500 when the session verifier throws, without leaking the error', async () => {
    const marker = 'MARKER_SECRET_9f27';
    const app = await buildApp({
      config: testConfig(),
      pool: null,
      version: '0.39.2-fork.1',
      verifySession: async () => {
        throw new Error(`database exploded: ${marker}`);
      },
    });
    app.get('/api/test-read', async () => successEnvelope({ ok: true }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: { cookie: 'notegen_session=good-session' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(marker);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('internal_error');
    await app.close();
  });
});

describe('no-session exemptions as wiring', () => {
  // The real CSP report route landed with V3-39b, so this case now
  // exercises it (a valid report, no session) instead of registering
  // a test-only route on the same path, which Fastify rejects as a
  // duplicate. The assertion is unchanged: the hook exemption lets
  // the request pass without a session.
  it('lets the real CSP report route pass without a session', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-reports',
      payload: {
        'csp-report': {
          'document-uri': 'https://app.example.invalid/notes/a',
          'violated-directive': 'script-src',
        },
      },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it('lets a test-only backup download route pass without a session', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    app.get('/api/backups/downloads/:token', async () => successEnvelope({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/api/backups/downloads/token-1' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('public mutation Origin preHandler', () => {
  it('rejects a wrong Origin and accepts the canonical one', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    app.post(
      '/api/test-login',
      { config: { requiresAuth: false }, preHandler: createOriginPreHandler(CANONICAL_ORIGIN) },
      async () => successEnvelope({ ok: true }),
    );
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { origin: 'https://evil.example.invalid' },
    });
    expect(rejected.statusCode).toBe(403);
    expect((rejected.json() as { error: Record<string, unknown> }).error['code']).toBe('origin_rejected');
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { origin: CANONICAL_ORIGIN },
    });
    expect(accepted.statusCode).toBe(200);
    await app.close();
  });
});

describe('request ids', () => {
  it('echoes a well-formed client request id in the header and the error envelope', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: { 'x-request-id': 'client-req-1' },
    });
    expect(res.headers['x-request-id']).toBe('client-req-1');
    expect((res.json() as { error: Record<string, unknown> }).error['requestId']).toBe('client-req-1');
    await app.close();
  });

  it('replaces a malformed client request id with a generated UUID', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/health/live',
      headers: { 'x-request-id': 'bad id\nwith newline' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  it('sends a request id header on health replies too', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const res = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });
});
