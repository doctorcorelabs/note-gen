// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: marks.list.
//
// Upstream: getAllMarks. Order is createdAt descending with id
// descending as the stable tiebreak. There is no tag filter on this
// kind (D-01): tag filtering lives only in marks.listByTag, so a
// tagId field here is rejected as an unknown field. The deletion
// filter is three-valued (D-02): active (default), deleted, or all.
// Rows carry full content; the 500-character truncation of upstream
// preview functions is a presentation concern, not a row shape.
//
// Every row carries the effective tag set from mark_tags: the primary
// tag is always included, ids are sorted ascending with no
// duplicates, and tagUpdatedAt is the marks.tag_updated_at value in
// epoch milliseconds, or 0 when the mark has never had its tag set
// written. The deletion timestamp itself is not exposed; trash
// listings read the deleted boolean only.
//
// Cursor format (opaque to the client, derivable from the last row):
// "<createdAtMs>:<id>". A malformed cursor answers 400
// invalid_cursor. Limit defaults to 50 and clamps to 1..200; a limit
// below 1 or not an integer answers 400 invalid_limit. Every query is
// scoped to the workspace id from the handler context; the workspace
// id is never an operation field.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { markTags, marks, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'marks.list' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export type DeletedFilter = 'active' | 'deleted' | 'all';

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  deleted?: DeletedFilter;
  cursor?: string;
  limit?: number;
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

async function loadTagIds(
  ctx: HandlerContext,
  markIds: readonly number[],
): Promise<Map<number, number[]>> {
  const byMark = new Map<number, number[]>();
  if (markIds.length === 0) {
    return byMark;
  }
  const rows = await ctx.tx
    .select({ markId: markTags.markId, tagId: markTags.tagId })
    .from(markTags)
    .where(and(eq(markTags.workspaceId, ctx.workspaceId), inArray(markTags.markId, [...markIds])));
  for (const row of rows) {
    const list = byMark.get(row.markId) ?? [];
    list.push(row.tagId);
    byMark.set(row.markId, list);
  }
  return byMark;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ApiError(400, 'invalid_limit', 'The pagination limit is not valid.');
  }
  return Math.min(limit, 200);
}

interface CursorPosition {
  createdAtMs: number;
  id: number;
}

function parseCursor(cursor: string): CursorPosition {
  const match = /^(\d+):(\d+)$/.exec(cursor);
  if (match === null) {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  const createdAtMs = Number(match[1]);
  const id = Number(match[2]);
  if (!Number.isSafeInteger(createdAtMs) || !Number.isSafeInteger(id)) {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  return { createdAtMs, id };
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
    if (key !== 'kind' && key !== 'deleted' && key !== 'cursor' && key !== 'limit') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (
    op.deleted !== undefined &&
    op.deleted !== 'active' &&
    op.deleted !== 'deleted' &&
    op.deleted !== 'all'
  ) {
    throw validationIssue('deleted', 'must be one of active, deleted, all');
  }
  if (op.cursor !== undefined) {
    if (typeof op.cursor !== 'string') {
      throw validationIssue('cursor', 'must be a string');
    }
    parseCursor(op.cursor);
  }
  if (op.limit !== undefined) {
    if (typeof op.limit !== 'number') {
      throw validationIssue('limit', 'must be a number');
    }
    clampLimit(op.limit);
  }
}

// DA08-01 anchor: the exact epoch microseconds of the cursor
// row, read in SQL. Postgres timestamps carry microseconds, but
// a JS Date (and therefore the cursor) carries only
// milliseconds, so the anchor must never pass through a Date.
// Returns null when the anchor row is gone or the value is not
// a plain decimal, in which case the caller falls back to the
// millisecond bucket predicate.
async function readAnchorMicros(ctx: HandlerContext, id: number): Promise<string | null> {
  const rows = await ctx.tx
    .select({ micros: sql`extract(epoch from ${marks.createdAt}) * 1000000` })
    .from(marks)
    .where(and(eq(marks.workspaceId, ctx.workspaceId), eq(marks.id, id)))
    .limit(1);
  if (rows.length === 0) {
    return null;
  }
  const raw: unknown = rows[0].micros;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? String(raw) : null;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<readonly MarkRow[]> {
  validate(op);
  const limit = clampLimit(op.limit);
  const position = op.cursor === undefined ? null : parseCursor(op.cursor);
  const deleted = op.deleted ?? 'active';
  const conditions: SQL[] = [eq(marks.workspaceId, ctx.workspaceId)];
  if (deleted === 'active') {
    conditions.push(isNull(marks.deletedAt));
  } else if (deleted === 'deleted') {
    conditions.push(isNotNull(marks.deletedAt));
  }
  if (position !== null) {
    // DA08-01: the cursor carries only milliseconds, but
    // Postgres timestamps carry microseconds. Anchoring the
    // page on the cursor row's exact epoch microseconds (read
    // in SQL, never truncated through a JS Date) keeps rows
    // that share the cursor millisecond from being duplicated
    // or skipped. When the anchor row is gone, the millisecond
    // bucket predicate below is the best available fallback.
    const anchorMicros = await readAnchorMicros(ctx, position.id);
    if (anchorMicros !== null) {
        const epochMicros = sql`extract(epoch from ${marks.createdAt}) * 1000000`;
        const after = or(
          sql`${epochMicros} < ${anchorMicros}`,
          and(sql`${epochMicros} = ${anchorMicros}`, lt(marks.id, position.id)),
        );
        if (after !== undefined) {
          conditions.push(after);
        }
    } else {
      const at = new Date(position.createdAtMs);
      const next = new Date(position.createdAtMs + 1);
      // Postgres timestamps carry microseconds, but the cursor carries
      // milliseconds (the precision of a JS Date). Rows sharing the
      // cursor's millisecond fall in [at, next); within that bucket the
      // id tiebreak applies. An exact equality on the timestamp would
      // miss every row whose microseconds are nonzero.
      const after = or(
        lt(marks.createdAt, at),
        and(gte(marks.createdAt, at), lt(marks.createdAt, next), lt(marks.id, position.id)),
      );
      if (after !== undefined) {
        conditions.push(after);
      }
    }
  }
  const rows = await ctx.tx
    .select()
    .from(marks)
    .where(and(...conditions))
    .orderBy(desc(marks.createdAt), desc(marks.id))
    .limit(limit);
  const tagIdsByMark = await loadTagIds(ctx, rows.map((row) => row.id));
  return rows.map((row) => mapRow(row, tagIdsByMark.get(row.id) ?? []));
}
