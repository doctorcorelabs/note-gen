// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: messages.delete.
//
// Deletes the message row, decrements the conversation messageCount
// in the same transaction (floored at zero), and invalidates the
// conversation compactions by deleting those rows, as upstream
// deleteChat does. A row owned by another workspace answers the
// generic 404, indistinguishable from a missing row.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import {
  chatMessages,
  conversationCompactions,
  conversations,
  type Database,
} from '../../db/index.js';

export const HANDLER_KIND = 'messages.delete' as const;

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
}

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
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
    if (key !== 'kind' && key !== 'id') {
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
  if (typeof op.id !== 'number' || !Number.isInteger(op.id)) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'id', issue: 'must be an integer' }],
    });
  }
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<WriteResult> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.workspaceId, ctx.workspaceId), eq(chatMessages.id, op.id)))
    .limit(1)
    .for('update');
  const current = rows[0];
  if (current === undefined) {
    throw ApiError.notFound();
  }
  await ctx.tx.delete(chatMessages).where(eq(chatMessages.id, current.id));
  const locked = await ctx.tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, ctx.workspaceId),
        eq(conversations.id, current.conversationId),
      ),
    )
    .limit(1)
    .for('update');
  const conversation = locked[0];
  if (conversation !== undefined && conversation.messageCount > 0) {
    await ctx.tx
      .update(conversations)
      .set({ messageCount: conversation.messageCount - 1 })
      .where(eq(conversations.id, conversation.id));
  }
  await ctx.tx.delete(conversationCompactions).where(
    and(
      eq(conversationCompactions.workspaceId, ctx.workspaceId),
      eq(conversationCompactions.conversationId, current.conversationId),
    ),
  );
  return { affected: 1, id: current.id };
}
