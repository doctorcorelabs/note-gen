// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Route tests for POST /api/transactions and POST /api/db/batch
// (kontrak section 3.4). Handlers here are STUBS registered into a
// fresh registry per test: this file proves routes, dispatch,
// validation, envelope, error codes, and atomicity through the fake
// runner (one runWrite call, failure rolls back, no commit). Real
// kind handlers are owned by V3-13b/V3-13c/V3-25. A Postgres-backed
// atomicity proof against the real Drizzle runner, workspace
// resolver, and idempotency store does not exist yet: it is
// integrator debt for the handler merges (no live-DB harness exists
// in server/test), and the single-transaction guarantee itself is
// Drizzle's db.transaction, pinned by the runner delegation tests
// in db-units.spec.ts.
//
// The test app assembles the same plugins and hooks in the same
// order as buildApp (request id, error handling, auth hooks, then
// routes), with stub session/CSRF/Origin verifiers, because buildApp
// itself has no db-dependency injection point (AD-40: AppDeps
// changes need a recorded amendment). One test below proves the
// routes are registered and protected through buildApp itself.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';
import { ApiError } from '../src/plugins/envelope.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import { registerRequestId, requestIdFromHeaders } from '../src/plugins/request-id.js';
import { registerDbRoutes } from '../src/routes/db.js';
import type { DbRouteDeps } from '../src/services/db/deps.js';
import { drizzleIdempotencyStore } from '../src/services/db/idempotency.js';
import { FORBIDDEN_OPERATION_FIELDS } from '../src/services/db/kinds.js';
import {
  createDbHandlerRegistry,
  type DbHandlerContext,
  type DbHandlerRegistry,
  type DbOperationInput,
  type DbTransaction,
} from '../src/services/db/registry.js';
import type { DbTransactionRunner } from '../src/services/db/runner.js';
import type { IdempotencyStore, StoredIdempotencyResponse } from '../src/services/db/idempotency.js';

const ORIGIN = 'https://app.example.invalid';
const PRINCIPAL: SessionPrincipal = {
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'user',
  sessionId: 'good-session',
};
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

const AUTHED_HEADERS = {
  cookie: 'notegen_session=good-session',
  origin: ORIGIN,
  'x-csrf-token': 'good-csrf',
};

class FakeRunner implements DbTransactionRunner {
  writeCalls = 0;
  readCalls = 0;
  commits = 0;
  rollbacks = 0;
  readonly tx = {} as DbTransaction;

  async runWrite<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    this.writeCalls += 1;
    try {
      const result = await fn(this.tx);
      this.commits += 1;
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }

  async runRead<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    this.readCalls += 1;
    try {
      const result = await fn(this.tx);
      this.commits += 1;
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }

  async close(): Promise<void> {}
}

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, StoredIdempotencyResponse & { expiresAt: number }>();

  async find(
    _tx: DbTransaction,
    input: { userId: string; scope: string; key: string },
  ): Promise<StoredIdempotencyResponse | null> {
    const row = this.rows.get(`${input.userId}|${input.scope}|${input.key}`);
    if (row === undefined) {
      return null;
    }
    if (row.expiresAt <= Date.now()) {
      this.rows.delete(`${input.userId}|${input.scope}|${input.key}`);
      return null;
    }
    return { requestHash: row.requestHash, status: row.status, data: row.data };
  }

  async store(
    _tx: DbTransaction,
    input: { userId: string; scope: string; key: string; requestHash: string },
    response: { status: number; data: unknown },
  ): Promise<void> {
    const mapKey = `${input.userId}|${input.scope}|${input.key}`;
    if (this.rows.has(mapKey)) {
      throw new ApiError(
        409,
        'idempotency_key_reused',
        'The idempotency key was reused with a different request.',
      );
    }
    this.rows.set(mapKey, {
      requestHash: input.requestHash,
      status: response.status,
      data: response.data,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
  }
}

interface Harness {
  app: FastifyInstance;
  registry: DbHandlerRegistry;
  runner: FakeRunner;
  calls: Array<{ kind: string; ctx: DbHandlerContext; op: DbOperationInput }>;
}

async function buildHarness(options: {
  workspaceId?: string | null;
  idempotencyStore?: IdempotencyStore;
  globalBodyLimit?: number;
  sweepAssets?: DbRouteDeps['sweepAssets'];
} = {}): Promise<Harness> {
  const registry = createDbHandlerRegistry();
  const runner = new FakeRunner();
  const calls: Harness['calls'] = [];
  const deps: DbRouteDeps = {
    registry,
    runner,
    resolveWorkspaceId: async () =>
      options.workspaceId === undefined ? WORKSPACE_ID : options.workspaceId,
    idempotencyStore: options.idempotencyStore ?? new MemoryIdempotencyStore(),
    ...(options.sweepAssets !== undefined ? { sweepAssets: options.sweepAssets } : {}),
  };
  const app = Fastify({
    logger: false,
    bodyLimit: options.globalBodyLimit ?? 1048576,
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  registerAuthHooks(app, {
    verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? PRINCIPAL : null),
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
    canonicalOrigin: ORIGIN,
  });
  await registerDbRoutes(app, deps);
  return { app, registry, runner, calls };
}

function recordStub(
  calls: Harness['calls'],
  result: { affected: number; id?: number | string; version?: number },
) {
  return async (ctx: DbHandlerContext, op: DbOperationInput) => {
    calls.push({ kind: op.kind, ctx, op });
    return result;
  };
}

function recordReadStub(calls: Harness['calls'], rows: readonly unknown[]) {
  return async (ctx: DbHandlerContext, op: DbOperationInput) => {
    calls.push({ kind: op.kind, ctx, op });
    return rows;
  };
}

function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3001,
    databaseUrl: undefined,
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
  };
}

