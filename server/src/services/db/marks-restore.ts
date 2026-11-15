// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: marks.restore.
//
// Upstream: restoreMark. Clears deletedAt and refreshes updatedAt,
// and bumps version so a guarded update against the old version
// conflicts afterwards (kontrak 3.5: restore raises version by 1).
// The mark_tags rows are preserved, so the restored mark keeps its
// full tag set (kind split note section 3; catalog idempotency
// note). createdAt is NOT rewritten: upstream rewrote createdAt on
// delete/restore, but the web schema keeps createdAt immutable and
// the catalog row for this kind names only deleted_at.
//
// Pruning tags that no longer exist, and falling back to the
// default Idea tag when the set becomes empty, is REST route work
// (kontrak 3.5 POST /api/marks/:markId/restore); the kind layer
// restores the row only and never invents a tag.
//
// A repeat on an already active mark is a no-op: it writes
// nothing and reports affected 0 with the current version, so the
// row keeps its updatedAt and version (kontrak 3.5 and desain
// 3.8: restoring an already active record answers 200 without a
// new change).
//
// A missing row, including a row owned by another workspace,
// answers the generic 404 not_found, indistinguishable from a
// missing row, following the canvases and conversations handler
// precedents. The REST route (a later task) propagates the same
// error.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { marks, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'marks.restore' as const;

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
    .select()
    .from(marks)
    .where(and(eq(marks.workspaceId, ctx.workspaceId), eq(marks.id, op.id)))
    .limit(1)
    .for('update');
  const current = rows[0];
  if (current === undefined) {
    throw ApiError.notFound();
  }
  if (current.deletedAt === null) {
    return { affected: 0, id: current.id, version: current.version };
  }
  const nextVersion = current.version + 1;
  await ctx.tx
    .update(marks)
    .set({ deletedAt: null, updatedAt: new Date(), version: nextVersion })
    .where(eq(marks.id, current.id));
  return { affected: 1, id: current.id, version: nextVersion };
}
