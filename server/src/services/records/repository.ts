// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Repository port for the REST marks/tags routes (kontrak
// 3.5/3.6, V1-14). The port is deliberately coarse: each method
// owns one endpoint's transaction, including tag checks, guard
// checks, activity-event writes, and tag resolution. The route
// layer owns HTTP only (auth, body parsing, status codes,
// representations). Two implementations exist: Drizzle over
// Postgres, and an in-memory fake for route specs.
//
// Parity note: the db kind handlers in services/db implement
// overlapping behavior for the kind transport, but the REST
// semantics diverge on purpose in several places (see the
// method docs and the W4-WIRE report): PATCH edits soft-deleted
// rows, PUT tags changes the primary tag, tag counts are direct
// membership (not subtree), and unknown tag ids are errors,
// not silently dropped. Mirroring the SQL is cheaper and more
// auditable than reusing kind handlers with fixups, and keeps
// the REST layer insulated from W4-CODEMOD's kind evolution.
// The divergences are documented per method, not hidden.
//
// Asset references: the repository never touches the asset
// store. The routes pass an assetExists predicate for
// create/PATCH url validation, and delete methods return the
// asset keys to sweep; the route deletes keys that are no
// longer referenced after the transaction commits (filesystem
// deletion cannot join the database transaction).

import type { MarkRow, TagRow } from './represent.js';
import type {
  CreateRecordInput,
  ListQuery,
  PatchRecordInput,
  PutTagsInput,
} from './validation.js';
import type { ListScanPage } from './list-scan.js';

export interface CreateMarkResult {
  row: MarkRow;
  duplicate: boolean;
}

export interface PatchMarkResult {
  row: MarkRow;
}

export interface SoftDeleteResult {
  row: MarkRow;
  changed: boolean;
}

export interface PermanentDeleteResult {
  deleted: boolean;
  assetKeys: string[];
}

export interface EmptyTrashResult {
  purged: number;
  purgedAt: number;
  assetKeys: string[];
}

export interface DeleteTagResult {
  deleted: boolean;
  reassignedTo: number | null;
}

export interface RecordsRepository {
  // Create, or return the existing row with duplicate: true on
  // sourceId first-write-wins. tagIds are deduped silently
  // (kind parity); the primary tag is tagId when given, else
  // the first tag id, else the default save target. All tag
  // ids must exist (400 tag_not_found). assetExists answers
  // whether a url value names a stored asset key.
  createMark(
    workspaceId: string,
    input: CreateRecordInput,
    assetExists: (assetKey: string) => Promise<boolean>,
  ): Promise<CreateMarkResult>;

  // A single record, including soft-deleted rows. Unknown id
  // answers 404.
  getMark(workspaceId: string, markId: number): Promise<MarkRow>;

  // Filtered list. The implementation may pre-filter in SQL;
  // the scan semantics in list-scan.ts are authoritative.
  listMarks(workspaceId: string, query: ListQuery): Promise<ListScanPage>;

  // PATCH content/desc/url. Soft-deleted rows are editable.
  // A guard mismatch answers 409 revision_conflict; force with
  // a mismatched guard overwrites and writes an activity event.
  // Todo content rewrites recompute desc to the todo title;
  // a desc-only patch on a todo must equal the current title.
  patchMark(
    workspaceId: string,
    markId: number,
    input: PatchRecordInput,
    assetExists: (assetKey: string) => Promise<boolean>,
  ): Promise<PatchMarkResult>;

  // PUT tags. The first tag id becomes the primary tag. Guard
  // mismatch answers 409 record_tags_changed with
  // details.currentTagIds. Unknown tag ids answer 400
  // tag_not_found (no newNames: REST has no tag creation by
  // side effect).
  putMarkTags(workspaceId: string, markId: number, input: PutTagsInput): Promise<MarkRow>;

  // Soft delete (idempotent no-op when already deleted) and
  // restore (idempotent no-op when already active). Restore
  // prunes missing tags and falls back to the default save
  // target when no tag survives.
  softDeleteMark(workspaceId: string, markId: number): Promise<SoftDeleteResult>;
  restoreMark(workspaceId: string, markId: number): Promise<SoftDeleteResult>;

  // Permanent delete from active or soft-deleted state. The
  // returned assetKeys are the record's asset url (when the
  // type is an asset type) for the caller to sweep after
  // commit; reference counting is the caller's job.
  permanentDeleteMark(workspaceId: string, markId: number): Promise<PermanentDeleteResult>;

  // Delete every soft-deleted record in the workspace.
  emptyTrash(workspaceId: string): Promise<EmptyTrashResult>;

  // Tag list, pinned first then name ascending (Postgres
  // collation in the Drizzle implementation), with direct
  // membership active-record counts.
  listTags(workspaceId: string): Promise<TagRow[]>;

  // Create; an existing name answers 409 tag_name_taken.
  createTag(workspaceId: string, name: string): Promise<TagRow>;

  // Rename (subtree) and/or pin change. Locked tags answer 409
  // tag_locked for a rename and for a pin change, except a
  // same-value pin no-op. Name collision answers 409
  // tag_name_taken.
  patchTag(
    workspaceId: string,
    tagId: number,
    input: { name: string | undefined; pinned: boolean | undefined },
  ): Promise<TagRow>;

  // Delete. Locked tags answer 409 tag_locked. In-use tags
  // (active plus soft-deleted membership) answer 409
  // tag_in_use unless reassignTo names a different existing
  // tag, in which case memberships move and the primary tag
  // follows.
  deleteTag(
    workspaceId: string,
    tagId: number,
    reassignTo: number | undefined,
  ): Promise<DeleteTagResult>;

  // Existence check for asset reference counting after
  // permanent deletion: does any remaining mark in the
  // workspace reference this url?
  hasUrlReference(workspaceId: string, url: string): Promise<boolean>;
}