let harness: Harness | null = null;
afterEach(async () => {
  if (harness !== null) {
    await harness.app.close();
    harness = null;
  }
});

describe('POST /api/transactions with stub handlers', () => {
  it('executes writes in order and returns the contract envelope', async () => {
    harness = await buildHarness();
    harness.registry.registerWrite('marks.create', recordStub(harness.calls, { affected: 1, id: 42, version: 1 }));
    harness.registry.registerWrite('activity.insert', recordStub(harness.calls, { affected: 1, id: 915 }));
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: {
        operations: [
          { kind: 'marks.create', mark: { content: 'hello' } },
          { kind: 'activity.insert', source: 'record', title: 'created' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data['transactionId']).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.data['results']).toEqual([
      { kind: 'marks.create', affected: 1, id: 42, version: 1 },
      { kind: 'activity.insert', affected: 1, id: 915 },
    ]);
    expect(harness.calls.map((call) => call.kind)).toEqual(['marks.create', 'activity.insert']);
    expect(harness.calls[0].ctx.workspaceId).toBe(WORKSPACE_ID);
    expect(harness.calls[0].ctx.userId).toBe(PRINCIPAL.userId);
    expect(harness.calls[0].ctx.transactionId).toBe(body.data['transactionId']);
    expect(harness.runner.commits).toBe(1);
    expect(harness.runner.rollbacks).toBe(0);
    expect(harness.runner.writeCalls).toBe(1);
  });

  it('rejects an empty operations array with validation_failed and opens no transaction', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: Record<string, unknown> };
    expect(body.ok).toBe(false);
    expect(body.error['code']).toBe('validation_failed');
    expect(body.error['retryable']).toBe(false);
    expect(body.error['details']).toEqual({
      fields: [{ field: 'operations', issue: 'must contain at least 1 operation' }],
    });
    expect(harness.runner.writeCalls).toBe(0);
    expect(harness.calls).toEqual([]);
  });

  it('rejects a read kind with invalid_operation and opens no transaction', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'marks.list' }] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: Record<string, unknown> };
    expect(body.ok).toBe(false);
    expect(body.error['code']).toBe('invalid_operation');
    expect(body.error['details']).toEqual({ operationIndex: 0, kind: 'marks.list' });
    expect(harness.runner.writeCalls).toBe(0);
  });

  it('rejects messages.get with invalid_operation: the 74th kind is a read kind', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'messages.get', id: 1 }] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('invalid_operation');
    expect(body.error['details']).toEqual({ operationIndex: 0, kind: 'messages.get' });
    expect(harness.runner.writeCalls).toBe(0);
  });

  it('rejects an unknown kind with invalid_operation', async () => {
    harness = await buildHarness();
    harness.registry.registerWrite('marks.create', recordStub(harness.calls, { affected: 1 }));
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: {
        operations: [{ kind: 'marks.create' }, { kind: 'marks.explode' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('invalid_operation');
    expect(body.error['details']).toEqual({ operationIndex: 1, kind: 'marks.explode' });
    expect(harness.runner.writeCalls).toBe(0);
    expect(harness.calls).toEqual([]);
  });

  it('rejects the server-only kind with 410, even when a handler is registered', async () => {
    harness = await buildHarness();
    // The 410 is a pre-flight second defense (penguncian D/G
    // section 7 rule 5): registration must not let the kind run
    // through HTTP.
    harness.registry.registerWrite('vector.replaceChunks', recordStub(harness.calls, { affected: 1 }));
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'vector.replaceChunks' }] },
    });
    expect(res.statusCode).toBe(410);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('capability_unavailable');
    expect(body.error['message']).toContain('vector.replaceChunks');
    expect(body.error['message']).toContain('Fase 2');
    expect(body.error['details']).toMatchObject({
      capability: 'vector.replaceChunks',
      phase: 'Fase 2',
      operationIndex: 0,
      kind: 'vector.replaceChunks',
    });
    expect(harness.runner.writeCalls).toBe(0);
    expect(harness.calls).toEqual([]);
    // In the read batch the same kind is a wrong-group kind and
    // answers 400 invalid_operation like any write kind.
    const batchRes = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'vector.replaceChunks' }] },
    });
    expect(batchRes.statusCode).toBe(400);
    expect((batchRes.json() as { error: Record<string, unknown> }).error['code']).toBe('invalid_operation');
    expect(harness.runner.readCalls).toBe(0);
  });

  it.each(FORBIDDEN_OPERATION_FIELDS)(
    'rejects forbidden operation field %s with validation_failed',
    async (field) => {
      harness = await buildHarness();
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: AUTHED_HEADERS,
        payload: { operations: [{ kind: 'marks.create', [field]: 'x' }] },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: Record<string, unknown> };
      expect(body.error['code']).toBe('validation_failed');
      const fields = body.error['details'] as { fields: Array<{ field: string }> };
      expect(fields.fields.map((entry) => entry.field)).toContain(`operations[0].${field}`);
      expect(harness.runner.writeCalls).toBe(0);
    },
  );

  it('rejects unknown top-level fields including workspaceId', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [], workspaceId: WORKSPACE_ID, extra: 1 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('validation_failed');
    const fields = body.error['details'] as { fields: Array<{ field: string }> };
    expect(fields.fields.map((entry) => entry.field).sort()).toEqual(['extra', 'workspaceId']);
  });

  it('rejects malformed bodies with validation_failed', async () => {
    harness = await buildHarness();
    for (const payload of [{}, { operations: 'nope' }, { operations: [42] }, { operations: [{ noKind: true }] }]) {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: AUTHED_HEADERS,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('validation_failed');
    }
    expect(harness.runner.writeCalls).toBe(0);
  });

  it('rejects malformed JSON with invalid_json', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('invalid_json');
  });

  it('rejects 51 operations and accepts exactly 50', async () => {
    harness = await buildHarness();
    harness.registry.registerWrite('activity.insert', recordStub(harness.calls, { affected: 1 }));
    const tooMany = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: Array.from({ length: 51 }, () => ({ kind: 'activity.insert' })) },
    });
    expect(tooMany.statusCode).toBe(400);
    expect((tooMany.json() as { error: Record<string, unknown> }).error['code']).toBe('validation_failed');
    expect(harness.runner.writeCalls).toBe(0);
    const exactlyFifty = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: Array.from({ length: 50 }, () => ({ kind: 'activity.insert' })) },
    });
    expect(exactlyFifty.statusCode).toBe(200);
    expect((exactlyFifty.json() as { data: { results: unknown[] } }).data.results).toHaveLength(50);
  });

  it('rejects a body over 1 MB with payload_too_large at the route limit', async () => {
    harness = await buildHarness({ globalBodyLimit: 10 * 1024 * 1024 });
    harness.registry.registerWrite('marks.create', recordStub(harness.calls, { affected: 1 }));
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ operations: [{ kind: 'marks.create', note: 'x'.repeat(1100000) }] }),
    });
    expect(res.statusCode).toBe(413);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('payload_too_large');
    expect(harness.runner.writeCalls).toBe(0);
  });

  it('rolls back when the third operation fails and reports its index', async () => {
    harness = await buildHarness();
    harness.registry.registerWrite('marks.create', recordStub(harness.calls, { affected: 1, id: 1 }));
    harness.registry.registerWrite('activity.insert', recordStub(harness.calls, { affected: 1, id: 2 }));
    harness.registry.registerWrite('marks.updateTags', async (ctx, op) => {
      harness?.calls.push({ kind: op.kind, ctx, op });
      throw ApiError.recordTagsChanged({ currentTagIds: [3, 7] });
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: {
        operations: [{ kind: 'marks.create' }, { kind: 'activity.insert' }, { kind: 'marks.updateTags' }],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('record_tags_changed');
    expect(body.error['retryable']).toBe(false);
    expect(body.error['details']).toEqual({
      currentTagIds: [3, 7],
      operationIndex: 2,
      kind: 'marks.updateTags',
    });
    expect(harness.runner.commits).toBe(0);
    expect(harness.runner.rollbacks).toBe(1);
    expect(harness.calls.map((call) => call.kind)).toEqual([
      'marks.create',
      'activity.insert',
      'marks.updateTags',
    ]);
  });

  it('runs handler validate steps before opening the transaction', async () => {
    harness = await buildHarness();
    harness.registry.registerWrite('marks.create', recordStub(harness.calls, { affected: 1 }));
    harness.registry.registerWrite('marks.update', {
      validate: () => {
        throw ApiError.validation('Request validation failed.', {
          fields: [{ field: 'operations[1].patch', issue: 'is required' }],
        });
      },
      handle: recordStub(harness.calls, { affected: 1 }),
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'marks.create' }, { kind: 'marks.update' }] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('validation_failed');
    expect(body.error['details']).toMatchObject({ operationIndex: 1, kind: 'marks.update' });
    expect(harness.runner.writeCalls).toBe(0);
    expect(harness.calls).toEqual([]);
  });

  it('maps an unexpected handler failure to internal_error without leaking', async () => {
    harness = await buildHarness();
    const marker = 'MARKER_SECRET_9f27';
    harness.registry.registerWrite('marks.create', async () => {
      throw new Error(`driver exploded: ${marker}`);
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'marks.create' }] },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(marker);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('internal_error');
    expect(body.error['details']).toEqual({ operationIndex: 0, kind: 'marks.create' });
    expect(harness.runner.rollbacks).toBe(1);
  });

  it('answers 500 for an unregistered W1 kind without opening a transaction', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'marks.create' }] },
    });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('internal_error');
    expect(harness.runner.writeCalls).toBe(0);
  });

  it('answers 410 for an unregistered W2 kind with details.capability', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'memories.create' }] },
    });
    expect(res.statusCode).toBe(410);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('capability_unavailable');
    // The message names the capability and the phase, and details
    // carry both (penguncian D/G section 7 rule 4).
    expect(body.error['message']).toContain('memories.create');
    expect(body.error['message']).toContain('Fase 2');
    expect(body.error['details']).toMatchObject({ capability: 'memories.create', phase: 'Fase 2' });
    expect(harness.runner.writeCalls).toBe(0);
  });

  it('answers 500 for a malformed handler result', async () => {
    harness = await buildHarness();
    harness.registry.registerWrite('marks.create', async () => ({ affected: -1 }));
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'marks.create' }] },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('internal_error');
    expect(body.error['details']).toEqual({ operationIndex: 0, kind: 'marks.create' });
    expect(harness.runner.rollbacks).toBe(1);
  });

  it('passes injection strings carried as data values through unchanged', async () => {
    harness = await buildHarness();
    harness.registry.registerWrite('marks.create', recordStub(harness.calls, { affected: 1 }));
    const injection = "' OR '1'='1; DROP TABLE marks; --";
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'marks.create', mark: { content: injection } }] },
    });
    expect(res.statusCode).toBe(200);
    const mark = harness.calls[0].op['mark'] as { content: string };
    expect(mark.content).toBe(injection);
  });

  it('replays an identical idempotent request without re-executing handlers', async () => {
    harness = await buildHarness();
    harness.registry.registerWrite('marks.create', recordStub(harness.calls, { affected: 1, id: 7 }));
    const payload = { operations: [{ kind: 'marks.create' }] };
    const headers = { ...AUTHED_HEADERS, 'idempotency-key': 'key-1' };
    const first = await harness.app.inject({ method: 'POST', url: '/api/transactions', headers, payload });
    const second = await harness.app.inject({ method: 'POST', url: '/api/transactions', headers, payload });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(harness.calls).toHaveLength(1);
  });

  it('rejects a reused idempotency key with a different body', async () => {
    harness = await buildHarness();
    harness.registry.registerWrite('marks.create', recordStub(harness.calls, { affected: 1 }));
    harness.registry.registerWrite('activity.insert', recordStub(harness.calls, { affected: 1 }));
    const headers = { ...AUTHED_HEADERS, 'idempotency-key': 'key-2' };
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers,
      payload: { operations: [{ kind: 'marks.create' }] },
    });
    expect(first.statusCode).toBe(200);
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers,
      payload: { operations: [{ kind: 'activity.insert' }] },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: Record<string, unknown> }).error['code']).toBe('idempotency_key_reused');
    expect(harness.calls).toHaveLength(1);
  });

  it('rejects an overlong idempotency key', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { ...AUTHED_HEADERS, 'idempotency-key': 'k'.repeat(129) },
      payload: { operations: [] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('validation_failed');
  });

  it('answers 404 when no workspace resolves for the session', async () => {
    harness = await buildHarness({ workspaceId: null });
    harness.registry.registerWrite('marks.create', recordStub(harness.calls, { affected: 1 }));
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'marks.create' }] },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('not_found');
    expect(harness.calls).toEqual([]);
  });

  it('carries requestId, retryable, and details on error envelopes', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { ...AUTHED_HEADERS, 'x-request-id': 'client-req-9' },
      payload: { operations: [{ kind: 'nope' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['x-request-id']).toBe('client-req-9');
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error['requestId']).toBe('client-req-9');
    expect(body.error['retryable']).toBe(false);
    expect(typeof body.error['details']).toBe('object');
  });

  it('answers 405 for GET on the transaction path and 404 for versioned paths', async () => {
    harness = await buildHarness();
    const getRes = await harness.app.inject({
      method: 'GET',
      url: '/api/transactions',
      headers: { cookie: 'notegen_session=good-session' },
    });
    expect(getRes.statusCode).toBe(405);
    expect((getRes.json() as { error: Record<string, unknown> }).error['code']).toBe('method_not_allowed');
    const versioned = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [] },
    });
    expect(versioned.statusCode).toBe(404);
  });
});

