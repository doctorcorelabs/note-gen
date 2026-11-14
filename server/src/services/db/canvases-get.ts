// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: canvases.get.
//
// Upstream: getCanvasProject. Returns the single row as a one-element
// array, or an empty array when no row exists in the caller's
// workspace. The row is returned regardless of its deleted state,
// matching upstream, which applies no deleted filter to the
// single-row read. Undo and redo stacks are never returned. The id
// must be a UUID (G-10/A6); a non-UUID id answers 400
// validation_failed.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { canvases, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'canvases.get' as const;

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
  id: string;
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
    if (key !== 'kind' && key !== 'id') {
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
  if (typeof op.id !== 'string' || !UUID_PATTERN.test(op.id)) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'id', issue: 'must be a UUID' }],
    });
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<readonly CanvasRow[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(canvases)
    .where(and(eq(canvases.workspaceId, ctx.workspaceId), eq(canvases.id, op.id)))
    .limit(1);
  return rows.map(mapRow);
}
