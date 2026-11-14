// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: wiki.getMeta.
//
// Upstream: getWikiMeta. The stored value is untyped JSON at this
// level; callers narrow the result. A missing row answers an empty
// array, matching the upstream null. A stored JSON null answers a
// one-element array holding null, so the two cases stay distinct in
// batch terms. contextId is an
// opaque context key (A13): the handler always applies both the
// workspace predicate from the session and the context predicate
// from the operation.
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
import { wikiMeta, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'wiki.getMeta' as const;

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
  contextId: string;
  key: string;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validate(op: unknown): asserts op is HandlerOperation {
  if (!isRecord(op)) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'operation', issue: 'must be an object' }],
    });
  }
  for (const key of Object.keys(op)) {
    if (key !== 'kind' && key !== 'contextId' && key !== 'key') {
      throw ApiError.validation('Request validation failed.', {
        fields: [{ field: key, issue: 'unknown field' }],
      });
    }
  }
  if (op.kind !== HANDLER_KIND) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'kind', issue: 'must match the handler kind' }],
    });
  }
  if (typeof op.contextId !== 'string') {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'contextId', issue: 'must be a string' }],
    });
  }
  if (typeof op.key !== 'string') {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'key', issue: 'must be a string' }],
    });
  }
}

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly JsonValue[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(wikiMeta)
    .where(
      and(
        eq(wikiMeta.workspaceId, ctx.workspaceId),
        eq(wikiMeta.contextId, op.contextId),
        eq(wikiMeta.key, op.key),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    return [];
  }
  return [rows[0].value as JsonValue];
}
