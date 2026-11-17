// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Worker check contract tests (wave 3A, V3-39c).
//
// The worker check stays honestly skipped in the MVP: no worker is
// deployed and no heartbeat table exists in the M1-M7 schema, so there
// is no heartbeat source to read. These tests lock the skipped value,
// its independence from database state, the unchanged readiness
// blocking rule, and the wire shape over HTTP (ready and alias) plus
// the emergency envelope. They do not claim a real worker check; the
// promotion contract (heartbeat table, 300000 ms stale threshold,
// WORKER_STALE / WORKER_NO_HEARTBEAT) belongs to wave 5 / T16.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { readMigrationManifest } from '../src/db/migrate.js';
import type { HealthDbPool } from '../src/db/pool.js';
import { checkWorker, runReadyChecks } from '../src/health/checks.js';
import { buildEmergencyEnvelope } from '../src/routes/health.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeBehavior {
  connectError?: unknown;
  queryError?: unknown;
  queryDelayMs?: number;
  select1Rows?: Array<Record<string, unknown>>;
  pgvectorRows?: Array<Record<string, unknown>>;
  // Journal rows for the wired migrations check. When omitted the
  // fake reports zero applied migrations, so a wired ready probe
  // fails with drift; healthy HTTP tests pass the real manifest
  // hashes through currentMigrationRows().
  migrationRows?: Array<Record<string, unknown>>;
  onConnect?: () => void;
}

// Applied journal rows matching the on-disk manifest: the fake
// database state in which the wired migrations check reports
// migrations_current.
async function currentMigrationRows(): Promise<Array<Record<string, unknown>>> {
  const manifest = await readMigrationManifest();
  return manifest.entries.map((entry) => ({ hash: entry.hash }));
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
          if (text.includes('__drizzle_migrations')) {
            return { rows: behavior.migrationRows ?? [] };
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

const WORKER_SKIPPED = {
  status: 'skipped',
  latencyMs: null,
  detail: 'no_worker_in_fase_0',
  error: null,
} as const;

describe('worker check contract', () => {
  it('returns the exact locked skipped value', () => {
    const result = checkWorker();
    expect(result).toEqual(WORKER_SKIPPED);
    expect(result.status).toBe('skipped');
    expect(result.detail).toBe('no_worker_in_fase_0');
    expect(result.error).toBeNull();
    expect(result.latencyMs).toBeNull();
    expect(Object.keys(result).sort()).toEqual(['detail', 'error', 'latencyMs', 'status']);
  });

  it('is synchronous and deterministic', () => {
    const first = checkWorker();
    const second = checkWorker();
    expect(first).toEqual(second);
    expect(first).not.toBeInstanceOf(Promise);
  });
});

describe('worker check inside runReadyChecks', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'v3-39c-worker-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stays skipped when healthy, with the fixed check order', async () => {
    const pool = makeFakePool();
    const { checks, ok } = await runReadyChecks({
      pool,
      workspaceRoot: dir,
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
    });
    expect(ok).toBe(true);
    expect(checks.worker).toEqual(WORKER_SKIPPED);
    expect(Object.keys(checks)).toEqual(['db', 'workspace', 'migrations', 'pgvector', 'worker']);
  });

  it('stays skipped when the database is down, unlike the dependent checks', async () => {
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
    expect(checks.worker).toEqual(WORKER_SKIPPED);
  });

  it('stays skipped when no database pool is configured', async () => {
    const { checks, ok } = await runReadyChecks({
      pool: null,
      workspaceRoot: dir,
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
    });
    expect(ok).toBe(false);
    expect(checks.db.error).toBe('DB_NOT_CONFIGURED');
    expect(checks.worker).toEqual(WORKER_SKIPPED);
  });

  it('stays skipped when the workspace is missing', async () => {
    const pool = makeFakePool();
    const { checks, ok } = await runReadyChecks({
      pool,
      workspaceRoot: join(dir, 'gone'),
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
    });
    expect(ok).toBe(false);
    expect(checks.workspace.error).toBe('WORKSPACE_MISSING');
    expect(checks.worker).toEqual(WORKER_SKIPPED);
  });

  it('does not block readiness when pgvector is missing', async () => {
    const pool = makeFakePool({ pgvectorRows: [] });
    const { checks, ok } = await runReadyChecks({
      pool,
      workspaceRoot: dir,
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
    });
    expect(ok).toBe(true);
    expect(checks.pgvector.status).toBe('fail');
    expect(checks.pgvector.error).toBe('PGVECTOR_MISSING');
    expect(checks.worker).toEqual(WORKER_SKIPPED);
  });

  it('performs no database round trip', async () => {
    const pool = makeFakePool();
    await runReadyChecks({ pool, workspaceRoot: dir, checkTimeoutMs: 2000, overallTimeoutMs: 5000 });
    // Exactly two connects: one for the db check, one for pgvector.
    // Migrations and worker add none.
    expect(pool.connectCalls()).toBe(2);
  });
});

describe('worker check over HTTP', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'v3-39c-worker-http-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('answers readiness 200 with the skipped worker value when healthy', async () => {
    const pool = makeFakePool({ migrationRows: await currentMigrationRows() });
    const app = await buildApp({ config: testConfig({ workspaceRoot: dir }), pool, version: '0.39.2-fork.1' });
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['status']).toBe('ready');
    expect(Object.keys(body)).toEqual(['ok', 'status', 'service', 'version', 'uptimeSeconds', 'timestamp', 'checks']);
    const checks = body['checks'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(checks)).toEqual(['db', 'workspace', 'migrations', 'pgvector', 'worker']);
    expect(checks['worker']).toEqual(WORKER_SKIPPED);
    await app.close();
  });

  it('answers readiness 503 with the same skipped worker value when the database is down', async () => {
    const pool = makeFakePool({ connectError: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    const app = await buildApp({ config: testConfig({ workspaceRoot: dir }), pool, version: '0.39.2-fork.1' });
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(false);
    expect(body['status']).toBe('not_ready');
    const checks = body['checks'] as Record<string, Record<string, unknown>>;
    expect(checks['worker']).toEqual(WORKER_SKIPPED);
    await app.close();
  });

  it('reports the same worker value on the ready alias', async () => {
    const pool = makeFakePool({ migrationRows: await currentMigrationRows() });
    const app = await buildApp({ config: testConfig({ workspaceRoot: dir }), pool, version: '0.39.2-fork.1' });
    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' });
    const alias = await app.inject({ method: 'GET', url: '/api/health' });
    expect(alias.statusCode).toBe(ready.statusCode);
    const readyChecks = (ready.json() as Record<string, Record<string, unknown>>)['checks'] as Record<string, unknown>;
    const aliasChecks = (alias.json() as Record<string, Record<string, unknown>>)['checks'] as Record<string, unknown>;
    expect(aliasChecks['worker']).toEqual(readyChecks['worker']);
    expect(aliasChecks['worker']).toEqual(WORKER_SKIPPED);
    await app.close();
  });

  it('keeps the skipped worker value in the emergency envelope', () => {
    const envelope = buildEmergencyEnvelope('0.39.2-fork.1');
    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe('not_ready');
    expect(envelope.checks['worker']).toEqual(WORKER_SKIPPED);
    for (const name of ['db', 'workspace', 'migrations', 'pgvector']) {
      expect(envelope.checks[name]?.status).toBe('fail');
      expect(envelope.checks[name]?.error).toBe('HEALTH_HANDLER_ERROR');
    }
  });
});
