// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Unit tests for the handler registry and the pure validation
// helpers. No HTTP, no database.

import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/plugins/envelope.js';
import { dbOpGroup, isClientExposedOpKind } from '../src/services/db/kinds.js';
import { createDbHandlerRegistry } from '../src/services/db/registry.js';
import {
  hashDbRequestBody,
  normalizeReadRows,
  normalizeWriteResult,
  stableStringify,
  validateDbOperations,
  validateIdempotencyKey,
} from '../src/services/db/validation.js';

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
