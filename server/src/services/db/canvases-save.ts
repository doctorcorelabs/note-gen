// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: canvases.save.
//
// The version guard is mandatory (D-09): expected.version must match
// the row locked in the transaction, or the answer is 409
// revision_conflict carrying the current snapshot (document, version,
// updatedAt) so the client can merge or force. Force true overwrites
// despite a stale version. The document is optional so a rename,
// thumbnail, or pin change need not resend it; at least one patch
// field must be present. An explicit null thumbnailPath or pinnedAt
// clears the field. A successful save bumps version by 1.
//
// Audit note: a force save must be recorded in audit_events with
// action canvas.force_save (G-07), but the handler context carries no
// IP hash and the audit table requires one, and no target convention
// is locked. This handler therefore writes no audit row; the gap is
// recorded as named debt UTANG-AUDIT-01 in the wave report. No audit
// value is invented here.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { canvases, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'canvases.save' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export interface CanvasDocumentShape {
  schemaVersion: number;
  nodes: readonly unknown[];
  edges: readonly unknown[];
  viewport: { x: number; y: number; zoom: number };
  settings: { layoutDirection: 'TB' | 'LR'; showGrid: boolean; snapToGrid: boolean };
  [key: string]: unknown;
}

export interface CanvasPatch {
  document?: CanvasDocumentShape;
  title?: string;
  thumbnailPath?: string | null;
  pinnedAt?: number | null;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  id: string;
  patch: CanvasPatch;
  expected: { version: number };
  force?: boolean;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

function validatePatch(patch: unknown): asserts patch is CanvasPatch {
  if (!isRecord(patch)) {
    throw validationIssue('patch', 'must be an object');
  }
  for (const key of Object.keys(patch)) {
    if (key !== 'document' && key !== 'title' && key !== 'thumbnailPath' && key !== 'pinnedAt') {
      throw validationIssue(`patch.${key}`, 'unknown field');
    }
  }
  if (Object.keys(patch).length === 0) {
    throw validationIssue('patch', 'must carry at least one field');
  }
  if (patch.document !== undefined) {
    if (!isRecord(patch.document)) {
      throw validationIssue('patch.document', 'must be an object');
    }
    if (patch.document.schemaVersion !== undefined && typeof patch.document.schemaVersion !== 'number') {
      throw validationIssue('patch.document.schemaVersion', 'must be a number');
    }
  }
  if (patch.title !== undefined && typeof patch.title !== 'string') {
    throw validationIssue('patch.title', 'must be a string');
  }
  if (patch.thumbnailPath !== undefined && patch.thumbnailPath !== null && typeof patch.thumbnailPath !== 'string') {
    throw validationIssue('patch.thumbnailPath', 'must be a string or null');
  }
  if (
    patch.pinnedAt !== undefined &&
    patch.pinnedAt !== null &&
    (typeof patch.pinnedAt !== 'number' || !Number.isInteger(patch.pinnedAt))
  ) {
    throw validationIssue('patch.pinnedAt', 'must be an integer or null');
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'id' && key !== 'patch' && key !== 'expected' && key !== 'force') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (typeof op.id !== 'string' || !UUID_PATTERN.test(op.id)) {
    throw validationIssue('id', 'must be a UUID');
  }
  validatePatch(op.patch);
  if (!isRecord(op.expected)) {
    throw validationIssue('expected', 'must be an object');
  }
  for (const key of Object.keys(op.expected)) {
    if (key !== 'version') {
      throw validationIssue(`expected.${key}`, 'unknown field');
    }
  }
  if (typeof op.expected.version !== 'number' || !Number.isInteger(op.expected.version)) {
    throw validationIssue('expected.version', 'must be an integer');
  }
  if (op.force !== undefined && typeof op.force !== 'boolean') {
    throw validationIssue('force', 'must be a boolean');
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(canvases)
    .where(and(eq(canvases.workspaceId, ctx.workspaceId), eq(canvases.id, op.id)))
    .limit(1)
    .for('update');
  const current = rows[0];
  if (current === undefined) {
    throw ApiError.notFound();
  }
  if (op.expected.version !== current.version && op.force !== true) {
    throw ApiError.revisionConflict({
      currentVersion: current.version,
      snapshot: {
        document: current.content,
        version: current.version,
        updatedAt: current.updatedAt.getTime(),
      },
    });
  }
  const patch = op.patch;
  const nextVersion = current.version + 1;
  await ctx.tx
    .update(canvases)
    .set({
      ...(patch.document === undefined
        ? {}
        : {
            content: patch.document as unknown as Record<string, unknown>,
            ...(typeof patch.document.schemaVersion === 'number'
              ? { schemaVersion: patch.document.schemaVersion }
              : {}),
          }),
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.thumbnailPath === undefined ? {} : { thumbnailPath: patch.thumbnailPath }),
      ...(patch.pinnedAt === undefined
        ? {}
        : { pinnedAt: patch.pinnedAt === null ? null : new Date(patch.pinnedAt) }),
      version: nextVersion,
      updatedAt: new Date(),
    })
    .where(eq(canvases.id, current.id));
  return { affected: 1, id: current.id, version: nextVersion };
}
