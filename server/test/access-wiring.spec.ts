// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the Cloudflare Access wiring (desain-auth.md section 7;
// AD-132, PREDEPLOY finding F-02). The verifier itself is covered in
// access-jwt.spec.ts; this spec proves the preHandler is actually
// installed in buildApp, runs before the session hook, and applies
// the exemption predicate from middleware/cf-access-exemptions.ts.
//
// Tokens are signed here with real RSA keys from node:crypto, and
// the JWKS fetch is a stubbed global fetch returning a dummy JWKS
// document built from the test key. No network access, no real
// Cloudflare token, and no dashboard artifact are involved: full
// G5(a)-(g) verification with a real service token stays a wave 5
// job after Q1A. What is pinned here is the wiring shape: missing,
// forged, wrong-audience, and expired tokens are rejected before
// the session layer runs; a valid token reaches the handler; the
// live path is exempt for every peer; the ready path is exempt only
// for loopback peers; a forwarded header cannot forge an exemption;
// session-public paths still require an Access JWT; and disabled
// verification stays inert.
//
// Peer simulation: app.inject defaults to 127.0.0.1 (loopback), and
// the remoteAddress inject option simulates a public-path peer
// (a compose-network address, as Caddy forwarding would present).
// Readiness without a database answers 503 with ok false, which is
// the discriminator between "reached the handler" (503) and
// "rejected by Access" (401) on the ready path.

import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getPrincipal, type SessionPrincipal } from '../src/middleware/auth-hook.js';
import { getCfAccessPrincipal } from '../src/middleware/cf-access.js';
import {
  isCfAccessExemptRequest,
  isLoopbackPeerAddress,
  requestPeerAddress,
} from '../src/middleware/cf-access-exemptions.js';
import { successEnvelope } from '../src/plugins/envelope.js';
import { testConfig } from './auth/helpers.js';

const TEAM_DOMAIN = 'team.cloudflareaccess.com';
const APP_AUD = 'app-audience-tag';
const SERVICE_AUD = 'service-audience-tag';
const KID = 'test-kid';
const PUBLIC_PEER = '172.18.0.5';

const PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'good-session' };

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function signToken(key: KeyObject, payload: Record<string, unknown>): string {
  const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput, 'utf8').sign(key);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: APP_AUD,
    iss: `https://${TEAM_DOMAIN}`,
    exp: nowSeconds() + 300,
    email: 'owner@example.invalid',
    sub: 'subject-1',
    ...overrides,
  };
}

interface KeyMaterial {
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeKey(kid: string): KeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exported = publicKey.export({ format: 'jwk' });
  return { privateKey, jwk: { ...exported, kid, use: 'sig', alg: 'RS256' } };
}

const goodKey = makeKey(KID);
const wrongKey = makeKey(KID);

const JWKS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;

