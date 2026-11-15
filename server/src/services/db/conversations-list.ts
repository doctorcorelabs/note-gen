// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: conversations.list.
//
// Upstream: getAllConversations. Order is pinned first, then updatedAt
// descending, with id descending as the stable tiebreak. Every query is
// scoped to the workspace id from the handler context; the workspace id
// is never an operation field.
//
// Cursor format (opaque to the client, derivable from the last row):
// "<pinned>:<updatedAtMs>:<id>" where pinned is 1 or 0. A malformed
// cursor answers 400 invalid_cursor. Limit defaults to 50 and clamps
// to 1..200; a limit below 1 or not an integer answers 400
// invalid_limit.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, desc, eq, gte, lt, or, type SQL } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { conversations, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'conversations.list' as const;

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
  cursor?: string;
  limit?: number;
}

export interface ConversationRow {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  isPinned: boolean;
  version: number;
}

const CURSOR_PATTERN = /^([01]):(\d+):(\d+)$/;

interface CursorPosition {
  pinned: boolean;
  updatedAtMs: number;
  id: number;
}

function parseCursor(cursor: string): CursorPosition {
  const match = CURSOR_PATTERN.exec(cursor);
  if (match === null) {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  const updatedAtMs = Number(match[2]);
  const id = Number(match[3]);
  if (!Number.isSafeInteger(updatedAtMs) || !Number.isSafeInteger(id)) {
    throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
  }
  return { pinned: match[1] === '1', updatedAtMs, id };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ApiError(400, 'invalid_limit', 'The pagination limit is not valid.');
  }
  return Math.min(limit, 200);
}

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
    if (key !== 'kind' && key !== 'cursor' && key !== 'limit') {
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
  if (op.cursor !== undefined && typeof op.cursor !== 'string') {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'cursor', issue: 'must be a string' }],
    });
  }
  if (op.cursor !== undefined) {
    parseCursor(op.cursor);
  }
  if (op.limit !== undefined && typeof op.limit !== 'number') {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'limit', issue: 'must be a number' }],
    });
  }
  if (op.limit !== undefined) {
    clampLimit(op.limit);
  }
}

export async function handle(
  ctx: HandlerContext,
  op: unknown,
): Promise<readonly ConversationRow[]> {
  validate(op);
  const limit = clampLimit(op.limit);
  const position = op.cursor === undefined ? null : parseCursor(op.cursor);
  const conditions: SQL[] = [eq(conversations.workspaceId, ctx.workspaceId)];
  if (position !== null) {
    const samePin = eq(conversations.isPinned, position.pinned);
    const parts: SQL[] = [];
    const at = new Date(position.updatedAtMs);
    const next = new Date(position.updatedAtMs + 1);
    // Postgres timestamps carry microseconds, but the cursor carries
    // milliseconds (the precision of a JS Date). Rows sharing the
    // cursor's millisecond fall in [at, next); within that bucket the
    // id tiebreak applies. An exact equality on the timestamp would
    // miss every row whose microseconds are nonzero.
    const olderUpdated = and(samePin, lt(conversations.updatedAt, at));
    if (olderUpdated !== undefined) {
      parts.push(olderUpdated);
    }
    const sameUpdated = and(
      samePin,
      gte(conversations.updatedAt, at),
      lt(conversations.updatedAt, next),
      lt(conversations.id, position.id),
    );
    if (sameUpdated !== undefined) {
      parts.push(sameUpdated);
    }
    if (position.pinned) {
      parts.push(eq(conversations.isPinned, false));
    }
    const after = or(...parts);
    if (after !== undefined) {
      conditions.push(after);
    }
  }
  const rows = await ctx.tx
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.isPinned), desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    messageCount: row.messageCount,
    isPinned: row.isPinned,
    version: row.version,
  }));
}
