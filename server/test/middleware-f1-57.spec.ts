// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Middleware tests for F1-57 (worker V3-01c, wave 3A): test W07 7.3
// item 6, the no-auth test against the middleware. Health passes
// without credentials while data endpoints reject, and the health
// path exemption is tested explicitly (desain-auth.md section 12.4).
//
// Layers, as in auth-negative.spec.ts:
// - Real app plus the real auth hook from the trunk, with injected
//   fake verifiers and test-only routes standing in for data routes
//   that other workers own. Route registration is guarded so that,
//   when this suite runs against a tree where a real route already
//   exists, the real route is used for the denial assertions and only
//   the positive controls are limited to test-registered routes.
// - The 10-route no-session allowlist from amandemen D3 (11 before
//   DA-6 A26-04 removed the backup-download exemption) is pinned as
//   an exact set, with the mechanism split made explicit: 5 routes
//   are exempt in the hook itself, 6 pre-session auth routes are
//   exempt by route config plus the Origin preHandler.
// - One readiness test runs against a real Postgres 17 database
//   (database v3_01c_tests on the persistent Fase 1 cluster at
//   127.0.0.1:55434, trust auth, no password in the DSN). The
//   database must exist and be migrated before the suite runs
//   (gate provisioning); the test itself never migrates. It skips
//   honestly when the database is unreachable, detected at
//   collection time.
//
// Sources: DAFTAR-TERBUKA-FASE1.md F1-57; desain-auth.md section
// 12.4; kontrak-api-kanonis.md sections 1.2, 3.14, 6;
// amandemen-kontrak-d1-d3.md section 3 (D3); bentuk-middleware-beku.md.

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { closePool, createPool } from '../src/db/pool.js';
import {
  createOriginPreHandler,
  getPrincipal,
  isPublicNoSessionRequest,
  PUBLIC_HEALTH_PATHS,
  readCsrfTokenHeader,
} from '../src/middleware/auth-hook.js';
import { successEnvelope } from '../src/plugins/envelope.js';
import { HEALTH_PATHS } from '../src/routes/health.js';

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

function sessionCookie(sessionId: string): Record<string, string> {
  return { cookie: `notegen_session=${sessionId}` };
}

// Postgres availability probe for the real-database readiness test.
// The DSN carries no password (trust auth on the test cluster); the
// default targets the persistent Fase 1 cluster (AD-69) at port
// 55434 and can be overridden with V3_01C_TEST_DATABASE_URL. The
// previous default port 55433 named the retired throwaway cluster
// and is stale since the gate moved to 55434 (W4-FAILCLOSED).
const TEST_DATABASE_URL =
  process.env['V3_01C_TEST_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55434/v3_01c_tests';

const PG_AVAILABLE: boolean = await (async () => {
  try {
    const pool = createPool(TEST_DATABASE_URL, 2000);
    if (pool === null) {
      return false;
    }
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT 1 AS ok');
      return result.rows.length === 1 && result.rows[0]?.['ok'] === 1;
    } finally {
      client.release();
      await pool.end();
    }
  } catch {
    return false;
  }
})();