function stubDummyJwks(): void {
  const stub = (async (url: unknown) => {
    expect(String(url)).toBe(JWKS_URL);
    return {
      status: 200,
      json: async () => ({ keys: [goodKey.jwk] }),
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', stub);
}

describe('Cloudflare Access wiring', () => {
  const apps: FastifyInstance[] = [];
  let sessionCalls = 0;

  beforeEach(() => {
    sessionCalls = 0;
    stubDummyJwks();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    while (apps.length > 0) {
      const app = apps.pop() as FastifyInstance;
      await app.close();
    }
  });

  async function accessApp(): Promise<FastifyInstance> {
    const app = await buildApp({
      config: testConfig({
        cfAccessEnabled: true,
        cfAccessTeamDomain: TEAM_DOMAIN,
        cfAccessAud: APP_AUD,
        cfAccessServiceAud: SERVICE_AUD,
      }),
      pool: null,
      version: 'test',
      verifySession: async ({ sessionId }) => {
        sessionCalls += 1;
        return sessionId === 'good-session' ? PRINCIPAL : null;
      },
    });
    app.get('/api/test-read', async (request) =>
      successEnvelope({
        userId: getPrincipal(request)?.userId ?? null,
        accessEmail: getCfAccessPrincipal(request)?.email ?? null,
      }),
    );
    app.get(
      '/api/test-open',
      { config: { requiresAuth: false } },
      async () => successEnvelope({ open: true }),
    );
    apps.push(app);
    return app;
  }

  function accessHeaders(token: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
    return token === undefined ? { ...extra } : { 'cf-access-jwt-assertion': token, ...extra };
  }

  it('rejects a request without a JWT before the session layer runs', async () => {
    const app = await accessApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      remoteAddress: PUBLIC_PEER,
      headers: { cookie: 'notegen_session=good-session' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('unauthenticated');
    expect(sessionCalls).toBe(0);
  });

  it('rejects a raw identity header without a JWT', async () => {
    const app = await accessApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      remoteAddress: PUBLIC_PEER,
      headers: { 'cf-access-authenticated-user-email': 'owner@example.invalid' },
    });
    expect(res.statusCode).toBe(401);
    expect(sessionCalls).toBe(0);
  });

  it('rejects a token signed with the wrong key before the session layer runs', async () => {
    const app = await accessApp();
    const forged = signToken(wrongKey.privateKey, validPayload());
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      remoteAddress: PUBLIC_PEER,
      headers: accessHeaders(forged, { cookie: 'notegen_session=good-session' }),
    });
    expect(res.statusCode).toBe(401);
    expect(sessionCalls).toBe(0);
  });

  it('rejects a token with the wrong audience', async () => {
    const app = await accessApp();
    const token = signToken(goodKey.privateKey, validPayload({ aud: 'someone-elses-audience' }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      remoteAddress: PUBLIC_PEER,
      headers: accessHeaders(token),
    });
    expect(res.statusCode).toBe(401);
    expect(sessionCalls).toBe(0);
  });

  it('rejects an expired token', async () => {
    const app = await accessApp();
    const token = signToken(goodKey.privateKey, validPayload({ exp: nowSeconds() - 10 }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      remoteAddress: PUBLIC_PEER,
      headers: accessHeaders(token),
    });
    expect(res.statusCode).toBe(401);
    expect(sessionCalls).toBe(0);
  });

  it('accepts a valid token and still enforces the session layer after it', async () => {
    const app = await accessApp();
    const token = signToken(goodKey.privateKey, validPayload());
    const authed = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      remoteAddress: PUBLIC_PEER,
      headers: accessHeaders(token, { cookie: 'notegen_session=good-session' }),
    });
    expect(authed.statusCode).toBe(200);
    const body = authed.json() as { data: { userId: string | null; accessEmail: string | null } };
    expect(body.data.userId).toBe('user-1');
    expect(body.data.accessEmail).toBe('owner@example.invalid');
    // A valid Access JWT without a session still answers 401, from
    // the session layer: the session verifier ran, so Access passed.
    const callsBefore = sessionCalls;
    const noSession = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      remoteAddress: PUBLIC_PEER,
      headers: accessHeaders(token),
    });
    expect(noSession.statusCode).toBe(401);
    expect(sessionCalls).toBeGreaterThan(callsBefore);
  });

  it('requires an Access JWT on session-public routes too', async () => {
    const app = await accessApp();
    const token = signToken(goodKey.privateKey, validPayload());
    const denied = await app.inject({
      method: 'GET',
      url: '/api/test-open',
      remoteAddress: PUBLIC_PEER,
    });
    expect(denied.statusCode).toBe(401);
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/test-open',
      remoteAddress: PUBLIC_PEER,
      headers: accessHeaders(token),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('verifies unmatched paths: 401 without a JWT, 404 with a valid JWT', async () => {
    const app = await accessApp();
    const token = signToken(goodKey.privateKey, validPayload());
    const denied = await app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      remoteAddress: PUBLIC_PEER,
    });
    expect(denied.statusCode).toBe(401);
    const notFound = await app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      remoteAddress: PUBLIC_PEER,
      headers: accessHeaders(token),
    });
    expect(notFound.statusCode).toBe(404);
    expect((notFound.json() as { error: Record<string, unknown> }).error['code']).toBe('not_found');
  });

  it('exempts GET /api/health/live for a public peer, with or without a JWT', async () => {
    const app = await accessApp();
    const forged = signToken(wrongKey.privateKey, validPayload());
    const noToken = await app.inject({ method: 'GET', url: '/api/health/live', remoteAddress: PUBLIC_PEER });
    expect(noToken.statusCode).toBe(200);
    const badToken = await app.inject({
      method: 'GET',
      url: '/api/health/live',
      remoteAddress: PUBLIC_PEER,
      headers: accessHeaders(forged),
    });
    expect(badToken.statusCode).toBe(200);
  });

  it('exempts GET /api/health/ready for a loopback peer without a JWT', async () => {
    const app = await accessApp();
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { ok: boolean }).ok).toBe(false);
  });

  it('requires a JWT for GET /api/health/ready from a public peer', async () => {
    const app = await accessApp();
    const token = signToken(goodKey.privateKey, validPayload());
    const denied = await app.inject({
      method: 'GET',
      url: '/api/health/ready',
      remoteAddress: PUBLIC_PEER,
    });
    expect(denied.statusCode).toBe(401);
    const deniedBody = denied.json() as { error: Record<string, unknown> };
    expect(deniedBody.error['code']).toBe('unauthenticated');
    expect(denied.json() as Record<string, unknown>).not.toHaveProperty('checks');
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/health/ready',
      remoteAddress: PUBLIC_PEER,
      headers: accessHeaders(token),
    });
    expect(allowed.statusCode).toBe(503);
    expect((allowed.json() as { ok: boolean }).ok).toBe(false);
  });

  it('does not let a forwarded header forge a loopback exemption', async () => {
    const app = await accessApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health/ready',
      remoteAddress: PUBLIC_PEER,
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('unauthenticated');
  });

  it('treats the GET /api/health alias exactly like ready', async () => {
    const app = await accessApp();
    const loopback = await app.inject({ method: 'GET', url: '/api/health' });
    expect(loopback.statusCode).toBe(503);
    const denied = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: PUBLIC_PEER });
    expect(denied.statusCode).toBe(401);
    expect((denied.json() as { error: Record<string, unknown> }).error['code']).toBe('unauthenticated');
  });

  it('accepts a service-audience token without an email claim on the ready path', async () => {
    const app = await accessApp();
    const { email: _email, ...servicePayload } = validPayload({ aud: SERVICE_AUD });
    void _email;
    const token = signToken(goodKey.privateKey, servicePayload);
    const res = await app.inject({
      method: 'GET',
      url: '/api/health/ready',
      remoteAddress: PUBLIC_PEER,
      headers: accessHeaders(token),
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { ok: boolean }).ok).toBe(false);
  });

  it('stays inert when verification is disabled', async () => {
    const app = await buildApp({
      config: testConfig({ cfAccessEnabled: false }),
      pool: null,
      version: 'test',
      verifySession: async ({ sessionId }) => {
        sessionCalls += 1;
        return sessionId === 'good-session' ? PRINCIPAL : null;
      },
    });
    apps.push(app);
    app.get('/api/test-read', async () => successEnvelope({ ok: true }));
    const ready = await app.inject({ method: 'GET', url: '/api/health/ready', remoteAddress: PUBLIC_PEER });
    expect(ready.statusCode).toBe(503);
    const protectedRes = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      remoteAddress: PUBLIC_PEER,
    });
    expect(protectedRes.statusCode).toBe(401);
    expect(sessionCalls).toBeGreaterThan(0);
  });

  it('refuses to build the app when enabled without an audience', async () => {
    await expect(
      buildApp({
        config: testConfig({ cfAccessEnabled: true, cfAccessTeamDomain: TEAM_DOMAIN }),
        pool: null,
        version: 'test',
      }),
    ).rejects.toThrow('CF_ACCESS_AUD');
  });
});

