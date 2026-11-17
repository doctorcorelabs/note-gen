// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: tags.reorder.
//
// Upstream `updateTagsOrder`: apply the given sortOrder to each
// listed tag. The operation is all-or-nothing inside the enclosing
// transaction: every listed id must exist in the workspace, else
// the whole operation answers 404 not_found and nothing is
// written (a row owned by another workspace answers the same
// generic 404). An empty order list is a no-op with affected 0,
// matching upstream. Duplicate ids in one order list are a
// validation failure: two entries for one tag make the result
// depend on application order, so the operation refuses rather
// than picking a winner silently.
//
// sortOrder values need not be unique and need not be contiguous:
// readers order by pin, then sortOrder, then id, and ties keep a
// deterministic order. No name, lock, or pin field changes here;
// renaming and pinning belong to tags.rename and tags.create.
//
// Re-applying the same order leaves the same sortOrder values
// (catalog idempotency note). `affected` counts the order entries
// applied, including entries whose stored value already matched.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq, inArray } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { tags, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'tags.reorder' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export interface TagOrderEntry {
  id: number;
  sortOrder: number;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  order: TagOrderEntry[];
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationIssue(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', { fields: [{ field, issue }] });
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw validationIssue('operation', 'must be an object');
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'order') {
      throw validationIssue(key, 'unknown field');
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw validationIssue('kind', 'must match the handler kind');
  }
  if (!Array.isArray(op.order)) {
    throw validationIssue('order', 'must be an array');
  }
  const seen = new Set<number>();
  for (let index = 0; index < op.order.length; index += 1) {
    const entry: unknown = op.order[index];
    if (!isRecord(entry)) {
      throw validationIssue(`order[${index}]`, 'must be an object');
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'id' && key !== 'sortOrder') {
        throw validationIssue(`order[${index}].${key}`, 'unknown field');
      }
    }
    if (typeof entry.id !== 'number' || !Number.isInteger(entry.id)) {
      throw validationIssue(`order[${index}].id`, 'must be an integer');
    }
    if (typeof entry.sortOrder !== 'number' || !Number.isInteger(entry.sortOrder)) {
      throw validationIssue(`order[${index}].sortOrder`, 'must be an integer');
    }
    if (seen.has(entry.id)) {
      throw validationIssue(`order[${index}].id`, 'must not repeat an id');
    }
    seen.add(entry.id);
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  if (op.order.length === 0) {
    return { affected: 0 };
  }
  const ids = op.order.map((entry) => entry.id);
  const owned = await ctx.tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.workspaceId, ctx.workspaceId), inArray(tags.id, ids)))
    .for('update');
  const ownedIds = new Set(owned.map((row) => row.id));
  for (const id of ids) {
    if (!ownedIds.has(id)) {
      throw ApiError.notFound();
    }
  }
  const now = new Date();
  for (const entry of op.order) {
    await ctx.tx
      .update(tags)
      .set({ sortOrder: entry.sortOrder, updatedAt: now })
      .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.id, entry.id)));
  }
  return { affected: op.order.length };
}
