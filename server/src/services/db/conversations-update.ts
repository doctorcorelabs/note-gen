// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: conversations.update.
//
// Covers title and pin in one kind (D-11): the client sends the
// desired pin value, there is no toggle kind. The optional guard
// expected.version is checked against the row locked in the
// transaction; a miss answers 409 revision_conflict with the current
// version. A successful write bumps version by 1 and refreshes
// updatedAt. A patch with neither field writes nothing and reports
// affected 0. A row owned by another workspace answers the generic
// 404, indistinguishable from a missing row.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { conversations, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'conversations.update' as const;

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface HandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

export interface ConversationPatch {
  title?: string;
  isPinned?: boolean;
}

export interface HandlerOperation {
  kind: typeof HANDLER_KIND;
  id: number;
  patch: ConversationPatch;
  expected?: { version: number };
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
  if (!isRecord(op.patch)) {
    throw validationIssue('patch', 'must be an object');
  }
  for (const key of Object.keys(op.patch)) {
    if (key !== 'title' && key !== 'isPinned') {
      throw validationIssue(`patch.${key}`, 'unknown field');
    }
  }
  if (op.patch.title !== undefined && typeof op.patch.title !== 'string') {
    throw validationIssue('patch.title', 'must be a string');
  }
  if (op.patch.isPinned !== undefined && typeof op.patch.isPinned !== 'boolean') {
    throw validationIssue('patch.isPinned', 'must be a boolean');
  }
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
    .from(conversations)
    .where(and(eq(conversations.workspaceId, ctx.workspaceId), eq(conversations.id, op.id)))
    .limit(1)
    .for('update');
  const current = rows[0];
  if (current === undefined) {
    throw ApiError.notFound();
  }
  if (op.expected !== undefined && op.expected.version !== current.version) {
    throw ApiError.revisionConflict({ currentVersion: current.version });
  }
  const hasTitle = op.patch.title !== undefined;
  const hasPin = op.patch.isPinned !== undefined;
  if (!hasTitle && !hasPin) {
    return { affected: 0, id: current.id, version: current.version };
  }
  const nextVersion = current.version + 1;
  await ctx.tx
    .update(conversations)
    .set({
      ...(hasTitle ? { title: op.patch.title as string } : {}),
      ...(hasPin ? { isPinned: op.patch.isPinned as boolean } : {}),
      version: nextVersion,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, current.id));
  return { affected: 1, id: current.id, version: nextVersion };
}
