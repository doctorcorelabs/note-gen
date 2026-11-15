// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: memories.stats.
//
// Upstream: getMemoryStats. Total counts active plus pending rows;
// preferences and memories count active rows only, split by kind
// (kind preference versus any other kind); pending and archived
// count rows of that status; totalAccessCount sums access counts
// over all rows in the workspace. The single stats object is
// returned as a one-element array. Only the three counted columns
// are read; no embedding is ever selected.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { memories, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'memories.stats' as const;

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
}

export interface MemoryStats {
  total: number;
  preferences: number;
  memories: number;
  pending: number;
  archived: number;
  totalAccessCount: number;
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
    if (key !== 'kind') {
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
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<readonly MemoryStats[]> {
  validate(op);
  const rows = await ctx.tx
    .select({ status: memories.status, kind: memories.kind, accessCount: memories.accessCount })
    .from(memories)
    .where(eq(memories.workspaceId, ctx.workspaceId));
  let active = 0;
  let pending = 0;
  let archived = 0;
  let preferences = 0;
  let memoryKind = 0;
  let totalAccessCount = 0;
  for (const row of rows) {
    totalAccessCount += row.accessCount;
    if (row.status === 'active') {
      active += 1;
      if (row.kind === 'preference') {
        preferences += 1;
      } else {
        memoryKind += 1;
      }
    } else if (row.status === 'pending') {
      pending += 1;
    } else if (row.status === 'archived') {
      archived += 1;
    }
  }
  return [
    {
      total: active + pending,
      preferences,
      memories: memoryKind,
      pending,
      archived,
      totalAccessCount,
    },
  ];
}