describe('F1-57: health passes without credentials [real app, no database]', () => {
  let app!: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health/live without a cookie answers 200 with the live envelope and no-store', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['status']).toBe('live');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/health/ready without a session answers 503 not_ready when the database is down, never 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { ok: boolean; status: string; checks: Record<string, unknown> };
    expect(body.ok).toBe(false);
    expect(body.status).toBe('not_ready');
    expect(Object.keys(body.checks)).toEqual(['db', 'workspace', 'migrations', 'pgvector', 'worker']);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/health (alias) matches ready exactly in status, ok, and per-check outcomes', async () => {
    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' });
    const alias = await app.inject({ method: 'GET', url: '/api/health' });
    expect(alias.statusCode).toBe(ready.statusCode);
    const normalize = (res: InjectResponse): string => {
      const body = res.json() as {
        ok: boolean;
        status: string;
        checks: Record<string, { status: string; detail: string; error: string | null }>;
      };
      const checks: Record<string, { status: string; detail: string; error: string | null }> = {};
      for (const [name, check] of Object.entries(body.checks)) {
        checks[name] = { status: check.status, detail: check.detail, error: check.error };
      }
      return JSON.stringify({ ok: body.ok, status: body.status, checks });
    };
    expect(normalize(alias)).toBe(normalize(ready));
  });

  it('all three health paths ignore auth entirely: a garbage cookie plus a wrong Origin never yields 401', async () => {
    for (const url of ['/api/health/live', '/api/health/ready', '/api/health']) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { ...sessionCookie('garbage-session'), origin: 'https://evil.example.invalid' },
      });
      expect(res.statusCode).not.toBe(401);
      if (url === '/api/health/live') {
        expect(res.statusCode).toBe(200);
      } else {
        expect(res.statusCode).toBe(503);
      }
    }
  });

  it('POST to a health path answers 405, never 401 and never a health 503', async () => {
    for (const url of ['/api/health/live', '/api/health/ready', '/api/health']) {
      const res = await app.inject({ method: 'POST', url });
      expect(res.statusCode).toBe(405);
      expect(errorOf(res).code).toBe('method_not_allowed');
      expect(res.json() as Record<string, unknown>).not.toHaveProperty('checks');
    }
  });

  it('ten rapid liveness probes without credentials all answer 200', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/api/health/live' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('health bodies leak no config value: no DSN fragment and no placeholder host', async () => {
    const live = await app.inject({ method: 'GET', url: '/api/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' });
    for (const res of [live, ready]) {
      expect(res.body).not.toContain('postgres://');
      expect(res.body).not.toContain('placeholder');
      expect(res.body).not.toContain('DATABASE_URL');
    }
  });
});

