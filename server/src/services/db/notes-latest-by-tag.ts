// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: notes.latestByTag.
//
// Upstream: getNoteByTagId. Returns the newest note row for one tag:
// at most one row, ordered by createdAt descending with id descending
// as the stable tiebreak, or an empty array when the workspace has no
// note for the tag. A tag owned by another workspace, or a tag that
// does not exist, is indistinguishable from a tag with no note: the
// answer is empty, never an error. Notes are the note index rows in
// the notes table (design M2); they are not workspace files and this
// handler never touches the filesystem.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, desc, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { notes, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'notes.latestByTag' as const;

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
  tagId: number;
}

export interface NoteRow {
  id: number;
  tagId: number;
  content?: string;
  locale: string;
  count: string;
  createdAt: number;
}

type DbRow = typeof notes.$inferSelect;

function mapRow(row: DbRow): NoteRow {
  return {
    id: row.id,
    tagId: row.tagId,
    ...(row.content === null ? {} : { content: row.content }),
    locale: row.locale,
    count: row.count,
    createdAt: row.createdAt.getTime(),
  };
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
    if (key !== 'kind' && key !== 'tagId') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (typeof op.tagId !== 'number' || !Number.isInteger(op.tagId)) {
    throw validationIssue('tagId', 'must be an integer');
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<readonly NoteRow[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(notes)
    .where(and(eq(notes.workspaceId, ctx.workspaceId), eq(notes.tagId, op.tagId)))
    .orderBy(desc(notes.createdAt), desc(notes.id))
    .limit(1);
  return rows.map(mapRow);
}
