// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: knowledge.upsertSource.
//
// Upstream: upsertKnowledgeSource / registerDocument, with the hash
// status machine of design 1.7:
//
// - A new source is inserted with the fields as sent.
// - An unchanged contentHash on a ready source is a no-op
//   (affected 0, no write at all).
// - A changed contentHash resets status to pending while keeping the
//   old indexedHash, so search can keep using the old index while a
//   reindex runs. The other fields follow the upstream upsert and are
//   overwritten with the sent values.
// - An unchanged hash on a non-ready source follows the upstream
//   upsert: the sent fields overwrite the stored row.
//
// The existing row is locked in the transaction before the decision,
// so the read and the write cannot be interleaved by another writer.
// A concurrent insert that wins the race for a new key is handled by
// re-reading the row and applying the same machine once.
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

export const HANDLER_KIND = 'knowledge.upsertSource' as const;

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
  source: KnowledgeSourceInput;
}

export type KnowledgeSourceType = 'article' | 'record' | 'canvas';

export type KnowledgeIndexStatus = 'pending' | 'indexing' | 'ready' | 'failed';

export interface KnowledgeLocator {
  filePath?: string;
  markId?: number;
  tagId?: number;
  tagIds?: number[];
  canvasId?: string;
  nodeIds?: string[];
}

export interface KnowledgeSourceInput {
  sourceKey: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  title: string;
  contentHash: string;
  indexedHash?: string | null;
  updatedAt: number;
  locator: KnowledgeLocator;
  status: KnowledgeIndexStatus;
  error?: string | null;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const SOURCE_TYPES: readonly string[] = ['article', 'record', 'canvas'];
const STATUSES: readonly string[] = ['pending', 'indexing', 'ready', 'failed'];
const SOURCE_KEYS: readonly string[] = [
  'sourceKey',
  'sourceType',
  'sourceId',
  'title',
  'contentHash',
  'indexedHash',
  'updatedAt',
  'locator',
  'status',
  'error',
];
const LOCATOR_KEYS: readonly string[] = ['filePath', 'markId', 'tagId', 'tagIds', 'canvasId', 'nodeIds'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isIntegerArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'number' && Number.isInteger(entry))
  );
}

function validateLocator(value: unknown): asserts value is KnowledgeLocator {
  if (!isRecord(value)) {
    throw validationIssue('source.locator', 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!LOCATOR_KEYS.includes(key)) {
      throw validationIssue(`source.locator.${key}`, 'unknown field');
    }
  }
  if (value.filePath !== undefined && typeof value.filePath !== 'string') {
    throw validationIssue('source.locator.filePath', 'must be a string');
  }
  if (value.markId !== undefined && (typeof value.markId !== 'number' || !Number.isInteger(value.markId))) {
    throw validationIssue('source.locator.markId', 'must be an integer');
  }
  if (value.tagId !== undefined && (typeof value.tagId !== 'number' || !Number.isInteger(value.tagId))) {
    throw validationIssue('source.locator.tagId', 'must be an integer');
  }
  if (value.tagIds !== undefined && !isIntegerArray(value.tagIds)) {
    throw validationIssue('source.locator.tagIds', 'must be an array of integers');
  }
  if (value.canvasId !== undefined && typeof value.canvasId !== 'string') {
    throw validationIssue('source.locator.canvasId', 'must be a string');
  }
  if (value.nodeIds !== undefined && !isStringArray(value.nodeIds)) {
    throw validationIssue('source.locator.nodeIds', 'must be an array of strings');
  }
}

function validateSource(value: unknown): asserts value is KnowledgeSourceInput {
  if (!isRecord(value)) {
    throw validationIssue('source', 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!SOURCE_KEYS.includes(key)) {
      throw validationIssue(`source.${key}`, 'unknown field');
    }
  }
  for (const key of ['sourceKey', 'sourceId', 'title', 'contentHash']) {
    if (typeof value[key] !== 'string') {
      throw validationIssue(`source.${key}`, 'must be a string');
    }
  }
  if (typeof value.sourceType !== 'string' || !SOURCE_TYPES.includes(value.sourceType)) {
    throw validationIssue('source.sourceType', 'must be a known source type');
  }
  if (typeof value.status !== 'string' || !STATUSES.includes(value.status)) {
    throw validationIssue('source.status', 'must be a known status');
  }
  if (typeof value.updatedAt !== 'number' || !Number.isInteger(value.updatedAt)) {
    throw validationIssue('source.updatedAt', 'must be an integer');
  }
  if (value.indexedHash !== undefined && value.indexedHash !== null && typeof value.indexedHash !== 'string') {
    throw validationIssue('source.indexedHash', 'must be a string or null');
  }
  if (value.error !== undefined && value.error !== null && typeof value.error !== 'string') {
    throw validationIssue('source.error', 'must be a string or null');
  }
  validateLocator(value.locator);
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'source') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  validateSource(op.source);
}

type DbRow = typeof knowledgeSources.$inferSelect;

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const source = op.source;
  const where = and(
    eq(knowledgeSources.workspaceId, ctx.workspaceId),
    eq(knowledgeSources.sourceKey, source.sourceKey),
  );

  async function applyToExisting(existing: DbRow): Promise<WriteResult> {
    if (existing.contentHash === source.contentHash && existing.status === 'ready') {
      return { affected: 0, id: source.sourceKey };
    }
    const hashChanged = existing.contentHash !== source.contentHash;
    await ctx.tx
      .update(knowledgeSources)
      .set({
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        title: source.title,
        locator: source.locator as Record<string, unknown>,
        contentHash: source.contentHash,
        indexedHash: hashChanged ? existing.indexedHash : (source.indexedHash ?? null),
        status: hashChanged ? 'pending' : source.status,
        error: source.error ?? null,
        updatedAt: new Date(source.updatedAt),
      })
      .where(where);
    return { affected: 1, id: source.sourceKey };
  }

  const locked = await ctx.tx.select().from(knowledgeSources).where(where).limit(1).for('update');
  const existing = locked[0];
  if (existing !== undefined) {
    return applyToExisting(existing);
  }
  const inserted = await ctx.tx
    .insert(knowledgeSources)
    .values({
      workspaceId: ctx.workspaceId,
      sourceKey: source.sourceKey,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      title: source.title,
      locator: source.locator as Record<string, unknown>,
      contentHash: source.contentHash,
      indexedHash: source.indexedHash ?? null,
      status: source.status,
      error: source.error ?? null,
      updatedAt: new Date(source.updatedAt),
    })
    .onConflictDoNothing()
    .returning({ sourceKey: knowledgeSources.sourceKey });
  if (inserted.length > 0) {
    return { affected: 1, id: source.sourceKey };
  }
  const raced = await ctx.tx.select().from(knowledgeSources).where(where).limit(1).for('update');
  const racedRow = raced[0];
  if (racedRow === undefined) {
    throw ApiError.internalError();
  }
  return applyToExisting(racedRow);
}
