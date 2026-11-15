// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Stub for one write kind: wiki.upsertJob.
//
// This kind is W2. In Fase 1 every call answers 410
// capability_unavailable with details naming the kind and the phase,
// and the message naming the capability and the phase. No database
// access happens: the stub throws before any query. The real handler
// (upstream upsertWikiJob) lands in Fase 2 with the wiki job engine.
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

export const HANDLER_KIND = 'wiki.upsertJob' as const;

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
  job: WikiJob;
}

export interface WikiJob {
  id: string;
  contextId: string;
  sourceKey: string;
  kind: 'source' | 'topic';
  inputHash: string;
  status: 'pending' | 'running' | 'failed' | 'paused';
  stage: string;
  attempts: number;
  readyAt: number;
  updatedAt: number;
  error: string | null;
}

export async function handle(_ctx: HandlerContext, _op: unknown): Promise<never> {
  throw new ApiError(
    410,
    'capability_unavailable',
    `Capability ${HANDLER_KIND} is not available in Fase 1; it is planned for Fase 2.`,
    { details: { kind: HANDLER_KIND, capability: HANDLER_KIND, phase: 'Fase 2' } },
  );
}
