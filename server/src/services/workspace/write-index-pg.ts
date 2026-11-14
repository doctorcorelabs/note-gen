// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Postgres index writer for the workspace write path (V3-04b, wave
// 3A): the write-flow half of desain-workspace-api.md section 3.7
// step 8. One transaction upserts the active files row (version + 1,
// or version 1 for a new path) and inserts the file_events row, so a
// disk write is never visible in the listing without its event, and
// never evented without its index row.
//
// This module owns ONLY the write-path upsert. Index rebuilds,
// drift detection, and reconciliation belong to V3-06
// (services/workspace/index.ts and reconcile.ts), which reads the
// same tables. No migration is created here: the files and
// file_events tables come from the frozen 0000 migration (AD-25).
//
// Failure semantics: when this transaction throws AFTER the atomic
// rename, the service answers 500 index_update_failed with
// details.diskWritten true and the new revision (desain section 3.7
// step 8). The rename is never rolled back. The per-path write queue
// serializes writers for one path inside one process (desain
// assumption A8), so the read-then-write inside the transaction
// cannot interleave with another API write to the same path.

import { and, eq, isNull } from 'drizzle-orm';
import { fileEvents, files, type Database } from '../../db/index.js';
import type { IndexWriteInput, WorkspaceIndexPort } from './write-ports.js';

export function createPgWorkspaceIndex(db: Database): WorkspaceIndexPort {
  return {
    async currentVersion(workspaceId: string, path: string): Promise<number | null> {
      const rows = await db
        .select({ version: files.version })
        .from(files)
        .where(and(eq(files.workspaceId, workspaceId), eq(files.path, path), isNull(files.deletedAt)))
        .limit(1);
      return rows[0]?.version ?? null;
    },

    async recordWrite(input: IndexWriteInput): Promise<{ version: number }> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: files.id, version: files.version })
          .from(files)
          .where(
            and(eq(files.workspaceId, input.workspaceId), eq(files.path, input.path), isNull(files.deletedAt)),
          )
          .limit(1);
        const existing = rows[0];
        let version: number;
        if (existing === undefined) {
          version = 1;
          await tx.insert(files).values({
            workspaceId: input.workspaceId,
            path: input.path,
            contentHash: input.contentHash,
            sizeBytes: input.sizeBytes,
            version,
            mimeType: input.mimeType,
            deletedAt: null,
          });
        } else {
          version = existing.version + 1;
          await tx
            .update(files)
            .set({ contentHash: input.contentHash, sizeBytes: input.sizeBytes, mimeType: input.mimeType, version })
            .where(eq(files.id, existing.id));
        }
        await tx.insert(fileEvents).values({
          workspaceId: input.workspaceId,
          actorId: input.actorId ?? null,
          eventType: input.eventType,
          path: input.path,
          previousPath: null,
        });
        return { version };
      });
    },
  };
}