describe(`F1-57: readiness passes without credentials against a real database (Postgres available: ${String(PG_AVAILABLE)})`, () => {
  it.skipIf(!PG_AVAILABLE)('GET /api/health/ready without a session answers 200 ready with db and workspace ok', async () => {
    const pool = createPool(TEST_DATABASE_URL, 2000);
    expect(pool).not.toBeNull();
    const workspaceRoot = mkdtempSync(join(process.cwd(), '.v3-01c-ws-'));
    try {
      const app = await buildApp({ config: testConfig({ workspaceRoot }), pool, version: VERSION });
      try {
        const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
          ok: boolean;
          status: string;
          checks: Record<string, { status: string }>;
        };
        expect(body.ok).toBe(true);
        expect(body.status).toBe('ready');
        expect(Object.keys(body.checks)).toEqual(['db', 'workspace', 'migrations', 'pgvector', 'worker']);
        expect(body.checks['db']?.status).toBe('ok');
        expect(body.checks['workspace']?.status).toBe('ok');
        const alias = await app.inject({ method: 'GET', url: '/api/health' });
        expect(alias.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    } finally {
      await closePool(pool);
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

// Representative data routes, one per contract group plus the AD-32
// trash route. Test-only stand-ins: the hook runs before the handler,
// so the denial assertions exercise the real middleware.
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const DATA_ROUTES: ReadonlyArray<{ method: HttpMethod; url: string }> = [
  { method: 'GET', url: '/api/marks' },
  { method: 'POST', url: '/api/marks' },
  { method: 'GET', url: '/api/marks/mark-1' },
  { method: 'PATCH', url: '/api/marks/mark-1' },
  { method: 'DELETE', url: '/api/marks/mark-1' },
  { method: 'DELETE', url: '/api/marks/trash' },
  { method: 'GET', url: '/api/tags' },
  { method: 'POST', url: '/api/tags' },
  { method: 'GET', url: '/api/search' },
  { method: 'POST', url: '/api/search/fuzzy' },
  { method: 'POST', url: '/api/documents/parse' },
  { method: 'GET', url: '/api/workspace/file' },
  { method: 'PUT', url: '/api/workspace/file' },
  { method: 'DELETE', url: '/api/workspace/file' },
  { method: 'GET', url: '/api/workspace/media/a.png' },
  { method: 'GET', url: '/api/settings' },
  { method: 'PATCH', url: '/api/settings' },
  { method: 'GET', url: '/api/settings/secrets/status' },
  { method: 'GET', url: '/api/backups' },
  { method: 'POST', url: '/api/backups' },
  { method: 'POST', url: '/api/backups/export' },
  { method: 'GET', url: '/api/backups/jobs/job-1' },
  { method: 'GET', url: '/api/backups/backup-1/download' },
  { method: 'POST', url: '/api/transactions' },
  { method: 'POST', url: '/api/db/batch' },
  { method: 'GET', url: '/api/assets/asset-1' },
  { method: 'GET', url: '/api/admin/users' },
  { method: 'POST', url: '/api/admin/users/user-1/disable' },
  { method: 'GET', url: '/api/auth/me' },
  { method: 'GET', url: '/api/auth/sessions' },
  { method: 'GET', url: '/api/auth/csrf' },
  { method: 'POST', url: '/api/auth/logout' },
  { method: 'DELETE', url: '/api/auth/sessions/session-1' },
  { method: 'POST', url: '/api/auth/step-up' },
  { method: 'POST', url: '/api/auth/totp/enroll/start' },
  { method: 'POST', url: '/api/auth/totp/recovery-codes/regenerate' },
];

function tryRegisterDataRoute(app: FastifyInstance, method: HttpMethod, url: string): boolean {
  try {
    app.route({ method, url, handler: async () => successEnvelope({ route: url }) });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'FST_ERR_DUPLICATED_ROUTE') {
      return false;
    }
    throw error;
  }
}

describe('F1-57: data endpoints reject without a session [real hook, representative routes]', () => {
  let app!: FastifyInstance;
  let registeredByTest: Set<string>;

  beforeAll(async () => {
    app = await buildApp({
      config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
      pool: null,
      version: VERSION,
      verifySession: async ({ sessionId }) =>
        sessionId === 'session-valid' ? { userId: 'user-1', role: 'user', sessionId } : null,
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'csrf-valid',
    });
    registeredByTest = new Set();
    for (const route of DATA_ROUTES) {
      if (tryRegisterDataRoute(app, route.method, route.url)) {
        registeredByTest.add(`${route.method} ${route.url}`);
      }
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(DATA_ROUTES)('$method $url without a cookie answers 401 unauthenticated', async ({ method, url }) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
  });

  it.each(DATA_ROUTES)('$method $url with an unknown cookie answers 401 unauthenticated', async ({ method, url }) => {
    const res = await app.inject({ method, url, headers: sessionCookie('session-unknown') });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
  });

  it.each(DATA_ROUTES)('$method $url with a Bearer token alone answers 401 unauthenticated', async ({ method, url }) => {
    const res = await app.inject({ method, url, headers: { authorization: 'Bearer fixture-token-value' } });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
  });

  it('mutations without a cookie answer 401, never 403: authentication is checked before CSRF and Origin', async () => {
    const mutations = DATA_ROUTES.filter((route) => route.method !== 'GET');
    expect(mutations.length).toBeGreaterThan(0);
    for (const route of mutations) {
      const res = await app.inject({ method: route.method, url: route.url });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('unauthenticated');
    }
  });

  it('a JSON body does not bypass the session check on a mutation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/marks',
      headers: { origin: CANONICAL_ORIGIN, 'x-csrf-token': 'csrf-valid', 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'bypass attempt' }),
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
  });

  it('GET data routes serve a valid session: positive control for the routes this file registered', async () => {
    const gets = DATA_ROUTES.filter(
      (route) => route.method === 'GET' && registeredByTest.has(`${route.method} ${route.url}`),
    );
    expect(gets.length).toBeGreaterThan(0);
    for (const route of gets) {
      const res = await app.inject({ method: 'GET', url: route.url, headers: sessionCookie('session-valid') });
      expect(res.statusCode).toBe(200);
    }
  });

  it('mutations serve a valid session with matching Origin and CSRF: positive control for the routes this file registered', async () => {
    const mutations = DATA_ROUTES.filter(
      (route) => route.method !== 'GET' && registeredByTest.has(`${route.method} ${route.url}`),
    );
    expect(mutations.length).toBeGreaterThan(0);
    for (const route of mutations) {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: { ...sessionCookie('session-valid'), origin: CANONICAL_ORIGIN, 'x-csrf-token': 'csrf-valid' },
      });
      expect(res.statusCode).toBe(200);
    }
  });
});

// The D3 no-session allowlist, exactly 10 routes (DA-6 A26-04 removed
// the backup-download exemption). The mechanism split
// is part of the pin: hook-exempt routes are skipped by
// isPublicNoSessionRequest, while the six pre-session auth routes are
// exempt by route config (requiresAuth: false) plus the Origin
// preHandler, because they carry replacement credentials (setup token,
// challenge, action token) instead of a session.
const NO_SESSION_ROUTES: ReadonlyArray<{
  method: string;
  path: string;
  mechanism: 'hook-exempt' | 'route-config';
}> = [
  { method: 'GET', path: '/api/health/live', mechanism: 'hook-exempt' },
  { method: 'GET', path: '/api/health/ready', mechanism: 'hook-exempt' },
  { method: 'GET', path: '/api/health', mechanism: 'hook-exempt' },
  { method: 'POST', path: '/api/csp-reports', mechanism: 'hook-exempt' },
  { method: 'POST', path: '/api/auth/setup', mechanism: 'route-config' },
  { method: 'POST', path: '/api/auth/login', mechanism: 'route-config' },
  { method: 'POST', path: '/api/auth/login/totp', mechanism: 'route-config' },
  { method: 'POST', path: '/api/auth/password/reset-request', mechanism: 'route-config' },
  { method: 'POST', path: '/api/auth/password/reset-confirm', mechanism: 'route-config' },
  { method: 'POST', path: '/api/auth/register', mechanism: 'route-config' },
];

const SESSION_ROUTES_SAMPLE: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/auth/me' },
  { method: 'GET', path: '/api/auth/sessions' },
  { method: 'GET', path: '/api/auth/csrf' },
  { method: 'POST', path: '/api/auth/logout' },
  { method: 'POST', path: '/api/auth/step-up' },
  { method: 'POST', path: '/api/auth/totp/enroll/start' },
  { method: 'GET', path: '/api/admin/users' },
  { method: 'GET', path: '/api/marks' },
  { method: 'GET', path: '/api/workspace/file' },
  { method: 'GET', path: '/api/settings' },
  { method: 'GET', path: '/api/backups' },
  { method: 'GET', path: '/api/backups/backup-1/download' },
  { method: 'GET', path: '/api/assets/asset-1' },
  { method: 'POST', path: '/api/search/fuzzy' },
  { method: 'DELETE', path: '/api/marks/trash' },
];

describe('D3: the no-session allowlist is exactly 10 routes', () => {
  it('contains exactly 10 routes with no duplicates', () => {
    expect(NO_SESSION_ROUTES).toHaveLength(10);
    const keys = NO_SESSION_ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(10);
  });

  it('splits into 4 hook-exempt routes and 6 route-config routes', () => {
    expect(NO_SESSION_ROUTES.filter((route) => route.mechanism === 'hook-exempt')).toHaveLength(4);
    expect(NO_SESSION_ROUTES.filter((route) => route.mechanism === 'route-config')).toHaveLength(6);
  });

  it('hook-exempt entries are exempt in the real hook allowlist', () => {
    expect(isPublicNoSessionRequest('GET', '/api/health/live')).toBe(true);
    expect(isPublicNoSessionRequest('GET', '/api/health/ready')).toBe(true);
    expect(isPublicNoSessionRequest('GET', '/api/health')).toBe(true);
    expect(isPublicNoSessionRequest('POST', '/api/csp-reports')).toBe(true);
    // DA-6 A26-04: the backup-download exemption is gone; downloads
    // require a session like every other route.
    expect(isPublicNoSessionRequest('GET', '/api/backups/downloads/token-1')).toBe(false);
  });

  it('route-config entries are NOT hook-exempt: their exemption comes from route config plus the Origin preHandler', () => {
    for (const route of NO_SESSION_ROUTES.filter((entry) => entry.mechanism === 'route-config')) {
      expect(isPublicNoSessionRequest(route.method, route.path)).toBe(false);
    }
  });

  it('no session route in the sample is hook-exempt', () => {
    for (const route of SESSION_ROUTES_SAMPLE) {
      expect(isPublicNoSessionRequest(route.method, route.path)).toBe(false);
    }
  });

  it('no session route in the sample appears in the 11-route list', () => {
    const keys = new Set(NO_SESSION_ROUTES.map((route) => `${route.method} ${route.path}`));
    for (const route of SESSION_ROUTES_SAMPLE) {
      expect(keys.has(`${route.method} ${route.path}`)).toBe(false);
    }
  });

  it('the list carries no version prefix, no workspace id segment, and no trailing slash', () => {
    for (const route of NO_SESSION_ROUTES) {
      expect(route.path.startsWith('/api/')).toBe(true);
      expect(route.path).not.toContain('/api/v1');
      expect(route.path.toLowerCase()).not.toContain('workspaceid');
      expect(route.path.endsWith('/')).toBe(false);
    }
  });

  it('the health paths in the list equal the single source of truth in the route module', () => {
    const healthInList = NO_SESSION_ROUTES.filter((route) => route.path.startsWith('/api/health')).map(
      (route) => route.path,
    );
    expect([...healthInList].sort()).toEqual([...HEALTH_PATHS].sort());
    expect([...PUBLIC_HEALTH_PATHS].sort()).toEqual([...HEALTH_PATHS].sort());
  });

  it('the route-config mechanism works: no session plus a good Origin passes, a bad Origin yields 403', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    app.post(
      '/api/test-presession',
      { config: { requiresAuth: false }, preHandler: createOriginPreHandler(CANONICAL_ORIGIN) },
      async () => successEnvelope({ ok: true }),
    );
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/test-presession',
      headers: { origin: CANONICAL_ORIGIN },
    });
    expect(accepted.statusCode).toBe(200);
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/test-presession',
      headers: { origin: 'https://evil.example.invalid' },
    });
    expect(rejected.statusCode).toBe(403);
    expect(errorOf(rejected).code).toBe('origin_rejected');
    const missing = await app.inject({ method: 'POST', url: '/api/test-presession' });
    expect(missing.statusCode).toBe(403);
    expect(errorOf(missing).code).toBe('origin_rejected');
    await app.close();
  });
});

