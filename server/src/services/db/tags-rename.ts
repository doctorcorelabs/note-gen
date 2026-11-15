// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: tags.rename.
//
// Upstream `updateTag`, catalog union `{ kind, id, name, isPin?,
// sortOrder? }` (D-11). The name is normalized exactly like upstream
// `normalizeTagName` (trim, drop one leading `#`, trim each `/`
// segment, reject empty segments; S-23 ratification) and capped at
// 100 characters after normalization (kontrak 3.6). Renaming a tag
// renames its descendant paths too: every tag whose name equals the
// old name or starts with the old name plus `/` gets the new prefix
// (upstream `tagPathMatches`). `isPin` and `sortOrder` apply to the
// renamed tag itself only.
//
// Rules, in the order they are checked:
// - The tag must exist in the workspace, else 404 not_found (a row
//   owned by another workspace answers the same generic 404).
// - A locked tag cannot change its name: 409 tag_locked (catalog
//   handler rule; kontrak 3.6). Changing only pin or order on a
//   locked tag, with the name unchanged, is allowed by this kind,
//   matching upstream `updateTag`, which checks the lock only on a
//   name change; the stricter REST rule for pin on locked tags is
//   enforced in the REST service, not in this kind (penguncian D/G
//   D-11 impact note).
// - When the name changes, every renamed name must be free: if any
//   renamed name (the tag itself or a descendant) collides with a
//   tag outside the renamed set, the whole operation answers 409
//   tag_name_taken and nothing is written (upstream collision
//   check, applied to the full renamed set).
// - Re-applying the same rename is a no-op for names: when the
//   normalized name equals the stored name, only pin/order fields
//   that were sent are written; when neither was sent, affected is
//   0. `affected` counts the tag rows whose names were rewritten,
//   or 1 when only pin/order changed.
//
// The rename runs in two phases inside the enclosing transaction:
// affected rows first move to unique temporary names, then to their
// final names. This keeps the per-workspace unique index satisfied
// at every step even when a final name equals another affected
// row's old name (for example renaming `A` to `A/B` while `A/B`
// exists as a child). A single-phase sequential update could hit a
// transient unique violation in that case.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm, node
// crypto). It imports no other handler file and no shared helper.
// The name normalization below is duplicated in the create handler
// on purpose: the kind split (O-10 rule 6) forbids shared helpers.

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'tags.rename' as const;

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
  name: string;
  isPin?: boolean;
  sortOrder?: number;
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

// Normalize a tag name exactly like upstream `normalizeTagName`.
// Returns null when the name is empty after normalization or any
// segment is empty.
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
    if (key !== 'kind' && key !== 'id' && key !== 'name' && key !== 'isPin' && key !== 'sortOrder') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (typeof op.id !== 'number' || !Number.isInteger(op.id)) {
    throw validationIssue('id', 'must be an integer');
  }
  validateName(op.name);
  if (op.isPin !== undefined && typeof op.isPin !== 'boolean') {
    throw validationIssue('isPin', 'must be a boolean');
  }
  if (op.sortOrder !== undefined && (typeof op.sortOrder !== 'number' || !Number.isInteger(op.sortOrder))) {
    throw validationIssue('sortOrder', 'must be an integer');
  }
}

// Upstream `tagPathMatches`: a name is the path itself or below it.
function isDescendantOrSelf(name: string, parent: string): boolean {
  return name === parent || name.startsWith(`${parent}/`);
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const name = validateName(op.name);
  const allTags = await ctx.tx
    .select()
    .from(tags)
    .where(eq(tags.workspaceId, ctx.workspaceId))
    .orderBy(tags.id)
    .for('update');
  const previous = allTags.find((tag) => tag.id === op.id);
  if (previous === undefined) {
    throw ApiError.notFound();
  }
  const now = new Date();
  if (name === previous.name) {
    const hasPin = op.isPin !== undefined;
    const hasOrder = op.sortOrder !== undefined;
    if (!hasPin && !hasOrder) {
      return { affected: 0, id: previous.id };
    }
    await ctx.tx
      .update(tags)
      .set({
        ...(hasPin ? { isPin: op.isPin as boolean } : {}),
        ...(hasOrder ? { sortOrder: op.sortOrder as number } : {}),
        updatedAt: now,
      })
      .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, previous.id)));
    return { affected: 1, id: previous.id };
  }
  if (previous.isLocked) {
    throw new ApiError(409, 'tag_locked', 'The locked tag cannot be renamed.');
  }
  const affected = allTags.filter((tag) => isDescendantOrSelf(tag.name, previous.name));
  const affectedIds = new Set(affected.map((tag) => tag.id));
  const remainingNames = new Set(
    allTags.filter((tag) => !affectedIds.has(tag.id)).map((tag) => tag.name),
  );
  const renamed = affected.map((tag) => ({
    id: tag.id,
    name: name + tag.name.slice(previous.name.length),
  }));
  if (renamed.some((tag) => remainingNames.has(tag.name))) {
    throw new ApiError(409, 'tag_name_taken', 'A tag with this name already exists.');
  }
  const stamp = randomUUID();
  for (const tag of renamed) {
    const current = allTags.find((row) => row.id === tag.id);
    await ctx.tx
      .update(tags)
      .set({ name: `__rename__${stamp}__${current?.name ?? ''}`, updatedAt: now })
      .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, tag.id)));
  }
  for (const tag of renamed) {
    const isTarget = tag.id === previous.id;
    await ctx.tx
      .update(tags)
      .set({
        name: tag.name,
        ...(isTarget && op.isPin !== undefined ? { isPin: op.isPin } : {}),
        ...(isTarget && op.sortOrder !== undefined ? { sortOrder: op.sortOrder } : {}),
        updatedAt: now,
      })
      .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, tag.id)));
  }
  return { affected: renamed.length, id: previous.id };
}
