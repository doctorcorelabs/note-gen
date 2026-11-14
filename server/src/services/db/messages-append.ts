// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: messages.append.
//
// One transaction: insert the message, then bump the conversation
// messageCount, updatedAt, and version. The optional guard
// expectedConversationVersion is checked against the conversation
// row locked in the transaction; a miss answers 409
// revision_conflict with the current version and message count.
//
// Asymmetry is deliberate (D-04): append writes NO activity event.
// Callers that need one send a separate activity insert in the same
// transaction. Role and type are validated against the locked sets
// (D-08). The five unlocked JSON fields are accepted as well-formed
// JSON only; no element shape is invented (G-03).
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { chatMessages, conversations, tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'messages.append' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ChatRole = 'system' | 'user';
export type ChatType = 'chat' | 'note' | 'clipboard' | 'clear' | 'condensed' | 'model_change';

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

export interface NewChatMessage {
  tagId?: number;
  conversationId: number;
  content?: string;
  role: ChatRole;
  type: ChatType;
  image?: string;
  images?: string[];
  imageAnalyses?: JsonValue;
  attachments?: JsonValue;
  inserted: boolean;
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

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  message: NewChatMessage;
  expectedConversationVersion?: number;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const ROLES: readonly string[] = ['system', 'user'];
const TYPES: readonly string[] = ['chat', 'note', 'clipboard', 'clear', 'condensed', 'model_change'];
const MESSAGE_KEYS: readonly string[] = [
  'tagId',
  'conversationId',
  'content',
  'role',
  'type',
  'image',
  'images',
  'imageAnalyses',
  'attachments',
  'inserted',
  'ragSources',
  'ragSourceDetails',
  'agentHistory',
  'uiBlocks',
  'thinking',
  'quoteData',
  'condensedContent',
  'condensedAt',
  'originalTokenCount',
  'originalMessageCount',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function validateQuoteData(value: unknown, field: string): void {
  if (!isRecord(value)) {
    throw validationIssue(field, 'must be an object');
  }
  const stringKeys = ['quote', 'fullContent', 'fileName', 'articlePath'];
  const numberKeys = ['startLine', 'endLine', 'from', 'to'];
  for (const key of Object.keys(value)) {
    if (!stringKeys.includes(key) && !numberKeys.includes(key)) {
      throw validationIssue(`${field}.${key}`, 'unknown field');
    }
  }
  for (const key of stringKeys) {
    if (typeof value[key] !== 'string') {
      throw validationIssue(`${field}.${key}`, 'must be a string');
    }
  }
  for (const key of numberKeys) {
    if (typeof value[key] !== 'number' || !Number.isInteger(value[key] as number)) {
      throw validationIssue(`${field}.${key}`, 'must be an integer');
    }
  }
}

function validateMessage(message: unknown): asserts message is NewChatMessage {
  if (!isRecord(message)) {
    throw validationIssue('message', 'must be an object');
  }
  for (const key of Object.keys(message)) {
    if (!MESSAGE_KEYS.includes(key)) {
      throw validationIssue(`message.${key}`, 'unknown field');
    }
  }
  if (message.tagId !== undefined && (typeof message.tagId !== 'number' || !Number.isInteger(message.tagId))) {
    throw validationIssue('message.tagId', 'must be an integer');
  }
  if (typeof message.conversationId !== 'number' || !Number.isInteger(message.conversationId)) {
    throw validationIssue('message.conversationId', 'must be an integer');
  }
  for (const key of ['content', 'image', 'thinking', 'condensedContent']) {
    if (message[key] !== undefined && typeof message[key] !== 'string') {
      throw validationIssue(`message.${key}`, 'must be a string');
    }
  }
  if (typeof message.role !== 'string' || !ROLES.includes(message.role)) {
    throw validationIssue('message.role', 'must be a known role');
  }
  if (typeof message.type !== 'string' || !TYPES.includes(message.type)) {
    throw validationIssue('message.type', 'must be a known type');
  }
  if (message.images !== undefined && !isStringArray(message.images)) {
    throw validationIssue('message.images', 'must be an array of strings');
  }
  if (message.ragSources !== undefined && !isStringArray(message.ragSources)) {
    throw validationIssue('message.ragSources', 'must be an array of strings');
  }
  for (const key of ['imageAnalyses', 'attachments', 'ragSourceDetails', 'agentHistory', 'uiBlocks']) {
    if (message[key] !== undefined && !isJsonValue(message[key])) {
      throw validationIssue(`message.${key}`, 'must be a JSON value');
    }
  }
  if (typeof message.inserted !== 'boolean') {
    throw validationIssue('message.inserted', 'must be a boolean');
  }
  if (message.quoteData !== undefined) {
    validateQuoteData(message.quoteData, 'message.quoteData');
  }
  for (const key of ['condensedAt', 'originalTokenCount', 'originalMessageCount']) {
    if (
      message[key] !== undefined &&
      (typeof message[key] !== 'number' || !Number.isInteger(message[key] as number))
    ) {
      throw validationIssue(`message.${key}`, 'must be an integer');
    }
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'message' && key !== 'expectedConversationVersion') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  validateMessage(op.message);
  if (
    op.expectedConversationVersion !== undefined &&
    (typeof op.expectedConversationVersion !== 'number' ||
      !Number.isInteger(op.expectedConversationVersion))
  ) {
    throw validationIssue('expectedConversationVersion', 'must be an integer');
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const message = op.message;
  const locked = await ctx.tx
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.workspaceId, ctx.workspaceId), eq(conversations.id, message.conversationId)),
    )
    .limit(1)
    .for('update');
  const conversation = locked[0];
  if (conversation === undefined) {
    throw ApiError.notFound();
  }
  if (
    op.expectedConversationVersion !== undefined &&
    op.expectedConversationVersion !== conversation.version
  ) {
    throw ApiError.revisionConflict({
      currentVersion: conversation.version,
      currentMessageCount: conversation.messageCount,
    });
  }
  if (message.tagId !== undefined) {
    const tagRows = await ctx.tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, message.tagId)))
      .limit(1);
    if (tagRows.length === 0) {
      throw validationIssue('message.tagId', 'tag does not exist');
    }
  }
  const nextVersion = conversation.version + 1;
  const now = new Date();
  const inserted = await ctx.tx
    .insert(chatMessages)
    .values({
      workspaceId: ctx.workspaceId,
      conversationId: message.conversationId,
      ...(message.tagId === undefined ? {} : { tagId: message.tagId }),
      ...(message.content === undefined ? {} : { content: message.content }),
      role: message.role,
      type: message.type,
      ...(message.image === undefined ? {} : { image: message.image }),
      ...(message.images === undefined ? {} : { images: message.images }),
      ...(message.imageAnalyses === undefined
        ? {}
        : { imageAnalyses: message.imageAnalyses as unknown as unknown[] }),
      ...(message.attachments === undefined
        ? {}
        : { attachments: message.attachments as unknown as unknown[] }),
      inserted: message.inserted,
      ...(message.ragSources === undefined ? {} : { ragSources: message.ragSources }),
      ...(message.ragSourceDetails === undefined
        ? {}
        : { ragSourceDetails: message.ragSourceDetails as unknown as unknown[] }),
      ...(message.agentHistory === undefined
        ? {}
        : { agentHistory: message.agentHistory as unknown as unknown[] }),
      ...(message.thinking === undefined ? {} : { thinking: message.thinking }),
      ...(message.quoteData === undefined
        ? {}
        : { quoteData: message.quoteData as unknown as Record<string, unknown> }),
      ...(message.condensedContent === undefined ? {} : { condensedContent: message.condensedContent }),
      ...(message.condensedAt === undefined ? {} : { condensedAt: new Date(message.condensedAt) }),
      ...(message.originalTokenCount === undefined
        ? {}
        : { originalTokenCount: message.originalTokenCount }),
      ...(message.originalMessageCount === undefined
        ? {}
        : { originalMessageCount: message.originalMessageCount }),
      ...(message.uiBlocks === undefined
        ? {}
        : { uiBlocks: message.uiBlocks as unknown as unknown[] }),
    })
    .returning({ id: chatMessages.id });
  const created = inserted[0];
  if (created === undefined) {
    throw ApiError.internalError();
  }
  await ctx.tx
    .update(conversations)
    .set({ messageCount: conversation.messageCount + 1, version: nextVersion, updatedAt: now })
    .where(eq(conversations.id, conversation.id));
  return { affected: 1, id: created.id, version: nextVersion };
}
