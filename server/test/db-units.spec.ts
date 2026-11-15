// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Unit tests for the handler registry, the pure validation
// helpers, the kind-group classifiers, the Drizzle runner
// delegation, and the workspace resolver's fail-closed UUID guard.
// No HTTP, no database.

import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/plugins/envelope.js';
import type { DbHandle } from '../src/db/index.js';
import { dbOpGroup, isClientExposedOpKind } from '../src/services/db/kinds.js';
import { createDbHandlerRegistry, type DbTransaction } from '../src/services/db/registry.js';
import {
  createDrizzleDbRunner,
  createUnavailableDbRunner,
} from '../src/services/db/runner.js';
import {
  hashDbRequestBody,
  normalizeReadRows,
  normalizeWriteResult,
  stableStringify,
  validateDbOperations,
  validateIdempotencyKey,
} from '../src/services/db/validation.js';
import { resolveDefaultWorkspaceId } from '../src/services/db/workspace.js';

describe('DbHandlerRegistry', () => {
  it('stores and returns handlers by kind', () => {
    const registry = createDbHandlerRegistry();
    const read = async () => [] as readonly unknown[];
    const write = async () => ({ affected: 1 });
    registry.registerRead('tags.list', read);
    registry.registerWrite('tags.create', write);
    expect(registry.getRead('tags.list')?.handle).toBe(read);
    expect(registry.getWrite('tags.create')?.handle).toBe(write);
    expect(registry.hasRead('tags.list')).toBe(true);
    expect(registry.hasWrite('tags.list')).toBe(false);
    expect(registry.getRead('marks.list')).toBeUndefined();
    expect(registry.readKinds()).toEqual(['tags.list']);
    expect(registry.writeKinds()).toEqual(['tags.create']);
  });

  it('throws on a duplicate registration for the same kind', () => {
    const registry = createDbHandlerRegistry();
    const write = async () => ({ affected: 1 });
    registry.registerWrite('tags.create', write);
    expect(() => registry.registerWrite('tags.create', write)).toThrow('Duplicate write handler');
    const read = async () => [] as readonly unknown[];
    registry.registerRead('tags.list', read);
    expect(() => registry.registerRead('tags.list', read)).toThrow('Duplicate read handler');
  });

  it('registers maps and keeps validate steps on definitions', () => {
    const registry = createDbHandlerRegistry();
    const validate = () => {};
    registry.registerReadMap({
      'tags.list': { validate, handle: async () => [] as readonly unknown[] },
    });
    registry.registerWriteMap({ 'tags.create': async () => ({ affected: 0 }) });
    expect(registry.getRead('tags.list')?.validate).toBe(validate);
    expect(registry.getWrite('tags.create')?.validate).toBeUndefined();
  });
});

describe('kind groups', () => {
  it('classifies read and write kinds and returns null for unknown kinds', () => {
    expect(dbOpGroup('marks.list')).toBe('read');
    expect(dbOpGroup('messages.get')).toBe('read');
    expect(dbOpGroup('marks.create')).toBe('write');
    expect(dbOpGroup('vector.replaceChunks')).toBe('write');
    expect(dbOpGroup('marks.explode')).toBeNull();
    expect(dbOpGroup('')).toBeNull();
  });

  it('exposes every kind to clients except the server-only kind', () => {
    expect(isClientExposedOpKind('marks.list')).toBe(true);
    expect(isClientExposedOpKind('messages.get')).toBe(true);
    expect(isClientExposedOpKind('memories.create')).toBe(true);
    expect(isClientExposedOpKind('vector.replaceChunks')).toBe(false);
    expect(isClientExposedOpKind('marks.explode')).toBe(false);
  });
});

describe('Drizzle runner delegation', () => {
  it('runs writes in a default transaction and reads in a read-only transaction', async () => {
    const optionsSeen: unknown[] = [];
    const fakeDb = {
      transaction: async (fn: (tx: DbTransaction) => Promise<string>, options?: unknown) => {
        optionsSeen.push(options);
        return fn({} as DbTransaction);
      },
    };
    const close = vi.fn(async () => {});
    const handle = { db: fakeDb, client: {}, close } as unknown as DbHandle;
    const runner = createDrizzleDbRunner(handle);
    await expect(runner.runWrite(async () => 'wrote')).resolves.toBe('wrote');
    await expect(runner.runRead(async () => 'read')).resolves.toBe('read');
    expect(optionsSeen).toEqual([undefined, { accessMode: 'read only' }]);
    await runner.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('propagates a transaction failure instead of swallowing it', async () => {
    const failure = new Error('driver down');
    const fakeDb = {
      transaction: async () => {
        throw failure;
      },
    };
    const handle = { db: fakeDb, client: {}, close: async () => {} } as unknown as DbHandle;
    const runner = createDrizzleDbRunner(handle);
    await expect(runner.runWrite(async () => 'never')).rejects.toBe(failure);
  });

  it('answers service_unavailable from the runner used without DATABASE_URL', async () => {
    const runner = createUnavailableDbRunner();
    for (const run of [runner.runWrite, runner.runRead]) {
      try {
        await run(async () => 'never');
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).statusCode).toBe(503);
        expect((error as ApiError).code).toBe('service_unavailable');
        expect((error as ApiError).retryable).toBe(true);
      }
    }
    await expect(runner.close()).resolves.toBeUndefined();
  });
});

