// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: tags.delete.
//
// Upstream `delTag`, as redefined by design D-03 (desain-record-search
// section 6.2, desain-sql-adapter section 3.4): deleting a tag NEVER
// marks records deleted. The upstream SQLite trigger
// `tags_trash_records_before_delete`, which trashed every related
// record, is rejected explicitly; AD-11 forbids silent data loss.
//
// Rules, in the order they are checked:
// - The tag must exist in the workspace, else 404 not_found (a row
//   owned by another workspace answers the same generic 404).
// - A locked tag is never deleted: 409 tag_locked (kontrak 3.6).
// - A tag still in use answers 409 tag_in_use with the affected
//   record count in details.recordCount (kontrak section 6.2),
//   unless `reassignTo` is given. "In use" counts distinct marks
//   that reference the tag (a mark_tags membership or the primary
//   tag), active and soft-deleted alike (soft delete keeps
//   mark_tags rows), plus notes that reference the tag: notes.tagId is a RESTRICT foreign
//   key, so a tag with notes is in use too, and refusing here keeps
//   the handler from surfacing a foreign-key failure as a 500.
//   Nothing is written on a refusal.
// - With `reassignTo`, the target must exist in the same workspace
//   and differ from the deleted tag: a missing or foreign target
//   answers 400 tag_not_found (the marks-create precedent, kontrak
//   section 6.2), and a target equal to the deleted tag is a
//   validation failure. In one transaction the handler moves every
//   primary (marks.tagId) to the target, moves every mark_tags
//   membership to the target (duplicates dropped: a mark already
//   carrying the target keeps one row), moves notes.tagId to the
//   target (the same FK-preserving move; notes follow the tag
//   rather than being deleted or orphaned), then deletes the tag
//   row. The primary invariant holds after the move: every moved
//   primary is present in mark_tags under the target.
// - No child-tag refusal and no last-tag refusal: upstream `delTag`
//   refused both, but neither rule appears in the catalog, the
//   contract, or D-03, so neither is enforced here. Deleting a
//   parent leaves descendant names untouched (names are plain
//   strings; no hierarchy row depends on the parent).
//
// Audit note: the catalog names audit_events as a touched table,
// but no audit event type for tags is locked and the handler
// context carries no request IP. This handler therefore writes no
// audit row, following the UTANG-AUDIT-01 precedent set by
// conversations.delete and canvases.save; the gap stays owned by
// the route worker that defines the audit convention. No audit
// value is invented here.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { marks, markTags, notes, tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'tags.delete' as const;

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
  reassignTo?: number;
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
    if (key !== 'kind' && key !== 'id' && key !== 'reassignTo') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (typeof op.id !== 'number' || !Number.isInteger(op.id)) {
    throw validationIssue('id', 'must be an integer');
  }
  if (
    op.reassignTo !== undefined &&
    (typeof op.reassignTo !== 'number' || !Number.isInteger(op.reassignTo))
  ) {
    throw validationIssue('reassignTo', 'must be an integer');
  }
  if (op.reassignTo !== undefined && op.reassignTo === op.id) {
    throw validationIssue('reassignTo', 'must differ from the deleted tag');
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const found = await ctx.tx
    .select()
    .from(tags)
    .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, op.id)))
    .limit(1)
    .for('update');
  const target = found[0];
  if (target === undefined) {
    throw ApiError.notFound();
  }
  if (target.isLocked) {
    throw new ApiError(409, 'tag_locked', 'The locked tag cannot be deleted.');
  }
  const memberships = await ctx.tx
    .select({ markId: markTags.markId })
    .from(markTags)
    .where(and(eq(markTags.workspaceId, ctx.workspaceId), eq(markTags.tagId, op.id)));
  const primaries = await ctx.tx
    .select({ id: marks.id })
    .from(marks)
    .where(and(eq(marks.workspaceId, ctx.workspaceId), eq(marks.tagId, op.id)));
  // The primary invariant (every primary is also a mark_tags row)
  // makes the two sets equal in healthy data; the union keeps the
  // reassignment correct even for a row that violates it.
  const usedMarkIds = [...new Set([...memberships.map((row) => row.markId), ...primaries.map((row) => row.id)])];
  const noteRows = await ctx.tx
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.workspaceId, ctx.workspaceId), eq(notes.tagId, op.id)));
  const inUse = usedMarkIds.length > 0 || noteRows.length > 0;
  if (op.reassignTo === undefined) {
    if (inUse) {
      throw new ApiError(
        409,
        'tag_in_use',
        'The tag is still in use. Reassign its records first.',
        // DA-6 TAG-04: notes count as in-use too, so the details
        // carry both counts instead of records alone.
        { details: { recordCount: usedMarkIds.length, noteCount: noteRows.length } },
      );
    }
    await ctx.tx
      .delete(tags)
      .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, op.id)));
    return { affected: 1, id: op.id };
  }
  const reassigned = await ctx.tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, op.reassignTo)))
    .limit(1);
  if (reassigned[0] === undefined) {
    throw new ApiError(400, 'tag_not_found', 'The referenced tag was not found in this workspace.', {
      details: { tagId: op.reassignTo },
    });
  }
  const now = new Date();
  await ctx.tx
    .update(marks)
    .set({ tagId: op.reassignTo, tagUpdatedAt: now, updatedAt: now })
    .where(and(eq(marks.workspaceId, ctx.workspaceId), eq(marks.tagId, op.id)));
  await ctx.tx
    .delete(markTags)
    .where(and(eq(markTags.workspaceId, ctx.workspaceId), eq(markTags.tagId, op.id)));
  if (usedMarkIds.length > 0) {
    await ctx.tx
      .insert(markTags)
      .values(
        usedMarkIds.map((markId) => ({ markId, tagId: op.reassignTo as number, workspaceId: ctx.workspaceId })),
      )
      .onConflictDoNothing();
  }
  await ctx.tx
    .update(notes)
    .set({ tagId: op.reassignTo })
    .where(and(eq(notes.workspaceId, ctx.workspaceId), eq(notes.tagId, op.id)));
  await ctx.tx
    .delete(tags)
    .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, op.id)));
  return { affected: 1, id: op.id };
}
