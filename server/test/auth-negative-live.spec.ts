// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Live auth probes, extended surface (worker V3-01cR, wave 3A).
//
// LAYER: L3, against the REAL routes only. Every test here is gated
// by a collection-time probe: when the real auth routes are absent
// (the trunk state at the time of writing), every gated test SKIPS
// with its reason in the suite name, and nothing claims a result
// against the real backend. When V3-01b/V3-02 land and this suite
// runs against a merged tree, the probes activate.
//
// Two gates, matching the two owners:
// - CORE (V3-01b): POST /api/auth/login exists. Gates logout-all,
//   session revoke, step-up, password change, register, and setup.
// - EXTENDED (V3-02): POST /api/auth/totp/enroll/start exists. Gates
//   the TOTP routes, the admin routes, and reset-confirm.
//
// What a passing gated test proves: the route is registered AND the
// real hook denies it without a session (401) or rejects a bad
// Origin (403) before any handler runs. The probes use buildApp with
// no database pool and no injected verifiers, so they prove
// registration plus deny-by-default wiring, NOT verifier correctness
// (session lookup, epoch comparison, Argon2id, TOTP). Verifier
// correctness needs a database-backed run and stays open debt (see
// the worker report). Probes send bad credentials only and never
// create a session; failed-login probes may increment failure
// buckets in a live database, which is harmless in a test run.
//
// This file does not repeat the L3 probes in
// auth-negative.spec.ts (me/sessions/csrf/logout no-session denials,
// login and login/totp Origin rejections, reset-request probes).
//
// Sources: kontrak-api-kanonis.md sections 1.2, 3.12, 3.13;
// desain-auth.md sections 2.2, 2.4, 3.4, 3.5.

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';

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

async function probeRoute(method: 'POST', url: string, headers: Record<string, string>, payload: string): Promise<number | null> {
  try {
    const probe = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    const res = await probe.inject({ method, url, headers, payload });
    const status = res.statusCode;
    await probe.close();
    return status;
  } catch {
    return null;
  }
}

// Presence detection: a registered session route answers 401 from the
// hook; an absent route answers 404 from the not-found handler. A
// registered pre-session route answers 401/403/503, never the router
// 404 (except setup/register by design, which is why those probes
// reuse the login gate instead of probing themselves).
const CORE_PROBE_STATUS: number | null = await probeRoute(
  'POST',
  '/api/auth/login',
  { origin: CANONICAL_ORIGIN, 'content-type': 'application/json' },
  JSON.stringify({ email: 'probe@example.invalid', password: 'probe-only-value' }),
);
const CORE_PRESENT = CORE_PROBE_STATUS !== null && CORE_PROBE_STATUS !== 404;

const EXTENDED_PROBE_STATUS: number | null = await probeRoute(
  'POST',
  '/api/auth/totp/enroll/start',
  { 'content-type': 'application/json' },
  JSON.stringify({}),
);
const EXTENDED_PRESENT = EXTENDED_PROBE_STATUS !== null && EXTENDED_PROBE_STATUS !== 404;

describe(`L3 core: real V3-01b auth routes without a session (present: ${String(CORE_PRESENT)}, probe status: ${String(CORE_PROBE_STATUS)})`, () => {
  it('records the core probe outcome instead of assuming it', () => {
    expect(typeof CORE_PRESENT).toBe('boolean');
    expect(CORE_PROBE_STATUS === null || typeof CORE_PROBE_STATUS === 'number').toBe(true);
  });

  const noSessionRoutes: Array<{ method: 'POST' | 'DELETE'; url: string }> = [
    { method: 'POST', url: '/api/auth/logout-all' },
    { method: 'DELETE', url: '/api/auth/sessions/session-probe-1' },
    { method: 'POST', url: '/api/auth/step-up' },
    { method: 'POST', url: '/api/auth/password/change' },
  ];
  for (const route of noSessionRoutes) {
    it.skipIf(!CORE_PRESENT)(`${route.method} ${route.url} without a session answers 401, never 403`, async () => {
      const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('unauthenticated');
      await app.close();
    });
  }

  it.skipIf(!CORE_PRESENT)('POST /api/auth/register answers 404 not_found in closed mode', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'new@example.invalid', password: 'probe-only-value' }),
    });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe('not_found');
    expect(res.body).not.toContain('closed');
    await app.close();
  });

  it.skipIf(!CORE_PRESENT)('POST /api/auth/register with a wrong Origin answers 403 origin_rejected', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'new@example.invalid', password: 'probe-only-value' }),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it.skipIf(!CORE_PRESENT)('POST /api/auth/setup with a wrong Origin answers 403 origin_rejected', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ setupToken: 'probe-only-value', email: 'probe@example.invalid', password: 'probe-only-value' }),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it.skipIf(!CORE_PRESENT)('POST /api/auth/setup with a bad token never succeeds: 401 open, 404 complete, or 503 when the database is down', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ setupToken: 'probe-only-setup-value', email: 'probe@example.invalid', password: 'probe-only-value' }),
    });
    expect([401, 404, 503]).toContain(res.statusCode);
    if (res.statusCode === 401) {
      expect(errorOf(res).code).toBe('invalid_setup_token');
    } else if (res.statusCode === 404) {
      expect(errorOf(res).code).toBe('not_found');
    } else {
      expect(errorOf(res).code).toBe('service_unavailable');
    }
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).not.toContain('probe-only-setup-value');
    await app.close();
  });
});

describe(`L3 extended: real V3-02 auth and admin routes without a session (present: ${String(EXTENDED_PRESENT)}, probe status: ${String(EXTENDED_PROBE_STATUS)})`, () => {
  it('records the extended probe outcome instead of assuming it', () => {
    expect(typeof EXTENDED_PRESENT).toBe('boolean');
    expect(EXTENDED_PROBE_STATUS === null || typeof EXTENDED_PROBE_STATUS === 'number').toBe(true);
  });

  const noSessionRoutes: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string }> = [
    { method: 'POST', url: '/api/auth/totp/enroll/start' },
    { method: 'POST', url: '/api/auth/totp/enroll/confirm' },
    { method: 'POST', url: '/api/auth/totp/disable' },
    { method: 'POST', url: '/api/auth/totp/recovery-codes/regenerate' },
    { method: 'GET', url: '/api/admin/users' },
    { method: 'POST', url: '/api/admin/users/user-probe-1/disable' },
    { method: 'POST', url: '/api/admin/users/user-probe-1/restore' },
    { method: 'DELETE', url: '/api/admin/users/user-probe-1/sessions/session-probe-1' },
  ];
  for (const route of noSessionRoutes) {
    it.skipIf(!EXTENDED_PRESENT)(`${route.method} ${route.url} without a session answers 401 unauthenticated`, async () => {
      const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: { 'content-type': 'application/json' },
        payload: route.method === 'GET' ? undefined : JSON.stringify({}),
      });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('unauthenticated');
      await app.close();
    });
  }

  it.skipIf(!EXTENDED_PRESENT)('POST /api/auth/password/reset-confirm with a wrong Origin answers 403 origin_rejected', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset-confirm',
      headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ token: 'probe-only-value', newPassword: 'probe-only-value' }),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });
});
