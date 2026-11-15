// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: notes.insert.
//
// Upstream: insertNote. A pure insert (A10): no upsert and no unique
// constraint on (workspace, tag) is assumed, so several notes may
// exist for one tag and readers take the newest row. createdAt is
// server-assigned; the client never sends it. The tag must belong to
// the caller's workspace: a missing tag, or a tag owned by another
// workspace, answers the generic 404, indistinguishable from a
// missing tag (AD-08). The foreign key alone cannot enforce this,
// because it checks existence without checking the workspace.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { notes, tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'notes.insert' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export interface NewNote {
  tagId: number;
  content?: string;
  locale: string;
  count: string;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  note: NewNote;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

const NOTE_KEYS: readonly string[] = ['tagId', 'content', 'locale', 'count'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

function validateNote(note: unknown): asserts note is NewNote {
  if (!isRecord(note)) {
    throw validationIssue('note', 'must be an object');
  }
  for (const key of Object.keys(note)) {
    if (!NOTE_KEYS.includes(key)) {
      throw validationIssue(`note.${key}`, 'unknown field');
    }
  }
  if (typeof note.tagId !== 'number' || !Number.isInteger(note.tagId)) {
    throw validationIssue('note.tagId', 'must be an integer');
  }
  if (note.content !== undefined && typeof note.content !== 'string') {
    throw validationIssue('note.content', 'must be a string');
  }
  if (typeof note.locale !== 'string') {
    throw validationIssue('note.locale', 'must be a string');
  }
  if (typeof note.count !== 'string') {
    throw validationIssue('note.count', 'must be a string');
  }
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'note') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  validateNote(op.note);
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const note = op.note;
  const owned = await ctx.tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, note.tagId)))
    .limit(1);
  if (owned.length === 0) {
    throw ApiError.notFound();
  }
  const inserted = await ctx.tx
    .insert(notes)
    .values({
      workspaceId: ctx.workspaceId,
      tagId: note.tagId,
      content: note.content ?? null,
      locale: note.locale,
      count: note.count,
    })
    .returning({ id: notes.id });
  const created = inserted[0];
  if (created === undefined) {
    throw ApiError.internalError();
  }
  return { affected: 1, id: created.id };
}
