// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: wiki.listJobs.
//
// Upstream: listWikiJobs. Read only; the job engine is W2. All jobs
// for one context, ordered by readyAt ascending as upstream, with id
// ascending as the deterministic tiebreak. contextId is an opaque
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
import { wikiJobs, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'wiki.listJobs' as const;

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
): Promise<readonly WikiJob[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(wikiJobs)
    .where(
      and(eq(wikiJobs.workspaceId, ctx.workspaceId), eq(wikiJobs.contextId, op.contextId)),
    )
    .orderBy(asc(wikiJobs.readyAt), asc(wikiJobs.id));
  return rows.map((row) => row.payload as unknown as WikiJob);
}
