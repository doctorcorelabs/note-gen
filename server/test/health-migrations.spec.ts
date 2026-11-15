// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the real migrations check (V3-15, wave 3B). The check
// compares the applied journal digests against the expected manifest
// with assessMigrationDrift, fails with MIGRATION_DRIFT on any
// difference, and fails closed with DB_UNAVAILABLE when the database
// cannot be reached. The drift detail names the direction only
// (migrations_missing, migrations_unexpected, migration_drift); the
// tags and digests themselves never enter the result.
//
// File name note: the root .gitignore ignores "*.test.*", which would
// silently drop a file named health-migrations.test.ts from git. This
// file uses the .spec.ts suffix instead, which Vitest also picks up
// by default.
//
// Live section: runs only when MIGRATIONS_PG_TEST_URL names a
// dedicated scratch database (for example v3b_15a_migrations on the
// shared Fase 1 cluster); skipped otherwise so the default suite
// stays database-free. Prepare the database outside the suite, with
// separate psql DROP/CREATE commands followed by the migration gate
// runner (fase1/scripts/m8gate-runner.mjs with MIGRATE_DIST pointing
// at this clone's built server dist, command "migrate"). The live
// section never migrates, drops, or creates anything itself, and the
// drift case uses an injected manifest with one extra entry, so the
// scratch database is left untouched.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assessMigrationDrift,
  readMigrationManifest,
  type MigrationManifest,
} from '../src/db/migrate.js';
import { closePool, createPool, type HealthDbPool } from '../src/db/pool.js';
import {
  checkDb,
  checkMigrations,
  checkWorker,
  runReadyChecks,
} from '../src/health/checks.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_UNEXPECTED = 'c'.repeat(64);

const FIXTURE_MANIFEST: MigrationManifest = {
  folder: '/nonexistent/migrations',
  entries: [
    { idx: 0, tag: '0000_alpha', hash: HASH_A },
    { idx: 1, tag: '0001_beta', hash: HASH_B },
  ],
};

