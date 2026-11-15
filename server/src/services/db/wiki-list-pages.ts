// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: wiki.listPages.
//
// Upstream: listWikiPages. All pages for one context, each payload
// returned as stored. Order is id ascending, a deterministic order
// the upstream query does not fix. contextId is an opaque context
// key (A13): the handler always applies both the workspace predicate
// from the session and the context predicate from the operation.
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
import { wikiPages, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'wiki.listPages' as const;

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

export interface WikiPage {
  id: string;
  contextId: string;
  kind: 'source' | 'topic';
  title: string;
  aliases: string[];
  body: string;
  sourceRefs: WikiSourceReference[];
  inputHash: string;
  outputHash: string;
  updatedAt: number;
  status: 'ready' | 'stale' | 'archived';
  relatedPageIds: string[];
  topicKey?: string;
  generation?: number;
  filePath?: string;
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
    if (key !== 'kind' && key !== 'contextId') {
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
}

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly WikiPage[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(wikiPages)
    .where(
      and(eq(wikiPages.workspaceId, ctx.workspaceId), eq(wikiPages.contextId, op.contextId)),
    )
    .orderBy(asc(wikiPages.id));
  return rows.map((row) => row.payload as unknown as WikiPage);
}
