// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: vector.clear (BUG-03).
//
// Upstream: clearVectorDb. Deletes every vector chunk in the
// session workspace. This is the first real vector write kind
// in Fase 1; the other vector writes (replace/upsert/rename/
// delete per file) stay legacy/stub Fase 2 work. The result
// `affected` is the deleted chunk count. Destructive by
// design: the UI confirm (deleteVectorConfirm) gates the call,
// and the delete is workspace-scoped like every other handler.
//
// This file stands alone: it imports only trunk modules (the
// Drizzle schema accessor, the canonical error type,
// drizzle-orm). It imports no other handler file and no shared
// helper.

import { eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { vectorChunks, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'vector.clear' as const;

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
    if (key !== 'kind') {
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
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const deleted = await ctx.tx
    .delete(vectorChunks)
    .where(eq(vectorChunks.workspaceId, ctx.workspaceId))
    .returning({ id: vectorChunks.id });
  return { affected: deleted.length };
}
