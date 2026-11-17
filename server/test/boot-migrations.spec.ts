// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the startup migration wiring (AD-104, SMK-F1). server.ts
// must apply pending migrations in-process before the SETUP_TOKEN
// prerequisite check and before listen, must refuse start on drift
// when MIGRATE_ON_START is 'false' without writing the schema, must
// skip migration entirely when DATABASE_URL is unset, and must
// fail-fast with a log line that distinguishes an unreachable
// database from a failed migration. These tests pin the decision
// table of runStartupMigrationStep with injected runners; they run
// no database. Live-database proof (fresh-DB 5/5 journal,
// idempotence, lock contention) belongs to the merge gate.

import { describe, expect, it, vi } from 'vitest';
import { isMigrateOnStartEnabled, runStartupMigrationStep, type StartupMigrationRunners } from '../src/server.js';
import type {
  CheckDriftOptions,
  CheckDriftResult,
  DriftResult,
  MigrationManifest,
  RunMigrationsOptions,
  RunMigrationsResult,
} from '../src/db/migrate.js';

const DATABASE_URL = 'postgres://user:pass@db.example.test:5432/notegen';

function fakeManifest(): MigrationManifest {
  return { folder: 'fake-migrations', entries: [] };
}

function fakeDrift(overrides: Partial<DriftResult>): DriftResult {
  return {
    current: true,
    expectedCount: 5,
    appliedCount: 5,
    missingTags: [],
    unexpectedHashes: [],
    ...overrides,
  };
}

function fakeRunResult(appliedTags: string[]): RunMigrationsResult {
  return { appliedTags, manifest: fakeManifest(), drift: fakeDrift({}) };
}

function fakeDriftResult(drift: DriftResult): CheckDriftResult {
  return { manifest: fakeManifest(), drift };
}

