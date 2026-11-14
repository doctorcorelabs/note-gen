// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Typed SQL operation catalog (type level only).
 *
 * WIP skeleton (V2-24): operation kind inventory from V1-03 design
 * (fase1/desain-sql-adapter.md section 3.4) only. Parameter types,
 * result types, touched tables, and idempotency notes land in the
 * next commit on this branch. No execution implementation, no fake,
 * no backend endpoint, and no schema live in this file.
 *
 * No operation in this catalog carries raw SQL, a table name, or a
 * column name from the client. Each kind maps server-side to one
 * fixed Drizzle handler (AD-05).
 */

/** Read operation kinds from V1-03 section 3.4. */
export const SQL_READ_OP_KINDS = [
  "marks.list",
  "marks.get",
  "marks.listByTag",
  "tags.list",
  "tags.get",
  "notes.latestByTag",
  "conversations.list",
  "conversations.get",
  "messages.listByConversation",
  "messages.listByTag",
  "compactions.listByConversation",
  "canvases.list",
  "canvases.get",
  "activity.list",
  "knowledge.listSources",
  "knowledge.getSource",
  "knowledge.stats",
  "vector.summaries",
  "wiki.getSourceState",
  "wiki.listSourceStates",
  "wiki.getRevision",
  "wiki.findRevisionByInputHash",
  "wiki.getActiveRevisions",
  "wiki.listPages",
  "wiki.getPage",
  "wiki.listJobs",
  "wiki.getSegment",
  "wiki.getMeta",
  "memories.list",
  "memories.get",
  "memories.stats",
  "policy.get",
  "imageCache.get",
] as const;

/** Write operation kinds from V1-03 section 3.4. */
export const SQL_WRITE_OP_KINDS = [
  "marks.create",
  "marks.update",
  "marks.softDelete",
  "marks.restore",
  "marks.deletePermanent",
  "marks.updateTags",
  "marks.saveTagIds",
  "tags.create",
  "tags.rename",
  "tags.reorder",
  "tags.delete",
  "notes.insert",
  "conversations.create",
  "conversations.update",
  "conversations.delete",
  "messages.append",
  "messages.update",
  "messages.delete",
  "compactions.insert",
  "canvases.create",
  "canvases.save",
  "canvases.softDelete",
  "canvases.restore",
  "activity.insert",
  "knowledge.upsertSource",
  "knowledge.updateStatus",
  "knowledge.removeSource",
  "vector.replaceChunks",
  "wiki.upsertSource",
  "wiki.commitRevision",
  "wiki.upsertPage",
  "wiki.upsertJob",
  "wiki.removeJob",
  "wiki.putSegment",
  "wiki.putMeta",
  "memories.create",
  "memories.update",
  "memories.delete",
  "policy.put",
  "imageCache.put",
] as const;

export type SqlReadOpKind = (typeof SQL_READ_OP_KINDS)[number];
export type SqlWriteOpKind = (typeof SQL_WRITE_OP_KINDS)[number];
export type SqlOpKind = SqlReadOpKind | SqlWriteOpKind;

/** All operation kinds, reads first, then writes. */
export const SQL_OP_KINDS: readonly SqlOpKind[] = [
  ...SQL_READ_OP_KINDS,
  ...SQL_WRITE_OP_KINDS,
];

/**
 * Placeholder operation shape for the WIP skeleton. Replaced by the
 * per-kind discriminated unions in the next commit.
 */
export type SqlOperationSkeleton = {
  readonly kind: SqlOpKind;
};
