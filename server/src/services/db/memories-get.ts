// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: memories.get.
//
// Upstream: getMemoryById. Returns the single row as a one-element
// array, or an empty array when no row exists in the caller's
// workspace. The embedding payload is never returned. A row owned by
// another workspace is indistinguishable from a missing row.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { memories, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'memories.get' as const;

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

export interface MemoryRow {
  id: string;
  content: string;
  category: 'preference' | 'memory';
  kind: 'preference' | 'fact' | 'experience' | 'decision';
  scopeType: 'global' | 'workspace';
  scopeId?: string;
  applyMode: 'always' | 'relevant';
  status: 'active' | 'pending' | 'archived';
  origin: 'manual' | 'explicit_chat' | 'auto_chat';
  confidence: number;
  conflictKey?: string;
  replacedId?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  indexingStatus: 'ready' | 'pending' | 'failed';
  sensitivity: 'normal' | 'suspected_sensitive';
  accessCount: number;
  lastAccessedAt: number;
  lastRecallReason?: string;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

type DbRow = typeof memories.$inferSelect;

function mapRow(row: DbRow): MemoryRow {
  return {
    id: row.id,
    content: row.content,
    category: row.category as MemoryRow['category'],
    kind: row.kind as MemoryRow['kind'],
    scopeType: row.scopeType as MemoryRow['scopeType'],
    ...(row.scopeId === null ? {} : { scopeId: row.scopeId }),
    applyMode: row.applyMode as MemoryRow['applyMode'],
    status: row.status as MemoryRow['status'],
    origin: row.origin as MemoryRow['origin'],
    confidence: row.confidence,
    ...(row.conflictKey === null ? {} : { conflictKey: row.conflictKey }),
    ...(row.replacedId === null ? {} : { replacedId: row.replacedId }),
    ...(row.embeddingModel === null ? {} : { embeddingModel: row.embeddingModel }),
    ...(row.embeddingDimensions === null ? {} : { embeddingDimensions: row.embeddingDimensions }),
    indexingStatus: row.indexingStatus as MemoryRow['indexingStatus'],
    sensitivity: row.sensitivity as MemoryRow['sensitivity'],
    accessCount: row.accessCount,
    lastAccessedAt: row.lastAccessedAt === null ? 0 : row.lastAccessedAt.getTime(),
    ...(row.lastRecallReason === null ? {} : { lastRecallReason: row.lastRecallReason }),
    ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt.getTime() }),
    createdAt: row.createdAt.getTime(),
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
  if (typeof op.id !== 'string') {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'id', issue: 'must be a string' }],
    });
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<readonly MemoryRow[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(memories)
    .where(and(eq(memories.workspaceId, ctx.workspaceId), eq(memories.id, op.id)))
    .limit(1);
  return rows.map(mapRow);
}
