// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: canvases.list.
//
// Upstream: getCanvasProjects. Order is updatedAt descending with id
// descending as the stable tiebreak. Undo and redo stacks are never
// returned: they stay in client memory. The deletion filter is a
// boolean (D-02): includeDeleted true returns deleted rows too;
// there is no deleted-only state.
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

import { and, desc, eq, gte, isNull, lt, or, type SQL } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { canvases, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'canvases.list' as const;

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
  includeDeleted?: boolean;
  cursor?: string;
  limit?: number;
}

export type CanvasProjectType =
  | 'blank'
  | 'flowchart'
  | 'mindmap'
  | 'timeline'
  | 'quadrant'
  | 'kanban'
  | 'swot';

export interface CanvasDocumentShape {
  schemaVersion: number;
  nodes: readonly unknown[];
  edges: readonly unknown[];
  viewport: { x: number; y: number; zoom: number };
  settings: { layoutDirection: 'TB' | 'LR'; showGrid: boolean; snapToGrid: boolean };
  [key: string]: unknown;
}

export interface CanvasRow {
  id: string;
  title: string;
  canvasType: CanvasProjectType;
  schemaVersion: number;
  document: CanvasDocumentShape;
  thumbnailPath?: string | null;
  createdAt: number;
  updatedAt: number;
  pinnedAt?: number | null;
  deletedAt?: number | null;
  version: number;
}

type DbRow = typeof canvases.$inferSelect;

function mapRow(row: DbRow): CanvasRow {
  return {
    id: row.id,
    title: row.title,
    canvasType: row.canvasType as CanvasProjectType,
    schemaVersion: row.schemaVersion,
    document: row.content as unknown as CanvasDocumentShape,
    thumbnailPath: row.thumbnailPath,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    pinnedAt: row.pinnedAt === null ? null : row.pinnedAt.getTime(),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.getTime(),
    version: row.version,
  };
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
  if (!Number.isSafeInteger(updatedAtMs) || !UUID_PATTERN.test(id)) {
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
    if (key !== 'kind' && key !== 'includeDeleted' && key !== 'cursor' && key !== 'limit') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (op.includeDeleted !== undefined && typeof op.includeDeleted !== 'boolean') {
    throw validationIssue('includeDeleted', 'must be a boolean');
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

export async function handle(ctx: HandlerContext, op: unknown): Promise<readonly CanvasRow[]> {
  validate(op);
  const limit = clampLimit(op.limit);
  const position = op.cursor === undefined ? null : parseCursor(op.cursor);
  const conditions: SQL[] = [eq(canvases.workspaceId, ctx.workspaceId)];
  if (op.includeDeleted !== true) {
    conditions.push(isNull(canvases.deletedAt));
  }
  if (position !== null) {
    const at = new Date(position.updatedAtMs);
    const next = new Date(position.updatedAtMs + 1);
    // Postgres timestamps carry microseconds, but the cursor carries
    // milliseconds (the precision of a JS Date). Rows sharing the
    // cursor's millisecond fall in [at, next); within that bucket the
    // id tiebreak applies. An exact equality on the timestamp would
    // miss every row whose microseconds are nonzero.
    const after = or(
      lt(canvases.updatedAt, at),
      and(gte(canvases.updatedAt, at), lt(canvases.updatedAt, next), lt(canvases.id, position.id)),
    );
    if (after !== undefined) {
      conditions.push(after);
    }
  }
  const rows = await ctx.tx
    .select()
    .from(canvases)
    .where(and(...conditions))
    .orderBy(desc(canvases.updatedAt), desc(canvases.id))
    .limit(limit);
  return rows.map(mapRow);
}
