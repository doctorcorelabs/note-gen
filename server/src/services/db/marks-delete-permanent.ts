// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Handler for one write kind: marks.deletePermanent.
//
// Upstream: delMarkForever. Deletes the mark row only. The
// mark_tags rows for the mark are removed by foreign key cascade
// (mark_tags.mark_id references marks.id ON DELETE CASCADE in
// schema M2); this handler issues no per-table delete, following
// the conversations.delete precedent. The tags themselves are
// untouched: deleting a mark never deletes a tag.
//
// Audit note: the kind split note and the catalog name
// audit_events as a touched table, but no audit event type for
// marks is locked (the desain-auth 12.1 catalog covers auth
// events only) and the handler context carries no request IP.
// This handler therefore writes no audit row, following the
// UTANG-AUDIT-01 precedent set by conversations.delete and
// canvases.save; the gap stays owned by the route worker that
// defines the audit convention. No audit value is invented here.
//
// Asset note: upstream deleted local assets referenced by the
// mark, but a kind handler must not touch the filesystem inside
// the transaction (registry contract). The handler therefore
// returns the deleted row's asset key in the internal-only
// `assetKeys` result field; dispatch sweeps it after commit,
// mirroring the REST route (kontrak 3.5 DELETE
// /api/marks/:markId/permanent). The field never reaches the
// wire: normalizeWriteResult drops it.
//
// A missing row, including a row owned by another workspace,
// answers the generic 404 not_found, indistinguishable from a
// missing row, following the conversations.delete precedent; a
// repeat over an already deleted row answers the same 404
// (kontrak 3.5). The REST route (a later task) propagates the
// same error.
//
// This file stands alone: it imports only trunk modules (the Drizzle
// schema accessor, the canonical error type, drizzle-orm). It imports
// no other handler file and no shared helper.

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import { marks, type Database } from '../../db/index.js';

export const HANDLER_KIND = 'marks.deletePermanent' as const;

// Record types whose url column holds an asset key, mirroring
// ASSET_TYPES in services/records/drizzle-repository.ts.
const ASSET_TYPES: ReadonlySet<string> = new Set(['image', 'file', 'recording', 'scan']);

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
  // Internal-only (F02-04b): swept by dispatch after commit,
  // never rendered to the wire.
  assetKeys?: string[];
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
    .delete(marks)
    .where(and(eq(marks.workspaceId, ctx.workspaceId), eq(marks.id, op.id)))
    .returning({ id: marks.id, type: marks.type, url: marks.url });
  const deleted = rows[0];
  if (deleted === undefined) {
    throw ApiError.notFound();
  }
  const assetKeys =
    ASSET_TYPES.has(deleted.type) && deleted.url !== null && deleted.url !== ''
      ? [deleted.url]
      : [];
  return {
    affected: 1,
    id: deleted.id,
    ...(assetKeys.length > 0 ? { assetKeys } : {}),
  };
}
