// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: canvases.create.
//
// Upstream: insertCanvasProject. The id is caller-generated and must
// be a UUID (G-10/A6); the canvas type must be one of the seven
// upstream project types; the document is optional and defaults to
// the upstream default canvas document, copied verbatim. CreatedAt,
// updatedAt, and version are server-assigned. An id that already
// exists in the workspace answers 409 already_exists.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { canvases, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'canvases.create' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
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

export interface NewCanvas {
  id: string;
  title: string;
  canvasType: CanvasProjectType;
  document?: CanvasDocumentShape;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  canvas: NewCanvas;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CANVAS_TYPES: readonly string[] = [
  'blank',
  'flowchart',
  'mindmap',
  'timeline',
  'quadrant',
  'kanban',
  'swot',
];

const DEFAULT_CANVAS_DOCUMENT: CanvasDocumentShape = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  settings: { layoutDirection: 'TB', showGrid: true, snapToGrid: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

function validateCanvas(canvas: unknown): asserts canvas is NewCanvas {
  if (!isRecord(canvas)) {
    throw validationIssue('canvas', 'must be an object');
  }
  for (const key of Object.keys(canvas)) {
    if (key !== 'id' && key !== 'title' && key !== 'canvasType' && key !== 'document') {
      throw validationIssue(`canvas.${key}`, 'unknown field');
    }
  }
  if (typeof canvas.id !== 'string' || !UUID_PATTERN.test(canvas.id)) {
    throw validationIssue('canvas.id', 'must be a UUID');
  }
  if (typeof canvas.title !== 'string') {
    throw validationIssue('canvas.title', 'must be a string');
  }
  if (typeof canvas.canvasType !== 'string' || !CANVAS_TYPES.includes(canvas.canvasType)) {
    throw validationIssue('canvas.canvasType', 'must be a known canvas type');
  }
  if (canvas.document !== undefined) {
    if (!isRecord(canvas.document)) {
      throw validationIssue('canvas.document', 'must be an object');
    }
    if (
      canvas.document.schemaVersion !== undefined &&
      typeof canvas.document.schemaVersion !== 'number'
    ) {
      throw validationIssue('canvas.document.schemaVersion', 'must be a number');
    }
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'canvas') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  validateCanvas(op.canvas);
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const canvas = op.canvas;
  const existing = await ctx.tx
    .select({ id: canvases.id })
    .from(canvases)
    .where(and(eq(canvases.workspaceId, ctx.workspaceId), eq(canvases.id, canvas.id)))
    .limit(1);
  if (existing.length > 0) {
    throw ApiError.alreadyExists();
  }
  const document = canvas.document === undefined ? DEFAULT_CANVAS_DOCUMENT : canvas.document;
  const inserted = await ctx.tx
    .insert(canvases)
    .values({
      id: canvas.id,
      workspaceId: ctx.workspaceId,
      title: canvas.title,
      canvasType: canvas.canvasType,
      schemaVersion: 1,
      content: document as unknown as Record<string, unknown>,
    })
    .returning({ id: canvases.id, version: canvases.version });
  const created = inserted[0];
  if (created === undefined) {
    throw ApiError.internalError();
  }
  return { affected: 1, id: created.id, version: created.version };
}
