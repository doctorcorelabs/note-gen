// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: conversations.delete.
//
// Deletes the conversation row only. Messages, compactions, and
// memory_jobs rows for the conversation are removed by foreign key
// cascade (G-05); this handler issues no per-table delete and writes
// no sync tombstone. There is no conversation soft delete.
//
// Audit note: the design requires an audit_events row in the same
// transaction, but the handler context carries no IP hash and the
// audit table requires one, and no target type convention is locked.
// This handler therefore writes no audit row; the gap is recorded as
// named debt UTANG-AUDIT-01 in the wave report, owned by the route
// worker that defines the handler context. No audit value is
// invented here.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { conversations, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'conversations.delete' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  id: number;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'operation', issue: 'must be an object' }],
    });
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'id') {
      throw ApiError.validation('Request validation failed.', {
        fields: [{ field: key, issue: 'unknown field' }],
      });
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'kind', issue: 'must match the handler kind' }],
    });
  }
  if (typeof op.id !== 'number' || !Number.isInteger(op.id)) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'id', issue: 'must be an integer' }],
    });
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const rows = await ctx.tx
    .delete(conversations)
    .where(and(eq(conversations.workspaceId, ctx.workspaceId), eq(conversations.id, op.id)))
    .returning({ id: conversations.id });
  const deleted = rows[0];
  if (deleted === undefined) {
    throw ApiError.notFound();
  }
  return { affected: 1, id: deleted.id };
}
