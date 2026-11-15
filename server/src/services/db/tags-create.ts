// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: tags.create.
//
// Upstream `insertTag`, catalog union `{ kind, name }`. The name is
// normalized exactly like upstream `normalizeTagName` (trim, drop one
// leading `#`, trim each `/` segment, reject empty segments; S-23
// ratification) and is capped at 100 characters after normalization
// (kontrak 3.6; the same cap the catalog sets for new tag names in
// marks.updateTags). Uniqueness is case-sensitive, per workspace,
// enforced by the unique index on (workspace_id, name).
//
// Insert uses ON CONFLICT DO NOTHING on the per-workspace name and
// returns the existing tag when the name is taken: a new tag answers
// affected 1, an existing name answers affected 0 with the existing
// id (upstream `insertTag` returns rowsAffected 0 with lastInsertId
// for the existing row). The REST route (kontrak 3.6) answers 409
// tag_name_taken for a duplicate name; it distinguishes the two
// cases from the affected count of this handler. This handler never
// answers tag_name_taken itself.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper. The name normalization
// below is duplicated in the rename handler on purpose: the kind
// split (O-10 rule 6) forbids shared helper files.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'tags.create' as const;

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
  name: string;
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

export const TAG_NAME_MAX_LENGTH = 100;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

// Normalize a tag name exactly like upstream `normalizeTagName`:
// trim, drop one leading `#`, trim each `/` segment, rejoin. Returns
// null when the name is empty after normalization or any segment is
// empty.
export function normalizeTagName(value: string): string | null {
  const name = value
    .trim()
    .replace(/^#/, '')
    .split('/')
    .map((part) => part.trim())
    .join('/');
  if (name === '' || name.split('/').some((part) => part === '')) {
    return null;
  }
  return name;
}

function validateName(value: unknown): string {
  if (typeof value !== 'string') {
    throw validationIssue('name', 'must be a string');
  }
  if (CONTROL_CHARS.test(value)) {
    throw validationIssue('name', 'must not contain control characters');
  }
  const normalized = normalizeTagName(value);
  if (normalized === null) {
    throw validationIssue('name', 'must have non-empty segments');
  }
  if (normalized.length > TAG_NAME_MAX_LENGTH) {
    throw validationIssue('name', `must be at most ${TAG_NAME_MAX_LENGTH} characters`);
  }
  return normalized;
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'name') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  validateName(op.name);
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const name = validateName(op.name);
  const inserted = await ctx.tx
    .insert(tags)
    .values({ workspaceId: ctx.workspaceId, name })
    .onConflictDoNothing({ target: [tags.workspaceId, tags.name] })
    .returning({ id: tags.id });
  const created = inserted[0];
  if (created !== undefined) {
    return { affected: 1, id: created.id };
  }
  const existing = await ctx.tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.name, name)))
    .limit(1);
  const found = existing[0];
  if (found === undefined) {
    throw ApiError.internalError();
  }
  return { affected: 0, id: found.id };
}