interface FakeBehavior {
  connectError?: unknown;
  queryError?: unknown;
  migrationRows?: Array<Record<string, unknown>>;
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
          if (behavior.queryError !== undefined) {
            throw behavior.queryError;
          }
          if (text.includes('__drizzle_migrations')) {
            return { rows: behavior.migrationRows ?? [{ hash: HASH_A }, { hash: HASH_B }] };
          }
          if (text.includes('pg_extension')) {
            return { rows: behavior.pgvectorRows ?? [{ present: 1 }] };
          }
          return { rows: [{ ok: 1 }] };
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

describe('checkMigrations with a fake pool', () => {
  it('reports ok when the applied digests match the manifest', async () => {
    const pool = makeFakePool();
    const result = await checkMigrations(true, { pool, timeoutMs: 2000, manifest: FIXTURE_MANIFEST });
    expect(result).toEqual({ status: 'ok', latencyMs: expect.any(Number), detail: 'migrations_current', error: null });
    expect(pool.connectCalls()).toBe(1);
  });

  it('reports missing drift when an expected tag has no applied digest', async () => {
    const pool = makeFakePool({ migrationRows: [{ hash: HASH_A }] });
    const result = await checkMigrations(true, { pool, timeoutMs: 2000, manifest: FIXTURE_MANIFEST });
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('migrations_missing');
    expect(result.error).toBe('MIGRATION_DRIFT');
  });

  it('reports unexpected drift when a stored digest matches no expected file', async () => {
    const pool = makeFakePool({ migrationRows: [{ hash: HASH_A }, { hash: HASH_B }, { hash: HASH_UNEXPECTED }] });
    const result = await checkMigrations(true, { pool, timeoutMs: 2000, manifest: FIXTURE_MANIFEST });
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('migrations_unexpected');
    expect(result.error).toBe('MIGRATION_DRIFT');
  });

  it('reports combined drift when both directions differ at once', async () => {
    const pool = makeFakePool({ migrationRows: [{ hash: HASH_A }, { hash: HASH_UNEXPECTED }] });
    const result = await checkMigrations(true, { pool, timeoutMs: 2000, manifest: FIXTURE_MANIFEST });
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('migration_drift');
    expect(result.error).toBe('MIGRATION_DRIFT');
  });

  it('never puts tags or digests into the result', async () => {
    const pool = makeFakePool({ migrationRows: [{ hash: HASH_A }] });
    const result = await checkMigrations(true, { pool, timeoutMs: 2000, manifest: FIXTURE_MANIFEST });
    const body = JSON.stringify(result);
    expect(body).not.toContain('0000_alpha');
    expect(body).not.toContain('0001_beta');
    expect(body).not.toContain(HASH_A);
    expect(body).not.toContain(HASH_B);
  });

  it('fails closed with DB_UNAVAILABLE when the database is down, without touching the runner', async () => {
    let runnerCalls = 0;
    const pool = makeFakePool();
    const result = await checkMigrations(true, {
      pool,
      timeoutMs: 2000,
      manifest: FIXTURE_MANIFEST,
    });
    expect(result.status).toBe('ok');
    const dead = await checkMigrations(false, {
      pool,
      timeoutMs: 2000,
      manifest: FIXTURE_MANIFEST,
      readAppliedHashes: async () => {
        runnerCalls += 1;
        return [HASH_A, HASH_B];
      },
    });
    expect(dead).toEqual({ status: 'fail', latencyMs: null, detail: 'db_unavailable', error: 'DB_UNAVAILABLE' });
    expect(runnerCalls).toBe(0);
    expect(pool.connectCalls()).toBe(1);
  });

  it('fails closed with DB_UNAVAILABLE when the pool is null', async () => {
    const result = await checkMigrations(true, { pool: null, timeoutMs: 2000, manifest: FIXTURE_MANIFEST });
    expect(result).toEqual({ status: 'fail', latencyMs: null, detail: 'db_unavailable', error: 'DB_UNAVAILABLE' });
  });

  it('reports skipped honestly when no deps are passed (wiring pending)', async () => {
    const result = await checkMigrations(true);
    expect(result).toEqual({ status: 'skipped', latencyMs: null, detail: 'check_not_configured', error: null });
  });

  it('treats a missing journal table as zero applied, never skipped', async () => {
    const pool = makeFakePool({ queryError: Object.assign(new Error('missing table'), { code: '42P01' }) });
    const result = await checkMigrations(true, { pool, timeoutMs: 2000, manifest: FIXTURE_MANIFEST });
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('migrations_missing');
    expect(result.error).toBe('MIGRATION_DRIFT');
  });

  it('treats a missing journal schema as zero applied, never skipped', async () => {
    const pool = makeFakePool({ queryError: Object.assign(new Error('missing schema'), { code: '3F000' }) });
    const result = await checkMigrations(true, { pool, timeoutMs: 2000, manifest: FIXTURE_MANIFEST });
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('migrations_missing');
    expect(result.error).toBe('MIGRATION_DRIFT');
  });

  it('fails with a fixed code on any other query error and never throws', async () => {
    const pool = makeFakePool({ queryError: Object.assign(new Error('boom'), { code: 'XX000' }) });
    const result = await checkMigrations(true, { pool, timeoutMs: 2000, manifest: FIXTURE_MANIFEST });
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('check_failed');
    expect(result.error).toBe('MIGRATION_CHECK_FAILED');
  });

  it('fails with a timeout code when the runner never resolves', async () => {
    const pool = makeFakePool();
    const result = await checkMigrations(true, {
      pool,
      timeoutMs: 50,
      manifest: FIXTURE_MANIFEST,
      readAppliedHashes: () => new Promise<string[]>(() => {
        // Never resolves: the timeout must win.
      }),
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('check_timed_out');
    expect(result.error).toBe('MIGRATION_CHECK_TIMEOUT');
    expect(pool.connectCalls()).toBe(0);
  });

  it('fails with a fixed code when the manifest cannot be read', async () => {
    const pool = makeFakePool();
    const result = await checkMigrations(true, {
      pool,
      timeoutMs: 2000,
      readManifest: async () => {
        throw new Error('journal gone');
      },
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('manifest_unavailable');
    expect(result.error).toBe('MIGRATION_MANIFEST_UNAVAILABLE');
    expect(pool.connectCalls()).toBe(0);
  });

  it('uses the injected runner without opening a pool connection', async () => {
    const pool = makeFakePool({ migrationRows: [] });
    const result = await checkMigrations(true, {
      pool,
      timeoutMs: 2000,
      manifest: FIXTURE_MANIFEST,
      readAppliedHashes: async () => [HASH_A, HASH_B],
    });
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('migrations_current');
    expect(pool.connectCalls()).toBe(0);
  });

  it('uses the injected manifest reader instead of the disk manifest', async () => {
    const pool = makeFakePool({ migrationRows: [{ hash: HASH_A }] });
    const result = await checkMigrations(true, {
      pool,
      timeoutMs: 2000,
      readManifest: async () => ({
        folder: '/nonexistent/migrations',
        entries: [{ idx: 0, tag: '0000_alpha', hash: HASH_A }],
      }),
    });
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('migrations_current');
  });
});

describe('real manifest and drift comparison', () => {
  it('reads the five journal entries M1-M8 from disk with SHA-256 digests', async () => {
    const manifest = await readMigrationManifest();
    expect(manifest.entries.map((entry) => entry.tag)).toEqual([
      '0000_initial-schema-m1-m7',
      '0001_m8-expand',
      '0002_m8-tighten',
      '0003_m8-contract-columns',
      '0004_m8-contract-tables',
    ]);
    for (const entry of manifest.entries) {
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('assessMigrationDrift names missing tags and unexpected hashes in both directions', () => {
    const manifest: MigrationManifest = {
      folder: '/nonexistent/migrations',
      entries: [
        { idx: 0, tag: '0000_alpha', hash: HASH_A },
        { idx: 1, tag: '0001_beta', hash: HASH_B },
      ],
    };
    expect(assessMigrationDrift(manifest, [HASH_A, HASH_B]).current).toBe(true);
    const missing = assessMigrationDrift(manifest, [HASH_A]);
    expect(missing.current).toBe(false);
    expect(missing.missingTags).toEqual(['0001_beta']);
    expect(missing.unexpectedHashes).toEqual([]);
    const unexpected = assessMigrationDrift(manifest, [HASH_A, HASH_B, HASH_UNEXPECTED]);
    expect(unexpected.current).toBe(false);
    expect(unexpected.missingTags).toEqual([]);
    expect(unexpected.unexpectedHashes).toEqual([HASH_UNEXPECTED]);
  });
});

describe('readiness composition with the real migrations check', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'w15-health-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stays ready when migrations are current and keeps the worker skipped', async () => {
    const pool = makeFakePool();
    const { checks, ok } = await runReadyChecks({
      pool,
      workspaceRoot: dir,
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
      migrationCheck: { pool, timeoutMs: 2000, manifest: FIXTURE_MANIFEST },
    });
    expect(ok).toBe(true);
    expect(checks.migrations.status).toBe('ok');
    expect(checks.migrations.detail).toBe('migrations_current');
    expect(checks.worker).toEqual({ status: 'skipped', latencyMs: null, detail: 'no_worker_in_fase_0', error: null });
    expect(Object.keys(checks)).toEqual(['db', 'workspace', 'migrations', 'pgvector', 'worker']);
  });

  it('blocks readiness on drift while db and workspace pass', async () => {
    const pool = makeFakePool({ migrationRows: [{ hash: HASH_A }] });
    const { checks, ok } = await runReadyChecks({
      pool,
      workspaceRoot: dir,
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
      migrationCheck: { pool, timeoutMs: 2000, manifest: FIXTURE_MANIFEST },
    });
    expect(ok).toBe(false);
    expect(checks.db.status).toBe('ok');
    expect(checks.workspace.status).toBe('ok');
    expect(checks.migrations.status).toBe('fail');
    expect(checks.migrations.error).toBe('MIGRATION_DRIFT');
    expect(checks.worker.status).toBe('skipped');
  });

  it('does not block readiness when the migrations check is not wired', async () => {
    const pool = makeFakePool();
    const { checks, ok } = await runReadyChecks({
      pool,
      workspaceRoot: dir,
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
    });
    expect(ok).toBe(true);
    expect(checks.migrations.status).toBe('skipped');
    expect(checks.migrations.detail).toBe('check_not_configured');
  });

  it('keeps the locked checkWorker value (V3-39c contract)', () => {
    expect(checkWorker()).toEqual({ status: 'skipped', latencyMs: null, detail: 'no_worker_in_fase_0', error: null });
  });
});

const LIVE_PG_URL = process.env['MIGRATIONS_PG_TEST_URL'];
const describePg = LIVE_PG_URL === undefined ? describe.skip : describe;

describePg('migrations check over live Postgres 17', () => {
  let pool: HealthDbPool;
  let dir: string;

  beforeAll(async () => {
    if (LIVE_PG_URL === undefined) {
      throw new Error('MIGRATIONS_PG_TEST_URL is required for the live section');
    }
    pool = createPool(LIVE_PG_URL, 2000) as HealthDbPool;
    dir = await mkdtemp(join(tmpdir(), 'w15-health-live-'));
  });

  afterAll(async () => {
    await closePool(pool);
    await rm(dir, { recursive: true, force: true });
  });

  it('reports ok on the migrated scratch database with the default disk manifest', async () => {
    const result = await checkMigrations(true, { pool, timeoutMs: 2000 });
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('migrations_current');
    expect(result.error).toBeNull();
    expect(result.latencyMs).not.toBeNull();
    const body = JSON.stringify(result);
    expect(body).not.toContain('127.0.0.1');
    expect(body).not.toContain('55433');
  });

  it('reports missing drift against the live journal when the manifest names one more migration', async () => {
    const manifest = await readMigrationManifest();
    const extended: MigrationManifest = {
      folder: manifest.folder,
      entries: [...manifest.entries, { idx: 99, tag: '9999_not_applied', hash: HASH_UNEXPECTED }],
    };
    const result = await checkMigrations(true, { pool, timeoutMs: 2000, manifest: extended });
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('migrations_missing');
    expect(result.error).toBe('MIGRATION_DRIFT');
  });

  it('passes readiness on the live database and keeps the worker skipped', async () => {
    const { checks, ok } = await runReadyChecks({
      pool,
      workspaceRoot: dir,
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
      migrationCheck: { pool, timeoutMs: 2000 },
    });
    expect(ok).toBe(true);
    expect(checks.migrations.status).toBe('ok');
    expect(checks.worker.status).toBe('skipped');
  });

  it('fails closed when the database is unreachable, with no host or credential material in the result', async () => {
    const deadPool = createPool('postgresql://postgres@127.0.0.1:1/nonexistent', 500);
    try {
      const db = await checkDb(deadPool, 2000);
      expect(db.status).toBe('fail');
      const result = await checkMigrations(db.status === 'ok', {
        pool: deadPool,
        timeoutMs: 2000,
        manifest: FIXTURE_MANIFEST,
      });
      expect(result).toEqual({ status: 'fail', latencyMs: null, detail: 'db_unavailable', error: 'DB_UNAVAILABLE' });
      const body = JSON.stringify(result);
      expect(body).not.toContain('127.0.0.1');
      expect(body).not.toContain('postgres');
      expect(body).not.toContain('nonexistent');
    } finally {
      await closePool(deadPool);
    }
  });
});
