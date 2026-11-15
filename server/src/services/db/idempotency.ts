// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Idempotency storage for POST /api/transactions (kontrak 1.6 and
// 3.4, V1-03 section 4.3 rule 6).
//
// Semantics: a key plus the request body hash is stored in
// idempotency_keys for 24 hours, in the same transaction as the
// operations. The same key with the same body replays the stored
// success response without executing the operations again (CT-I1).
// The same key with a different body answers 409
// idempotency_key_reused (CT-I2). Only success responses are
// stored: a failed request is never replayed. An expired row is
// deleted on lookup so the key can be reused (CT-I3).
//
// Scope is `workspace:<workspaceId>` per user, matching the
// idempotency_keys table design. Two different users, or two
// workspaces, never share a key namespace.
//
// Known limitation: two requests carrying the same key that arrive
// concurrently may both pass the lookup before either commits. The
// unique index then rejects the second insert, and dispatch
// answers 409 idempotency_key_reused instead of replaying the
// stored response. No double execution is visible (the second
// transaction rolls back), but the client must retry with a fresh
// read instead of receiving the replay. A lock-based single-flight
// refinement is future work; the safe behavior (no double apply)
// is preserved.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { idempotencyKeys } from '../../db/index.js';
import { IDEMPOTENCY_TTL_MS } from './kinds.js';
import type { DbTransaction } from './registry.js';

export interface IdempotencyLookupInput {
  userId: string;
  scope: string;
  key: string;
}

export interface StoredIdempotencyResponse {
  requestHash: string;
  status: number;
  data: unknown;
}

export interface IdempotencyStore {
  find(tx: DbTransaction, input: IdempotencyLookupInput): Promise<StoredIdempotencyResponse | null>;
  store(
    tx: DbTransaction,
    input: IdempotencyLookupInput & { requestHash: string },
    response: { status: number; data: unknown },
  ): Promise<void>;
}

export function idempotencyScope(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export const drizzleIdempotencyStore: IdempotencyStore = {
  async find(tx: DbTransaction, input: IdempotencyLookupInput): Promise<StoredIdempotencyResponse | null> {
    const rows = await tx
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
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    if (row.expiresAt.getTime() <= Date.now()) {
      await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.id, row.id));
      return null;
    }
    return { requestHash: row.requestHash, status: row.responseStatus, data: row.responseBody };
  },

  async store(
    tx: DbTransaction,
    input: IdempotencyLookupInput & { requestHash: string },
    response: { status: number; data: unknown },
  ): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({
        userId: input.userId,
        scope: input.scope,
        key: input.key,
        requestHash: input.requestHash,
        responseStatus: response.status,
        responseBody: response.data,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(
          409,
          'idempotency_key_reused',
          'The idempotency key was reused with a different request.',
        );
      }
      throw error;
    }
  },
};
