// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Regression tests for the Fase 0 health endpoints (desain-health-endpoint.md
// section 7.3). These tests do not replace the manual start/stop matrix
// T01-T16, which proves real process and database behavior; they guard the
// schema, the error mapping, the timeouts, the alias equivalence, and the
// failure semantics against regressions.
//
// File name note: the root .gitignore ignores "*.test.*", which would
// silently drop a file named health.test.ts from git. This file uses the
// .spec.ts suffix instead, which Vitest also picks up by default.
//
// Middleware contract (design 7.3 item 6, closed in Fase 1 by the
// backend foundation): auth-hook.spec.ts proves health passes without
// credentials while a protected data route rejects them, plus the
// health path exemption list. The test below only proves health
// answers without credentials today.

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import type { HealthDbPool } from '../src/db/pool.js';
import {
  checkDb,
  checkPgvector,
  checkWorkspace,
  runReadyChecks,
  type WorkspaceFs,
} from '../src/health/checks.js';
import { readServerVersion } from '../src/server.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeBehavior {
  connectError?: unknown;
  queryError?: unknown;
  queryDelayMs?: number;
  select1Rows?: Array<Record<string, unknown>>;
  pgvectorRows?: Array<Record<string, unknown>>;
  onConnect?: () => void;
}

function makeFakePool(behavior: FakeBehavior = {}): HealthDbPool & { connectCalls: () => number } {
  let calls = 0;
  return {
    connectCalls: () => calls,
    connect: async () => {
      calls += 1;
      behavior.onConnect?.();
      if (behavior.connectError !== undefined) {
        throw behavior.connectError;
      }
      return {
        query: async (text: string, _params?: unknown[]) => {
          if (behavior.queryDelayMs !== undefined && behavior.queryDelayMs > 0) {
            await sleep(behavior.queryDelayMs);
          }
          if (behavior.queryError !== undefined) {
            throw behavior.queryError;
          }
          if (text.includes('pg_extension')) {
            return { rows: behavior.pgvectorRows ?? [{ present: 1 }] };
          }
          return { rows: behavior.select1Rows ?? [{ ok: 1 }] };
        },
        release: (_err?: Error) => {
          // No-op for the fake.
        },
      };
    },
    end: async () => {
      // No-op for the fake.
    },
  };
}

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

function stripVolatile(body: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  delete copy['timestamp'];
  delete copy['uptimeSeconds'];
  const checks = copy['checks'] as Record<string, Record<string, unknown>>;
  for (const check of Object.values(checks)) {
    delete check['latencyMs'];
  }
  return copy;
}

describe('config', () => {
  it('rejects an invalid PORT at startup', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow();
    expect(() => loadConfig({ PORT: '0' })).toThrow();
    expect(() => loadConfig({ PORT: '70000' })).toThrow();
    expect(() => loadConfig({ PORT: '3001.5' })).toThrow();
  });

  it('defaults PORT, HOST, and timeouts', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3001);
    expect(config.host).toBe('127.0.0.1');
    expect(config.checkTimeoutMs).toBe(2000);
    expect(config.overallTimeoutMs).toBe(5000);
  });

  it('leaves DATABASE_URL and WORKSPACE_ROOT unset without silent defaults', () => {
    const config = loadConfig({});
    expect(config.databaseUrl).toBeUndefined();
    expect(config.workspaceRoot).toBeUndefined();
    expect(config.warnings.length).toBeGreaterThan(0);
  });

  it('falls back to the default when the overall timeout is not larger than the per-check timeout', () => {
    const config = loadConfig({ HEALTH_CHECK_TIMEOUT_MS: '4000', HEALTH_OVERALL_TIMEOUT_MS: '4000' });
    expect(config.overallTimeoutMs).toBe(5000);
  });

  it('rejects an invalid timeout value with a warning, not a crash', () => {
    const config = loadConfig({ HEALTH_CHECK_TIMEOUT_MS: 'soon' });
    expect(config.checkTimeoutMs).toBe(2000);
    expect(config.warnings.length).toBeGreaterThan(0);
  });
});

describe('version', () => {
  it('reads the version from server/package.json', () => {
    expect(readServerVersion()).toBe('0.39.2-fork.1');
  });
});