describe('Access exemption predicate', () => {
  function fakeRequest(method: string, url: string, remoteAddress: string | undefined): FastifyRequest {
    return {
      method,
      url,
      headers: {},
      socket: remoteAddress === undefined ? {} : { remoteAddress },
    } as unknown as FastifyRequest;
  }

  it('exempts live for every peer, including an unknown one', () => {
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/health/live', PUBLIC_PEER))).toBe(true);
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/health/live', undefined))).toBe(true);
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/health/live?probe=1', PUBLIC_PEER))).toBe(true);
  });

  it('exempts ready only for loopback peers', () => {
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/health/ready', '127.0.0.1'))).toBe(true);
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/health/ready', '::1'))).toBe(true);
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/health/ready', '::ffff:127.0.0.1'))).toBe(true);
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/health/ready', PUBLIC_PEER))).toBe(false);
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/health/ready', undefined))).toBe(false);
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/health', '127.0.0.1'))).toBe(true);
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/health', PUBLIC_PEER))).toBe(false);
  });

  it('never exempts other methods or paths', () => {
    expect(isCfAccessExemptRequest(fakeRequest('POST', '/api/health/live', '127.0.0.1'))).toBe(false);
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/auth/me', '127.0.0.1'))).toBe(false);
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/csp-reports', '127.0.0.1'))).toBe(false);
    expect(isCfAccessExemptRequest(fakeRequest('GET', '/api/health/unknown', '127.0.0.1'))).toBe(false);
  });

  it('reads the peer address from the socket only', () => {
    expect(requestPeerAddress(fakeRequest('GET', '/x', '172.18.0.5'))).toBe('172.18.0.5');
    expect(requestPeerAddress(fakeRequest('GET', '/x', undefined))).toBeUndefined();
    expect(isLoopbackPeerAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackPeerAddress('127.0.0.2')).toBe(false);
    expect(isLoopbackPeerAddress(undefined)).toBe(false);
  });
});
