// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: knowledge.updateStatus.
//
// Upstream: updateKnowledgeSourceIndexState, plus the optimistic
// guard of design 4.5. The existing row is locked in the
// transaction; when expectedStatus is given and does not match the
// current status, the answer is 409 revision_conflict with the
// current status and nothing is written. Transitions follow the hash
// machine of design 1.7: pending to indexing, indexing to ready,
// failed, or pending, ready to pending, failed to pending, plus
// re-applying the same status. Any other transition is answered 409
// revision_conflict with the current and requested status; the error
// code for an illegal transition is not locked by the design or the
// D/G locking, so the guard code is used and the choice is recorded
// as a named debt in the wave report for coordinator ratification.
//
// Field semantics follow upstream exactly: indexedHash and error are
// overwritten, with an absent value meaning null. A missing source
// answers affected 0 without an error, matching the silent zero-row
// update upstream. Transitions are worker-driven in Fase 2, but the
// handler contract is fixed in Fase 1.
//
// The result id is the sourceKey. The workspace id comes from the
// handler context, never from the operation.
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
import { knowledgeSources, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'knowledge.updateStatus' as const;

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
  sourceKey: string;
  update: KnowledgeStatusUpdate;
}

export type KnowledgeIndexStatus = 'pending' | 'indexing' | 'ready' | 'failed';

export interface KnowledgeStatusUpdate {
  status: KnowledgeIndexStatus;
  indexedHash?: string | null;
  error?: string | null;
  expectedStatus?: KnowledgeIndexStatus;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const STATUSES: readonly string[] = ['pending', 'indexing', 'ready', 'failed'];
const UPDATE_KEYS: readonly string[] = ['status', 'indexedHash', 'error', 'expectedStatus'];

const LEGAL_TRANSITIONS: Record<KnowledgeIndexStatus, readonly KnowledgeIndexStatus[]> = {
  pending: ['pending', 'indexing'],
  indexing: ['indexing', 'ready', 'failed', 'pending'],
  ready: ['ready', 'pending'],
  failed: ['failed', 'pending'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

function validateUpdate(value: unknown): asserts value is KnowledgeStatusUpdate {
  if (!isRecord(value)) {
    throw validationIssue('update', 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!UPDATE_KEYS.includes(key)) {
      throw validationIssue(`update.${key}`, 'unknown field');
    }
  }
  if (typeof value.status !== 'string' || !STATUSES.includes(value.status)) {
    throw validationIssue('update.status', 'must be a known status');
  }
  if (value.indexedHash !== undefined && value.indexedHash !== null && typeof value.indexedHash !== 'string') {
    throw validationIssue('update.indexedHash', 'must be a string or null');
  }
  if (value.error !== undefined && value.error !== null && typeof value.error !== 'string') {
    throw validationIssue('update.error', 'must be a string or null');
  }
  if (
    value.expectedStatus !== undefined &&
    (typeof value.expectedStatus !== 'string' || !STATUSES.includes(value.expectedStatus))
  ) {
    throw validationIssue('update.expectedStatus', 'must be a known status');
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'sourceKey' && key !== 'update') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (typeof op.sourceKey !== 'string') {
    throw validationIssue('sourceKey', 'must be a string');
  }
  validateUpdate(op.update);
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const where = and(
    eq(knowledgeSources.workspaceId, ctx.workspaceId),
    eq(knowledgeSources.sourceKey, op.sourceKey),
  );
  const locked = await ctx.tx.select().from(knowledgeSources).where(where).limit(1).for('update');
  const existing = locked[0];
  if (existing === undefined) {
    return { affected: 0, id: op.sourceKey };
  }
  const currentStatus = existing.status as KnowledgeIndexStatus;
  const update = op.update;
  if (update.expectedStatus !== undefined && update.expectedStatus !== currentStatus) {
    throw ApiError.revisionConflict({ currentStatus });
  }
  if (!LEGAL_TRANSITIONS[currentStatus].includes(update.status)) {
    throw ApiError.revisionConflict({ currentStatus, status: update.status });
  }
  await ctx.tx
    .update(knowledgeSources)
    .set({
      status: update.status,
      indexedHash: update.indexedHash ?? null,
      error: update.error ?? null,
    })
    .where(where);
  return { affected: 1, id: op.sourceKey };
}
