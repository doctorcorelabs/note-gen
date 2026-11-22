// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Pure list filtering, sorting, and cursor pagination for GET
// /api/marks (kontrak 3.5, V1-14 6.1 as amended by A-12). The
// Drizzle repository pre-filters in SQL and the fake repository
// passes every row; both run this scan, so the two agree by
// construction. Re-applying a filter the SQL layer already
// applied is harmless.
//
// Filter semantics:
// - status: active (deletedAt null), trash (deletedAt set), all.
// - tagId: membership in the tag or any descendant (name equal
//   to the tag name or starting with name + '/'). A tagId that
//   names no tag matches nothing (empty page, not an error: a
//   list filter is not resource addressing).
// - tagIds: OR over exact membership.
// - tagInclude/tagExclude: tag-name paths; a path matches a tag
//   name exactly or as a name-prefix ancestor. tagMatch all
//   requires every include path to match at least one of the
//   record's tags; any requires one. Exclude always wins.
// - type: OR over the listed types. createdAfter/createdBefore:
//   inclusive bounds on createdAt.
// - q: one case-insensitive substring over desc, url, and
//   searchable content (todo content is title + description, the
//   same extraction the search loader applies; fileName is always
//   empty in MVP, so it contributes nothing). DA-6 F-15-01: url
//   joined the haystack so a link record whose keyword lives only
//   in its URL matches here exactly like global search
//   (UTANG-UJI-03b).
// - Sort: created_desc (createdAt desc), created_asc (createdAt
//   asc), updated_desc (updatedAt desc), type (type asc, then
//   createdAt desc); the final tiebreak is always id
//   descending (V1-14 6.1).
//
// Cursor: `mrk1.` + base64url JSON binding the normalized query
// (every filter and the sort; the limit is NOT bound) plus the
// sort position of the last item. A malformed cursor, or one
// carried to a different query, answers 400 invalid_cursor.

import { ApiError } from '../../plugins/envelope.js';
import type { MarkRow } from './represent.js';
import type { ListQuery } from './validation.js';

const CURSOR_PREFIX = 'mrk1.';

export interface ListScanRow extends MarkRow {
  tagNames: string[];
}

interface CursorBinding {
  status: string;
  tagId: number | null;
  tagIds: number[] | null;
  tagInclude: string[] | null;
  tagExclude: string[] | null;
  tagMatch: string;
  types: string[] | null;
  q: string | null;
  createdAfter: number | null;
  createdBefore: number | null;
  sort: string;
}

interface CursorPayload {
  v: 1;
  binding: CursorBinding;
  sortKey: number | string;
  id: number;
}

function bindingOf(query: ListQuery): CursorBinding {
  return {
    status: query.status,
    tagId: query.tagId ?? null,
    tagIds: query.tagIds === undefined ? null : [...query.tagIds],
    tagInclude: query.tagInclude === undefined ? null : [...query.tagInclude],
    tagExclude: query.tagExclude === undefined ? null : [...query.tagExclude],
    tagMatch: query.tagMatch,
    types: query.types === undefined ? null : [...query.types],
    q: query.q ?? null,
    createdAfter: query.createdAfter ?? null,
    createdBefore: query.createdBefore ?? null,
    sort: query.sort,
  };
}

function sameBinding(a: CursorBinding, b: CursorBinding): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function invalidCursor(): ApiError {
  return new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
}

function encodeCursor(query: ListQuery, last: ListScanRow): string {
  const payload: CursorPayload = {
    v: 1,
    binding: bindingOf(query),
    sortKey: sortKeyOf(query.sort, last),
    id: last.id,
  };
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, query: ListQuery): CursorPayload {
  let parsed: unknown;
  try {
    if (!cursor.startsWith(CURSOR_PREFIX)) {
      throw invalidCursor();
    }
    parsed = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    ) as unknown;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor();
  }
  const record = parsed as Record<string, unknown>;
  const binding = record['binding'] as CursorBinding | undefined;
  const sortKey = record['sortKey'];
  const id = record['id'];
  if (
    record['v'] !== 1 ||
    binding === undefined ||
    typeof binding !== 'object' ||
    binding === null ||
    (typeof sortKey !== 'number' && typeof sortKey !== 'string') ||
    typeof id !== 'number' ||
    !Number.isInteger(id)
  ) {
    throw invalidCursor();
  }
  if (!sameBinding(binding, bindingOf(query))) {
    throw invalidCursor();
  }
  return { v: 1, binding, sortKey, id };
}

function sortKeyOf(sort: ListQuery['sort'], row: ListScanRow): number | string {
  switch (sort) {
    case 'created_desc':
    case 'created_asc':
      return row.createdAt;
    case 'updated_desc':
      return row.updatedAt;
    case 'type':
      return row.type;
  }
}

