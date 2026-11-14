// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: wiki.getSegment.
//
// Upstream: getWikiSegmentCache. The payload stored in wiki_segments
// is the whole segment cache entry; the handler returns it as
// stored, or an empty array when no row matches. The operation field
// is named key and maps to the cache_key column. contextId is an
// opaque context key (A13): the handler always applies both the
// workspace predicate from the session and the context predicate
// from the operation.
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
import { wikiSegments, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'wiki.getSegment' as const;

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
  key: string;
}

export interface WikiEvidence {
  quote: string;
  nodeId?: string;
}

export interface WikiContribution {
  topicKey: string;
  title: string;
  aliases: string[];
  content: string;
  evidence: WikiEvidence[];
}

export interface WikiUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

export interface WikiSegmentCache {
  summary: string;
  contributions: WikiContribution[];
  usage: WikiUsage;
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
    if (key !== 'kind' && key !== 'contextId' && key !== 'key') {
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
  if (typeof op.key !== 'string') {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'key', issue: 'must be a string' }],
    });
  }
}

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly WikiSegmentCache[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(wikiSegments)
    .where(
      and(
        eq(wikiSegments.workspaceId, ctx.workspaceId),
        eq(wikiSegments.contextId, op.contextId),
        eq(wikiSegments.cacheKey, op.key),
      ),
    )
    .limit(1);
  return rows.map((row) => row.payload as unknown as WikiSegmentCache);
}
