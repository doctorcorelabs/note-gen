// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: tags.list.
//
// Upstream: getTags. Order is sortOrder ascending, then id ascending.
// This is the only kind that fills the total field (D-09): total
// counts distinct non-deleted marks in the tag subtree, where a
// subtree is the tag itself plus every tag whose name starts with
// the parent name followed by a slash. Membership is the union of a
// mark primary tag and its rows in the join table, exactly mirroring
// the upstream membership CTE over marks plus record_tag_metadata.
// Deleted marks never count. Totals are aggregated in code from
// three workspace-scoped Drizzle selects, following the aggregation
// precedent of the stats handlers; no raw SQL string is used.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, asc, eq, isNull } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { markTags, marks, notes, tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'tags.list' as const;

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

export interface TagRow {
  id: number;
  name: string;
  isLocked: boolean;
  isPin: boolean;
  sortOrder: number;
  total: number;
  // DA-6 TAG-04: direct usage for the delete dialog - distinct
  // marks referencing this tag itself (membership or primary,
  // soft-deleted included, mirroring the tags.delete in-use rule)
  // and notes referencing this tag. `total` above stays the
  // subtree badge count; the two definitions answer different
  // questions and are no longer conflated.
  directTotal: number;
  noteCount: number;
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

function tagPathMatches(name: string, parent: string): boolean {
  return name === parent || name.startsWith(`${parent}/`);
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<readonly TagRow[]> {
  validate(op);
  const tagRows = await ctx.tx
    .select()
    .from(tags)
    .where(eq(tags.workspaceId, ctx.workspaceId))
    .orderBy(asc(tags.sortOrder), asc(tags.id));
  const liveMarks = await ctx.tx
    .select({ id: marks.id, tagId: marks.tagId })
    .from(marks)
    .where(and(eq(marks.workspaceId, ctx.workspaceId), isNull(marks.deletedAt)));
  const liveMarkIds = new Set(liveMarks.map((row) => row.id));
  const linkRows = await ctx.tx
    .select({ markId: markTags.markId, tagId: markTags.tagId })
    .from(markTags)
    .where(eq(markTags.workspaceId, ctx.workspaceId));
  // DA-6 TAG-04: direct counts include soft-deleted marks, exactly
  // like the tags.delete in-use rule, so all marks are read here
  // (the live-only set above stays the badge `total` basis).
  const allMarks = await ctx.tx
    .select({ id: marks.id, tagId: marks.tagId })
    .from(marks)
    .where(eq(marks.workspaceId, ctx.workspaceId));
  const directByTag = new Map<number, Set<number>>();
  const addDirect = (tagId: number, markId: number): void => {
    const members = directByTag.get(tagId) ?? new Set<number>();
    members.add(markId);
    directByTag.set(tagId, members);
  };
  for (const row of allMarks) {
    addDirect(row.tagId, row.id);
  }
  for (const row of linkRows) {
    addDirect(row.tagId, row.markId);
  }
  const noteRows = await ctx.tx
    .select({ tagId: notes.tagId })
    .from(notes)
    .where(eq(notes.workspaceId, ctx.workspaceId));
  const notesByTag = new Map<number, number>();
  for (const row of noteRows) {
    notesByTag.set(row.tagId, (notesByTag.get(row.tagId) ?? 0) + 1);
  }
  const membersByTag = new Map<number, Set<number>>();
  const addMember = (tagId: number, markId: number): void => {
    const members = membersByTag.get(tagId) ?? new Set<number>();
    members.add(markId);
    membersByTag.set(tagId, members);
  };
  for (const row of liveMarks) {
    addMember(row.tagId, row.id);
  }
  for (const row of linkRows) {
    if (liveMarkIds.has(row.markId)) {
      addMember(row.tagId, row.markId);
    }
  }
  return tagRows.map((tag) => {
    const counted = new Set<number>();
    for (const child of tagRows) {
      if (tagPathMatches(child.name, tag.name)) {
        const members = membersByTag.get(child.id);
        if (members !== undefined) {
          for (const markId of members) {
            counted.add(markId);
          }
        }
      }
    }
    return {
      id: tag.id,
      name: tag.name,
      isLocked: tag.isLocked,
      isPin: tag.isPin,
      sortOrder: tag.sortOrder,
      total: counted.size,
      directTotal: directByTag.get(tag.id)?.size ?? 0,
      noteCount: notesByTag.get(tag.id) ?? 0,
    };
  });
}