function codedError(message: string, code: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

interface RecordingRunners extends StartupMigrationRunners {
  runCalls: RunMigrationsOptions[];
  driftCalls: CheckDriftOptions[];
}

function recordingRunners(impl: Partial<StartupMigrationRunners>): RecordingRunners {
  const runCalls: RunMigrationsOptions[] = [];
  const driftCalls: CheckDriftOptions[] = [];
  return {
    runCalls,
    driftCalls,
    runMigrations: async (options: RunMigrationsOptions) => {
      runCalls.push(options);
      if (impl.runMigrations !== undefined) {
        return impl.runMigrations(options);
      }
      return fakeRunResult([]);
    },
    checkMigrationDrift: async (options: CheckDriftOptions) => {
      driftCalls.push(options);
      if (impl.checkMigrationDrift !== undefined) {
        return impl.checkMigrationDrift(options);
      }
      return fakeDriftResult(fakeDrift({}));
    },
  };
}

describe('isMigrateOnStartEnabled', () => {
  it('is enabled when MIGRATE_ON_START is unset (default true)', () => {
    expect(isMigrateOnStartEnabled({})).toBe(true);
  });

  it('is enabled when MIGRATE_ON_START is true', () => {
    expect(isMigrateOnStartEnabled({ MIGRATE_ON_START: 'true' })).toBe(true);
  });

  it('is disabled only when MIGRATE_ON_START is exactly false', () => {
    expect(isMigrateOnStartEnabled({ MIGRATE_ON_START: 'false' })).toBe(false);
  });

  it('treats unrecognized values as enabled, including FALSE, 0, no, and empty', () => {
    expect(isMigrateOnStartEnabled({ MIGRATE_ON_START: 'FALSE' })).toBe(true);
    expect(isMigrateOnStartEnabled({ MIGRATE_ON_START: 'False' })).toBe(true);
    expect(isMigrateOnStartEnabled({ MIGRATE_ON_START: '0' })).toBe(true);
    expect(isMigrateOnStartEnabled({ MIGRATE_ON_START: 'no' })).toBe(true);
    expect(isMigrateOnStartEnabled({ MIGRATE_ON_START: '' })).toBe(true);
    expect(isMigrateOnStartEnabled({ MIGRATE_ON_START: ' false' })).toBe(true);
  });

  it('reads process.env by default', () => {
    vi.stubEnv('MIGRATE_ON_START', 'false');
    try {
      expect(isMigrateOnStartEnabled()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv('MIGRATE_ON_START', 'yes');
    try {
      expect(isMigrateOnStartEnabled()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('runStartupMigrationStep', () => {
  it('skips migration entirely when DATABASE_URL is unset and calls no runner', async () => {
    const runners = recordingRunners({});
    const logs: string[] = [];
    const outcome = await runStartupMigrationStep({
      databaseUrl: undefined,
      migrateOnStart: true,
      runners,
      log: (message) => {
        logs.push(message);
      },
    });
    expect(outcome).toEqual({ status: 'skipped' });
    expect(runners.runCalls).toEqual([]);
    expect(runners.driftCalls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('DATABASE_URL');
  });

  it('runs migrations with only the database URL, keeping the default 30s lock timeout', async () => {
    const runners = recordingRunners({
      runMigrations: async () => fakeRunResult(['0000_initial-schema-m1-m7', '0001_m8-expand']),
    });
    const logs: string[] = [];
    const outcome = await runStartupMigrationStep({
      databaseUrl: DATABASE_URL,
      migrateOnStart: true,
      runners,
      log: (message) => {
        logs.push(message);
      },
    });
    expect(outcome).toEqual({
      status: 'migrated',
      appliedTags: ['0000_initial-schema-m1-m7', '0001_m8-expand'],
    });
    expect(runners.runCalls).toEqual([{ databaseUrl: DATABASE_URL }]);
    expect(runners.runCalls[0]).not.toHaveProperty('lockTimeoutMs');
    expect(runners.runCalls[0]).not.toHaveProperty('migrationsFolder');
    expect(runners.driftCalls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('0000_initial-schema-m1-m7');
    expect(logs[0]).toContain('0001_m8-expand');
    expect(logs[0]).not.toContain(DATABASE_URL);
  });

  it('logs current when migrations apply nothing', async () => {
    const runners = recordingRunners({});
    const logs: string[] = [];
    const outcome = await runStartupMigrationStep({
      databaseUrl: DATABASE_URL,
      migrateOnStart: true,
      runners,
      log: (message) => {
        logs.push(message);
      },
    });
    expect(outcome).toEqual({ status: 'migrated', appliedTags: [] });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('no pending migrations');
  });

  it('checks drift without writing when MIGRATE_ON_START is false and the schema is current', async () => {
    const runners = recordingRunners({});
    const logs: string[] = [];
    const outcome = await runStartupMigrationStep({
      databaseUrl: DATABASE_URL,
      migrateOnStart: false,
      runners,
      log: (message) => {
        logs.push(message);
      },
    });
    expect(outcome).toEqual({ status: 'current' });
    expect(runners.driftCalls).toEqual([{ databaseUrl: DATABASE_URL }]);
    expect(runners.runCalls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('MIGRATE_ON_START=false');
    expect(logs[0]).toContain('5/5');
  });

  it('refuses start naming missing tags when MIGRATE_ON_START is false and drift is detected', async () => {
    const runners = recordingRunners({
      checkMigrationDrift: async () =>
        fakeDriftResult(fakeDrift({ current: false, appliedCount: 1, missingTags: ['0001_m8-expand'] })),
    });
    const logs: string[] = [];
    const outcome = await runStartupMigrationStep({
      databaseUrl: DATABASE_URL,
      migrateOnStart: false,
      runners,
      log: (message) => {
        logs.push(message);
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') {
      throw new Error('unreachable');
    }
    expect(outcome.kind).toBe('migration-failed');
    expect(outcome.message).toContain('0001_m8-expand');
    expect(outcome.message).toContain("MIGRATE_ON_START is 'false'");
    expect(outcome.message).not.toContain(DATABASE_URL);
    expect(runners.runCalls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('counts unexpected digests without quoting them in the drift refusal', async () => {
    const digest = 'a'.repeat(64);
    const runners = recordingRunners({
      checkMigrationDrift: async () =>
        fakeDriftResult(fakeDrift({ current: false, appliedCount: 6, unexpectedHashes: [digest] })),
    });
    const outcome = await runStartupMigrationStep({
      databaseUrl: DATABASE_URL,
      migrateOnStart: false,
      runners,
      log: () => {},
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') {
      throw new Error('unreachable');
    }
    expect(outcome.message).toContain('1 unexpected applied digests');
    expect(outcome.message).not.toContain(digest);
  });

  it('reports database-unreachable with the code only when the connection is refused', async () => {
    const runners = recordingRunners({
      runMigrations: async () => {
        throw codedError('connect ECONNREFUSED 10.1.2.3:5432', 'ECONNREFUSED');
      },
    });
    const outcome = await runStartupMigrationStep({
      databaseUrl: DATABASE_URL,
      migrateOnStart: true,
      runners,
      log: () => {},
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') {
      throw new Error('unreachable');
    }
    expect(outcome.kind).toBe('database-unreachable');
    expect(outcome.message).toContain('ECONNREFUSED');
    expect(outcome.message).toContain('DATABASE_URL');
    expect(outcome.message).not.toContain('10.1.2.3');
    expect(outcome.message).not.toContain(DATABASE_URL);
  });

  it('reports database-unreachable when the drift check cannot reach the database', async () => {
    const runners = recordingRunners({
      checkMigrationDrift: async () => {
        throw codedError('getaddrinfo ENOTFOUND db.example.test', 'ENOTFOUND');
      },
    });
    const outcome = await runStartupMigrationStep({
      databaseUrl: DATABASE_URL,
      migrateOnStart: false,
      runners,
      log: () => {},
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') {
      throw new Error('unreachable');
    }
    expect(outcome.kind).toBe('database-unreachable');
    expect(outcome.message).toContain('ENOTFOUND');
    expect(outcome.message).not.toContain('db.example.test');
  });

  it('keeps the migration lock name in the log when the lock times out', async () => {
    const runners = recordingRunners({
      runMigrations: async () => {
        throw new Error('Timed out waiting for the migration advisory lock; another migrator may be running.');
      },
    });
    const outcome = await runStartupMigrationStep({
      databaseUrl: DATABASE_URL,
      migrateOnStart: true,
      runners,
      log: () => {},
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') {
      throw new Error('unreachable');
    }
    expect(outcome.kind).toBe('migration-failed');
    expect(outcome.message).toContain('migration advisory lock');
  });

  it('keeps the journal file name in the log when the manifest is unreadable', async () => {
    const runners = recordingRunners({
      runMigrations: async () => {
        throw new Error('Migration journal not found: /srv/api/drizzle/meta/_journal.json');
      },
    });
    const outcome = await runStartupMigrationStep({
      databaseUrl: DATABASE_URL,
      migrateOnStart: true,
      runners,
      log: () => {},
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') {
      throw new Error('unreachable');
    }
    expect(outcome.kind).toBe('migration-failed');
    expect(outcome.message).toContain('_journal.json');
  });

  it('logs only the machine code for driver errors whose message may quote SQL', async () => {
    const runners = recordingRunners({
      runMigrations: async () => {
        throw codedError('relation "marks" already exists; CREATE TABLE "marks" (...)', '42P07');
      },
    });
    const outcome = await runStartupMigrationStep({
      databaseUrl: DATABASE_URL,
      migrateOnStart: true,
      runners,
      log: () => {},
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') {
      throw new Error('unreachable');
    }
    expect(outcome.kind).toBe('migration-failed');
    expect(outcome.message).toContain('42P07');
    expect(outcome.message).not.toContain('CREATE TABLE');
    expect(outcome.message).not.toContain('marks');
  });

  it('uses a fixed message when a runner throws a non-error value', async () => {
    const runners = recordingRunners({
      runMigrations: async () => {
        throw 'weird-string-value';
      },
    });
    const outcome = await runStartupMigrationStep({
      databaseUrl: DATABASE_URL,
      migrateOnStart: true,
      runners,
      log: () => {},
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') {
      throw new Error('unreachable');
    }
    expect(outcome.kind).toBe('migration-failed');
    expect(outcome.message).not.toContain('weird-string-value');
  });
});
