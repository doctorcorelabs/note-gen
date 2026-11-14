// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: compactions.listByConversation.
//
// Returns the full compaction list for a conversation, revision
// descending (D-13). Callers that need only the latest use limit 1
// and take the first row; there is no latest-only kind. The id
// descending tiebreak keeps the order stable.
//
// Cursor format (opaque to the client, derivable from the last row):
// "<revision>:<id>". A malformed cursor answers 400 invalid_cursor.
// Limit defaults to 50 and clamps to 1..200; a limit below 1 or not
// an integer answers 400 invalid_limit. Every query is scoped to the
// workspace id from the handler context.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { conversationCompactions, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'compactions.listByConversation' as const;

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
  conversationId: number;
  cursor?: string;
  limit?: number;
}

export interface CompactionRow {
  id: number;
  conversationId: number;
  summary: string;
  coveredThroughChatId: number;
  tailStartChatId?: number;
  sourceTokenCount: number;
  summaryTokenCount: number;
  model: string;
  promptVersion: number;
  retainedTurnCount: number;
  prunedToolResultCount: number;
  prunedToolTokenCount: number;
  revision: number;
  createdAt: number;
}

type DbRow = typeof conversationCompactions.$inferSelect;

function mapRow(row: DbRow): CompactionRow {
  return {
    id: row.id,
    conversationId: row.conversationId,
    summary: row.summary,
    coveredThroughChatId: row.coveredThroughChatId,
    ...(row.tailStartChatId === null ? {} : { tailStartChatId: row.tailStartChatId }),
    sourceTokenCount: row.sourceTokenCount,
    summaryTokenCount: row.summaryTokenCount,
    model: row.model,
    promptVersion: row.promptVersion,
    retainedTurnCount: row.retainedTurnCount,
    prunedToolResultCount: row.prunedToolResultCount,
    prunedToolTokenCount: row.prunedToolTokenCount,
    revision: row.revision,
    createdAt: row.createdAt.getTime(),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ApiError(400, 'invalid_limit', 'The pagination limit is not valid.');
  }
  return Math.min(limit, 200);
}

interface CursorPosition {
  revision: number;
  id: number;
}

function parseCursor(cursor: string): CursorPosition {
  const match = /^(\d+):(\d+)$/.exec(cursor);
  if (match === null) {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  const revision = Number(match[1]);
  const id = Number(match[2]);
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(id)) {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  return { revision, id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'conversationId' && key !== 'cursor' && key !== 'limit') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (typeof op.conversationId !== 'number' || !Number.isInteger(op.conversationId)) {
    throw validationIssue('conversationId', 'must be an integer');
  }
  if (op.cursor !== undefined) {
    if (typeof op.cursor !== 'string') {
      throw validationIssue('cursor', 'must be a string');
    }
    parseCursor(op.cursor);
  }
  if (op.limit !== undefined) {
    if (typeof op.limit !== 'number') {
      throw validationIssue('limit', 'must be a number');
    }
    clampLimit(op.limit);
  }
}

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly CompactionRow[]> {
  validate(op);
  const limit = clampLimit(op.limit);
  const position = op.cursor === undefined ? null : parseCursor(op.cursor);
  const conditions: SQL[] = [
    eq(conversationCompactions.workspaceId, ctx.workspaceId),
    eq(conversationCompactions.conversationId, op.conversationId),
  ];
  if (position !== null) {
    const after = or(
      lt(conversationCompactions.revision, position.revision),
      and(
        eq(conversationCompactions.revision, position.revision),
        lt(conversationCompactions.id, position.id),
      ),
    );
    if (after !== undefined) {
      conditions.push(after);
    }
  }
  const rows = await ctx.tx
    .select()
    .from(conversationCompactions)
    .where(and(...conditions))
    .orderBy(desc(conversationCompactions.revision), desc(conversationCompactions.id))
    .limit(limit);
  return rows.map(mapRow);
}
