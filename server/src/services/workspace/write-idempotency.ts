// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Idempotency-Key support for workspace writes (V3-04b, wave 3A).
//
// Contract (kontrak-api-kanonis.md sections 1.6 and 4): the canonical
// header is Idempotency-Key (no X- prefix, no alias). The same key
// with the same request (method, path, guard, body) returns the
// stored success without re-running the mutation, for 24 hours. The
// same key with a different request answers 409
// idempotency_key_reused. Keys are scoped per user: one user's key
// never replays another user's response. Only successful (2xx)
// responses are stored; guard failures and validation errors are
// never replayed, so a corrected retry is always possible.
//
// Storage uses the existing idempotency_keys table (M1 schema, no
// migration): scope + key + request hash + response. The scope for
// all workspace write endpoints is the single string
// "workspace-write"; the path, guard, and body enter the request
// hash, so a key reused across paths or bodies is still detected.

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { idempotencyKeys, type Database } from '../../db/index.js';
import type {
  IdempotencyLookupInput,
  IdempotencyLookupResult,
  IdempotencyPort,
  StoredIdempotentResponse,
} from './write-ports.js';

export const IDEMPOTENCY_SCOPE = 'workspace-write';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

// Deterministic JSON stringify with sorted object keys, so the same
// logical body hashes the same regardless of key order on the wire.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

// Hashes the request identity for key-reuse detection: method,
// normalized path, canonical guard, and body hash. The body itself
// is never stored, only its hash.
export function hashIdempotencyRequest(input: {
  method: string;
  path: string;
  guard: string;
  bodyHash: string;
}): string {
  return createHash('sha256')
    .update(`${input.method}\n${input.path}\n${input.guard}\n${input.bodyHash}`, 'utf8')
    .digest('hex');
}

export function hashBytes(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isStoredResponse(value: unknown): value is StoredIdempotentResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['status'] !== 'number' || typeof record['data'] !== 'object' || record['data'] === null) {
    return false;
  }
  const headers = record['headers'];
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    return false;
  }
  const h = headers as Record<string, unknown>;
  return (
    typeof h['etag'] === 'string' && typeof h['revision'] === 'string' && typeof h['lastModified'] === 'string'
  );
}

export function createPgIdempotencyStore(db: Database): IdempotencyPort {
  return {
    async lookup(input: IdempotencyLookupInput): Promise<IdempotencyLookupResult> {
      const rows = await db
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.userId, input.userId),
            eq(idempotencyKeys.scope, input.scope),
            eq(idempotencyKeys.key, input.key),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return { outcome: 'miss' };
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        return { outcome: 'miss' };
      }
      if (row.requestHash !== input.requestHash) {
        return { outcome: 'reused' };
      }
      if (!isStoredResponse(row.responseBody)) {
        return { outcome: 'miss' };
      }
      return { outcome: 'hit', response: row.responseBody };
    },

    async store(input: IdempotencyLookupInput & { response: StoredIdempotentResponse }): Promise<void> {
      const now = new Date();
      await db
        .insert(idempotencyKeys)
        .values({
          userId: input.userId,
          scope: input.scope,
          key: input.key,
          requestHash: input.requestHash,
          responseStatus: input.response.status,
          responseBody: input.response,
          createdAt: now,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        })
        .onConflictDoUpdate({
          target: [idempotencyKeys.userId, idempotencyKeys.scope, idempotencyKeys.key],
          set: {
            requestHash: input.requestHash,
            responseStatus: input.response.status,
            responseBody: input.response,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
          },
        });
    },
  };
}