describe('POST /api/db/batch with stub handlers', () => {
  it('executes reads in order in one read transaction', async () => {
    harness = await buildHarness();
    harness.registry.registerRead('tags.list', recordReadStub(harness.calls, [{ id: 1, name: 'Idea' }]));
    harness.registry.registerRead('marks.list', recordReadStub(harness.calls, []));
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'tags.list' }, { kind: 'marks.list' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data['results']).toEqual([
      { kind: 'tags.list', rows: [{ id: 1, name: 'Idea' }] },
      { kind: 'marks.list', rows: [] },
    ]);
    expect(harness.calls[0].ctx.transactionId).toBeNull();
    expect(harness.calls[0].ctx.workspaceId).toBe(WORKSPACE_ID);
    expect(harness.runner.readCalls).toBe(1);
    expect(harness.runner.writeCalls).toBe(0);
    expect(harness.runner.commits).toBe(1);
  });

  it('serves messages.get through the batch endpoint (74th kind, AD-44)', async () => {
    harness = await buildHarness();
    harness.registry.registerRead(
      'messages.get',
      recordReadStub(harness.calls, [{ id: 7, role: 'user' }]),
    );
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'messages.get', id: 7 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data['results']).toEqual([{ kind: 'messages.get', rows: [{ id: 7, role: 'user' }] }]);
    expect(harness.runner.readCalls).toBe(1);
  });

  it('rejects a write kind with invalid_operation and opens no transaction', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'marks.create' }] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('invalid_operation');
    expect(body.error['details']).toEqual({ operationIndex: 0, kind: 'marks.create' });
    expect(harness.runner.readCalls).toBe(0);
  });

  it('rejects an unknown kind with invalid_operation', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'tags.nope' }] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('invalid_operation');
  });

  it('reports the failing read operation and rolls back', async () => {
    harness = await buildHarness();
    harness.registry.registerRead('tags.list', recordReadStub(harness.calls, []));
    harness.registry.registerRead('marks.get', async () => {
      throw ApiError.notFound();
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'tags.list' }, { kind: 'marks.get', id: 99 }] },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('not_found');
    expect(body.error['details']).toEqual({ operationIndex: 1, kind: 'marks.get' });
    expect(harness.runner.rollbacks).toBe(1);
  });

  it('answers 500 for an unregistered read kind without opening a transaction', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'tags.list' }] },
    });
    expect(res.statusCode).toBe(500);
    expect(harness.runner.readCalls).toBe(0);
  });

  it('answers 500 when a read handler returns a non-array', async () => {
    harness = await buildHarness();
    harness.registry.registerRead('tags.list', async () => ({ not: 'an array' }) as unknown as readonly unknown[]);
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'tags.list' }] },
    });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('internal_error');
  });

  it('rejects an empty batch with validation_failed and opens no transaction', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: { ...AUTHED_HEADERS, 'idempotency-key': 'ignored-key' },
      payload: { operations: [] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: Record<string, unknown> };
    expect(body.ok).toBe(false);
    expect(body.error['code']).toBe('validation_failed');
    expect(body.error['retryable']).toBe(false);
    expect(body.error['details']).toEqual({
      fields: [{ field: 'operations', issue: 'must contain at least 1 operation' }],
    });
    expect(harness.runner.readCalls).toBe(0);
    expect(harness.calls).toEqual([]);
  });

  it('rejects non-array operations on the batch with validation_failed', async () => {
    harness = await buildHarness();
    for (const payload of [
      {},
      { operations: null },
      { operations: 'nope' },
      { operations: 42 },
      { operations: { kind: 'tags.list' } },
    ]) {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/db/batch',
        headers: AUTHED_HEADERS,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('validation_failed');
    }
    expect(harness.runner.readCalls).toBe(0);
  });

  it('accepts a batch with exactly one operation', async () => {
    harness = await buildHarness();
    harness.registry.registerRead('tags.list', recordReadStub(harness.calls, [{ id: 1, name: 'Idea' }]));
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'tags.list' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: Record<string, unknown> };
    expect(body.data['results']).toEqual([{ kind: 'tags.list', rows: [{ id: 1, name: 'Idea' }] }]);
    expect(harness.runner.readCalls).toBe(1);
  });

  it('rejects 51 operations and accepts exactly 50 on the batch', async () => {
    harness = await buildHarness();
    harness.registry.registerRead('tags.list', recordReadStub(harness.calls, []));
    const tooMany = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: AUTHED_HEADERS,
      payload: { operations: Array.from({ length: 51 }, () => ({ kind: 'tags.list' })) },
    });
    expect(tooMany.statusCode).toBe(400);
    expect((tooMany.json() as { error: Record<string, unknown> }).error['code']).toBe('validation_failed');
    expect(harness.runner.readCalls).toBe(0);
    const exactlyFifty = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: AUTHED_HEADERS,
      payload: { operations: Array.from({ length: 50 }, () => ({ kind: 'tags.list' })) },
    });
    expect(exactlyFifty.statusCode).toBe(200);
    expect((exactlyFifty.json() as { data: { results: unknown[] } }).data.results).toHaveLength(50);
  });
});