describe('hook exemptions are method-scoped [real hook, test-only routes]', () => {
  let app!: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ config: testConfig(), pool: null, version: VERSION });
    // No test-only POST /api/csp-reports route: the real route
    // landed with V3-39b, and Fastify rejects a duplicate
    // registration. The POST case below exercises the real route.
    app.get('/api/csp-reports', async () => successEnvelope({ ok: true }));
    app.get('/api/backups/downloads/:token', async () => successEnvelope({ ok: true }));
    app.post('/api/backups/downloads/:token', async () => successEnvelope({ ok: true }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /api/csp-reports passes without a session and answers 204', async () => {
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
    expect(res.body).toBe('');
  });

  it('GET /api/csp-reports without a session answers 401: the exemption is POST-only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/csp-reports' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
  });

  it('GET /api/backups/downloads/:token without a session answers 401 (DA-6 A26-04)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/backups/downloads/token-1' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
  });

  it('POST /api/backups/downloads/:token without a session answers 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/backups/downloads/token-1' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
  });

  it('an empty download token is denied 401 (fail closed, never exempt) and a nested download path answers 404', async () => {
    expect(isPublicNoSessionRequest('GET', '/api/backups/downloads/')).toBe(false);
    expect(isPublicNoSessionRequest('GET', '/api/backups/downloads/a/b')).toBe(false);
    // The router still matches the trailing-slash form to the token
    // route, so the hook runs and denies it: the empty token is not
    // exempt and is never served. The nested path matches no route.
    const empty = await app.inject({ method: 'GET', url: '/api/backups/downloads/' });
    expect(empty.statusCode).toBe(401);
    expect(errorOf(empty).code).toBe('unauthenticated');
    const nested = await app.inject({ method: 'GET', url: '/api/backups/downloads/a/b' });
    expect(nested.statusCode).toBe(404);
  });
});

