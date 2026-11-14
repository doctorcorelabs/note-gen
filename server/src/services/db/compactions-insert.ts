// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: compactions.insert.
//
// The server assigns the revision: latest revision for the
// conversation plus one, or 1 when none exists, exactly as upstream
// insertConversationCompaction does. The client never sends a
// revision, so the duplicate-revision service guard is the
// assignment itself, serialized by locking the conversation row in
// the transaction. A conversation owned by another workspace answers
// the generic 404, indistinguishable from a missing conversation.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, desc, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { conversationCompactions, conversations, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'compactions.insert' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export interface NewCompaction {
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
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  compaction: NewCompaction;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const COMPACTION_KEYS: readonly string[] = [
  'conversationId',
  'summary',
  'coveredThroughChatId',
  'tailStartChatId',
  'sourceTokenCount',
  'summaryTokenCount',
  'model',
  'promptVersion',
  'retainedTurnCount',
  'prunedToolResultCount',
  'prunedToolTokenCount',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

function validateCompaction(compaction: unknown): asserts compaction is NewCompaction {
  if (!isRecord(compaction)) {
    throw validationIssue('compaction', 'must be an object');
  }
  for (const key of Object.keys(compaction)) {
    if (!COMPACTION_KEYS.includes(key)) {
      throw validationIssue(`compaction.${key}`, 'unknown field');
    }
  }
  for (const key of ['summary', 'model']) {
    if (typeof compaction[key] !== 'string') {
      throw validationIssue(`compaction.${key}`, 'must be a string');
    }
  }
  for (const key of [
    'conversationId',
    'coveredThroughChatId',
    'sourceTokenCount',
    'summaryTokenCount',
    'promptVersion',
    'retainedTurnCount',
    'prunedToolResultCount',
    'prunedToolTokenCount',
  ]) {
    if (typeof compaction[key] !== 'number' || !Number.isInteger(compaction[key])) {
      throw validationIssue(`compaction.${key}`, 'must be an integer');
    }
  }
  if (
    compaction.tailStartChatId !== undefined &&
    (typeof compaction.tailStartChatId !== 'number' || !Number.isInteger(compaction.tailStartChatId))
  ) {
    throw validationIssue('compaction.tailStartChatId', 'must be an integer');
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'compaction') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  validateCompaction(op.compaction);
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const compaction = op.compaction;
  const locked = await ctx.tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(eq(conversations.workspaceId, ctx.workspaceId), eq(conversations.id, compaction.conversationId)),
    )
    .limit(1)
    .for('update');
  if (locked.length === 0) {
    throw ApiError.notFound();
  }
  const latest = await ctx.tx
    .select({ revision: conversationCompactions.revision })
    .from(conversationCompactions)
    .where(
      and(
        eq(conversationCompactions.workspaceId, ctx.workspaceId),
        eq(conversationCompactions.conversationId, compaction.conversationId),
      ),
    )
    .orderBy(desc(conversationCompactions.revision))
    .limit(1);
  const revision = (latest[0]?.revision ?? 0) + 1;
  const inserted = await ctx.tx
    .insert(conversationCompactions)
    .values({
      workspaceId: ctx.workspaceId,
      conversationId: compaction.conversationId,
      summary: compaction.summary,
      coveredThroughChatId: compaction.coveredThroughChatId,
      ...(compaction.tailStartChatId === undefined
        ? {}
        : { tailStartChatId: compaction.tailStartChatId }),
      sourceTokenCount: compaction.sourceTokenCount,
      summaryTokenCount: compaction.summaryTokenCount,
      model: compaction.model,
      promptVersion: compaction.promptVersion,
      retainedTurnCount: compaction.retainedTurnCount,
      prunedToolResultCount: compaction.prunedToolResultCount,
      prunedToolTokenCount: compaction.prunedToolTokenCount,
      revision,
    })
    .returning({ id: conversationCompactions.id });
  const created = inserted[0];
  if (created === undefined) {
    throw ApiError.internalError();
  }
  return { affected: 1, id: created.id };
}
