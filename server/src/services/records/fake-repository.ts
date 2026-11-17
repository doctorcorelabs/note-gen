// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// In-memory implementation of the REST records repository,
// for route specs only. It mirrors the Drizzle implementation's
// observable semantics (guards, error codes, default save
// target, subtree rename, direct-membership counts, list scan)
// without a database. It must never be wired into production:
// the records adapter wires the Drizzle repository when a
// database URL is set and an unavailable repository otherwise.
//
// The fake owns one workspace per instance; the workspaceId
// argument is accepted for interface compatibility and checked
// for equality. Timestamps come from a monotonic counter so
// sort order is deterministic in specs.

import { ApiError } from '../../plugins/envelope.js';
import { scanList, type ListScanRow } from './list-scan.js';
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

const ASSET_TYPES: ReadonlySet<RecordType> = new Set(['image', 'file', 'recording', 'scan']);

export interface FakeActivityEvent {
  tagId: number | null;
  title: string;
  description: string;
  dedupeKey: string | null;
}

export interface FakeRecordsRepository extends RecordsRepository {
  readonly events: FakeActivityEvent[];
  seedTag(name: string, options?: { locked?: boolean; pinned?: boolean }): TagRow;
}

interface StoredMark {
  row: MarkRow;
}

interface StoredTag {
  id: number;
  name: string;
  locked: boolean;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

function tagNotFound(tagId: number): ApiError {
  return new ApiError(400, 'tag_not_found', 'The referenced tag was not found in this workspace.', {
    details: { tagId },
  });
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

export function createFakeRecordsRepository(workspaceId: string): FakeRecordsRepository {
  const marksStore = new Map<number, StoredMark>();
  const tagsStore = new Map<number, StoredTag>();
  const events: FakeActivityEvent[] = [];
  let nextMarkId = 1;
  let nextTagId = 1;
  let clock = 1_700_000_000_000;

  function now(): number {
    clock += 1;
    return clock;
  }

  function checkWorkspace(requested: string): void {
    if (requested !== workspaceId) {
      throw ApiError.notFound();
    }
  }

  function countDirect(tagId: number, activeOnly: boolean): number {
    let count = 0;
    for (const stored of marksStore.values()) {
      if (!stored.row.tagIds.includes(tagId)) {
        continue;
      }
      if (activeOnly && stored.row.deletedAt !== null) {
        continue;
      }
      count += 1;
    }
    return count;
  }

  function toTagRow(stored: StoredTag): TagRow {
    return {
      id: stored.id,
      workspaceId,
      name: stored.name,
      locked: stored.locked,
      pinned: stored.pinned,
      recordCount: countDirect(stored.id, true),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  function insertTag(name: string, locked: boolean, pinned: boolean): StoredTag {
    const at = now();
    const stored: StoredTag = { id: nextTagId, name, locked, pinned, createdAt: at, updatedAt: at };
    nextTagId += 1;
    tagsStore.set(stored.id, stored);
    return stored;
  }

  function resolveDefaultTag(createWhenEmpty: boolean): number {
    const all = [...tagsStore.values()].sort((a, b) => a.id - b.id);
    const locked = all.find((tag) => tag.locked);
    if (locked !== undefined) {
      return locked.id;
    }
    const idea = all.find((tag) => tag.name === 'Idea');
    if (idea !== undefined) {
      return idea.id;
    }
    if (all.length === 0 && createWhenEmpty) {
      return insertTag('Idea', true, true).id;
    }
    if (all.length > 0) {
      return all[0].id;
    }
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'tagId', issue: 'no default save target exists in this workspace' }],
    });
  }

  function loadMark(markId: number): StoredMark {
    const stored = marksStore.get(markId);
    if (stored === undefined) {
      throw ApiError.notFound();
    }
    return stored;
  }

  function previewOf(descText: string, content: string, url: string): string {
    const normalized = (descText || content || url || '').replace(/\s+/g, ' ').trim();
    return normalized.length <= 140 ? normalized : `${normalized.slice(0, 139)}...`;
  }

