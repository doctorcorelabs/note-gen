// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: knowledge.listSources.
//
// Upstream: getKnowledgeSources. Filters sourceTypes and statuses
// come from fixed enums; an empty filter array means no filter, as
// upstream. Order is updatedAt descending with sourceKey ascending as
// the deterministic tiebreak. Every query is scoped to the workspace
// id from the handler context; the workspace id is never an operation
// field.
//
// Cursor format (opaque to the client, derivable from the last row):
// "<updatedAtMs>:<sourceKey>" with the sourceKey part percent-encoded
// because source keys contain ':' and '/'. A malformed cursor answers
// 400 invalid_cursor. Limit defaults to 50 and clamps to 1..200; a
// limit below 1 or not an integer answers 400 invalid_limit. The
// response channel for a next cursor is not fixed by the catalog or
// the contract (the batch result entry carries rows only); callers
// derive the next cursor from the last returned row. That gap is
// recorded as a named debt in the wave report.
//
// The catalog mirror types are declared locally because the emit
// build (rootDir src) cannot import type files from the frontend
// tree.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, asc, desc, eq, gt, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { knowledgeSources, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'knowledge.listSources' as const;

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
  sourceTypes?: KnowledgeSourceType[];
  statuses?: KnowledgeIndexStatus[];
  cursor?: string;
  limit?: number;
}

export type KnowledgeSourceType = 'article' | 'record' | 'canvas';

export type KnowledgeIndexStatus = 'pending' | 'indexing' | 'ready' | 'failed';

export interface KnowledgeLocator {
  filePath?: string;
  markId?: number;
  tagId?: number;
  tagIds?: number[];
  canvasId?: string;
  nodeIds?: string[];
}

export interface KnowledgeSourceRow {
  sourceKey: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  title: string;
  contentHash: string;
  indexedHash?: string | null;
  updatedAt: number;
  locator: KnowledgeLocator;
  status: KnowledgeIndexStatus;
  error?: string | null;
}

const SOURCE_TYPES: readonly string[] = ['article', 'record', 'canvas'];
const STATUSES: readonly string[] = ['pending', 'indexing', 'ready', 'failed'];

interface CursorPosition {
  updatedAtMs: number;
  sourceKey: string;
}

function parseCursor(cursor: string): CursorPosition {
  const separator = cursor.indexOf(':');
  if (separator <= 0) {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  const updatedAtMs = Number(cursor.slice(0, separator));
  let sourceKey: string;
  try {
    sourceKey = decodeURIComponent(cursor.slice(separator + 1));
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0 || sourceKey === '') {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  return { updatedAtMs, sourceKey };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

function validateEnumArray(
  value: unknown,
  allowed: readonly string[],
  field: string,
): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && allowed.includes(entry))) {
    throw validationIssue(field, 'must be an array of known values');
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'sourceTypes' && key !== 'statuses' && key !== 'cursor' && key !== 'limit') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (op.sourceTypes !== undefined) {
    validateEnumArray(op.sourceTypes, SOURCE_TYPES, 'sourceTypes');
  }
  if (op.statuses !== undefined) {
    validateEnumArray(op.statuses, STATUSES, 'statuses');
  }
  if (op.cursor !== undefined && typeof op.cursor !== 'string') {
    throw validationIssue('cursor', 'must be a string');
  }
  if (op.cursor !== undefined) {
    parseCursor(op.cursor);
  }
  if (op.limit !== undefined && typeof op.limit !== 'number') {
    throw validationIssue('limit', 'must be a number');
  }
  if (op.limit !== undefined) {
    clampLimit(op.limit);
  }
}

type DbRow = typeof knowledgeSources.$inferSelect;

function mapRow(row: DbRow): KnowledgeSourceRow {
  return {
    sourceKey: row.sourceKey,
    sourceType: row.sourceType as KnowledgeSourceType,
    sourceId: row.sourceId,
    title: row.title ?? '',
    locator: row.locator as KnowledgeLocator,
    contentHash: row.contentHash,
    indexedHash: row.indexedHash,
    status: row.status as KnowledgeIndexStatus,
    error: row.error,
    updatedAt: row.updatedAt.getTime(),
  };
}

// DA08-01 anchor: the exact epoch microseconds of the cursor
// row, read in SQL. Postgres timestamps carry microseconds, but
// a JS Date (and therefore the cursor) carries only
// milliseconds, so the anchor must never pass through a Date.
// Returns null when the anchor row is gone or the value is not
// a plain decimal, in which case the caller falls back to the
// millisecond bucket predicate.
async function readAnchorMicros(ctx: HandlerContext, sourceKey: string): Promise<string | null> {
  const rows = await ctx.tx
    .select({ micros: sql`extract(epoch from ${knowledgeSources.updatedAt}) * 1000000` })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.workspaceId, ctx.workspaceId), eq(knowledgeSources.sourceKey, sourceKey)))
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
): Promise<readonly KnowledgeSourceRow[]> {
  validate(op);
  const limit = clampLimit(op.limit);
  const position = op.cursor === undefined ? null : parseCursor(op.cursor);
  const conditions: SQL[] = [eq(knowledgeSources.workspaceId, ctx.workspaceId)];
  if (op.sourceTypes !== undefined && op.sourceTypes.length > 0) {
    conditions.push(inArray(knowledgeSources.sourceType, op.sourceTypes));
  }
  if (op.statuses !== undefined && op.statuses.length > 0) {
    conditions.push(inArray(knowledgeSources.status, op.statuses));
  }
  if (position !== null) {
    // DA08-01: the cursor carries only milliseconds, but
    // Postgres timestamps carry microseconds. Anchoring the
    // page on the cursor row's exact epoch microseconds (read
    // in SQL, never truncated through a JS Date) keeps rows
    // that share the cursor millisecond from being duplicated
    // or skipped. When the anchor row is gone, the millisecond
    // bucket predicate below is the best available fallback.
    const anchorMicros = await readAnchorMicros(ctx, position.sourceKey);
    if (anchorMicros !== null) {
        const epochMicros = sql`extract(epoch from ${knowledgeSources.updatedAt}) * 1000000`;
        const after = or(
          sql`${epochMicros} < ${anchorMicros}`,
          and(sql`${epochMicros} = ${anchorMicros}`, gt(knowledgeSources.sourceKey, position.sourceKey)),
        );
        if (after !== undefined) {
          conditions.push(after);
        }
    } else {
      const cursorDate = new Date(position.updatedAtMs);
      const after = or(
        lt(knowledgeSources.updatedAt, cursorDate),
        and(
          eq(knowledgeSources.updatedAt, cursorDate),
          gt(knowledgeSources.sourceKey, position.sourceKey),
        ),
      );
      if (after !== undefined) {
        conditions.push(after);
      }
    }
  }
  const rows = await ctx.tx
    .select()
    .from(knowledgeSources)
    .where(and(...conditions))
    .orderBy(desc(knowledgeSources.updatedAt), asc(knowledgeSources.sourceKey))
    .limit(limit);
  return rows.map(mapRow);
}
