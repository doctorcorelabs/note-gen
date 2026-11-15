// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: knowledge.stats.
//
// Upstream: getKnowledgeIndexStats. Counts per source type crossed
// with index status. Every cell is present, with zero for empty
// combinations. The query is scoped to the workspace id from the
// handler context; the workspace id is never an operation field.
//
// The catalog mirror types are declared locally because the emit
// build (rootDir src) cannot import type files from the frontend
// tree.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { count, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { knowledgeSources, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'knowledge.stats' as const;

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

export type KnowledgeIndexStatus = 'pending' | 'indexing' | 'ready' | 'failed';

export type KnowledgeIndexStats = Record<KnowledgeSourceType, Record<KnowledgeIndexStatus, number>>;

const SOURCE_TYPES: readonly KnowledgeSourceType[] = ['article', 'record', 'canvas'];
const STATUSES: readonly KnowledgeIndexStatus[] = ['pending', 'indexing', 'ready', 'failed'];

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
): Promise<readonly KnowledgeIndexStats[]> {
  validate(op);
  const rows = await ctx.tx
    .select({
      sourceType: knowledgeSources.sourceType,
      status: knowledgeSources.status,
      n: count(),
    })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.workspaceId, ctx.workspaceId))
    .groupBy(knowledgeSources.sourceType, knowledgeSources.status);
  const stats: KnowledgeIndexStats = {
    article: { pending: 0, indexing: 0, ready: 0, failed: 0 },
    record: { pending: 0, indexing: 0, ready: 0, failed: 0 },
    canvas: { pending: 0, indexing: 0, ready: 0, failed: 0 },
  };
  for (const row of rows) {
    if (
      SOURCE_TYPES.includes(row.sourceType as KnowledgeSourceType) &&
      STATUSES.includes(row.status as KnowledgeIndexStatus)
    ) {
      stats[row.sourceType as KnowledgeSourceType][row.status as KnowledgeIndexStatus] = Number(row.n);
    }
  }
  return [stats];
}
