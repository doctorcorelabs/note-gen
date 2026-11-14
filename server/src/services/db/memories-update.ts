// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: memories.update.
//
// Wave 2 stub (D-07). This kind is known but its handler lands in
// Fase 2; in Fase 1 the whole request is rejected before execution
// with 410 capability_unavailable, naming the kind and the phase
// (penguncian seksi 7 butir 4). Both validate (which dispatch runs
// before the transaction opens) and handle reject the same way, so
// the wire behavior holds whichever path reaches this file. The
// future implementation covers archive, restore, and approve through
// the status field (D-06); it is not built here.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// database type, the canonical error type). It imports no other
// handler file and no shared helper.

import { ApiError } from '../../plugins/envelope.js';
import type { Database } from '../../db/index.js';

export const HANDLER_KIND = 'memories.update' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export interface MemoryUpdateInput {
  content?: string;
  category?: 'preference' | 'memory';
  kind?: 'preference' | 'fact' | 'experience' | 'decision';
  scopeType?: 'global' | 'workspace';
  scopeId?: string;
  applyMode?: 'always' | 'relevant';
  status?: 'active' | 'pending' | 'archived';
  origin?: 'manual' | 'explicit_chat' | 'auto_chat';
  confidence?: number;
  conflictKey?: string;
  sensitivity?: 'normal' | 'suspected_sensitive';
  embedding?: string;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  id: string;
  updates: MemoryUpdateInput;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

function unavailable(): ApiError {
  return new ApiError(
    410,
    'capability_unavailable',
    'Updating memories is not available in Fase 1. This capability arrives in Fase 2.',
    { details: { capability: HANDLER_KIND, kind: HANDLER_KIND, phase: 'Fase 2' } },
  );
}

export function validate(op: unknown): void {
  void op;
  throw unavailable();
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  void ctx;
  validate(op);
  throw unavailable();
}
