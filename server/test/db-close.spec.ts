// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Pins finding 30-F4-5: closing the app closes the db runner.
//
// buildApp has no db-dependency injection point (AD-40), so this file
// observes the wiring through a module mock: only the
// createDefaultDbRouteDeps factory is replaced, with a runner that
// records close() calls. The real closeDbRouteDeps runs, so the test
// fails if app.ts stops calling it from the onClose hook, and the
// recorded order pins auth close before db close. No HTTP request is
// made and no database is touched: the mocked factory never creates
// a postgres client.

import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createAuthContext } from '../src/auth/context.js';
import type { ServerConfig } from '../src/config.js';
import {
  closeDbRouteDeps,
  createDefaultDbRouteDeps,
  type DbRouteDeps,
} from '../src/services/db/deps.js';
import type { IdempotencyStore } from '../src/services/db/idempotency.js';
import { createDbHandlerRegistry, type DbTransaction } from '../src/services/db/registry.js';
import type { DbTransactionRunner } from '../src/services/db/runner.js';

const { closeEvents } = vi.hoisted(() => ({ closeEvents: [] as string[] }));

vi.mock('../src/services/db/deps.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/db/deps.js')>();
  const { createDbHandlerRegistry: createRegistry } = await import('../src/services/db/registry.js');
  const runner: DbTransactionRunner = {
    runWrite: async <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> => fn({} as DbTransaction),
    runRead: async <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> => fn({} as DbTransaction),
    close: async (): Promise<void> => {
      closeEvents.push('db');
    },
  };
  const idempotencyStore: IdempotencyStore = {
    find: async () => null,
    store: async () => {},
  };
  return {
    ...original,
    createDefaultDbRouteDeps: vi.fn(
      (_config: { databaseUrl: string | undefined }): DbRouteDeps => ({
        registry: createRegistry(),
        runner,
        resolveWorkspaceId: async () => null,
        idempotencyStore,
      }),
    ),
  };
});

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

describe('app close closes the db runner', () => {
  it('closes auth first, then the db runner, on app.close()', async () => {
    const auth = createAuthContext({ store: null });
    auth.close = async (): Promise<void> => {
      closeEvents.push('auth');
    };
    const app = await buildApp({
      config: testConfig(),
      pool: null,
      version: '0.39.2-fork.1',
      auth,
    });
    expect(vi.mocked(createDefaultDbRouteDeps)).toHaveBeenCalledTimes(1);
    expect(closeEvents).toEqual([]);
    await app.close();
    expect(closeEvents).toEqual(['auth', 'db']);
  });

  it('closeDbRouteDeps awaits runner.close()', async () => {
    let closed = 0;
    const runner: DbTransactionRunner = {
      runWrite: async <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
        fn({} as DbTransaction),
      runRead: async <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
        fn({} as DbTransaction),
      close: async (): Promise<void> => {
        closed += 1;
      },
    };
    const deps: DbRouteDeps = {
      registry: createDbHandlerRegistry(),
      runner,
      resolveWorkspaceId: async () => null,
      idempotencyStore: {
        find: async () => null,
        store: async () => {},
      },
    };
    await closeDbRouteDeps(deps);
    expect(closed).toBe(1);
  });
});
