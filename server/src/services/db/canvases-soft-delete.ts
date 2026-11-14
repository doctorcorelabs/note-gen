// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: canvases.softDelete.
//
// Upstream: softDeleteCanvasProject. Sets deletedAt and refreshes
// updatedAt, and bumps version so a guarded save against the old
// version conflicts afterwards. The id must be a UUID (G-10/A6). A
// row owned by another workspace answers the generic 404,
// indistinguishable from a missing row.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { canvases, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'canvases.softDelete' as const;

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

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
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
  const now = new Date();
  const nextVersion = current.version + 1;
  await ctx.tx
    .update(canvases)
    .set({ deletedAt: now, updatedAt: now, version: nextVersion })
    .where(eq(canvases.id, current.id));
  return { affected: 1, id: current.id, version: nextVersion };
}
