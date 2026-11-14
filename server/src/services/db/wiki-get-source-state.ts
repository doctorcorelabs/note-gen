// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: wiki.getSourceState.
//
// Upstream: getWikiSourceState. The payload stored in wiki_sources
// is the whole source state; the handler returns it as stored, or an
// empty array when no row matches. contextId is an opaque context
// key (A13): the handler never assumes it equals the workspace, and
// always applies both the workspace predicate from the session and
// the context predicate from the operation. A row owned by another
// workspace never matches.
//
// The catalog mirror types are declared locally because the emit
// build (rootDir src) cannot import type files from the frontend
// tree.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { wikiSources, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'wiki.getSourceState' as const;

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
  contextId: string;
  stableId: string;
}

export type KnowledgeSourceType = 'article' | 'record' | 'canvas';

export interface KnowledgeLocator {
  filePath?: string;
  markId?: number;
  tagId?: number;
  tagIds?: number[];
  canvasId?: string;
  nodeIds?: string[];
}

export type WikiSyncDomain = 'library' | 'account-data';

export interface WikiSourceReference {
  sourceKey: string;
  stableId: string;
  sourceType: KnowledgeSourceType;
  title: string;
  contentHash: string;
  locator: KnowledgeLocator;
  syncDomain: WikiSyncDomain;
  remoteVersion?: string;
  tagKeys?: string[];
}

export type WikiSourceStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleted'
  | 'excluded'
  | 'unavailable';

export interface WikiSourceState {
  contextId: string;
  stableId: string;
  sourceKey: string;
  sourceType: KnowledgeSourceType;
  source: WikiSourceReference;
  contentHash: string;
  status: WikiSourceStatus;
  revisionId: string | null;
  version: number;
  updatedAt: number;
  error: string | null;
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
    if (key !== 'kind' && key !== 'contextId' && key !== 'stableId') {
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
  if (typeof op.contextId !== 'string') {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'contextId', issue: 'must be a string' }],
    });
  }
  if (typeof op.stableId !== 'string') {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'stableId', issue: 'must be a string' }],
    });
  }
}

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly WikiSourceState[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(wikiSources)
    .where(
      and(
        eq(wikiSources.workspaceId, ctx.workspaceId),
        eq(wikiSources.contextId, op.contextId),
        eq(wikiSources.stableId, op.stableId),
      ),
    )
    .limit(1);
  return rows.map((row) => row.payload as unknown as WikiSourceState);
}