  const repository: FakeRecordsRepository = {
    events,

    seedTag(name: string, options?: { locked?: boolean; pinned?: boolean }): TagRow {
      const stored = insertTag(name, options?.locked === true, options?.pinned === true);
      return toTagRow(stored);
    },

    async createMark(
      requestedWorkspace: string,
      input: CreateRecordInput,
      assetExists: (assetKey: string) => Promise<boolean>,
    ): Promise<CreateMarkResult> {
      checkWorkspace(requestedWorkspace);
      if (ASSET_TYPES.has(input.type) && input.url !== '' && !(await assetExists(input.url))) {
        throw new ApiError(400, 'asset_not_found', 'The referenced asset was not found in this workspace.', {
          details: { url: input.url },
        });
      }
      let primaryTagId: number;
      let effectiveTagIds: number[];
      if (input.tagId === undefined && input.tagIds === undefined) {
        primaryTagId = resolveDefaultTag(true);
        effectiveTagIds = [primaryTagId];
      } else {
        const requested = input.tagIds !== undefined ? [...input.tagIds] : [input.tagId as number];
        for (const tagId of requested) {
          if (!tagsStore.has(tagId)) {
            throw tagNotFound(tagId);
          }
        }
        primaryTagId = input.tagId ?? requested[0];
        effectiveTagIds = sortedTagIds(primaryTagId, requested);
      }
      for (const stored of marksStore.values()) {
        if (stored.row.sourceId === input.sourceId) {
          return { row: { ...stored.row, tagIds: [...stored.row.tagIds] }, duplicate: true };
        }
      }
      const at = now();
      const row: MarkRow = {
        id: nextMarkId,
        workspaceId,
        type: input.type,
        content: input.content,
        desc: input.desc,
        url: input.url,
        tagId: primaryTagId,
        tagIds: effectiveTagIds,
        version: 1,
        deletedAt: null,
        sourceId: input.sourceId,
        createdAt: at,
        updatedAt: at,
      };
      nextMarkId += 1;
      marksStore.set(row.id, { row });
      const preview = previewOf(input.desc, input.content, input.url);
      events.push({
        tagId: primaryTagId,
        title: preview || input.type,
        description: preview || input.type,
        dedupeKey: `record:${row.id}`,
      });
      return { row: { ...row, tagIds: [...row.tagIds] }, duplicate: false };
    },

    async getMark(requestedWorkspace: string, markId: number): Promise<MarkRow> {
      checkWorkspace(requestedWorkspace);
      const stored = loadMark(markId);
      return { ...stored.row, tagIds: [...stored.row.tagIds] };
    },

    async listMarks(requestedWorkspace: string, query: ListQuery) {
      checkWorkspace(requestedWorkspace);
      const tagNameById = new Map([...tagsStore.values()].map((tag) => [tag.id, tag.name]));
      const scanRows: ListScanRow[] = [...marksStore.values()].map((stored) => ({
        ...stored.row,
        tagIds: [...stored.row.tagIds],
        tagNames: stored.row.tagIds
          .map((tagId) => tagNameById.get(tagId))
          .filter((name) => name !== undefined),
      }));
      return scanList(scanRows, query, tagNameById);
    },

    async patchMark(
      requestedWorkspace: string,
      markId: number,
      input: PatchRecordInput,
      assetExists: (assetKey: string) => Promise<boolean>,
    ): Promise<{ row: MarkRow }> {
      checkWorkspace(requestedWorkspace);
      const stored = loadMark(markId);
      const current = stored.row;
      const guardMismatch =
        input.expectedVersion !== undefined && input.expectedVersion !== current.version;
      if (guardMismatch && !input.force) {
        throw new ApiError(409, 'revision_conflict', 'The record has changed since it was read.', {
          details: { current: { version: current.version, updatedAt: current.updatedAt } },
        });
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
          throw new ApiError(400, 'asset_not_found', 'The referenced asset was not found in this workspace.', {
            details: { url },
          });
        }
      }
      const changed = content !== current.content || descText !== current.desc || url !== current.url;
      if (!changed) {
        return { row: { ...current, tagIds: [...current.tagIds] } };
      }
      const updated: MarkRow = {
        ...current,
        content,
        desc: descText,
        url,
        version: current.version + 1,
        updatedAt: now(),
        tagIds: [...current.tagIds],
      };
      stored.row = updated;
      if (guardMismatch && input.force) {
        const preview = previewOf(descText, content, url);
        events.push({
          tagId: current.tagId,
          title: preview || current.type,
          description: 'Record overwritten with force.',
          dedupeKey: null,
        });
      }
      return { row: { ...updated, tagIds: [...updated.tagIds] } };
    },

