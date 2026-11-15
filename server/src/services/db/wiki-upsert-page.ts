// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Stub for one write kind: wiki.upsertPage.
//
// This kind is W2. In Fase 1 every call answers 410
// capability_unavailable with details naming the kind and the phase,
// and the message naming the capability and the phase. No database
// access happens: the stub throws before any query. The real handler
// (upstream upsertWikiPage, including the dirty flag in wiki_meta)
// lands in Fase 2.
//
// There is deliberately no validate step: every call, well-formed or
// not, answers 410, so the unavailable capability is never masked by
// a shape error. The operation mirror below documents the catalog
// shape for the Fase 2 handler.
//
// The catalog mirror types are declared locally because the emit
// build (rootDir src) cannot import type files from the frontend
// tree.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type). It imports no other
// handler file and no shared helper.

import { ApiError } from '../../plugins/envelope.js';
import type { Database } from '../../db/index.js';

export const HANDLER_KIND = 'wiki.upsertPage' as const;

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
  page: WikiPage;
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

export async function handle(_ctx: HandlerContext, _op: unknown): Promise<never> {
  throw new ApiError(
    410,
    'capability_unavailable',
    `Capability ${HANDLER_KIND} is not available in Fase 1; it is planned for Fase 2.`,
    { details: { kind: HANDLER_KIND, capability: HANDLER_KIND, phase: 'Fase 2' } },
  );
}