describe('db check error mapping', () => {
  it('maps connection refused to DB_UNREACHABLE', async () => {
    const pool = makeFakePool({ connectError: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const result = await checkDb(pool, 2000);
    expect(result.status).toBe('fail');
    expect(result.error).toBe('DB_UNREACHABLE');
    expect(result.detail).toBe('connection_failed');
  });

  it('maps sandbox connect refusal (EPERM) and network unreachable to DB_UNREACHABLE', async () => {
    const eperm = makeFakePool({ connectError: Object.assign(new Error('connect EPERM'), { code: 'EPERM' }) });
    expect((await checkDb(eperm, 2000)).error).toBe('DB_UNREACHABLE');
    const netUnreach = makeFakePool({ connectError: Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }) });
    const result = await checkDb(netUnreach, 2000);
    expect(result.error).toBe('DB_UNREACHABLE');
    expect(result.detail).toBe('connection_failed');
  });

  it('maps a wrong role to DB_AUTH_FAILED', async () => {
    const pool = makeFakePool({ connectError: Object.assign(new Error('role does not exist'), { code: '28P01' }) });
    const result = await checkDb(pool, 2000);
    expect(result.error).toBe('DB_AUTH_FAILED');
    expect(result.detail).toBe('authentication_failed');
  });

  it('maps a missing database to DB_NOT_FOUND', async () => {
    const pool = makeFakePool({ connectError: Object.assign(new Error('database does not exist'), { code: '3D000' }) });
    const result = await checkDb(pool, 2000);
    expect(result.error).toBe('DB_NOT_FOUND');
    expect(result.detail).toBe('database_not_found');
  });

  it('maps a missing DATABASE_URL to DB_NOT_CONFIGURED with null latency', async () => {
    const result = await checkDb(null, 2000);
    expect(result.status).toBe('fail');
    expect(result.error).toBe('DB_NOT_CONFIGURED');
    expect(result.detail).toBe('not_configured');
    expect(result.latencyMs).toBeNull();
  });

  it('maps a wrong query result to DB_QUERY_FAILED', async () => {
    const pool = makeFakePool({ select1Rows: [{ ok: 2 }] });
    const result = await checkDb(pool, 2000);
    expect(result.error).toBe('DB_QUERY_FAILED');
    expect(result.detail).toBe('unexpected_result');
  });

  it('times out a slow query with DB_TIMEOUT inside the bound', async () => {
    const pool = makeFakePool({ queryDelayMs: 5000 });
    const start = Date.now();
    const result = await checkDb(pool, 50);
    const elapsed = Date.now() - start;
    expect(result.error).toBe('DB_TIMEOUT');
    expect(result.detail).toBe('check_timed_out');
    expect(elapsed).toBeLessThan(2000);
  });

  it('never leaks a raw driver message into the result', async () => {
    const marker = 'MARKER_SECRET_9f27';
    const pool = makeFakePool({
      queryError: Object.assign(new Error(`password is ${marker}`), { code: 'XX000' }),
    });
    const result = await checkDb(pool, 2000);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(result.error).toBe('DB_QUERY_FAILED');
  });
});

describe('pgvector check', () => {
  it('reports DB_UNAVAILABLE when the database check failed', async () => {
    const pool = makeFakePool();
    const result = await checkPgvector(pool, false, 2000);
    expect(result.status).toBe('fail');
    expect(result.error).toBe('DB_UNAVAILABLE');
    expect(result.latencyMs).toBeNull();
    expect(pool.connectCalls()).toBe(0);
  });

  it('reports PGVECTOR_MISSING when the extension is absent', async () => {
    const pool = makeFakePool({ pgvectorRows: [] });
    const result = await checkPgvector(pool, true, 2000);
    expect(result.status).toBe('fail');
    expect(result.error).toBe('PGVECTOR_MISSING');
    expect(result.detail).toBe('extension_missing');
  });

  it('reports ok when the extension is present', async () => {
    const pool = makeFakePool({ pgvectorRows: [{ present: 1 }] });
    const result = await checkPgvector(pool, true, 2000);
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('extension_present');
    expect(result.error).toBeNull();
  });
});