    async putMarkTags(
      requestedWorkspace: string,
      markId: number,
      input: PutTagsInput,
    ): Promise<MarkRow> {
      checkWorkspace(requestedWorkspace);
      const stored = loadMark(markId);
      const current = stored.row;
      for (const tagId of input.tagIds) {
        if (!tagsStore.has(tagId)) {
          throw tagNotFound(tagId);
        }
      }
      const guardMismatch =
        (input.expectedTagIds !== undefined &&
          JSON.stringify([...input.expectedTagIds].sort((a, b) => a - b)) !==
            JSON.stringify(current.tagIds)) ||
        (input.expectedTagVersion !== undefined && input.expectedTagVersion !== current.version);
      if (guardMismatch && !input.force) {
        throw new ApiError(
          409,
          'record_tags_changed',
          'The record tags have changed since they were read.',
          { details: { currentTagIds: [...current.tagIds] } },
        );
      }
      const primaryTagId = input.tagIds[0];
      const effectiveTagIds = sortedTagIds(primaryTagId, input.tagIds);
      const updated: MarkRow = {
        ...current,
        tagId: primaryTagId,
        tagIds: effectiveTagIds,
        version: current.version + 1,
        updatedAt: now(),
      };
      stored.row = updated;
      if (guardMismatch && input.force) {
        const preview = previewOf(current.desc, current.content, current.url);
        events.push({
          tagId: primaryTagId,
          title: preview || current.type,
          description: 'Record tags overwritten with force.',
          dedupeKey: null,
        });
      }
      return { ...updated, tagIds: [...updated.tagIds] };
    },

    async softDeleteMark(requestedWorkspace: string, markId: number): Promise<SoftDeleteResult> {
      checkWorkspace(requestedWorkspace);
      const stored = loadMark(markId);
      const current = stored.row;
      if (current.deletedAt !== null) {
        return { row: { ...current, tagIds: [...current.tagIds] }, changed: false };
      }
      const at = now();
      const updated: MarkRow = {
        ...current,
        deletedAt: at,
        version: current.version + 1,
        updatedAt: at,
        tagIds: [...current.tagIds],
      };
      stored.row = updated;
      const preview = previewOf(current.desc, current.content, current.url);
      events.push({
        tagId: current.tagId,
        title: preview || current.type,
        description: 'Record moved to trash.',
        dedupeKey: null,
      });
      return { row: { ...updated, tagIds: [...updated.tagIds] }, changed: true };
    },

    async restoreMark(requestedWorkspace: string, markId: number): Promise<SoftDeleteResult> {
      checkWorkspace(requestedWorkspace);
      const stored = loadMark(markId);
      const current = stored.row;
      if (current.deletedAt === null) {
        return { row: { ...current, tagIds: [...current.tagIds] }, changed: false };
      }
      let surviving = current.tagIds.filter((tagId) => tagsStore.has(tagId));
      let primaryTagId: number;
      if (surviving.length === 0) {
        primaryTagId = resolveDefaultTag(false);
        surviving = [primaryTagId];
      } else {
        primaryTagId = surviving.includes(current.tagId)
          ? current.tagId
          : [...surviving].sort((a, b) => a - b)[0];
        surviving = sortedTagIds(primaryTagId, surviving);
      }
      const at = now();
      const updated: MarkRow = {
        ...current,
        deletedAt: null,
        tagId: primaryTagId,
        tagIds: surviving,
        version: current.version + 1,
        updatedAt: at,
      };
      stored.row = updated;
      const preview = previewOf(current.desc, current.content, current.url);
      events.push({
        tagId: primaryTagId,
        title: preview || current.type,
        description: 'Record restored from trash.',
        dedupeKey: null,
      });
      return { row: { ...updated, tagIds: [...updated.tagIds] }, changed: true };
    },

    async permanentDeleteMark(
      requestedWorkspace: string,
      markId: number,
    ): Promise<PermanentDeleteResult> {
      checkWorkspace(requestedWorkspace);
      const stored = loadMark(markId);
      const current = stored.row;
      const preview = previewOf(current.desc, current.content, current.url);
      events.push({
        tagId: current.tagId,
        title: preview || current.type,
        description: 'Record permanently deleted.',
        dedupeKey: null,
      });
      marksStore.delete(markId);
      const assetKeys = ASSET_TYPES.has(current.type) && current.url !== '' ? [current.url] : [];
      return { deleted: true, assetKeys };
    },

    async emptyTrash(requestedWorkspace: string): Promise<EmptyTrashResult> {
      checkWorkspace(requestedWorkspace);
      const trashed = [...marksStore.values()].filter((stored) => stored.row.deletedAt !== null);
      const assetKeys = [
        ...new Set(
          trashed
            .filter((stored) => ASSET_TYPES.has(stored.row.type) && stored.row.url !== '')
            .map((stored) => stored.row.url),
        ),
      ];
      for (const stored of trashed) {
        marksStore.delete(stored.row.id);
      }
      const purgedAt = now();
      events.push({
        tagId: null,
        title: 'Trash emptied',
        description: `${trashed.length} record(s) permanently deleted.`,
        dedupeKey: null,
      });
      return { purged: trashed.length, purgedAt, assetKeys };
    },

