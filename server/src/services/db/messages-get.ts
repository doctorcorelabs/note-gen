// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: messages.get.
//
// Kind 74, ratified by AMD-O10-01 and AD-44 (G-04). Upstream:
// getChatById. Shape: {id} to one message row via queryOne, null when
// no row exists. In batch terms this handler returns a one-element
// array, or an empty array when no row exists in the caller's
// workspace. A negative id (the upstream store-only convention)
// answers empty without an error, and callers keep their store
// fallback for negative ids. A row owned by another workspace is
// indistinguishable from a missing row.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { chatMessages, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'messages.get' as const;

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
  id: number;
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
    if (key !== 'kind' && key !== 'id') {
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
  if (typeof op.id !== 'number' || !Number.isInteger(op.id)) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'id', issue: 'must be an integer' }],
    });
  }
}

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly ChatMessageRow[]> {
  validate(op);
  if (op.id < 0) {
    return [];
  }
  const rows = await ctx.tx
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.workspaceId, ctx.workspaceId), eq(chatMessages.id, op.id)))
    .limit(1);
  return rows.map(mapRow);
}