describe('middleware fail-closed negatives [real hook]', () => {
  async function buildGuardedApp(withOrigin: boolean): Promise<FastifyInstance> {
    const app = await buildApp({
      config: testConfig(withOrigin ? { publicBaseUrl: CANONICAL_ORIGIN } : {}),
      pool: null,
      version: VERSION,
      verifySession: async ({ sessionId }) =>
        sessionId === 'session-valid' ? { userId: 'user-1', role: 'user', sessionId } : null,
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'csrf-valid',
    });
    app.get('/api/test-read', async (request) => successEnvelope({ userId: getPrincipal(request)?.userId ?? null }));
    app.post('/api/test-mutate', async () => successEnvelope({ ok: true }));
    return app;
  }

  it('a route under /api/ with no config at all defaults to protected', async () => {
    const app = await buildGuardedApp(true);
    const denied = await app.inject({ method: 'GET', url: '/api/test-read' });
    expect(denied.statusCode).toBe(401);
    const served = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: sessionCookie('session-valid'),
    });
    expect(served.statusCode).toBe(200);
    await app.close();
  });

  it('requiresCsrf false still requires a session, then serves without CSRF or Origin', async () => {
    const app = await buildApp({
      config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
      pool: null,
      version: VERSION,
      verifySession: async ({ sessionId }) =>
        sessionId === 'session-valid' ? { userId: 'user-1', role: 'user', sessionId } : null,
      verifyCsrf: async () => false,
    });
    app.post('/api/test-nocsrf', { config: { requiresCsrf: false } }, async () => successEnvelope({ ok: true }));
    const denied = await app.inject({ method: 'POST', url: '/api/test-nocsrf' });
    expect(denied.statusCode).toBe(401);
    const served = await app.inject({
      method: 'POST',
      url: '/api/test-nocsrf',
      headers: sessionCookie('session-valid'),
    });
    expect(served.statusCode).toBe(200);
    await app.close();
  });

  it('an unmatched auth-like path answers 404, never 401', async () => {
    const app = await buildGuardedApp(true);
    const res = await app.inject({ method: 'GET', url: '/api/auth/unknown-thing' });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe('not_found');
    await app.close();
  });

  it('a wrong method on a protected route answers 405, never 401', async () => {
    const app = await buildGuardedApp(true);
    const res = await app.inject({ method: 'DELETE', url: '/api/test-read' });
    expect(res.statusCode).toBe(405);
    expect(errorOf(res).code).toBe('method_not_allowed');
    await app.close();
  });

  it('a session id in the query string is ignored: no cookie still means 401', async () => {
    const app = await buildGuardedApp(true);
    const res = await app.inject({ method: 'GET', url: '/api/test-read?session=session-valid' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('a CSRF token in the query string is ignored: a valid session without the header still yields 403', async () => {
    const app = await buildGuardedApp(true);
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate?x-csrf-token=csrf-valid',
      headers: { ...sessionCookie('session-valid'), origin: CANONICAL_ORIGIN },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('csrf_invalid');
    await app.close();
  });

  it('a session id under the wrong cookie name answers 401', async () => {
    const app = await buildGuardedApp(true);
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: { cookie: 'session=session-valid' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('paths are case-sensitive: an upper-case variant answers 404, never 401', async () => {
    const app = await buildGuardedApp(true);
    const res = await app.inject({ method: 'GET', url: '/API/test-read' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('a trailing-slash variant answers 404 with no redirect', async () => {
    const app = await buildGuardedApp(true);
    const res = await app.inject({ method: 'GET', url: '/api/test-read/' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['location']).toBeUndefined();
    await app.close();
  });

  it('a mutation fails closed when no canonical origin is configured', async () => {
    const app = await buildGuardedApp(false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { ...sessionCookie('session-valid'), origin: CANONICAL_ORIGIN, 'x-csrf-token': 'csrf-valid' },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    await app.close();
  });

  it('a mutation fails closed when no CSRF verifier is injected', async () => {
    const app = await buildApp({
      config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
      pool: null,
      version: VERSION,
      verifySession: async ({ sessionId }) =>
        sessionId === 'session-valid' ? { userId: 'user-1', role: 'user', sessionId } : null,
    });
    app.post('/api/test-mutate', async () => successEnvelope({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: { ...sessionCookie('session-valid'), origin: CANONICAL_ORIGIN, 'x-csrf-token': 'csrf-valid' },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('csrf_invalid');
    await app.close();
  });
});

describe('denial envelope, request id, and leak checks [real hook]', () => {
  async function buildDenialApp(): Promise<FastifyInstance> {
    const app = await buildApp({
      config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN }),
      pool: null,
      version: VERSION,
      verifySession: async ({ sessionId }) =>
        sessionId === 'session-valid' ? { userId: 'user-1', role: 'user', sessionId } : null,
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'csrf-valid',
    });
    app.get('/api/test-read', async () => successEnvelope({ ok: true }));
    app.post('/api/test-mutate', async () => successEnvelope({ ok: true }));
    return app;
  }

  it('every denial carries the full error envelope with retryable false', async () => {
    const app = await buildDenialApp();
    const cases: Array<{ res: InjectResponse; status: number; code: string }> = [
      { res: await app.inject({ method: 'GET', url: '/api/test-read' }), status: 401, code: 'unauthenticated' },
      { res: await app.inject({ method: 'POST', url: '/api/test-mutate' }), status: 401, code: 'unauthenticated' },
      {
        res: await app.inject({
          method: 'POST',
          url: '/api/test-mutate',
          headers: { ...sessionCookie('session-valid'), 'x-csrf-token': 'csrf-valid' },
        }),
        status: 403,
        code: 'origin_rejected',
      },
      {
        res: await app.inject({
          method: 'POST',
          url: '/api/test-mutate',
          headers: { ...sessionCookie('session-valid'), origin: CANONICAL_ORIGIN },
        }),
        status: 403,
        code: 'csrf_invalid',
      },
    ];
    for (const entry of cases) {
      expect(entry.res.statusCode).toBe(entry.status);
      const body = entry.res.json() as ErrorEnvelopeBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe(entry.code);
      expect(body.error.message.length).toBeGreaterThan(0);
      expect(typeof body.error.requestId).toBe('string');
      expect(body.error.requestId.length).toBeGreaterThan(0);
      expect(body.error.retryable).toBe(false);
      expect(body.error.details).toEqual({});
    }
    await app.close();
  });

  it('a well-formed client request id is echoed in the header and the denial envelope', async () => {
    const app = await buildDenialApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: { 'x-request-id': 'client-req-f157-1' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-request-id']).toBe('client-req-f157-1');
    expect(errorOf(res).requestId).toBe('client-req-f157-1');
    await app.close();
  });

  it('a malformed client request id is replaced by a generated id shared by header and envelope', async () => {
    const app = await buildDenialApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-read',
      headers: { 'x-request-id': 'bad id\nwith newline' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(errorOf(res).requestId).toBe(res.headers['x-request-id']);
    await app.close();
  });

  it('an Origin denial with a valid session never echoes the Origin, token, or body values', async () => {
    const app = await buildDenialApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-mutate',
      headers: {
        ...sessionCookie('session-valid'),
        origin: 'https://marker-origin-f157.invalid',
        'x-csrf-token': 'marker-csrf-f157',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ password: 'marker-body-f157' }),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('origin_rejected');
    expect(res.body).not.toContain('marker-origin-f157');
    expect(res.body).not.toContain('marker-csrf-f157');
    expect(res.body).not.toContain('marker-body-f157');
    expect(res.body).not.toContain('session-valid');
    await app.close();
  });
});
