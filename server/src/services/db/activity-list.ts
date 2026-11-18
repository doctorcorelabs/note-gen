// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: activity.list.
//
// Upstream: getAllActivityEvents. Order is createdAt descending with
// id descending as the stable tiebreak. The optional source filter
// takes only the fixed activity source enum. Every query is scoped
// to the workspace id from the handler context.
//
// Cursor format (opaque to the client, derivable from the last row):
// "<createdAtMs>:<id>". The cursor is anchored on the last row's id
// plus its sort key, following the established pattern for
// createdAt-ordered lists: a bare id cannot page this list correctly
// because activity rows may carry client-supplied createdAt values
// that do not follow insertion order. A malformed cursor answers 400
// invalid_cursor. Limit defaults to 50 and clamps to 1..200; a limit
// below 1 or not an integer answers 400 invalid_limit.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, desc, eq, gte, lt, or, sql, type SQL } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { activityEvents, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'activity.list' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export type ActivitySource = 'record' | 'chat' | 'writing' | 'canvas';

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  source?: ActivitySource;
  cursor?: string;
  limit?: number;
}

export interface ActivityEventRow {
  id: number;
  source: ActivitySource;
  title: string;
  description?: string | null;
  path?: string | null;
  tagId?: number | null;
  dedupeKey?: string | null;
  createdAt: number;
}

type DbRow = typeof activityEvents.$inferSelect;

function mapRow(row: DbRow): ActivityEventRow {
  return {
    id: row.id,
    source: row.source as ActivitySource,
    title: row.title,
    description: row.description,
    path: row.path,
    tagId: row.tagId,
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt.getTime(),
  };
}

const SOURCES: readonly string[] = ['record', 'chat', 'writing', 'canvas'];

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
    if (key !== 'kind' && key !== 'source' && key !== 'cursor' && key !== 'limit') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (op.source !== undefined && (typeof op.source !== 'string' || !SOURCES.includes(op.source))) {
    throw validationIssue('source', 'must be a known activity source');
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
    .select({ micros: sql`extract(epoch from ${activityEvents.createdAt}) * 1000000` })
    .from(activityEvents)
    .where(and(eq(activityEvents.workspaceId, ctx.workspaceId), eq(activityEvents.id, id)))
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

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly ActivityEventRow[]> {
  validate(op);
  const limit = clampLimit(op.limit);
  const position = op.cursor === undefined ? null : parseCursor(op.cursor);
  const conditions: SQL[] = [eq(activityEvents.workspaceId, ctx.workspaceId)];
  if (op.source !== undefined) {
    conditions.push(eq(activityEvents.source, op.source));
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
        const epochMicros = sql`extract(epoch from ${activityEvents.createdAt}) * 1000000`;
        const after = or(
          sql`${epochMicros} < ${anchorMicros}`,
          and(sql`${epochMicros} = ${anchorMicros}`, lt(activityEvents.id, position.id)),
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
        lt(activityEvents.createdAt, at),
        and(
          gte(activityEvents.createdAt, at),
          lt(activityEvents.createdAt, next),
          lt(activityEvents.id, position.id),
        ),
      );
      if (after !== undefined) {
        conditions.push(after);
      }
    }
  }
  const rows = await ctx.tx
    .select()
    .from(activityEvents)
    .where(and(...conditions))
    .orderBy(desc(activityEvents.createdAt), desc(activityEvents.id))
    .limit(limit);
  return rows.map(mapRow);
}
