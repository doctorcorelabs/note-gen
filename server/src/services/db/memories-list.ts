// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: memories.list.
//
// Filter behavior follows upstream getAllMemories and
// getMemoriesByCategory: a status filter narrows to that one status;
// without it, includeInactive lifts the default filter; otherwise
// only active plus pending rows are returned. A category filter
// applies on top. Order is updatedAt descending with id descending
// as the stable tiebreak. The embedding payload is never returned.
//
// Cursor format (opaque to the client, derivable from the last row):
// "<updatedAtMs>:<id>". A malformed cursor answers 400
// invalid_cursor. Limit defaults to 50 and clamps to 1..200; a limit
// below 1 or not an integer answers 400 invalid_limit. Every query is
// scoped to the workspace id from the handler context.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { memories, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'memories.list' as const;

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
  status?: 'active' | 'pending' | 'archived';
  category?: 'preference' | 'memory';
  includeInactive?: boolean;
  cursor?: string;
  limit?: number;
}

export interface MemoryRow {
  id: string;
  content: string;
  category: 'preference' | 'memory';
  kind: 'preference' | 'fact' | 'experience' | 'decision';
  scopeType: 'global' | 'workspace';
  scopeId?: string;
  applyMode: 'always' | 'relevant';
  status: 'active' | 'pending' | 'archived';
  origin: 'manual' | 'explicit_chat' | 'auto_chat';
  confidence: number;
  conflictKey?: string;
  replacedId?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  indexingStatus: 'ready' | 'pending' | 'failed';
  sensitivity: 'normal' | 'suspected_sensitive';
  accessCount: number;
  lastAccessedAt: number;
  lastRecallReason?: string;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

type DbRow = typeof memories.$inferSelect;

function mapRow(row: DbRow): MemoryRow {
  return {
    id: row.id,
    content: row.content,
    category: row.category as MemoryRow['category'],
    kind: row.kind as MemoryRow['kind'],
    scopeType: row.scopeType as MemoryRow['scopeType'],
    ...(row.scopeId === null ? {} : { scopeId: row.scopeId }),
    applyMode: row.applyMode as MemoryRow['applyMode'],
    status: row.status as MemoryRow['status'],
    origin: row.origin as MemoryRow['origin'],
    confidence: row.confidence,
    ...(row.conflictKey === null ? {} : { conflictKey: row.conflictKey }),
    ...(row.replacedId === null ? {} : { replacedId: row.replacedId }),
    ...(row.embeddingModel === null ? {} : { embeddingModel: row.embeddingModel }),
    ...(row.embeddingDimensions === null ? {} : { embeddingDimensions: row.embeddingDimensions }),
    indexingStatus: row.indexingStatus as MemoryRow['indexingStatus'],
    sensitivity: row.sensitivity as MemoryRow['sensitivity'],
    accessCount: row.accessCount,
    lastAccessedAt: row.lastAccessedAt === null ? 0 : row.lastAccessedAt.getTime(),
    ...(row.lastRecallReason === null ? {} : { lastRecallReason: row.lastRecallReason }),
    ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt.getTime() }),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

const STATUSES: readonly string[] = ['active', 'pending', 'archived'];
const CATEGORIES: readonly string[] = ['preference', 'memory'];

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
  updatedAtMs: number;
  id: string;
}

function parseCursor(cursor: string): CursorPosition {
  const split = cursor.indexOf(':');
  if (split <= 0) {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  const updatedAtMs = Number(cursor.slice(0, split));
  const id = cursor.slice(split + 1);
  if (!Number.isSafeInteger(updatedAtMs) || id === '') {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  return { updatedAtMs, id };
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
    if (
      key !== 'kind' &&
      key !== 'status' &&
      key !== 'category' &&
      key !== 'includeInactive' &&
      key !== 'cursor' &&
      key !== 'limit'
    ) {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (op.status !== undefined && (typeof op.status !== 'string' || !STATUSES.includes(op.status))) {
    throw validationIssue('status', 'must be a known memory status');
  }
  if (
    op.category !== undefined &&
    (typeof op.category !== 'string' || !CATEGORIES.includes(op.category))
  ) {
    throw validationIssue('category', 'must be a known memory category');
  }
  if (op.includeInactive !== undefined && typeof op.includeInactive !== 'boolean') {
    throw validationIssue('includeInactive', 'must be a boolean');
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
async function readAnchorMicros(ctx: HandlerContext, id: string): Promise<string | null> {
  const rows = await ctx.tx
    .select({ micros: sql`extract(epoch from ${memories.updatedAt}) * 1000000` })
    .from(memories)
    .where(and(eq(memories.workspaceId, ctx.workspaceId), eq(memories.id, id)))
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

export async function handle(ctx: HandlerContext, op: unknown): Promise<readonly MemoryRow[]> {
  validate(op);
  const limit = clampLimit(op.limit);
  const position = op.cursor === undefined ? null : parseCursor(op.cursor);
  const conditions: SQL[] = [eq(memories.workspaceId, ctx.workspaceId)];
  if (op.status !== undefined) {
    conditions.push(eq(memories.status, op.status));
  } else if (op.includeInactive !== true) {
    conditions.push(inArray(memories.status, ['active', 'pending']));
  }
  if (op.category !== undefined) {
    conditions.push(eq(memories.category, op.category));
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
        const epochMicros = sql`extract(epoch from ${memories.updatedAt}) * 1000000`;
        const after = or(
          sql`${epochMicros} < ${anchorMicros}`,
          and(sql`${epochMicros} = ${anchorMicros}`, lt(memories.id, position.id)),
        );
        if (after !== undefined) {
          conditions.push(after);
        }
    } else {
      const at = new Date(position.updatedAtMs);
      const next = new Date(position.updatedAtMs + 1);
      // Postgres timestamps carry microseconds, but the cursor carries
      // milliseconds (the precision of a JS Date). Rows sharing the
      // cursor's millisecond fall in [at, next); within that bucket the
      // id tiebreak applies. An exact equality on the timestamp would
      // miss every row whose microseconds are nonzero.
      const after = or(
        lt(memories.updatedAt, at),
        and(gte(memories.updatedAt, at), lt(memories.updatedAt, next), lt(memories.id, position.id)),
      );
      if (after !== undefined) {
        conditions.push(after);
      }
    }
  }
  const rows = await ctx.tx
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(memories.updatedAt), desc(memories.id))
    .limit(limit);
  return rows.map(mapRow);
}
