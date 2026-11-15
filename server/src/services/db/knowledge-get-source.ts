// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: knowledge.getSource.
//
// Upstream: getKnowledgeSource. One row from knowledge_sources in the
// session workspace, mapped to the catalog shape, or an empty array
// when no row matches. A row owned by another workspace never matches
// and is indistinguishable from a missing row (the read-side
// equivalent of the generic 404 in the canonical contract).
//
// The query predicate and row mapping below are salvaged from the
// first replacement worker (V3-13cR, uncommitted draft); the
// signature, validation step, and array result follow the route
// handler contract used by the group A handlers, so the route layer
// can register this file directly. The catalog mirror types are
// declared locally because the emit build (rootDir src) cannot import
// type files from the frontend tree.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { knowledgeSources, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'knowledge.getSource' as const;

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
  sourceKey: string;
}

export type KnowledgeSourceType = 'article' | 'record' | 'canvas';

export type KnowledgeIndexStatus = 'pending' | 'indexing' | 'ready' | 'failed';

export interface KnowledgeLocator {
  filePath?: string;
  markId?: number;
  tagId?: number;
  tagIds?: number[];
  canvasId?: string;
  nodeIds?: string[];
}

export interface KnowledgeSourceRow {
  sourceKey: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  title: string;
  contentHash: string;
  indexedHash?: string | null;
  updatedAt: number;
  locator: KnowledgeLocator;
  status: KnowledgeIndexStatus;
  error?: string | null;
}

type DbRow = typeof knowledgeSources.$inferSelect;

function mapRow(row: DbRow): KnowledgeSourceRow {
  return {
    sourceKey: row.sourceKey,
    sourceType: row.sourceType as KnowledgeSourceType,
    sourceId: row.sourceId,
    title: row.title ?? '',
    locator: row.locator as KnowledgeLocator,
    contentHash: row.contentHash,
    indexedHash: row.indexedHash,
    status: row.status as KnowledgeIndexStatus,
    error: row.error,
    updatedAt: row.updatedAt.getTime(),
  };
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
    if (key !== 'kind' && key !== 'sourceKey') {
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
  if (typeof op.sourceKey !== 'string') {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'sourceKey', issue: 'must be a string' }],
    });
  }
}

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly KnowledgeSourceRow[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.sourceKey, op.sourceKey),
      ),
    )
    .limit(1);
  return rows.map(mapRow);
}
