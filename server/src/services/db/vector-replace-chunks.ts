// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Stub for one server-only write kind: vector.replaceChunks.
//
// This kind is W2 and server-only. It is never exposed to the web
// adapter and must never be called from a browser client: the web
// adapter rejects it locally, and the transaction route rejects it
// before dispatch. This stub is the second line of defense for any
// caller that reaches the handler directly: every call answers 410
// capability_unavailable with details naming the kind and the phase,
// and the message naming the capability, its server-only nature, and
// the phase. No database access happens: the stub throws before any
// query. The real chunk replacement (server worker, full replacement
// per source in one transaction) lands in Fase 2.
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

export const HANDLER_KIND = 'vector.replaceChunks' as const;

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
  sourceType: KnowledgeSourceType;
  sourceId: string;
  chunks: VectorChunkInput[];
}

export type KnowledgeSourceType = 'article' | 'record' | 'canvas';

export interface VectorChunkInput {
  chunkId: number;
  content: string;
  embedding: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  updatedAt?: number;
}

export async function handle(_ctx: HandlerContext, _op: unknown): Promise<never> {
  throw new ApiError(
    410,
    'capability_unavailable',
    `Capability ${HANDLER_KIND} is server-only and is not available in Fase 1; it is planned for Fase 2.`,
    { details: { kind: HANDLER_KIND, capability: HANDLER_KIND, phase: 'Fase 2' } },
  );
}
