// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: wiki.findRevisionByInputHash.
//
// Upstream: findWikiRevision. The first revision for the input hash
// in outputHash ascending order, or an empty array when none
// matches. The id ascending tiebreak is added for determinism; the
// upstream query orders by output hash only. contextId is an opaque
// context key (A13): the handler always applies both the workspace
// predicate from the session and the context predicate from the
// operation.
//
// The catalog mirror types are declared locally because the emit
// build (rootDir src) cannot import type files from the frontend
// tree.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, asc, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { wikiRevisions, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'wiki.findRevisionByInputHash' as const;

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
  inputHash: string;
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

export interface WikiSourceRevision {
  id: string;
  contextId: string;
  inputHash: string;
  outputHash: string;
  pipelineVersion: string;
  generation: number;
  language: string;
  source: WikiSourceReference;
  summary: string;
  contributions: WikiContribution[];
  createdAt: number;
  modelId: string;
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
    if (key !== 'kind' && key !== 'contextId' && key !== 'inputHash') {
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
  if (typeof op.inputHash !== 'string') {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'inputHash', issue: 'must be a string' }],
    });
  }
}

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly WikiSourceRevision[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(wikiRevisions)
    .where(
      and(
        eq(wikiRevisions.workspaceId, ctx.workspaceId),
        eq(wikiRevisions.contextId, op.contextId),
        eq(wikiRevisions.inputHash, op.inputHash),
      ),
    )
    .orderBy(asc(wikiRevisions.outputHash), asc(wikiRevisions.id))
    .limit(1);
  return rows.map((row) => row.payload as unknown as WikiSourceRevision);
}
