// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Drizzle/Postgres implementation of the REST records
// repository (W4-WIRE, kontrak 3.5/3.6, V1-14). Every method
// runs in one transaction via db.transaction(); no caller may
// issue manual transaction statements. Empty strings are stored
// as NULL for content/desc/url and read back as empty strings,
// matching the kind handlers' nullability convention.
//
// Activity events: create follows the kind precedent exactly
// (source 'record', title/description from the 140-char
// preview, dedupeKey `record:<id>`, ON CONFLICT DO NOTHING).
// Soft delete, restore, permanent delete, force overwrites,
// and empty-trash write events with a NULL dedupeKey (no
// precedent exists for their shapes; the labels are documented
// in the W4-WIRE report for integrator adjudication).
//
// Tag counts here are DIRECT membership (mark_tags rows over
// active marks), per V1-14 5.1. That diverges from the kind
// tags.list subtree counts on purpose; the two transports
// answer different questions and the contract pins the REST
// one.

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../plugins/envelope.js';
import {
  activityEvents,
  markTags,
  marks,
  tags,
  type Database,
} from '../../db/index.js';
import { scanList, type ListScanRow } from './list-scan.js';
import type { ListScanPage } from './list-scan.js';
import type {
  CreateMarkResult,
  DeleteTagResult,
  EmptyTrashResult,
  PermanentDeleteResult,
  RecordsRepository,
  SoftDeleteResult,
} from './repository.js';
import { sortedTagIds, type MarkRow, type TagRow } from './represent.js';
import {
  validateTodoContent,
  validateUrlShape,
  type CreateRecordInput,
  type ListQuery,
  type PatchRecordInput,
  type PutTagsInput,
  type RecordType,
} from './validation.js';

type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const ACTIVITY_PREVIEW_LENGTH = 140;
const ASSET_TYPES: ReadonlySet<RecordType> = new Set(['image', 'file', 'recording', 'scan']);

function tagNotFound(tagId: number): ApiError {
  return new ApiError(400, 'tag_not_found', 'The referenced tag was not found in this workspace.', {
    details: { tagId },
  });
}

function tagNameTaken(): ApiError {
  return new ApiError(409, 'tag_name_taken', 'A tag with this name already exists in this workspace.');
}

function tagLocked(): ApiError {
  return new ApiError(409, 'tag_locked', 'A locked tag cannot be renamed, unpinned, or deleted.');
}

function tagInUse(recordCount: number): ApiError {
  return new ApiError(409, 'tag_in_use', 'The tag is still in use by records.', {
    details: { recordCount },
  });
}

function assetNotFound(url: string): ApiError {
  return new ApiError(400, 'asset_not_found', 'The referenced asset was not found in this workspace.', {
    details: { url },
  });
}

function revisionConflict(current: { version: number; updatedAt: number }): ApiError {
  return new ApiError(409, 'revision_conflict', 'The record has changed since it was read.', {
    details: { current },
  });
}

function recordTagsChanged(currentTagIds: number[]): ApiError {
  return new ApiError(
    409,
    'record_tags_changed',
    'The record tags have changed since they were read.',
    { details: { currentTagIds } },
  );
}

function truncateActivityText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function previewOf(descText: string, content: string, url: string): string {
  return truncateActivityText(descText || content || url || '', ACTIVITY_PREVIEW_LENGTH);
}

function nullIfEmpty(value: string): string | null {
  return value === '' ? null : value;
}

