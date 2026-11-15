// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: messages.update.
//
// Patch form (D-05): absent fields are preserved. The guard
// expectedAgentHistory, when present, guards ONLY the agent-history
// field: a mismatch writes nothing and reports affected 0, it is not
// a throw and not a 409, and the enclosing transaction still commits
// for its other operations. A successful write invalidates the
// compactions of the affected conversation (and of the new
// conversation when the patch moves the message), by deleting those
// compaction rows in the same transaction, as upstream updateChat
// does. A missing row answers the generic 404.
//
// Role and type values in the patch are validated against the locked
// sets (D-08). The five unlocked JSON fields are accepted as
// well-formed JSON only; no element shape is invented (G-03).
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq, inArray } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import {
  chatMessages,
  conversationCompactions,
  conversations,
  tags,
  type Database,
} from '../../db/index.js';

export const HANDLER_KIND = 'messages.update' as const;

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

export interface ChatMessagePatch {
  tagId?: number;
  conversationId?: number;
  content?: string;
  role?: ChatRole;
  type?: ChatType;
  image?: string;
  images?: string[];
  imageAnalyses?: JsonValue;
  attachments?: JsonValue;
  inserted?: boolean;
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
  id: number;
  patch: ChatMessagePatch;
  expectedAgentHistory?: JsonValue | null;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const ROLES: readonly string[] = ['system', 'user'];
const TYPES: readonly string[] = ['chat', 'note', 'clipboard', 'clear', 'condensed', 'model_change'];
const PATCH_KEYS: readonly string[] = [
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
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

function validatePatch(patch: unknown): asserts patch is ChatMessagePatch {
  if (!isRecord(patch)) {
    throw validationIssue('patch', 'must be an object');
  }
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.includes(key)) {
      throw validationIssue(`patch.${key}`, 'unknown field');
    }
  }
  for (const key of ['tagId', 'conversationId']) {
    if (patch[key] !== undefined && (typeof patch[key] !== 'number' || !Number.isInteger(patch[key]))) {
      throw validationIssue(`patch.${key}`, 'must be an integer');
    }
  }
  for (const key of ['content', 'image', 'thinking', 'condensedContent']) {
    if (patch[key] !== undefined && typeof patch[key] !== 'string') {
      throw validationIssue(`patch.${key}`, 'must be a string');
    }
  }
  if (patch.role !== undefined && (typeof patch.role !== 'string' || !ROLES.includes(patch.role))) {
    throw validationIssue('patch.role', 'must be a known role');
  }
  if (patch.type !== undefined && (typeof patch.type !== 'string' || !TYPES.includes(patch.type))) {
    throw validationIssue('patch.type', 'must be a known type');
  }
  if (patch.images !== undefined && !isStringArray(patch.images)) {
    throw validationIssue('patch.images', 'must be an array of strings');
  }
  if (patch.ragSources !== undefined && !isStringArray(patch.ragSources)) {
    throw validationIssue('patch.ragSources', 'must be an array of strings');
  }
  for (const key of ['imageAnalyses', 'attachments', 'ragSourceDetails', 'agentHistory', 'uiBlocks']) {
    if (patch[key] !== undefined && !isJsonValue(patch[key])) {
      throw validationIssue(`patch.${key}`, 'must be a JSON value');
    }
  }
  if (patch.inserted !== undefined && typeof patch.inserted !== 'boolean') {
    throw validationIssue('patch.inserted', 'must be a boolean');
  }
  if (patch.quoteData !== undefined) {
    validateQuoteData(patch.quoteData, 'patch.quoteData');
  }
  for (const key of ['condensedAt', 'originalTokenCount', 'originalMessageCount']) {
    if (
      patch[key] !== undefined &&
      (typeof patch[key] !== 'number' || !Number.isInteger(patch[key] as number))
    ) {
      throw validationIssue(`patch.${key}`, 'must be an integer');
    }
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'id' && key !== 'patch' && key !== 'expectedAgentHistory') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (typeof op.id !== 'number' || !Number.isInteger(op.id)) {
    throw validationIssue('id', 'must be an integer');
  }
  validatePatch(op.patch);
  if ('expectedAgentHistory' in op && op.expectedAgentHistory !== undefined) {
    if (!isJsonValue(op.expectedAgentHistory)) {
      throw validationIssue('expectedAgentHistory', 'must be a JSON value or null');
    }
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.workspaceId, ctx.workspaceId), eq(chatMessages.id, op.id)))
    .limit(1)
    .for('update');
  const current = rows[0];
  if (current === undefined) {
    throw ApiError.notFound();
  }
  const guardActive =
    'expectedAgentHistory' in op && (op as HandlerOperation).expectedAgentHistory !== undefined;
  if (guardActive) {
    const stored = current.agentHistory === null ? null : (current.agentHistory as unknown);
    const expected = (op as HandlerOperation).expectedAgentHistory as unknown;
    if (stableStringify(stored) !== stableStringify(expected)) {
      return { affected: 0, id: current.id };
    }
  }
  const patch = op.patch;
  if (Object.keys(patch).length === 0) {
    return { affected: 0, id: current.id };
  }
  if (patch.tagId !== undefined) {
    const tagRows = await ctx.tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, patch.tagId)))
      .limit(1);
    if (tagRows.length === 0) {
      throw validationIssue('patch.tagId', 'tag does not exist');
    }
  }
  if (patch.conversationId !== undefined && patch.conversationId !== current.conversationId) {
    const convRows = await ctx.tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.workspaceId, ctx.workspaceId), eq(conversations.id, patch.conversationId)),
      )
      .limit(1);
    if (convRows.length === 0) {
      throw ApiError.notFound();
    }
  }
  await ctx.tx
    .update(chatMessages)
    .set({
      ...(patch.tagId === undefined ? {} : { tagId: patch.tagId }),
      ...(patch.conversationId === undefined ? {} : { conversationId: patch.conversationId }),
      ...(patch.content === undefined ? {} : { content: patch.content }),
      ...(patch.role === undefined ? {} : { role: patch.role }),
      ...(patch.type === undefined ? {} : { type: patch.type }),
      ...(patch.image === undefined ? {} : { image: patch.image }),
      ...(patch.images === undefined ? {} : { images: patch.images }),
      ...(patch.imageAnalyses === undefined
        ? {}
        : { imageAnalyses: patch.imageAnalyses as unknown as unknown[] }),
      ...(patch.attachments === undefined
        ? {}
        : { attachments: patch.attachments as unknown as unknown[] }),
      ...(patch.inserted === undefined ? {} : { inserted: patch.inserted }),
      ...(patch.ragSources === undefined ? {} : { ragSources: patch.ragSources }),
      ...(patch.ragSourceDetails === undefined
        ? {}
        : { ragSourceDetails: patch.ragSourceDetails as unknown as unknown[] }),
      ...(patch.agentHistory === undefined
        ? {}
        : { agentHistory: patch.agentHistory as unknown as unknown[] }),
      ...(patch.thinking === undefined ? {} : { thinking: patch.thinking }),
      ...(patch.quoteData === undefined
        ? {}
        : { quoteData: patch.quoteData as unknown as Record<string, unknown> }),
      ...(patch.condensedContent === undefined ? {} : { condensedContent: patch.condensedContent }),
      ...(patch.condensedAt === undefined ? {} : { condensedAt: new Date(patch.condensedAt) }),
      ...(patch.originalTokenCount === undefined
        ? {}
        : { originalTokenCount: patch.originalTokenCount }),
      ...(patch.originalMessageCount === undefined
        ? {}
        : { originalMessageCount: patch.originalMessageCount }),
      ...(patch.uiBlocks === undefined ? {} : { uiBlocks: patch.uiBlocks as unknown as unknown[] }),
    })
    .where(eq(chatMessages.id, current.id));
  const affectedConversations = new Set<number>([current.conversationId]);
  if (patch.conversationId !== undefined) {
    affectedConversations.add(patch.conversationId);
  }
  await ctx.tx.delete(conversationCompactions).where(
    and(
      eq(conversationCompactions.workspaceId, ctx.workspaceId),
      inArray(conversationCompactions.conversationId, [...affectedConversations]),
    ),
  );
  return { affected: 1, id: current.id };
}
