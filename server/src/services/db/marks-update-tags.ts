// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: marks.updateTags.
//
// Full contract in design section 4.4, the direct replacement of
// upstream updateRecordTags. tagIds is the desired set after the
// operation, including the primary tag. Ids that do not name a tag in
// this workspace are ignored (the upstream filter over the valid
// set), except that a request naming no valid tag at all, with no
// new tag created from newNames, answers 400: a mark without a tag
// is not valid. F02-08 (AD-1050): the ignore-unknown-ids rule
// above is the ratified contract, kept deliberately over the
// REST tag_not_found divergence (records-kind-client divergence
// 7): a save never fails because another surface deleted a tag
// first. The primary tag never changes through this
// operation: the old primary is always added to the final set, and
// the marks tag_id column is untouched. Every execution bumps
// version by 1 and refreshes tag_updated_at, even when the set is
// unchanged.
//
// The optional expected guard compares sets, not serializations: the
// expected tag set and expected primary must equal the current state
// exactly, or the answer is 409 record_tags_changed carrying the
// current tag ids, primary, and version in details (kontrak K-04).
// The conflict message is the upstream text required by CT-X6, so
// the error is built directly instead of through the recordTagsChanged
// factory, whose fixed message differs. A missing mark, or a
// soft-deleted mark, answers 404.
//
// newNames (at most 10, each at most 100 characters) are normalized
// with the upstream normalizeTagName rules, replicated locally
// because the server cannot import the client path alias: trim,
// strip one leading hash, trim each slash-separated segment. A name
// that normalizes to empty is ignored; a name with an empty segment
// answers 400. New tags are created in the same transaction with
// ON CONFLICT DO NOTHING over the per-workspace name, then read back
// by name, so an existing name reuses its row.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq, inArray } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { markTags, marks, tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'marks.updateTags' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export interface ExpectedTagState {
  tagIds: number[];
  primaryTagId: number;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  id: number;
  tagIds: number[];
  newNames?: string[];
  expected?: ExpectedTagState;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const MAX_NEW_NAMES = 10;
const MAX_NEW_NAME_LENGTH = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

function isIntegerArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isInteger(entry))
  );
}

// Upstream normalizeTagName, replicated locally. Returns null for a
// name that normalizes to empty (ignored by the caller); throws a
// validation error for a name with an empty path segment.
function normalizeTagName(value: string): string | null {
  const trimmed = value.trim().replace(/^#/, '');
  const parts = trimmed.split('/').map((part) => part.trim());
  const joined = parts.join('/');
  if (joined === '') {
    return null;
  }
  if (parts.some((part) => part === '')) {
    throw validationIssue('newNames', 'tag names must have non-empty segments');
  }
  return joined;
}

function validateNewNames(value: unknown): asserts value is string[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw validationIssue('newNames', 'must be an array');
  }
  if (value.length > MAX_NEW_NAMES) {
    throw validationIssue('newNames', `must contain at most ${MAX_NEW_NAMES} names`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw validationIssue('newNames', 'must contain only strings');
    }
    if (entry.length > MAX_NEW_NAME_LENGTH) {
      throw validationIssue('newNames', `each name must be at most ${MAX_NEW_NAME_LENGTH} characters`);
    }
    normalizeTagName(entry);
  }
}

function validateExpected(value: unknown): asserts value is ExpectedTagState | undefined {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw validationIssue('expected', 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'tagIds' && key !== 'primaryTagId') {
      throw validationIssue(`expected.${key}`, 'unknown field');
    }
  }
  if (!isIntegerArray(value.tagIds)) {
    throw validationIssue('expected.tagIds', 'must be an array of integers');
  }
  if (typeof value.primaryTagId !== 'number' || !Number.isInteger(value.primaryTagId)) {
    throw validationIssue('expected.primaryTagId', 'must be an integer');
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'id' && key !== 'tagIds' && key !== 'newNames' && key !== 'expected') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (typeof op.id !== 'number' || !Number.isInteger(op.id)) {
    throw validationIssue('id', 'must be an integer');
  }
  if (!isIntegerArray(op.tagIds)) {
    throw validationIssue('tagIds', 'must be an array of integers');
  }
  validateNewNames(op.newNames);
  validateExpected(op.expected);
}

function sortedUnique(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

function sameSet(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const locked = await ctx.tx
    .select()
    .from(marks)
    .where(and(eq(marks.workspaceId, ctx.workspaceId), eq(marks.id, op.id)))
    .limit(1)
    .for('update');
  const current = locked[0];
  if (current === undefined || current.deletedAt !== null) {
    throw ApiError.notFound();
  }
  const linkRows = await ctx.tx
    .select({ tagId: markTags.tagId })
    .from(markTags)
    .where(and(eq(markTags.workspaceId, ctx.workspaceId), eq(markTags.markId, current.id)));
  const currentTagIds = sortedUnique([current.tagId, ...linkRows.map((row) => row.tagId)]);
  if (op.expected !== undefined) {
    const expectedTagIds = sortedUnique(op.expected.tagIds);
    if (!sameSet(expectedTagIds, currentTagIds) || op.expected.primaryTagId !== current.tagId) {
      throw new ApiError(
        409,
        'record_tags_changed',
        'Record tags changed. Reopen the tag editor and try again.',
        {
          details: {
            currentTagIds,
            currentPrimaryTagId: current.tagId,
            currentVersion: current.version,
          },
        },
      );
    }
  }
  const workspaceTags = await ctx.tx
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.workspaceId, ctx.workspaceId));
  const validIds = new Set(workspaceTags.map((row) => row.id));
  const filtered = sortedUnique(op.tagIds.filter((id) => validIds.has(id)));
  const wantedNames: string[] = [];
  if (op.newNames !== undefined) {
    for (const raw of op.newNames) {
      const normalized = normalizeTagName(raw);
      if (normalized !== null && !wantedNames.includes(normalized)) {
        wantedNames.push(normalized);
      }
    }
  }
  let newTagIds: number[] = [];
  if (wantedNames.length > 0) {
    await ctx.tx
      .insert(tags)
      .values(wantedNames.map((name) => ({ workspaceId: ctx.workspaceId, name })))
      .onConflictDoNothing();
    const created = await ctx.tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.workspaceId, ctx.workspaceId), inArray(tags.name, wantedNames)));
    newTagIds = created.map((row) => row.id);
  }
  if (filtered.length === 0 && newTagIds.length === 0) {
    throw validationIssue('tagIds', 'must name at least one existing tag');
  }
  const finalSet = sortedUnique([...filtered, ...newTagIds, current.tagId]);
  const now = new Date();
  const nextVersion = current.version + 1;
  await ctx.tx.delete(markTags).where(eq(markTags.markId, current.id));
  await ctx.tx.insert(markTags).values(
    finalSet.map((tagId) => ({ markId: current.id, tagId, workspaceId: ctx.workspaceId })),
  );
  await ctx.tx
    .update(marks)
    .set({ tagUpdatedAt: now, version: nextVersion, updatedAt: now })
    .where(eq(marks.id, current.id));
  return { affected: 1, id: current.id, version: nextVersion };
}
