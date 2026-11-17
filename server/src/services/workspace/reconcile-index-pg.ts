// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Postgres implementations of the reconcile read port and the
// session-to-workspace identity resolver (W4-WIRE, V3-06 wiring
// remainder). Both are built over an explicit Drizzle handle
// supplied by the reconcile registration adapter; neither reads
// the process-wide singleton, so the adapter owns the handle
// lifetime through the close registry like the db adapter does.
//
// - The index port lists active `files` rows (deletedAt null) for
//   one workspace, the exact read the reconcile scanner diffs
//   against the disk walk (desain-workspace-api.md section 4.5).
// - The identity resolver runs resolveDefaultWorkspaceId inside
//   one read transaction: membership first, owned-workspace
//   fallback, null when the user has no workspace (see
//   services/db/workspace.ts for the full rule). A null result
//   fails the reconcile POST closed with 503, never with a
//   workspace guess.
//
// No repair port lives here: W4-WIRE wires scan and diff only, so
// driftRepaired stays 0 and driftRemaining equals driftFound. A
// repair port that writes the index is a separate slice; claiming
// repairs without one would lie in the status response.

import { and, eq, isNull } from 'drizzle-orm';
import { files, type Database } from '../../db/index.js';
import { resolveDefaultWorkspaceId } from '../db/workspace.js';
import type { WorkspaceIdentityResolver } from './write-ports.js';
import type { ReconcileIndexPort } from './reconcile.js';

export function createDrizzleReconcileIndexPort(db: Database): ReconcileIndexPort {
  return {
    async listActiveRows(workspaceId: string) {
      const rows = await db
        .select({
          path: files.path,
          contentHash: files.contentHash,
          sizeBytes: files.sizeBytes,
          version: files.version,
        })
        .from(files)
        .where(and(eq(files.workspaceId, workspaceId), isNull(files.deletedAt)));
      return rows.map((row) => ({
        path: row.path,
        contentHash: row.contentHash,
        sizeBytes: row.sizeBytes,
        version: row.version,
      }));
    },
  };
}

export function createDrizzleWorkspaceIdentityResolver(db: Database): WorkspaceIdentityResolver {
  return async (principal) => {
    const workspaceId = await db.transaction(async (tx) =>
      resolveDefaultWorkspaceId(tx, principal.userId),
    );
    if (workspaceId === null) {
      return null;
    }
    return { workspaceId, userId: principal.userId, actorId: undefined };
  };
}
