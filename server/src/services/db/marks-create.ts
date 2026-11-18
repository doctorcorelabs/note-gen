// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: marks.create.
//
// One transaction: the mark row, its mark_tags rows, and one record
// activity event, replacing upstream insertMark plus saveMarkTagIds
// plus insertActivityEvent (design section 4.2). tagIds is
// optional: when absent the effective set is the primary tag alone.
// The primary tag is always present in mark_tags (design 1.3 rule
// 2). activity is optional: when absent the server derives the event
// title and description from the mark exactly as upstream insertMark
// does (desc, content, or url, truncated to 140 characters). The
// event source, dedupeKey, and createdAt are server-derived and are
// rejected as unknown fields when sent inside activity.
//
// sourceId is first-write-wins (insertExternalMark): a sent
// sourceId that already names a mark in this workspace returns that
// mark with affected 0 and changes nothing; when omitted the server
// mints a UUID. A race between the existence check and the insert is
// resolved by the partial unique index (workspace_id, source_id):
// the insert uses ON CONFLICT DO NOTHING and the raced row is then
// re-selected and returned with affected 0, never a 409, matching
// the knowledge upsert precedent. A tag id that names no tag in this workspace answers
// 400 tag_not_found (kontrak section 6.2), for the primary tag and
// for every tagIds entry alike.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { activityEvents, markTags, marks, tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'marks.create' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export interface NewMarkInput {
  tagId: number;
  type: 'scan' | 'text' | 'image' | 'link' | 'file' | 'recording' | 'todo';
  content?: string;
  desc?: string;
  url: string;
  sourceId?: string;
}

export interface MarkCreateActivityInput {
  title: string;
  description?: string | null;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  mark: NewMarkInput;
  tagIds?: number[];
  activity?: MarkCreateActivityInput;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const MARK_TYPES: readonly string[] = ['scan', 'text', 'image', 'link', 'file', 'recording', 'todo'];
const ACTIVITY_PREVIEW_LENGTH = 140;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

function tagNotFound(tagId: number): ApiError {
  return new ApiError(400, 'tag_not_found', 'The referenced tag was not found in this workspace.', {
    details: { tagId },
  });
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateMark(value: unknown): asserts value is NewMarkInput {
  if (!isRecord(value)) {
    throw validationIssue('mark', 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'tagId' && key !== 'type' && key !== 'content' && key !== 'desc' && key !== 'url' && key !== 'sourceId') {
      throw validationIssue(`mark.${key}`, 'unknown field');
    }
  }
  if (!isPositiveInteger(value.tagId)) {
    throw validationIssue('mark.tagId', 'must be a positive integer');
  }
  if (typeof value.type !== 'string' || !MARK_TYPES.includes(value.type)) {
    throw validationIssue('mark.type', 'must be a known mark type');
  }
  if (value.content !== undefined && typeof value.content !== 'string') {
    throw validationIssue('mark.content', 'must be a string');
  }
  if (value.desc !== undefined && typeof value.desc !== 'string') {
    throw validationIssue('mark.desc', 'must be a string');
  }
  if (typeof value.url !== 'string') {
    throw validationIssue('mark.url', 'must be a string');
  }
  if (value.sourceId !== undefined && (typeof value.sourceId !== 'string' || value.sourceId === '')) {
    throw validationIssue('mark.sourceId', 'must be a non-empty string');
  }
}

function validateActivity(value: unknown): asserts value is MarkCreateActivityInput | undefined {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw validationIssue('activity', 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'title' && key !== 'description') {
      throw validationIssue(`activity.${key}`, 'unknown field');
    }
  }
  if (typeof value.title !== 'string') {
    throw validationIssue('activity.title', 'must be a string');
  }
  if (value.description !== undefined && value.description !== null && typeof value.description !== 'string') {
    throw validationIssue('activity.description', 'must be a string or null');
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'mark' && key !== 'tagIds' && key !== 'activity') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  validateMark(op.mark);
  if (op.tagIds !== undefined) {
    if (!Array.isArray(op.tagIds) || !op.tagIds.every((entry) => isPositiveInteger(entry))) {
      throw validationIssue('tagIds', 'must be an array of positive integers');
    }
  }
  validateActivity(op.activity);
}

// Upstream truncateActivityText, replicated locally: collapse
// whitespace, trim, and cap at the given length with an ellipsis.
function truncateActivityText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function sortedUnique(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const mark = op.mark;
  const effectiveTagIds = sortedUnique([mark.tagId, ...(op.tagIds ?? [])]);
  const owned = await ctx.tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.workspaceId, ctx.workspaceId), inArray(tags.id, effectiveTagIds)));
  const ownedIds = new Set(owned.map((row) => row.id));
  for (const tagId of effectiveTagIds) {
    if (!ownedIds.has(tagId)) {
      throw tagNotFound(tagId);
    }
  }
  const sourceId = mark.sourceId ?? randomUUID();
  if (mark.sourceId !== undefined) {
    const existing = await ctx.tx
      .select({ id: marks.id, version: marks.version })
      .from(marks)
      .where(and(eq(marks.workspaceId, ctx.workspaceId), eq(marks.sourceId, sourceId)))
      .limit(1);
    const found = existing[0];
    if (found !== undefined) {
      return { affected: 0, id: found.id, version: found.version };
    }
  }
  const now = new Date();
  const inserted = await ctx.tx
    .insert(marks)
    .values({
      workspaceId: ctx.workspaceId,
      tagId: mark.tagId,
      type: mark.type,
      content: mark.content ?? null,
      url: mark.url,
      desc: mark.desc ?? null,
      sourceId,
      tagUpdatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: marks.id, version: marks.version });
  const created = inserted[0];
  if (created === undefined) {
    const raced = await ctx.tx
      .select({ id: marks.id, version: marks.version })
      .from(marks)
      .where(and(eq(marks.workspaceId, ctx.workspaceId), eq(marks.sourceId, sourceId)))
      .limit(1);
    const racedRow = raced[0];
    if (racedRow !== undefined) {
      return { affected: 0, id: racedRow.id, version: racedRow.version };
    }
    throw ApiError.internalError();
  }
  await ctx.tx.insert(markTags).values(
    effectiveTagIds.map((tagId) => ({ markId: created.id, tagId, workspaceId: ctx.workspaceId })),
  );
  const preview = truncateActivityText(mark.desc || mark.content || mark.url || '', ACTIVITY_PREVIEW_LENGTH);
  const title = op.activity !== undefined ? op.activity.title : preview || mark.type || 'record';
  const description =
    op.activity !== undefined ? (op.activity.description ?? null) : preview || mark.type || '';
  await ctx.tx
    .insert(activityEvents)
    .values({
      workspaceId: ctx.workspaceId,
      tagId: mark.tagId,
      source: 'record',
      title,
      description,
      dedupeKey: `record:${created.id}`,
      createdAt: now,
    })
    .onConflictDoNothing();
  return { affected: 1, id: created.id, version: created.version };
}
