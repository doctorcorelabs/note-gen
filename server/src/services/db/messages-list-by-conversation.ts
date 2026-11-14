// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: messages.listByConversation.
//
// Upstream: getChatsByConversation. Order is id ascending with a
// cursor over id: the cursor is the decimal id of the last row seen.
// A malformed cursor answers 400 invalid_cursor. Limit defaults to
// 50 and clamps to 1..200; a limit below 1 or not an integer answers
// 400 invalid_limit. Every query is scoped to the workspace id from
// the handler context.
//
// JSON columns are returned parsed: images and ragSources as string
// arrays, quoteData in its locked shape, and the five unlocked JSON
// fields as JSON values (D-08, G-03). This file invents no element
// shape for the unlocked fields.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, asc, eq, gt } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { chatMessages, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'messages.listByConversation' as const;

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

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ChatQuoteData {
  quote: string;
  fullContent: string;
  fileName: string;
  startLine: number;
  endLine: number;
  from: number;
  to: number;
  articlePath: string;
}

export interface ChatMessageRow {
  id: number;
  tagId?: number;
  conversationId?: number;
  content?: string;
  role: 'system' | 'user';
  type: 'chat' | 'note' | 'clipboard' | 'clear' | 'condensed' | 'model_change';
  image?: string;
  images?: string[];
  imageAnalyses?: JsonValue;
  attachments?: JsonValue;
  inserted: boolean;
  createdAt: number;
  ragSources?: string[];
  ragSourceDetails?: JsonValue;
  agentHistory?: JsonValue;
  uiBlocks?: JsonValue;
  thinking?: string;
  quoteData?: ChatQuoteData;
  condensedContent?: string;
  condensedAt?: number;
  originalTokenCount?: number;
  originalMessageCount?: number;
}

type DbRow = typeof chatMessages.$inferSelect;

function mapRow(row: DbRow): ChatMessageRow {
  return {
    id: row.id,
    ...(row.tagId === null ? {} : { tagId: row.tagId }),
    conversationId: row.conversationId,
    ...(row.content === null ? {} : { content: row.content }),
    role: row.role as ChatMessageRow['role'],
    type: row.type as ChatMessageRow['type'],
    ...(row.image === null ? {} : { image: row.image }),
    ...(row.images === null ? {} : { images: row.images as string[] }),
    ...(row.imageAnalyses === null ? {} : { imageAnalyses: row.imageAnalyses as unknown as JsonValue }),
    ...(row.attachments === null ? {} : { attachments: row.attachments as unknown as JsonValue }),
    inserted: row.inserted,
    createdAt: row.createdAt.getTime(),
    ...(row.ragSources === null ? {} : { ragSources: row.ragSources as string[] }),
    ...(row.ragSourceDetails === null
      ? {}
      : { ragSourceDetails: row.ragSourceDetails as unknown as JsonValue }),
    ...(row.agentHistory === null ? {} : { agentHistory: row.agentHistory as unknown as JsonValue }),
    ...(row.uiBlocks === null ? {} : { uiBlocks: row.uiBlocks as unknown as JsonValue }),
    ...(row.thinking === null ? {} : { thinking: row.thinking }),
    ...(row.quoteData === null ? {} : { quoteData: row.quoteData as unknown as ChatQuoteData }),
    ...(row.condensedContent === null ? {} : { condensedContent: row.condensedContent }),
    ...(row.condensedAt === null ? {} : { condensedAt: row.condensedAt.getTime() }),
    ...(row.originalTokenCount === null ? {} : { originalTokenCount: row.originalTokenCount }),
    ...(row.originalMessageCount === null ? {} : { originalMessageCount: row.originalMessageCount }),
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

function parseCursor(cursor: string): number {
  if (!/^\d+$/.test(cursor)) {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  const id = Number(cursor);
  if (!Number.isSafeInteger(id)) {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  return id;
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
): Promise<readonly ChatMessageRow[]> {
  validate(op);
  const limit = clampLimit(op.limit);
  const afterId = op.cursor === undefined ? null : parseCursor(op.cursor);
  const conditions = [
    eq(chatMessages.workspaceId, ctx.workspaceId),
    eq(chatMessages.conversationId, op.conversationId),
  ];
  if (afterId !== null) {
    conditions.push(gt(chatMessages.id, afterId));
  }
  const rows = await ctx.tx
    .select()
    .from(chatMessages)
    .where(and(...conditions))
    .orderBy(asc(chatMessages.id))
    .limit(limit);
  return rows.map(mapRow);
}
