// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Server-side mirror of the typed SQL operation catalog.
//
// The canonical catalog lives at src/lib/platform/sql/ops-catalog.ts
// (74 kinds: 34 reads + 40 writes; V2-24, merged at K1 under AD-35,
// plus the V3-14 catalog amendment adding messages.get). The server
// cannot import it directly: the catalog imports types through the
// "@/types/..." path alias, which the server tsconfig (NodeNext,
// rootDir src) does not resolve, and importing a file outside
// server/src would break the server build layout. So this module
// restates the kind membership verbatim, and
// server/test/db-kinds.spec.ts pins the restatement to the catalog
// text: any drift in membership, wave, or exposure fails that test.
// Do not edit the lists here without the matching catalog change
// and the conformance test passing.
//
// History (AD-44, AMD-O10-01): messages.get, the 74th kind, was
// ratified by the D/G lock-in as a W1 client read kind and entered
// this mirror before the catalog code, so the mirror temporarily
// carried catalog + messages.get and the conformance test pinned
// that one-kind delta. The V3-14 catalog amendment (wave 3B) added
// messages.get to the catalog; mirror and catalog are equal again
// and the conformance test now pins equality.
//
// Rules carried from the catalog and the design (V1-03 sections 3.3
// and 3.4, AD-26):
// - Read and write kinds are disjoint sets. The read batch endpoint
//   rejects write kinds and the transaction endpoint rejects read
//   kinds, both with invalid_operation (kontrak section 6.2).
// - There is no generic kind (raw, query, exec) and no operation
//   carries SQL, a table name, a column name, or a workspace id.
// - vector.replaceChunks is server-only: it is a catalog kind, but
//   it is never a valid client operation. The web client must
//   reject it locally before any HTTP, and the server rejects it
//   with 410 capability_unavailable as the second defense, even
//   if a handler were registered (penguncian D/G section 7 rule
//   5). Only worker code on the server may run it, never through
//   these HTTP endpoints.
// - W2 kinds have their contract fixed but their handlers land in
//   Fase 2. A W2 kind with no registered handler answers
//   capability_unavailable (410), never a silent failure (AD-07).

export const DB_READ_OP_KINDS = [
  'marks.list',
  'marks.get',
  'marks.listByTag',
  'tags.list',
  'tags.get',
  'notes.latestByTag',
  'conversations.list',
  'conversations.get',
  'messages.listByConversation',
  'messages.listByTag',
  'messages.get',
  'compactions.listByConversation',
  'canvases.list',
  'canvases.get',
  'activity.list',
  'knowledge.listSources',
  'knowledge.getSource',
  'knowledge.stats',
  'vector.summaries',
  'wiki.getSourceState',
  'wiki.listSourceStates',
  'wiki.getRevision',
  'wiki.findRevisionByInputHash',
  'wiki.getActiveRevisions',
  'wiki.listPages',
  'wiki.getPage',
  'wiki.listJobs',
  'wiki.getSegment',
  'wiki.getMeta',
  'memories.list',
  'memories.get',
  'memories.stats',
  'policy.get',
  'imageCache.get',
] as const;

export const DB_WRITE_OP_KINDS = [
  'marks.create',
  'marks.update',
  'marks.softDelete',
  'marks.restore',
  'marks.deletePermanent',
  'marks.updateTags',
  'marks.saveTagIds',
  'tags.create',
  'tags.rename',
  'tags.reorder',
  'tags.delete',
  'notes.insert',
  'conversations.create',
  'conversations.update',
  'conversations.delete',
  'messages.append',
  'messages.update',
  'messages.delete',
  'compactions.insert',
  'canvases.create',
  'canvases.save',
  'canvases.softDelete',
  'canvases.restore',
  'activity.insert',
  'knowledge.upsertSource',
  'knowledge.updateStatus',
  'knowledge.removeSource',
  'vector.replaceChunks',
  'wiki.upsertSource',
  'wiki.commitRevision',
  'wiki.upsertPage',
  'wiki.upsertJob',
  'wiki.removeJob',
  'wiki.putSegment',
  'wiki.putMeta',
  'memories.create',
  'memories.update',
  'memories.delete',
  'policy.put',
  'imageCache.put',
] as const;

export type DbReadOpKind = (typeof DB_READ_OP_KINDS)[number];
export type DbWriteOpKind = (typeof DB_WRITE_OP_KINDS)[number];
export type DbOpKind = DbReadOpKind | DbWriteOpKind;

export const DB_OP_KINDS: readonly DbOpKind[] = [...DB_READ_OP_KINDS, ...DB_WRITE_OP_KINDS];

// W2 write kinds (catalog metadata wave W2). All read kinds are W1.
export const DB_WAVE2_OP_KINDS: readonly DbWriteOpKind[] = [
  'vector.replaceChunks',
  'wiki.upsertSource',
  'wiki.commitRevision',
  'wiki.upsertPage',
  'wiki.upsertJob',
  'wiki.removeJob',
  'wiki.putSegment',
  'wiki.putMeta',
  'memories.create',
  'memories.update',
  'memories.delete',
  'policy.put',
];

// The single server-only kind (catalog metadata exposure server-only).
export const DB_SERVER_ONLY_OP_KIND: DbWriteOpKind = 'vector.replaceChunks';

const READ_SET: ReadonlySet<string> = new Set(DB_READ_OP_KINDS);
const WRITE_SET: ReadonlySet<string> = new Set(DB_WRITE_OP_KINDS);
const WAVE2_SET: ReadonlySet<string> = new Set(DB_WAVE2_OP_KINDS);

export type DbOpGroup = 'read' | 'write';

export function isDbReadOpKind(value: unknown): value is DbReadOpKind {
  return typeof value === 'string' && READ_SET.has(value);
}

export function isDbWriteOpKind(value: unknown): value is DbWriteOpKind {
  return typeof value === 'string' && WRITE_SET.has(value);
}

// The group a kind belongs to, or null when the kind is not in the
// closed catalog at all.
export function dbOpGroup(kind: string): DbOpGroup | null {
  if (READ_SET.has(kind)) {
    return 'read';
  }
  if (WRITE_SET.has(kind)) {
    return 'write';
  }
  return null;
}

export function isWave2OpKind(kind: string): boolean {
  return WAVE2_SET.has(kind);
}

// True for kinds a client may send. The server-only kind is excluded
// even though it is a catalog member.
export function isClientExposedOpKind(kind: string): boolean {
  return (READ_SET.has(kind) || WRITE_SET.has(kind)) && kind !== DB_SERVER_ONLY_OP_KIND;
}

// Request limits from kontrak section 3.4 and V1-03 section 4.3.
export const DB_MAX_OPERATIONS_PER_REQUEST = 50;
export const DB_MAX_BODY_BYTES = 1048576;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

// Field names that must never appear on an operation object
// (kontrak sections 1.3 and 1.5, V1-03 section 4.3 rule 2). The
// `operations` name is included because transactions must not nest:
// an operation cannot carry a list of operations (V1-03 4.3 rule 3).
export const FORBIDDEN_OPERATION_FIELDS: readonly string[] = [
  'sql',
  'query',
  'statement',
  'table',
  'columns',
  'raw',
  'workspaceId',
  'workspace_id',
  'operations',
];
