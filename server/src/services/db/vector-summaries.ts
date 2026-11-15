// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: vector.summaries.
//
// Upstream: getVectorIndexSummaries. One summary per indexed source:
// sourceType, sourceId, and the newest chunk updatedAt. The fork
// splits the upstream filename (article:, record:, canvas: plus id)
// into typed columns; the service maps back for legacy readers, and
// no embedding is ever returned. Order is sourceType ascending then
// sourceId ascending, a deterministic order the upstream query does
// not fix. The query is scoped to the workspace id from the handler
// context; the workspace id is never an operation field.
//
// The catalog mirror types are declared locally because the emit
// build (rootDir src) cannot import type files from the frontend
// tree.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { asc, eq, max } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { vectorChunks, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'vector.summaries' as const;

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

export type KnowledgeSourceType = 'article' | 'record' | 'canvas';

export interface VectorIndexSummary {
  sourceType: KnowledgeSourceType;
  sourceId: string;
  updatedAt: number;
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

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly VectorIndexSummary[]> {
  validate(op);
  const rows = await ctx.tx
    .select({
      sourceType: vectorChunks.sourceType,
      sourceId: vectorChunks.sourceId,
      updatedAt: max(vectorChunks.updatedAt),
    })
    .from(vectorChunks)
    .where(eq(vectorChunks.workspaceId, ctx.workspaceId))
    .groupBy(vectorChunks.sourceType, vectorChunks.sourceId)
    .orderBy(asc(vectorChunks.sourceType), asc(vectorChunks.sourceId));
  const summaries: VectorIndexSummary[] = [];
  for (const row of rows) {
    if (row.updatedAt !== null) {
      summaries.push({
        sourceType: row.sourceType as KnowledgeSourceType,
        sourceId: row.sourceId,
        updatedAt: row.updatedAt.getTime(),
      });
    }
  }
  return summaries;
}
