// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: marks.update.
//
// A field patch over one mark, replacing the content part of
// upstream updateMark. Absent fields are preserved; a null content
// or desc clears the field; url cannot be nulled and createdAt is
// not patchable (the fork preserves creation time, unlike upstream).
// The optional guard expected.version is checked against the row
// locked in the transaction; a miss answers 409 revision_conflict
// with the current version and never retries. A successful write
// bumps version by 1 and refreshes updatedAt. A patch with no field
// writes nothing and reports affected 0, after the guard check. A
// row owned by another workspace, or a soft-deleted row, answers
// the generic 404, indistinguishable from a missing row.
//
// Changing tagId moves the primary tag under design 1.3 rule 3:
// additional tags survive the move, so existing mark_tags rows are
// kept and a row for the new primary is added; tag_updated_at is
// refreshed because the effective tag set changed. The new primary
// must name a tag in this workspace, or the answer is 400
// tag_not_found (kontrak section 6.2).
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { markTags, marks, tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'marks.update' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export interface MarkPatch {
  tagId?: number;
  type?: 'scan' | 'text' | 'image' | 'link' | 'file' | 'recording' | 'todo';
  content?: string | null;
  desc?: string | null;
  url?: string;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  id: number;
  patch: MarkPatch;
  expected?: { version: number };
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const MARK_TYPES: readonly string[] = ['scan', 'text', 'image', 'link', 'file', 'recording', 'todo'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

const ASSET_MARK_TYPES: readonly string[] = ['image', 'file', 'recording', 'scan'];

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// URL shape rules per type, mirroring the REST records validation
// (services/records/validation.ts, V1-14 3.2): link requires a valid
// http/https URL, text/todo require an empty url, asset types
// require a non-empty url (an asset key). The protocol check runs
// on the parsed URL, so control-character obfuscation cannot
// smuggle a javascript: URL past it: the WHATWG parser strips a
// leading C0 byte before the protocol is read. This runs in
// handle() against the effective (type, url) pair, because a patch
// may change either field alone; validate() only checks the patch
// shape and stays unaware of the stored row.
function validateMarkUrlShape(type: string, url: string): void {
  if (type === 'link') {
    if (url === '' || !isValidHttpUrl(url)) {
      throw validationIssue('patch.url', 'must be a valid http or https URL');
    }
    return;
  }
  if (type === 'text' || type === 'todo') {
    if (url !== '') {
      throw validationIssue('patch.url', 'must be empty for this record type');
    }
    return;
  }
  if (ASSET_MARK_TYPES.includes(type) && url === '') {
    throw validationIssue('patch.url', 'must be an asset key for this record type');
  }
}

function validatePatch(value: unknown): asserts value is MarkPatch {
  if (!isRecord(value)) {
    throw validationIssue('patch', 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'tagId' && key !== 'type' && key !== 'content' && key !== 'desc' && key !== 'url') {
      throw validationIssue(`patch.${key}`, 'unknown field');
    }
  }
  if (
    value.tagId !== undefined &&
    (typeof value.tagId !== 'number' || !Number.isInteger(value.tagId) || value.tagId <= 0)
  ) {
    throw validationIssue('patch.tagId', 'must be a positive integer');
  }
  if (value.type !== undefined && (typeof value.type !== 'string' || !MARK_TYPES.includes(value.type))) {
    throw validationIssue('patch.type', 'must be a known mark type');
  }
  if (value.content !== undefined && value.content !== null && typeof value.content !== 'string') {
    throw validationIssue('patch.content', 'must be a string or null');
  }
  if (value.desc !== undefined && value.desc !== null && typeof value.desc !== 'string') {
    throw validationIssue('patch.desc', 'must be a string or null');
  }
  if (value.url !== undefined && typeof value.url !== 'string') {
    throw validationIssue('patch.url', 'must be a string');
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'id' && key !== 'patch' && key !== 'expected') {
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
  if (op.expected !== undefined) {
    if (!isRecord(op.expected)) {
      throw validationIssue('expected', 'must be an object');
    }
    for (const key of Object.keys(op.expected)) {
      if (key !== 'version') {
        throw validationIssue(`expected.${key}`, 'unknown field');
      }
    }
    if (typeof op.expected.version !== 'number' || !Number.isInteger(op.expected.version)) {
      throw validationIssue('expected.version', 'must be an integer');
    }
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(marks)
    .where(and(eq(marks.workspaceId, ctx.workspaceId), eq(marks.id, op.id)))
    .limit(1)
    .for('update');
  const current = rows[0];
  if (current === undefined || current.deletedAt !== null) {
    throw ApiError.notFound();
  }
  if (op.expected !== undefined && op.expected.version !== current.version) {
    throw ApiError.revisionConflict({ currentVersion: current.version });
  }
  const patch = op.patch;
  if (patch.url !== undefined || patch.type !== undefined) {
    validateMarkUrlShape(patch.type ?? current.type, patch.url ?? current.url ?? '');
  }
  const movesPrimary = patch.tagId !== undefined && patch.tagId !== current.tagId;
  if (movesPrimary) {
    const owned = await ctx.tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, patch.tagId as number)))
      .limit(1);
    if (owned.length === 0) {
      throw new ApiError(400, 'tag_not_found', 'The referenced tag was not found in this workspace.', {
        details: { tagId: patch.tagId },
      });
    }
  }
  const hasChange =
    patch.tagId !== undefined ||
    patch.type !== undefined ||
    patch.content !== undefined ||
    patch.desc !== undefined ||
    patch.url !== undefined;
  if (!hasChange) {
    return { affected: 0, id: current.id, version: current.version };
  }
  const now = new Date();
  const nextVersion = current.version + 1;
  if (movesPrimary) {
    await ctx.tx
      .insert(markTags)
      .values({ markId: current.id, tagId: patch.tagId as number, workspaceId: ctx.workspaceId })
      .onConflictDoNothing();
  }
  await ctx.tx
    .update(marks)
    .set({
      ...(patch.tagId !== undefined ? { tagId: patch.tagId } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.desc !== undefined ? { desc: patch.desc } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(movesPrimary ? { tagUpdatedAt: now } : {}),
      version: nextVersion,
      updatedAt: now,
    })
    .where(eq(marks.id, current.id));
  return { affected: 1, id: current.id, version: nextVersion };
}
