// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: marks.saveTagIds.
//
// Replacement of upstream saveMarkTagIds (design section 1.3 rule 6):
// delete every join row for the mark, then insert the new set in the
// same transaction. Unlike the guarded tag-set operation, this kind
// has no expected guard and no new-name creation. Its tagId field is
// the primary tag: it is always included in the stored set, and the
// marks tag_id column is set to it, so the primary invariant (the
// primary pair is always present in the join table) holds even when
// the caller passes a primary different from the stored one. Every
// upstream call site passes the mark current primary, so the two
// readings coincide in practice; the catalog wording (tagId is the
// primary tag) decides the divergent case.
//
// An undefined tagIds field is a preserve no-op: nothing is written,
// no tag is validated, and the result reports affected 0 with the
// current version. An empty array is not a no-op: it stores the
// primary tag alone. When tagIds is present, every referenced tag,
// including the primary, must exist in this workspace, or the answer
// is 400 tag_not_found (kontrak section 6.2); unknown ids are
// rejected here, not silently filtered as in the guarded operation.
// A successful replace refreshes tag_updated_at but does not bump
// version: the catalog idempotency note for this kind names only the
// timestamp refresh. A missing mark answers 404. Soft-deleted marks
// are not rejected: upstream saveMarkTagIds writes regardless of the
// deleted flag and no canonical rule rejects them here.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { markTags, marks, tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'marks.saveTagIds' as const;

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
  tagId: number;
  tagIds?: number[];
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'id' && key !== 'tagId' && key !== 'tagIds') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (typeof op.id !== 'number' || !Number.isInteger(op.id)) {
    throw validationIssue('id', 'must be an integer');
  }
  if (typeof op.tagId !== 'number' || !Number.isInteger(op.tagId)) {
    throw validationIssue('tagId', 'must be an integer');
  }
  if (
    op.tagIds !== undefined &&
    (!Array.isArray(op.tagIds) ||
      op.tagIds.some((entry) => typeof entry !== 'number' || !Number.isInteger(entry)))
  ) {
    throw validationIssue('tagIds', 'must be an array of integers');
  }
}

function sortedUnique(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const locked = await ctx.tx
    .select()
    .from(marks)
    .where(and(eq(marks.workspaceId, ctx.workspaceId), eq(marks.id, op.id)))
    .limit(1)
    .for('update');
  const current = locked[0];
  if (current === undefined) {
    throw ApiError.notFound();
  }
  if (op.tagIds === undefined) {
    return { affected: 0, id: current.id, version: current.version };
  }
  const wanted = sortedUnique([op.tagId, ...op.tagIds]);
  const workspaceTags = await ctx.tx
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.workspaceId, ctx.workspaceId));
  const validIds = new Set(workspaceTags.map((row) => row.id));
  if (wanted.some((id) => !validIds.has(id))) {
    throw new ApiError(400, 'tag_not_found', 'A referenced tag does not exist in this workspace.');
  }
  const now = new Date();
  await ctx.tx.delete(markTags).where(eq(markTags.markId, current.id));
  await ctx.tx.insert(markTags).values(
    wanted.map((tagId) => ({ markId: current.id, tagId, workspaceId: ctx.workspaceId })),
  );
  await ctx.tx
    .update(marks)
    .set({ tagId: op.tagId, tagUpdatedAt: now, updatedAt: now })
    .where(eq(marks.id, current.id));
  return { affected: 1, id: current.id, version: current.version };
}