describe('workspace resolver UUID guard', () => {
  it('returns null for a non-UUID user id without touching the database', async () => {
    // An empty transaction object: any database access would throw,
    // proving the guard runs first and fails closed with null.
    const untouched = {} as DbTransaction;
    for (const userId of ['', 'not-a-uuid', '11111111-1111-4111-8111-11111111111']) {
      await expect(resolveDefaultWorkspaceId(untouched, userId)).resolves.toBeNull();
    }
  });
});

describe('validateDbOperations', () => {
  it('returns operations in request order for a valid body', () => {
    const ops = validateDbOperations(
      { operations: [{ kind: 'tags.create', name: 'A' }, { kind: 'tags.delete', id: 3 }] },
      'write',
    );
    expect(ops.map((op) => op.kind)).toEqual(['tags.create', 'tags.delete']);
  });

  it('rejects a kind from the wrong group on each endpoint', () => {
    expect(() => validateDbOperations({ operations: [{ kind: 'tags.create' }] }, 'read')).toThrowError(
      ApiError,
    );
    try {
      validateDbOperations({ operations: [{ kind: 'tags.create' }] }, 'read');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('invalid_operation');
      expect((error as ApiError).statusCode).toBe(400);
    }
  });

  it('rejects an empty operations array with validation_failed on both endpoints', () => {
    for (const group of ['read', 'write'] as const) {
      try {
        validateDbOperations({ operations: [] }, group);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe('validation_failed');
        expect((error as ApiError).statusCode).toBe(400);
        expect((error as ApiError).details).toEqual({
          fields: [{ field: 'operations', issue: 'must contain at least 1 operation' }],
        });
      }
    }
  });

  it('rejects missing and non-array operations with validation_failed', () => {
    for (const body of [{}, { operations: null }, { operations: 'nope' }, { operations: 42 }]) {
      try {
        validateDbOperations(body, 'read');
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe('validation_failed');
        expect((error as ApiError).statusCode).toBe(400);
      }
    }
  });
});

describe('validateIdempotencyKey', () => {
  it('returns null when no key is sent', () => {
    expect(validateIdempotencyKey(undefined)).toBeNull();
    expect(validateIdempotencyKey('')).toBeNull();
  });

  it('returns the key unchanged when valid', () => {
    expect(validateIdempotencyKey('key-abc')).toBe('key-abc');
    expect(validateIdempotencyKey('k'.repeat(128))).toBe('k'.repeat(128));
  });

  it('rejects duplicated and overlong keys', () => {
    expect(() => validateIdempotencyKey(['a', 'b'])).toThrowError(ApiError);
    expect(() => validateIdempotencyKey('k'.repeat(129))).toThrowError(ApiError);
  });
});

describe('stableStringify and hashDbRequestBody', () => {
  it('is insensitive to object key order', () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 4 }, b: 1 }));
    expect(stableStringify([3, 2, 1])).not.toBe(stableStringify([1, 2, 3]));
  });

  it('hashes reordered bodies identically and different bodies differently', () => {
    const first = hashDbRequestBody([{ kind: 'tags.create', name: 'A' }]);
    const reordered = hashDbRequestBody([{ name: 'A', kind: 'tags.create' }]);
    const different = hashDbRequestBody([{ kind: 'tags.create', name: 'B' }]);
    expect(reordered).toBe(first);
    expect(different).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('result normalization', () => {
  it('normalizes a full write result including committed', () => {
    expect(normalizeWriteResult({ affected: 1, id: 'abc', version: 3, committed: false }, 'wiki.commitRevision', 0)).toEqual(
      { affected: 1, id: 'abc', version: 3, committed: false },
    );
    expect(normalizeWriteResult({ affected: 0 }, 'tags.create', 0)).toEqual({ affected: 0 });
  });

  it('rejects malformed write results with operation context', () => {
    for (const bad of [null, [], { affected: 1.5 }, { affected: -1 }, { affected: 1, id: {} }, { affected: 1, version: 'x' }, { affected: 1, committed: 'yes' }]) {
      try {
        normalizeWriteResult(bad, 'tags.create', 2);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).statusCode).toBe(500);
        expect((error as ApiError).details).toEqual({ operationIndex: 2, kind: 'tags.create' });
      }
    }
  });

  it('accepts row arrays and rejects anything else', () => {
    expect(normalizeReadRows([{ id: 1 }], 'tags.list', 0)).toEqual([{ id: 1 }]);
    try {
      normalizeReadRows({ id: 1 }, 'tags.list', 1);
      expect.unreachable();
    } catch (error) {
      expect((error as ApiError).statusCode).toBe(500);
      expect((error as ApiError).details).toEqual({ operationIndex: 1, kind: 'tags.list' });
    }
  });
});