interface DbMarkRow {
  id: number;
  workspaceId: string;
  tagId: number;
  type: string;
  content: string | null;
  url: string | null;
  desc: string | null;
  deletedAt: Date | null;
  sourceId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

function toMarkRow(row: DbMarkRow, tagIds: readonly number[]): MarkRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type as RecordType,
    content: row.content ?? '',
    desc: row.desc ?? '',
    url: row.url ?? '',
    tagId: row.tagId,
    tagIds: sortedTagIds(row.tagId, tagIds),
    version: row.version,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.getTime(),
    sourceId: row.sourceId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

interface TagDbRow {
  id: number;
  workspaceId: string;
  name: string;
  isLocked: boolean;
  isPin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toTagRow(row: TagDbRow, recordCount: number): TagRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    locked: row.isLocked,
    pinned: row.isPin,
    recordCount,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

async function loadTagIdsForMarks(
  tx: DbTransaction,
  workspaceId: string,
  markIds: readonly number[],
): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (markIds.length === 0) {
    return map;
  }
  const rows = await tx
    .select({ markId: markTags.markId, tagId: markTags.tagId })
    .from(markTags)
    .where(and(eq(markTags.workspaceId, workspaceId), inArray(markTags.markId, [...markIds])));
  for (const row of rows) {
    const list = map.get(row.markId) ?? [];
    list.push(row.tagId);
    map.set(row.markId, list);
  }
  return map;
}

async function loadMark(
  tx: DbTransaction,
  workspaceId: string,
  markId: number,
  forUpdate: boolean,
): Promise<{ row: DbMarkRow; tagIds: number[] }> {
  const query = tx
    .select()
    .from(marks)
    .where(and(eq(marks.workspaceId, workspaceId), eq(marks.id, markId)))
    .limit(1);
  const rows = forUpdate ? await query.for('update') : await query;
  const found = rows[0];
  if (found === undefined) {
    throw ApiError.notFound();
  }
  const tagMap = await loadTagIdsForMarks(tx, workspaceId, [markId]);
  return { row: found, tagIds: tagMap.get(markId) ?? [] };
}

async function insertActivity(
  tx: DbTransaction,
  input: {
    workspaceId: string;
    tagId: number | null;
    title: string;
    description: string;
    dedupeKey: string | null;
    createdAt: Date;
  },
): Promise<void> {
  await tx
    .insert(activityEvents)
    .values({
      workspaceId: input.workspaceId,
      tagId: input.tagId,
      source: 'record',
      title: input.title,
      description: input.description,
      dedupeKey: input.dedupeKey,
      createdAt: input.createdAt,
    })
    .onConflictDoNothing();
}

async function assertTagsExist(
  tx: DbTransaction,
  workspaceId: string,
  tagIds: readonly number[],
): Promise<void> {
  if (tagIds.length === 0) {
    return;
  }
  const owned = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.workspaceId, workspaceId), inArray(tags.id, [...tagIds])));
  const ownedIds = new Set(owned.map((row) => row.id));
  for (const tagId of tagIds) {
    if (!ownedIds.has(tagId)) {
      throw tagNotFound(tagId);
    }
  }
}

interface DefaultTagOptions {
  // When true, create a locked + pinned `Idea` tag when the
  // workspace has no tags at all (create path). When false,
  // fall back to the earliest tag instead (restore path: a
  // record being restored implies tags once existed, and
  // creating a new tag on restore would surprise).
  createWhenEmpty: boolean;
}

// Default save target (V1-14 3.7, adapted): the locked tag
// with the lowest id, else the tag named `Idea` with the
// lowest id, else a created locked + pinned `Idea` tag when
// the workspace has no tags, else 400. Preference-based
// resolution is impossible server-side: record-save
// preferences are local-only settings keys.
async function resolveDefaultTag(
  tx: DbTransaction,
  workspaceId: string,
  options: DefaultTagOptions,
): Promise<number> {
  const all = await tx
    .select({ id: tags.id, name: tags.name, isLocked: tags.isLocked })
    .from(tags)
    .where(eq(tags.workspaceId, workspaceId))
    .orderBy(asc(tags.id));
  const locked = all.find((row) => row.isLocked);
  if (locked !== undefined) {
    return locked.id;
  }
  const idea = all.find((row) => row.name === 'Idea');
  if (idea !== undefined) {
    return idea.id;
  }
  if (all.length === 0 && options.createWhenEmpty) {
    const inserted = await tx
      .insert(tags)
      .values({ workspaceId, name: 'Idea', isLocked: true, isPin: true, sortOrder: 0 })
      .onConflictDoNothing()
      .returning({ id: tags.id });
    const created = inserted[0];
    if (created !== undefined) {
      return created.id;
    }
    const raced = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.workspaceId, workspaceId), eq(tags.name, 'Idea')))
      .limit(1);
    if (raced[0] !== undefined) {
      return raced[0].id;
    }
    throw ApiError.internalError();
  }
  if (all.length > 0) {
    return all[0].id;
  }
  throw ApiError.validation('Request validation failed.', {
    fields: [{ field: 'tagId', issue: 'no default save target exists in this workspace' }],
  });
}