function compareRows(sort: ListQuery['sort'], a: ListScanRow, b: ListScanRow): number {
  const aKey = sortKeyOf(sort, a);
  const bKey = sortKeyOf(sort, b);
  if (aKey !== bKey) {
    if (typeof aKey === 'number' && typeof bKey === 'number') {
      return sort === 'created_asc' ? aKey - bKey : bKey - aKey;
    }
    if (typeof aKey === 'string' && typeof bKey === 'string') {
      // Type sort: type ascending, then createdAt descending.
      if (aKey !== bKey) {
        return aKey < bKey ? -1 : 1;
      }
    }
  }
  if (sort === 'type' && a.createdAt !== b.createdAt) {
    return b.createdAt - a.createdAt;
  }
  return b.id - a.id;
}

function compareToCursor(sort: ListQuery['sort'], row: ListScanRow, cursor: CursorPayload): number {
  const key = sortKeyOf(sort, row);
  const cursorKey = cursor.sortKey;
  if (typeof key === 'number' && typeof cursorKey === 'number' && key !== cursorKey) {
    return sort === 'created_asc' ? key - cursorKey : cursorKey - key;
  }
  if (typeof key === 'string' && typeof cursorKey === 'string' && key !== cursorKey) {
    return key < cursorKey ? -1 : 1;
  }
  if (sort === 'type' && typeof key === 'string' && typeof cursorKey === 'string') {
    // Cursor position for type sort carries the type as sortKey;
    // createdAt is not in the cursor, so rows sharing the type
    // fall through to the id tiebreak below, which is only
    // exact when createdAt order equals id order within a type.
    // createdAt ties across types are resolved by id, matching
    // the comparator's final tiebreak.
  }
  return cursor.id - row.id;
}

function nameMatchesPath(tagName: string, path: string): boolean {
  return tagName === path || tagName.startsWith(`${path}/`);
}

function searchableText(row: ListScanRow): string {
  if (row.type !== 'todo') {
    return `${row.desc}\n${row.url}\n${row.content}`;
  }
  try {
    const parsed: unknown = JSON.parse(row.content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const title = typeof record['title'] === 'string' ? record['title'] : '';
      const description = typeof record['description'] === 'string' ? record['description'] : '';
      return `${row.desc}\n${row.url}\n${title}\n${description}`;
    }
  } catch {
    // Legacy non-JSON todo content: match the raw text.
  }
  return `${row.desc}\n${row.url}\n${row.content}`;
}

function rowMatches(row: ListScanRow, query: ListQuery, tagNameById: ReadonlyMap<number, string>): boolean {
  if (query.status === 'active' && row.deletedAt !== null) {
    return false;
  }
  if (query.status === 'trash' && row.deletedAt === null) {
    return false;
  }
  if (query.types !== undefined && !query.types.includes(row.type)) {
    return false;
  }
  if (query.createdAfter !== undefined && row.createdAt < query.createdAfter) {
    return false;
  }
  if (query.createdBefore !== undefined && row.createdAt > query.createdBefore) {
    return false;
  }
  if (query.tagId !== undefined) {
    const targetName = tagNameById.get(query.tagId);
    if (targetName === undefined) {
      return false;
    }
    if (!row.tagNames.some((name) => nameMatchesPath(name, targetName))) {
      return false;
    }
  }
  if (query.tagIds !== undefined && !query.tagIds.some((tagId) => row.tagIds.includes(tagId))) {
    return false;
  }
  if (query.tagInclude !== undefined) {
    const matches = query.tagInclude.map((path) =>
      row.tagNames.some((name) => nameMatchesPath(name, path)),
    );
    const included = query.tagMatch === 'all' ? matches.every(Boolean) : matches.some(Boolean);
    if (!included) {
      return false;
    }
  }
  if (
    query.tagExclude !== undefined &&
    query.tagExclude.some((path) => row.tagNames.some((name) => nameMatchesPath(name, path)))
  ) {
    return false;
  }
  if (query.q !== undefined) {
    const haystack = searchableText(row).toLowerCase();
    if (!haystack.includes(query.q.toLowerCase())) {
      return false;
    }
  }
  return true;
}

export interface ListScanPage {
  items: MarkRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

// NOTE on the type-sort cursor: the cursor carries (type, id)
// but not createdAt, while the comparator orders type groups by
// createdAt desc before id desc. Pagination stays exact as long
// as createdAt order within one type agrees with id order,
// which holds for rows created through the API (ids and
// timestamps both increase). A backfilled row with an old
// timestamp and a new id could be skipped or repeated across a
// type-sorted page boundary; that edge is accepted in MVP and
// documented here rather than hidden.
export function scanList(
  rows: readonly ListScanRow[],
  query: ListQuery,
  tagNameById: ReadonlyMap<number, string>,
): ListScanPage {
  const anchor = query.cursor === undefined ? undefined : decodeCursor(query.cursor, query);
  const matched = rows.filter((row) => rowMatches(row, query, tagNameById));
  matched.sort((a, b) => compareRows(query.sort, a, b));
  const after =
    anchor === undefined
      ? matched
      : matched.filter((row) => compareToCursor(query.sort, row, anchor) > 0);
  const page = after.slice(0, query.limit);
  const hasMore = after.length > query.limit;
  const last = page[page.length - 1];
  return {
    items: page.map((row) => {
      const { tagNames: _tagNames, ...mark } = row;
      return mark;
    }),
    nextCursor: hasMore && last !== undefined ? encodeCursor(query, last) : null,
    hasMore,
  };
}