describe('auth enforcement on the db routes', () => {
  it('rejects requests without a session with 401', async () => {
    harness = await buildHarness();
    for (const url of ['/api/transactions', '/api/db/batch']) {
      const res = await harness.app.inject({ method: 'POST', url, payload: { operations: [] } });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('unauthenticated');
    }
    expect(harness.runner.writeCalls).toBe(0);
    expect(harness.runner.readCalls).toBe(0);
  });

  it('rejects a wrong Origin and a bad CSRF token with distinct codes', async () => {
    harness = await buildHarness();
    const originRes = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { cookie: 'notegen_session=good-session', origin: 'https://evil.example.invalid', 'x-csrf-token': 'good-csrf' },
      payload: { operations: [] },
    });
    expect(originRes.statusCode).toBe(403);
    expect((originRes.json() as { error: Record<string, unknown> }).error['code']).toBe('origin_rejected');
    const csrfRes = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: { cookie: 'notegen_session=good-session', origin: ORIGIN, 'x-csrf-token': 'stale' },
      payload: { operations: [] },
    });
    expect(csrfRes.statusCode).toBe(403);
    expect((csrfRes.json() as { error: Record<string, unknown> }).error['code']).toBe('csrf_invalid');
  });

  it('requires CSRF on the read batch too, because it uses POST', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/db/batch',
      headers: { cookie: 'notegen_session=good-session', origin: ORIGIN },
      payload: { operations: [] },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('csrf_invalid');
  });
});