describe('workspace check with mocked filesystem', () => {
  const baseFs = (overrides: Partial<WorkspaceFs> = {}): WorkspaceFs => ({
    stat: async () => ({ isDirectory: () => true }),
    access: async () => {},
    opendir: async () => ({ close: async () => {} }),
    open: async () => ({ writeFile: async () => {}, close: async () => {} }),
    unlink: async () => {},
    R_OK: 4,
    ...overrides,
  });

  it('reports WORKSPACE_MISSING for a missing directory', async () => {
    const fs = baseFs({ stat: async () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); } });
    const result = await checkWorkspace('/tmp/does-not-exist-w13', 2000, fs);
    expect(result.error).toBe('WORKSPACE_MISSING');
    expect(result.detail).toBe('directory_missing');
  });

  it('reports WORKSPACE_NOT_DIRECTORY for a regular file', async () => {
    const fs = baseFs({ stat: async () => ({ isDirectory: () => false }) });
    const result = await checkWorkspace('/tmp/some-file', 2000, fs);
    expect(result.error).toBe('WORKSPACE_NOT_DIRECTORY');
  });

  it('reports WORKSPACE_NOT_READABLE when opening the directory fails', async () => {
    const fs = baseFs({ opendir: async () => { throw new Error('permission denied'); } });
    const result = await checkWorkspace('/tmp/unreadable', 2000, fs);
    expect(result.error).toBe('WORKSPACE_NOT_READABLE');
  });

  it('reports WORKSPACE_NOT_WRITABLE when the write probe fails', async () => {
    const fs = baseFs({ open: async () => { throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }); } });
    const result = await checkWorkspace('/tmp/readonly', 2000, fs);
    expect(result.error).toBe('WORKSPACE_NOT_WRITABLE');
    expect(result.detail).toBe('write_probe_failed');
  });

  it('reports WORKSPACE_CLEANUP_FAILED when the probe file cannot be removed', async () => {
    const fs = baseFs({ unlink: async () => { throw new Error('cannot remove'); } });
    const result = await checkWorkspace('/tmp/nocleanup', 2000, fs);
    expect(result.error).toBe('WORKSPACE_CLEANUP_FAILED');
  });

  it('reports WORKSPACE_NOT_CONFIGURED when the variable is missing', async () => {
    const result = await checkWorkspace(undefined, 2000, baseFs());
    expect(result.error).toBe('WORKSPACE_NOT_CONFIGURED');
    expect(result.latencyMs).toBeNull();
  });

  it('reports WORKSPACE_INVALID_PATH for a relative path and for root', async () => {
    expect((await checkWorkspace('relative/path', 2000, baseFs())).error).toBe('WORKSPACE_INVALID_PATH');
    expect((await checkWorkspace('/', 2000, baseFs())).error).toBe('WORKSPACE_INVALID_PATH');
  });

  it('passes a healthy directory and removes the probe file', async () => {
    let unlinked = 0;
    const fs = baseFs({ unlink: async () => { unlinked += 1; } });
    const result = await checkWorkspace('/tmp/healthy', 2000, fs);
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('readable_and_writable');
    expect(unlinked).toBe(1);
  });
});

describe('ready composition', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'w13-health-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is ok when db and workspace pass, even with pgvector missing (Fase 0)', async () => {
    const pool = makeFakePool({ pgvectorRows: [] });
    const { checks, ok } = await runReadyChecks({
      pool,
      workspaceRoot: dir,
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
    });
    expect(ok).toBe(true);
    expect(checks.db.status).toBe('ok');
    expect(checks.workspace.status).toBe('ok');
    expect(checks.migrations.status).toBe('skipped');
    expect(checks.pgvector.status).toBe('fail');
    expect(checks.pgvector.error).toBe('PGVECTOR_MISSING');
    expect(checks.worker.status).toBe('skipped');
    expect(Object.keys(checks)).toEqual(['db', 'workspace', 'migrations', 'pgvector', 'worker']);
  });

  it('is not ok when the database is down, with dependent checks DB_UNAVAILABLE', async () => {
    const pool = makeFakePool({ connectError: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    const { checks, ok } = await runReadyChecks({
      pool,
      workspaceRoot: dir,
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
    });
    expect(ok).toBe(false);
    expect(checks.db.error).toBe('DB_UNREACHABLE');
    expect(checks.migrations.error).toBe('DB_UNAVAILABLE');
    expect(checks.pgvector.error).toBe('DB_UNAVAILABLE');
    expect(checks.workspace.status).toBe('ok');
    expect(checks.worker.status).toBe('skipped');
  });

  it('leaves no probe file behind in a real directory', async () => {
    const pool = makeFakePool();
    await runReadyChecks({ pool, workspaceRoot: dir, checkTimeoutMs: 2000, overallTimeoutMs: 5000 });
    await runReadyChecks({ pool, workspaceRoot: dir, checkTimeoutMs: 2000, overallTimeoutMs: 5000 });
    expect(await readdir(dir)).toEqual([]);
  });

  it('reports WORKSPACE_MISSING against a real missing directory', async () => {
    const pool = makeFakePool();
    const missing = join(dir, 'gone');
    const { checks, ok } = await runReadyChecks({
      pool,
      workspaceRoot: missing,
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
    });
    expect(ok).toBe(false);
    expect(checks.workspace.error).toBe('WORKSPACE_MISSING');
    expect(checks.db.status).toBe('ok');
  });

  it('reports WORKSPACE_NOT_DIRECTORY against a real regular file', async () => {
    const pool = makeFakePool();
    const file = join(dir, 'file.txt');
    await writeFile(file, 'x');
    const { checks, ok } = await runReadyChecks({
      pool,
      workspaceRoot: file,
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
    });
    expect(ok).toBe(false);
    expect(checks.workspace.error).toBe('WORKSPACE_NOT_DIRECTORY');
  });
});