async function countDirectMembership(
  tx: DbTransaction,
  workspaceId: string,
  tagId: number,
  activeOnly: boolean,
): Promise<number> {
  const conditions = [
    eq(markTags.workspaceId, workspaceId),
    eq(markTags.tagId, tagId),
    eq(marks.id, markTags.markId),
  ];
  if (activeOnly) {
    conditions.push(isNull(marks.deletedAt));
  }
  const rows = await tx
    .select({ count: sql<number>`count(distinct ${markTags.markId})` })
    .from(markTags)
    .innerJoin(marks, eq(marks.id, markTags.markId))
    .where(and(...conditions));
  return Number(rows[0]?.count ?? 0);
}

function parseTodoTitle(content: string): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const title = (parsed as Record<string, unknown>)['title'];
      return typeof title === 'string' ? title.trim() : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function createDrizzleRecordsRepository(db: Database): RecordsRepository {
  return {
    async createMark(
      workspaceId: string,
      input: CreateRecordInput,
      assetExists: (assetKey: string) => Promise<boolean>,
    ): Promise<CreateMarkResult> {
      if (ASSET_TYPES.has(input.type) && input.url !== '' && !(await assetExists(input.url))) {
        throw assetNotFound(input.url);
      }
      return db.transaction(async (tx) => {
        let primaryTagId: number;
        let effectiveTagIds: number[];
        if (input.tagId === undefined && input.tagIds === undefined) {
          primaryTagId = await resolveDefaultTag(tx, workspaceId, { createWhenEmpty: true });
          effectiveTagIds = [primaryTagId];
        } else {
          const requested =
            input.tagIds !== undefined ? [...input.tagIds] : [input.tagId as number];
          await assertTagsExist(tx, workspaceId, requested);
          primaryTagId = input.tagId ?? requested[0];
          effectiveTagIds = sortedTagIds(primaryTagId, requested);
        }
        const existing = await tx
          .select({ id: marks.id })
          .from(marks)
          .where(and(eq(marks.workspaceId, workspaceId), eq(marks.sourceId, input.sourceId)))
          .limit(1);
        if (existing[0] !== undefined) {
          const loaded = await loadMark(tx, workspaceId, existing[0].id, false);
          return { row: toMarkRow(loaded.row, loaded.tagIds), duplicate: true };
        }
        const now = new Date();
        const inserted = await tx
          .insert(marks)
          .values({
            workspaceId,
            tagId: primaryTagId,
            type: input.type,
            content: nullIfEmpty(input.content),
            url: nullIfEmpty(input.url),
            desc: nullIfEmpty(input.desc),
            sourceId: input.sourceId,
            tagUpdatedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: marks.id });
        let createdId = inserted[0]?.id;
        if (createdId === undefined) {
          const raced = await tx
            .select({ id: marks.id })
            .from(marks)
            .where(and(eq(marks.workspaceId, workspaceId), eq(marks.sourceId, input.sourceId)))
            .limit(1);
          if (raced[0] === undefined) {
            throw ApiError.internalError();
          }
          const loaded = await loadMark(tx, workspaceId, raced[0].id, false);
          return { row: toMarkRow(loaded.row, loaded.tagIds), duplicate: true };
        }
        await tx.insert(markTags).values(
          effectiveTagIds.map((tagId) => ({ markId: createdId, tagId, workspaceId })),
        );
        const preview = previewOf(input.desc, input.content, input.url);
        await insertActivity(tx, {
          workspaceId,
          tagId: primaryTagId,
          title: preview || input.type,
          description: preview || input.type,
          dedupeKey: `record:${createdId}`,
          createdAt: now,
        });
        const loaded = await loadMark(tx, workspaceId, createdId, false);
        return { row: toMarkRow(loaded.row, loaded.tagIds), duplicate: false };
      });
    },

    async getMark(workspaceId: string, markId: number): Promise<MarkRow> {
      const loaded = await db.transaction(async (tx) => loadMark(tx, workspaceId, markId, false));
      return toMarkRow(loaded.row, loaded.tagIds);
    },

    async listMarks(workspaceId: string, query: ListQuery): Promise<ListScanPage> {
      const tagRows = await db
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(eq(tags.workspaceId, workspaceId));
      const tagNameById = new Map(tagRows.map((row) => [row.id, row.name]));
      const conditions = [eq(marks.workspaceId, workspaceId)];
      if (query.status === 'active') {
        conditions.push(isNull(marks.deletedAt));
      } else if (query.status === 'trash') {
        conditions.push(isNotNull(marks.deletedAt));
      }
      if (query.types !== undefined) {
        conditions.push(inArray(marks.type, [...query.types]));
      }
      if (query.createdAfter !== undefined) {
        conditions.push(gte(marks.createdAt, new Date(query.createdAfter)));
      }
      if (query.createdBefore !== undefined) {
        conditions.push(lte(marks.createdAt, new Date(query.createdBefore)));
      }
      const rows = await db
        .select()
        .from(marks)
        .where(and(...conditions));
      const tagMap = await db.transaction(async (tx) =>
        loadTagIdsForMarks(
          tx,
          workspaceId,
          rows.map((row) => row.id),
        ),
      );
      const scanRows: ListScanRow[] = rows.map((row) => {
        const tagIds = tagMap.get(row.id) ?? [];
        const mark = toMarkRow(row, tagIds);
        return {
          ...mark,
          tagNames: mark.tagIds.map((tagId) => tagNameById.get(tagId)).filter((name) => name !== undefined),
        };
      });
      return scanList(scanRows, query, tagNameById);
    },

    async patchMark(
      workspaceId: string,
      markId: number,
      input: PatchRecordInput,
      assetExists: (assetKey: string) => Promise<boolean>,
    ): Promise<{ row: MarkRow }> {
      return db.transaction(async (tx) => {
        const loaded = await loadMark(tx, workspaceId, markId, true);
        const current = toMarkRow(loaded.row, loaded.tagIds);
        const guardMismatch =
          input.expectedVersion !== undefined && input.expectedVersion !== current.version;
        if (guardMismatch && !input.force) {
          throw revisionConflict({ version: current.version, updatedAt: current.updatedAt });
        }
        let content = input.content ?? current.content;
        let descText = input.desc ?? current.desc;
        let url = input.url ?? current.url;
        if (current.type === 'todo') {
          if (input.content !== undefined) {
            const todo = validateTodoContent(content);
            if (input.desc !== undefined && input.desc !== todo.title) {
              throw ApiError.validation('Request validation failed.', {
                fields: [{ field: 'desc', issue: 'must equal the todo title' }],
              });
            }
            descText = todo.title;
          } else if (input.desc !== undefined) {
            const currentTitle = parseTodoTitle(current.content);
            if (currentTitle !== null && descText !== currentTitle) {
              throw ApiError.validation('Request validation failed.', {
                fields: [{ field: 'desc', issue: 'must equal the todo title' }],
              });
            }
          }
        }
        if (input.url !== undefined) {
          validateUrlShape(current.type, url);
          if (ASSET_TYPES.has(current.type) && url !== '' && !(await assetExists(url))) {
            throw assetNotFound(url);
          }
        }
        const changed =
          content !== current.content || descText !== current.desc || url !== current.url;
        if (!changed) {
          return { row: current };
        }
        const now = new Date();
        await tx
          .update(marks)
          .set({
            content: nullIfEmpty(content),
            desc: nullIfEmpty(descText),
            url: nullIfEmpty(url),
            version: current.version + 1,
            updatedAt: now,
          })
          .where(and(eq(marks.workspaceId, workspaceId), eq(marks.id, markId)));
        if (guardMismatch && input.force) {
          const preview = previewOf(descText, content, url);
          await insertActivity(tx, {
            workspaceId,
            tagId: current.tagId,
            title: preview || current.type,
            description: 'Record overwritten with force.',
            dedupeKey: null,
            createdAt: now,
          });
        }
        const reloaded = await loadMark(tx, workspaceId, markId, false);
        return { row: toMarkRow(reloaded.row, reloaded.tagIds) };
      });
    },

    async putMarkTags(workspaceId: string, markId: number, input: PutTagsInput): Promise<MarkRow> {
      return db.transaction(async (tx) => {
        const loaded = await loadMark(tx, workspaceId, markId, true);
        const current = toMarkRow(loaded.row, loaded.tagIds);
        await assertTagsExist(tx, workspaceId, input.tagIds);
        const guardMismatch =
          (input.expectedTagIds !== undefined &&
            JSON.stringify([...input.expectedTagIds].sort((a, b) => a - b)) !==
              JSON.stringify(current.tagIds)) ||
          (input.expectedTagVersion !== undefined && input.expectedTagVersion !== current.version);
        if (guardMismatch && !input.force) {
          throw recordTagsChanged(current.tagIds);
        }
        const primaryTagId = input.tagIds[0];
        const effectiveTagIds = sortedTagIds(primaryTagId, input.tagIds);
        const now = new Date();
        await tx
          .delete(markTags)
          .where(and(eq(markTags.workspaceId, workspaceId), eq(markTags.markId, markId)));
        await tx.insert(markTags).values(
          effectiveTagIds.map((tagId) => ({ markId, tagId, workspaceId })),
        );
        await tx
          .update(marks)
          .set({ tagId: primaryTagId, tagUpdatedAt: now, version: current.version + 1, updatedAt: now })
          .where(and(eq(marks.workspaceId, workspaceId), eq(marks.id, markId)));
        if (guardMismatch && input.force) {
          const preview = previewOf(current.desc, current.content, current.url);
          await insertActivity(tx, {
            workspaceId,
            tagId: primaryTagId,
            title: preview || current.type,
            description: 'Record tags overwritten with force.',
            dedupeKey: null,
            createdAt: now,
          });
        }
        const reloaded = await loadMark(tx, workspaceId, markId, false);
        return toMarkRow(reloaded.row, reloaded.tagIds);
      });
    },

    async softDeleteMark(workspaceId: string, markId: number): Promise<SoftDeleteResult> {
      return db.transaction(async (tx) => {
        const loaded = await loadMark(tx, workspaceId, markId, true);
        const current = toMarkRow(loaded.row, loaded.tagIds);
        if (current.deletedAt !== null) {
          return { row: current, changed: false };
        }
        const now = new Date();
        await tx
          .update(marks)
          .set({ deletedAt: now, version: current.version + 1, updatedAt: now })
          .where(and(eq(marks.workspaceId, workspaceId), eq(marks.id, markId)));
        const preview = previewOf(current.desc, current.content, current.url);
        await insertActivity(tx, {
          workspaceId,
          tagId: current.tagId,
          title: preview || current.type,
          description: 'Record moved to trash.',
          dedupeKey: null,
          createdAt: now,
        });
        const reloaded = await loadMark(tx, workspaceId, markId, false);
        return { row: toMarkRow(reloaded.row, reloaded.tagIds), changed: true };
      });
    },

    async restoreMark(workspaceId: string, markId: number): Promise<SoftDeleteResult> {
      return db.transaction(async (tx) => {
        const loaded = await loadMark(tx, workspaceId, markId, true);
        const current = toMarkRow(loaded.row, loaded.tagIds);
        if (current.deletedAt === null) {
          return { row: current, changed: false };
        }
        const surviving = await tx
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.workspaceId, workspaceId), inArray(tags.id, [...current.tagIds])));
        let effectiveTagIds = surviving.map((row) => row.id);
        let primaryTagId: number;
        if (effectiveTagIds.length === 0) {
          primaryTagId = await resolveDefaultTag(tx, workspaceId, { createWhenEmpty: false });
          effectiveTagIds = [primaryTagId];
        } else {
          effectiveTagIds = sortedTagIds(
            effectiveTagIds.includes(current.tagId) ? current.tagId : effectiveTagIds[0],
            effectiveTagIds,
          );
          primaryTagId = effectiveTagIds.includes(current.tagId)
            ? current.tagId
            : [...effectiveTagIds].sort((a, b) => a - b)[0];
        }
        const now = new Date();
        await tx
          .delete(markTags)
          .where(and(eq(markTags.workspaceId, workspaceId), eq(markTags.markId, markId)));
        await tx.insert(markTags).values(
          effectiveTagIds.map((tagId) => ({ markId, tagId, workspaceId })),
        );
        await tx
          .update(marks)
          .set({
            deletedAt: null,
            tagId: primaryTagId,
            tagUpdatedAt: now,
            version: current.version + 1,
            updatedAt: now,
          })
          .where(and(eq(marks.workspaceId, workspaceId), eq(marks.id, markId)));
        const preview = previewOf(current.desc, current.content, current.url);
        await insertActivity(tx, {
          workspaceId,
          tagId: primaryTagId,
          title: preview || current.type,
          description: 'Record restored from trash.',
          dedupeKey: null,
          createdAt: now,
        });
        const reloaded = await loadMark(tx, workspaceId, markId, false);
        return { row: toMarkRow(reloaded.row, reloaded.tagIds), changed: true };
      });
    },

    async permanentDeleteMark(
      workspaceId: string,
      markId: number,
    ): Promise<PermanentDeleteResult> {
      return db.transaction(async (tx) => {
        const loaded = await loadMark(tx, workspaceId, markId, true);
        const current = toMarkRow(loaded.row, loaded.tagIds);
        const now = new Date();
        const preview = previewOf(current.desc, current.content, current.url);
        await insertActivity(tx, {
          workspaceId,
          tagId: current.tagId,
          title: preview || current.type,
          description: 'Record permanently deleted.',
          dedupeKey: null,
          createdAt: now,
        });
        await tx
          .delete(markTags)
          .where(and(eq(markTags.workspaceId, workspaceId), eq(markTags.markId, markId)));
        await tx
          .delete(marks)
          .where(and(eq(marks.workspaceId, workspaceId), eq(marks.id, markId)));
        const assetKeys =
          ASSET_TYPES.has(current.type) && current.url !== '' ? [current.url] : [];
        return { deleted: true, assetKeys };
      });
    },

    async emptyTrash(workspaceId: string): Promise<EmptyTrashResult> {
      return db.transaction(async (tx) => {
        const trashed = await tx
          .select({ id: marks.id, type: marks.type, url: marks.url })
          .from(marks)
          .where(and(eq(marks.workspaceId, workspaceId), isNotNull(marks.deletedAt)));
        const now = new Date();
        const assetKeys = [
          ...new Set(
            trashed
              .filter((row) => ASSET_TYPES.has(row.type as RecordType) && row.url !== null && row.url !== '')
              .map((row) => row.url as string),
          ),
        ];
        if (trashed.length > 0) {
          const ids = trashed.map((row) => row.id);
          await tx
            .delete(markTags)
            .where(and(eq(markTags.workspaceId, workspaceId), inArray(markTags.markId, ids)));
          await tx
            .delete(marks)
            .where(and(eq(marks.workspaceId, workspaceId), inArray(marks.id, ids)));
        }
        await insertActivity(tx, {
          workspaceId,
          tagId: null,
          title: 'Trash emptied',
          description: `${trashed.length} record(s) permanently deleted.`,
          dedupeKey: null,
          createdAt: now,
        });
        return { purged: trashed.length, purgedAt: now.getTime(), assetKeys };
      });
    },

    async listTags(workspaceId: string): Promise<TagRow[]> {
      const tagRows = await db
        .select()
        .from(tags)
        .where(eq(tags.workspaceId, workspaceId))
        .orderBy(desc(tags.isPin), asc(tags.name));
      if (tagRows.length === 0) {
        return [];
      }
      const counts = await db
        .select({
          tagId: markTags.tagId,
          count: sql<number>`count(distinct ${markTags.markId})`,
        })
        .from(markTags)
        .innerJoin(marks, eq(marks.id, markTags.markId))
        .where(and(eq(markTags.workspaceId, workspaceId), isNull(marks.deletedAt)))
        .groupBy(markTags.tagId);
      const countByTag = new Map(counts.map((row) => [row.tagId, Number(row.count)]));
      return tagRows.map((row) => toTagRow(row, countByTag.get(row.id) ?? 0));
    },

    async createTag(workspaceId: string, name: string): Promise<TagRow> {
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(tags)
          .values({ workspaceId, name, isLocked: false, isPin: false, sortOrder: 0 })
          .onConflictDoNothing()
          .returning();
        const created = inserted[0];
        if (created === undefined) {
          throw tagNameTaken();
        }
        return toTagRow(created, 0);
      });
    },

    async patchTag(
      workspaceId: string,
      tagId: number,
      input: { name: string | undefined; pinned: boolean | undefined },
    ): Promise<TagRow> {
      return db.transaction(async (tx) => {
        const all = await tx
          .select()
          .from(tags)
          .where(eq(tags.workspaceId, workspaceId))
          .orderBy(asc(tags.id))
          .for('update');
        const target = all.find((row) => row.id === tagId);
        if (target === undefined) {
          throw ApiError.notFound();
        }
        let nextPinned = target.isPin;
        if (input.pinned !== undefined && input.pinned !== target.isPin) {
          if (target.isLocked) {
            throw tagLocked();
          }
          nextPinned = input.pinned;
        }
        if (input.name !== undefined && input.name !== target.name) {
          if (target.isLocked) {
            throw tagLocked();
          }
          const oldName = target.name;
          const newName = input.name;
          const subtree = all.filter(
            (row) => row.name === oldName || row.name.startsWith(`${oldName}/`),
          );
          const renamed = new Map<number, string>();
          for (const row of subtree) {
            renamed.set(row.id, newName + row.name.slice(oldName.length));
          }
          const subtreeIds = new Set(subtree.map((row) => row.id));
          for (const row of all) {
            if (subtreeIds.has(row.id)) {
              continue;
            }
            if ([...renamed.values()].includes(row.name)) {
              throw tagNameTaken();
            }
          }
          // Two-phase rename through temporary names so the
          // unique index never sees an intermediate collision
          // inside the subtree (kind tags.rename precedent).
          const nonce = randomUUID();
          const tempNames = new Map<number, string>();
          for (const row of subtree) {
            const temp = `__rename__${nonce}__${row.id}`;
            tempNames.set(row.id, temp);
            await tx.update(tags).set({ name: temp }).where(eq(tags.id, row.id));
          }
          for (const row of subtree) {
            await tx
              .update(tags)
              .set({ name: renamed.get(row.id) as string })
              .where(eq(tags.id, row.id));
          }
        }
        if (nextPinned !== target.isPin) {
          await tx.update(tags).set({ isPin: nextPinned }).where(eq(tags.id, tagId));
        }
        const reloaded = await tx
          .select()
          .from(tags)
          .where(and(eq(tags.workspaceId, workspaceId), eq(tags.id, tagId)))
          .limit(1);
        const fresh = reloaded[0];
        if (fresh === undefined) {
          throw ApiError.internalError();
        }
        const count = await countDirectMembership(tx, workspaceId, tagId, true);
        return toTagRow(fresh, count);
      });
    },

    async deleteTag(
      workspaceId: string,
      tagId: number,
      reassignTo: number | undefined,
    ): Promise<DeleteTagResult> {
      return db.transaction(async (tx) => {
        const found = await tx
          .select()
          .from(tags)
          .where(and(eq(tags.workspaceId, workspaceId), eq(tags.id, tagId)))
          .limit(1)
          .for('update');
        const target = found[0];
        if (target === undefined) {
          throw ApiError.notFound();
        }
        if (target.isLocked) {
          throw tagLocked();
        }
        const inUse = await countDirectMembership(tx, workspaceId, tagId, false);
        if (inUse > 0 && reassignTo === undefined) {
          throw tagInUse(inUse);
        }
        if (reassignTo !== undefined) {
          if (reassignTo === tagId) {
            throw ApiError.validation('Request validation failed.', {
              fields: [{ field: 'reassignTo', issue: 'must differ from the deleted tag' }],
            });
          }
          const replacement = await tx
            .select({ id: tags.id })
            .from(tags)
            .where(and(eq(tags.workspaceId, workspaceId), eq(tags.id, reassignTo)))
            .limit(1);
          if (replacement[0] === undefined) {
            throw tagNotFound(reassignTo);
          }
          await tx
            .update(marks)
            .set({ tagId: reassignTo })
            .where(and(eq(marks.workspaceId, workspaceId), eq(marks.tagId, tagId)));
          // Move memberships one row at a time so a record
          // already in the target tag keeps exactly one row
          // (the primary key is markId + tagId).
          const memberships = await tx
            .select({ markId: markTags.markId })
            .from(markTags)
            .where(and(eq(markTags.workspaceId, workspaceId), eq(markTags.tagId, tagId)));
          for (const membership of memberships) {
            await tx
              .insert(markTags)
              .values({ markId: membership.markId, tagId: reassignTo, workspaceId })
              .onConflictDoNothing();
          }
          await tx
            .delete(markTags)
            .where(and(eq(markTags.workspaceId, workspaceId), eq(markTags.tagId, tagId)));
        }
        await tx
          .delete(tags)
          .where(and(eq(tags.workspaceId, workspaceId), eq(tags.id, tagId)));
        return { deleted: true, reassignedTo: reassignTo ?? null };
      });
    },

    async hasUrlReference(workspaceId: string, url: string): Promise<boolean> {
      const rows = await db
        .select({ id: marks.id })
        .from(marks)
        .where(and(eq(marks.workspaceId, workspaceId), eq(marks.url, url)))
        .limit(1);
      return rows.length > 0;
    },
  };
}