describe('db routes through buildApp', () => {
  it('registers both routes and protects them deny-by-default', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: 'test' });
    try {
      for (const url of ['/api/transactions', '/api/db/batch']) {
        const res = await app.inject({ method: 'POST', url, payload: { operations: [] } });
        expect(res.statusCode).toBe(401);
        expect((res.json() as { error: Record<string, unknown> }).error['code']).toBe('unauthenticated');
      }
      const live = await app.inject({ method: 'GET', url: '/api/health/live' });
      expect(live.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('exposes the drizzle idempotency store used by the default wiring', () => {
    expect(typeof drizzleIdempotencyStore.find).toBe('function');
    expect(typeof drizzleIdempotencyStore.store).toBe('function');
  });
});

describe('post-commit asset sweep (F02-04b)', () => {
  function assetStub(calls: Harness['calls'], assetKeys: string[]) {
    return async (ctx: DbHandlerContext, op: DbOperationInput) => {
      calls.push({ kind: op.kind, ctx, op });
      return { affected: 1, id: 7, assetKeys };
    };
  }

  it('sweeps internal assetKeys after commit and never renders them', async () => {
    const sweeps: Array<{ workspaceId: string; assetKeys: readonly string[]; commits: number }> = [];
    harness = await buildHarness({
      sweepAssets: async (workspaceId, assetKeys) => {
        sweeps.push({ workspaceId, assetKeys, commits: harness?.runner.commits ?? -1 });
      },
    });
    harness.registry.registerWrite('marks.deletePermanent', assetStub(harness.calls, ['key-1', 'key-2']));
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'marks.deletePermanent', id: 7 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    expect(body.data['results']).toEqual([
      { kind: 'marks.deletePermanent', affected: 1, id: 7 },
    ]);
    expect(sweeps).toEqual([
      { workspaceId: WORKSPACE_ID, assetKeys: ['key-1', 'key-2'], commits: 1 },
    ]);
  });

  it('does not sweep when the transaction rolls back', async () => {
    const sweeps: string[] = [];
    harness = await buildHarness({
      sweepAssets: async (_workspaceId, assetKeys) => {
        sweeps.push(...assetKeys);
      },
    });
    harness.registry.registerWrite('marks.deletePermanent', assetStub(harness.calls, ['key-1']));
    harness.registry.registerWrite('marks.create', async () => {
      throw ApiError.notFound();
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: {
        operations: [
          { kind: 'marks.deletePermanent', id: 7 },
          { kind: 'marks.create', mark: { content: 'boom' } },
        ],
      },
    });
    expect(res.statusCode).toBe(404);
    expect(sweeps).toEqual([]);
    expect(harness.runner.rollbacks).toBe(1);
    expect(harness.runner.commits).toBe(0);
  });

  it('keeps the committed response when the sweep itself fails', async () => {
    harness = await buildHarness({
      sweepAssets: async () => {
        throw new Error('sweep failed');
      },
    });
    harness.registry.registerWrite('marks.deletePermanent', assetStub(harness.calls, ['key-1']));
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'marks.deletePermanent', id: 7 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    expect(body.data['results']).toEqual([
      { kind: 'marks.deletePermanent', affected: 1, id: 7 },
    ]);
  });

  it('answers normally when no sweep is wired', async () => {
    harness = await buildHarness();
    harness.registry.registerWrite('marks.deletePermanent', assetStub(harness.calls, ['key-1']));
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: AUTHED_HEADERS,
      payload: { operations: [{ kind: 'marks.deletePermanent', id: 7 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    expect(body.data['results']).toEqual([
      { kind: 'marks.deletePermanent', affected: 1, id: 7 },
    ]);
  });
});
