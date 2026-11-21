// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: marks.emptyTrash (BUG-01).
//
// Upstream: clearTrash. Permanently deletes every soft-deleted
// mark in the session workspace in one transaction, mirroring
// the REST repository emptyTrash (drizzle-repository.ts): the
// mark_tags rows go first, then the mark rows, then one
// activity event records the purge. The result `affected` is
// the purged count. Asset cleanup stays client-side: the
// caller reads the trashed rows before calling (asset keys
// never leave the handler, per the registry contract that a
// handler must not touch the filesystem inside the
// transaction).
//
// An empty trash is not an error: affected 0, and the activity
// event still records the (empty) purge, matching the REST
// repository.
//
// This file stands alone: it imports only trunk modules (the
// Drizzle schema accessor, the canonical error type,
// drizzle-orm). It imports no other handler file and no shared
// helper.

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { activityEvents, markTags, marks, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'marks.emptyTrash' as const;

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
  const trashed = await ctx.tx
    .select({ id: marks.id })
    .from(marks)
    .where(and(eq(marks.workspaceId, ctx.workspaceId), isNotNull(marks.deletedAt)));
  if (trashed.length > 0) {
    const ids = trashed.map((row) => row.id);
    await ctx.tx
      .delete(markTags)
      .where(and(eq(markTags.workspaceId, ctx.workspaceId), inArray(markTags.markId, ids)));
    await ctx.tx
      .delete(marks)
      .where(and(eq(marks.workspaceId, ctx.workspaceId), inArray(marks.id, ids)));
  }
  await ctx.tx.insert(activityEvents).values({
    workspaceId: ctx.workspaceId,
    tagId: null,
    source: 'record',
    title: 'Trash emptied',
    description: `${trashed.length} record(s) permanently deleted.`,
    dedupeKey: null,
    createdAt: new Date(),
  });
  return { affected: trashed.length };
}
