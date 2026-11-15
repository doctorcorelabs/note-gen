// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: marks.get.
//
// Upstream: getMarkById. Returns the single row as a one-element
// array, or an empty array when no row exists in the caller's
// workspace. A row owned by another workspace is indistinguishable
// from a missing row. The row is returned regardless of its deleted
// state, matching upstream, which applies no deleted filter to the
// single-row read.
//
// The row carries the effective tag set from mark_tags: the primary
// tag is always included, ids are sorted ascending with no
// duplicates, and tagUpdatedAt is the marks.tag_updated_at value in
// epoch milliseconds, or 0 when the mark has never had its tag set
// written. The deletion timestamp itself is not exposed; callers
// read the deleted boolean only.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { markTags, marks, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'marks.get' as const;

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

export type MarkType = 'scan' | 'text' | 'image' | 'link' | 'file' | 'recording' | 'todo';

export interface MarkRow {
  id: number;
  tagId: number;
  tagIds: number[];
  tagUpdatedAt: number;
  type: MarkType;
  content?: string;
  desc?: string;
  url: string;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
  version: number;
  sourceId?: string | null;
}

type DbRow = typeof marks.$inferSelect;

function effectiveTagIds(primaryTagId: number, extraIds: readonly number[]): number[] {
  return [...new Set([primaryTagId, ...extraIds])].sort((a, b) => a - b);
}

function mapRow(row: DbRow, extraIds: readonly number[]): MarkRow {
  return {
    id: row.id,
    tagId: row.tagId,
    tagIds: effectiveTagIds(row.tagId, extraIds),
    tagUpdatedAt: row.tagUpdatedAt === null ? 0 : row.tagUpdatedAt.getTime(),
    type: row.type as MarkType,
    ...(row.content === null ? {} : { content: row.content }),
    ...(row.desc === null ? {} : { desc: row.desc }),
    url: row.url ?? '',
    deleted: row.deletedAt !== null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    version: row.version,
    sourceId: row.sourceId,
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
    if (key !== 'kind' && key !== 'id') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (typeof op.id !== 'number' || !Number.isInteger(op.id)) {
    throw validationIssue('id', 'must be an integer');
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<readonly MarkRow[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(marks)
    .where(and(eq(marks.workspaceId, ctx.workspaceId), eq(marks.id, op.id)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return [];
  }
  const tagRows = await ctx.tx
    .select({ tagId: markTags.tagId })
    .from(markTags)
    .where(and(eq(markTags.workspaceId, ctx.workspaceId), eq(markTags.markId, row.id)));
  return [mapRow(row, tagRows.map((tagRow) => tagRow.tagId))];
}
