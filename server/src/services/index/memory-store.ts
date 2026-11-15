// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// In-memory implementation of the FilesIndexStore contract
// (query.ts), for tests and for the pre-DB seam. It holds the same
// rows the Postgres files table holds, keyed by (workspaceId, path),
// with one active row per path, plus an in-memory journal standing
// in for the file_events table.
//
// Semantics mirror the Postgres write implementation
// (services/workspace/write-index-pg.ts) exactly, so tests written
// against this store pin production behavior:
//
// - recordWrite creates version 1 for a path with no active row and
//   increments otherwise, updating contentHash, sizeBytes, and
//   mimeType, and journals one event atomically with the row update
//   (no interleaving inside one process: each method runs to
//   completion synchronously once awaited).
// - A soft-deleted path restarts at version 1 on the next
//   recordWrite, because the lookup only ever sees active rows.
// - markDeleted retains the row with deletedAt set and journals a
//   'deleted' event; lookups and listings never return it again.
// - getEntry and listEntries return fresh copies, so callers cannot
//   mutate stored state through a result.
//
// This store performs no path validation and no hashing: it stores
// exactly what it is given, like the Postgres implementation does.
// Validation belongs to the query functions (query.ts) and the
// write service, which validate before they reach the store.
//
// The journal is exposed read-only through events() so tests can
// verify that each write produced its event. Production code must
// not depend on the journal: the Postgres file_events table is
// append-only history owned by the write and reconcile paths, not a
// query input.
//
// putEntry is a seeding seam for tests and for local harnesses that
// need an exact row (for example version 7 without seven writes).
// It replaces any row at the same key, active or deleted, without
// journaling an event. Production population of rows belongs to the
// scan worker (V3-06 part 1) and to recordWrite on the write path,
// never to putEntry.

import type { IndexWriteInput } from '../workspace/write-ports.js';
import type { FilesIndexEntry, FilesIndexStore } from './query.js';

// One journal record, mirroring a file_events row minus its
// server-generated id and timestamp. previousPath is always null
// here: moves are owned by the move/reconcile path, which journals
// previousPath itself; this store never invents a move.
export interface FilesIndexEventRecord {
  workspaceId: string;
  actorId: string | undefined;
  eventType: 'created' | 'changed' | 'deleted';
  path: string;
  previousPath: null;
}

interface StoredRow extends FilesIndexEntry {
  deletedAt: Date | null;
}

function rowKey(workspaceId: string, path: string): string {
  return JSON.stringify([workspaceId, path]);
}

function toEntry(row: StoredRow): FilesIndexEntry {
  return {
    workspaceId: row.workspaceId,
    path: row.path,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    version: row.version,
    mimeType: row.mimeType,
  };
}

export class InMemoryFilesIndexStore implements FilesIndexStore {
  private readonly rows = new Map<string, StoredRow>();
  private readonly journal: FilesIndexEventRecord[] = [];

  async getEntry(workspaceId: string, path: string): Promise<FilesIndexEntry | null> {
    const row = this.rows.get(rowKey(workspaceId, path));
    if (row === undefined || row.deletedAt !== null) {
      return null;
    }
    return toEntry(row);
  }

  async listEntries(workspaceId: string): Promise<FilesIndexEntry[]> {
    const entries: FilesIndexEntry[] = [];
    for (const row of this.rows.values()) {
      if (row.workspaceId === workspaceId && row.deletedAt === null) {
        entries.push(toEntry(row));
      }
    }
    entries.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
    return entries;
  }

  async recordWrite(input: IndexWriteInput): Promise<{ version: number }> {
    const key = rowKey(input.workspaceId, input.path);
    const existing = this.rows.get(key);
    const version = existing === undefined || existing.deletedAt !== null ? 1 : existing.version + 1;
    this.rows.set(key, {
      workspaceId: input.workspaceId,
      path: input.path,
      contentHash: input.contentHash,
      sizeBytes: input.sizeBytes,
      version,
      mimeType: input.mimeType,
      deletedAt: null,
    });
    this.journal.push({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      eventType: input.eventType,
      path: input.path,
      previousPath: null,
    });
    return { version };
  }

  async markDeleted(workspaceId: string, path: string): Promise<boolean> {
    const key = rowKey(workspaceId, path);
    const row = this.rows.get(key);
    if (row === undefined || row.deletedAt !== null) {
      return false;
    }
    row.deletedAt = new Date();
    this.journal.push({
      workspaceId,
      actorId: undefined,
      eventType: 'deleted',
      path,
      previousPath: null,
    });
    return true;
  }

  // Seeds one exact row, replacing any row at the same key without
  // journaling. An optional deletedAt seeds a soft-deleted row.
  // Test and harness seam only; see the header.
  putEntry(entry: FilesIndexEntry, deletedAt: Date | null = null): void {
    this.rows.set(rowKey(entry.workspaceId, entry.path), { ...entry, deletedAt });
  }

  // A snapshot copy of the journal, oldest first.
  events(): FilesIndexEventRecord[] {
    return this.journal.map((event) => ({ ...event }));
  }
}

export function createInMemoryFilesIndexStore(): InMemoryFilesIndexStore {
  return new InMemoryFilesIndexStore();
}
