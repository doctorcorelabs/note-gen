// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: imageCache.get.
//
// Upstream: getImageAnalysisCache. An expired row is treated as a
// miss and never returned; the read performs no synchronous cleanup
// (G-06). A miss returns an empty array, which the adapter reads as
// null through queryOne. Every query is scoped to the workspace id
// from the handler context.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { imageAnalysisCache, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'imageCache.get' as const;

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
  cacheKey: string;
}

export interface ImageAnalysisCacheRow {
  cacheKey: string;
  imageHash: string;
  queryHash: string;
  ocrText?: string;
  visualAnalysis?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  updatedAt: number;
  expiresAt?: number;
}

type DbRow = typeof imageAnalysisCache.$inferSelect;

function mapRow(row: DbRow): ImageAnalysisCacheRow {
  return {
    cacheKey: row.cacheKey,
    imageHash: row.imageHash,
    queryHash: row.queryHash,
    ...(row.ocrText === null ? {} : { ocrText: row.ocrText }),
    ...(row.visualAnalysis === null ? {} : { visualAnalysis: row.visualAnalysis }),
    ...(row.mimeType === null ? {} : { mimeType: row.mimeType }),
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    updatedAt: row.updatedAt.getTime(),
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt.getTime() }),
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
    if (key !== 'kind' && key !== 'cacheKey') {
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
  if (typeof op.cacheKey !== 'string') {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'cacheKey', issue: 'must be a string' }],
    });
  }
}

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly ImageAnalysisCacheRow[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(imageAnalysisCache)
    .where(
      and(
        eq(imageAnalysisCache.workspaceId, ctx.workspaceId),
        eq(imageAnalysisCache.cacheKey, op.cacheKey),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return [];
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    return [];
  }
  return [mapRow(row)];
}