describe('http routes', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'w13-health-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('answers liveness 200 with only the process check and no-store, without touching the database', async () => {
    let touched = false;
    const pool = makeFakePool({ onConnect: () => { touched = true; } });
    const app = await buildApp({ config: testConfig({ workspaceRoot: dir }), pool, version: '0.39.2-fork.1' });
    const res = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(String(res.headers['content-type'])).toContain('application/json');
    const body = res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['status']).toBe('live');
    expect(body['service']).toBe('note-gen-web-api');
    expect(body['version']).toBe('0.39.2-fork.1');
    expect(typeof body['uptimeSeconds']).toBe('number');
    expect(Object.keys(body['checks'] as object)).toEqual(['process']);
    expect(touched).toBe(false);
    await app.close();
  });

  it('answers liveness 200 even when the database pool throws and config is missing', async () => {
    const pool = makeFakePool({ connectError: new Error('boom') });
    const app = await buildApp({
      config: testConfig({ databaseUrl: undefined, workspaceRoot: undefined }),
      pool,
      version: '0.39.2-fork.1',
    });
    const res = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>)['ok']).toBe(true);
    await app.close();
  });

  it('answers readiness 200 with the fixed envelope when healthy', async () => {
    const pool = makeFakePool();
    const app = await buildApp({ config: testConfig({ workspaceRoot: dir }), pool, version: '0.39.2-fork.1' });
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['status']).toBe('ready');
    expect(Object.keys(body)).toEqual(['ok', 'status', 'service', 'version', 'uptimeSeconds', 'timestamp', 'checks']);
    const checks = body['checks'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(checks)).toEqual(['db', 'workspace', 'migrations', 'pgvector', 'worker']);
    for (const check of Object.values(checks)) {
      expect(Object.keys(check).sort()).toEqual(['detail', 'error', 'latencyMs', 'status']);
    }
    await app.close();
  });

  it('answers readiness 503 with ok false when the database is down, never 200 with ok false', async () => {
    const pool = makeFakePool({ connectError: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    const app = await buildApp({ config: testConfig({ workspaceRoot: dir }), pool, version: '0.39.2-fork.1' });
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(false);
    expect(body['status']).toBe('not_ready');
    await app.close();
  });

  it('serves the alias with the same body as ready, healthy and unhealthy', async () => {
    const healthy = makeFakePool();
    const app = await buildApp({ config: testConfig({ workspaceRoot: dir }), pool: healthy, version: '0.39.2-fork.1' });
    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' });
    const alias = await app.inject({ method: 'GET', url: '/api/health' });
    expect(alias.statusCode).toBe(ready.statusCode);
    expect(stripVolatile(alias.json() as Record<string, unknown>)).toEqual(stripVolatile(ready.json() as Record<string, unknown>));
    await app.close();

    const down = makeFakePool({ connectError: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    const app2 = await buildApp({ config: testConfig({ workspaceRoot: dir }), pool: down, version: '0.39.2-fork.1' });
    const ready2 = await app2.inject({ method: 'GET', url: '/api/health/ready' });
    const alias2 = await app2.inject({ method: 'GET', url: '/api/health' });
    expect(ready2.statusCode).toBe(503);
    expect(alias2.statusCode).toBe(ready2.statusCode);
    expect(stripVolatile(alias2.json() as Record<string, unknown>)).toEqual(stripVolatile(ready2.json() as Record<string, unknown>));
    await app2.close();
  });

  it('answers unknown health paths and wrong methods without ok true', async () => {
    const pool = makeFakePool();
    const app = await buildApp({ config: testConfig({ workspaceRoot: dir }), pool, version: '0.39.2-fork.1' });
    for (const target of [
      { method: 'GET', url: '/api/health/unknown' },
      { method: 'POST', url: '/api/health/ready' },
      { method: 'GET', url: '/health/ready' },
      { method: 'GET', url: '/health' },
    ] as const) {
      const res = await app.inject(target);
      expect([404, 405]).toContain(res.statusCode);
      expect(JSON.stringify(res.json())).not.toContain('"ok":true');
    }
    await app.close();
  });

  it('answers health without credentials and leaks no credential fragment', async () => {
    const marker = 'MARKER_SECRET_9f27';
    const pool = makeFakePool({
      queryError: Object.assign(new Error(`FATAL: password authentication failed, password=${marker}`), { code: '28P01' }),
    });
    const app = await buildApp({ config: testConfig({ workspaceRoot: dir }), pool, version: '0.39.2-fork.1' });
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain(marker);
    expect(res.body).not.toContain('password');
    const body = res.json() as Record<string, unknown>;
    const checks = body['checks'] as Record<string, Record<string, unknown>>;
    expect(checks['db']?.['error']).toBe('DB_AUTH_FAILED');
    await app.close();
  });
});
