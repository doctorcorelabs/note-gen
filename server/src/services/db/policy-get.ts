// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one read kind: policy.get.
//
// Upstream: getMemoryPolicy. The policy row is keyed by user, not by
// workspace, so this handler reads by the user id from the handler
// context. When no row exists yet, the default row is returned: all
// three flags true, generationStartedAt 0 (generation never
// started), updatedAt now. When a row exists, its stored flag values
// are returned as stored: the fork stores what is sent, so the read
// must not force flags true. A null generationStartedAt reads as 0,
// the Postgres form of the upstream integer 0.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { memoryPolicies, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'policy.get' as const;

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
}

export interface MemoryPolicyRow {
  useMemories: boolean;
  generateMemories: boolean;
  excludeExternalContext: boolean;
  generationStartedAt: number;
  updatedAt: number;
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
    if (key !== 'kind') {
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
}

export async function handle(ctx: HandlerContext, op: unknown): Promise<readonly MemoryPolicyRow[]> {
  validate(op);
  const rows = await ctx.tx
    .select()
    .from(memoryPolicies)
    .where(eq(memoryPolicies.userId, ctx.userId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return [
      {
        useMemories: true,
        generateMemories: true,
        excludeExternalContext: true,
        generationStartedAt: 0,
        updatedAt: Date.now(),
      },
    ];
  }
  return [
    {
      useMemories: row.useMemories,
      generateMemories: row.generateMemories,
      excludeExternalContext: row.excludeExternalContext,
      generationStartedAt: row.generationStartedAt === null ? 0 : row.generationStartedAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    },
  ];
}