    async listTags(requestedWorkspace: string): Promise<TagRow[]> {
      checkWorkspace(requestedWorkspace);
      const all = [...tagsStore.values()].sort((a, b) => {
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
      return all.map((stored) => toTagRow(stored));
    },

    async createTag(requestedWorkspace: string, name: string): Promise<TagRow> {
      checkWorkspace(requestedWorkspace);
      for (const stored of tagsStore.values()) {
        if (stored.name === name) {
          throw new ApiError(409, 'tag_name_taken', 'A tag with this name already exists in this workspace.');
        }
      }
      return toTagRow(insertTag(name, false, false));
    },

    async patchTag(
      requestedWorkspace: string,
      tagId: number,
      input: { name: string | undefined; pinned: boolean | undefined },
    ): Promise<TagRow> {
      checkWorkspace(requestedWorkspace);
      const target = tagsStore.get(tagId);
      if (target === undefined) {
        throw ApiError.notFound();
      }
      if (input.pinned !== undefined && input.pinned !== target.pinned) {
        if (target.locked) {
          throw new ApiError(409, 'tag_locked', 'A locked tag cannot be renamed, unpinned, or deleted.');
        }
        target.pinned = input.pinned;
        target.updatedAt = now();
      }
      if (input.name !== undefined && input.name !== target.name) {
        if (target.locked) {
          throw new ApiError(409, 'tag_locked', 'A locked tag cannot be renamed, unpinned, or deleted.');
        }
        const oldName = target.name;
        const newName = input.name;
        const subtree = [...tagsStore.values()].filter(
          (tag) => tag.name === oldName || tag.name.startsWith(`${oldName}/`),
        );
        const subtreeIds = new Set(subtree.map((tag) => tag.id));
        const newNames = subtree.map((tag) => newName + tag.name.slice(oldName.length));
        for (const tag of tagsStore.values()) {
          if (!subtreeIds.has(tag.id) && newNames.includes(tag.name)) {
            throw new ApiError(409, 'tag_name_taken', 'A tag with this name already exists in this workspace.');
          }
        }
        for (const tag of subtree) {
          tag.name = newName + tag.name.slice(oldName.length);
          tag.updatedAt = now();
        }
      }
      return toTagRow(target);
    },

    async deleteTag(
      requestedWorkspace: string,
      tagId: number,
      reassignTo: number | undefined,
    ): Promise<DeleteTagResult> {
      checkWorkspace(requestedWorkspace);
      const target = tagsStore.get(tagId);
      if (target === undefined) {
        throw ApiError.notFound();
      }
      if (target.locked) {
        throw new ApiError(409, 'tag_locked', 'A locked tag cannot be renamed, unpinned, or deleted.');
      }
      const inUse = countDirect(tagId, false);
      if (inUse > 0 && reassignTo === undefined) {
        throw new ApiError(409, 'tag_in_use', 'The tag is still in use by records.', {
          details: { recordCount: inUse },
        });
      }
      if (reassignTo !== undefined) {
        if (reassignTo === tagId) {
          throw ApiError.validation('Request validation failed.', {
            fields: [{ field: 'reassignTo', issue: 'must differ from the deleted tag' }],
          });
        }
        if (!tagsStore.has(reassignTo)) {
          throw tagNotFound(reassignTo);
        }
        for (const stored of marksStore.values()) {
          if (!stored.row.tagIds.includes(tagId)) {
            continue;
          }
          const nextIds = sortedTagIds(
            stored.row.tagId === tagId ? reassignTo : stored.row.tagId,
            stored.row.tagIds.filter((id) => id !== tagId).concat(reassignTo),
          );
          stored.row = {
            ...stored.row,
            tagId: stored.row.tagId === tagId ? reassignTo : stored.row.tagId,
            tagIds: nextIds,
          };
        }
      }
      tagsStore.delete(tagId);
      return { deleted: true, reassignedTo: reassignTo ?? null };
    },

    async hasUrlReference(requestedWorkspace: string, url: string): Promise<boolean> {
      checkWorkspace(requestedWorkspace);
      for (const stored of marksStore.values()) {
        if (stored.row.url === url) {
          return true;
        }
      }
      return false;
    },
  };

  return repository;
}
