// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: tags.get.
//
// A new fork kind (D-14): upstream callers filtered the full tag
// list, and no single-tag read function exists upstream. This handler
// reads one row from the tags table only. It never fills total
// (D-09): callers that need a count use the list kind. A missing row,
// or a row owned by another workspace, answers an empty array, which
// the adapter reads as null through queryOne.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'tags.get' as const;

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

export interface TagRow {
  id: number;
  name: string;
  isLocked: boolean;
  isPin: boolean;
  sortOrder: number;
}

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
  if (typeof op.id !== 'number' || !Number.isInteger(op.id)) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'id', issue: 'must be an integer' }],
    });
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<readonly TagRow[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(tags)
    .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, op.id)))
    .limit(1);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    isLocked: row.isLocked,
    isPin: row.isPin,
    sortOrder: row.sortOrder,
  }));
}
