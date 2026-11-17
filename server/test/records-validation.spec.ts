// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Pure parsing/validation and list-scan specs for the REST
// marks/tags routes (W4-WIRE, kontrak 3.5/3.6, V1-14 as
// amended by A-12 and AD-32). No database, no HTTP: every
// rule the route layer relies on is pinned here, including
// the S-05 todo convention, the guard-merging rules, the list
// cursor binding, and the tag-name subtree matching.

import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/plugins/envelope.js';
import { scanList, type ListScanRow } from '../src/services/records/list-scan.js';
import {
  parseCreateBody,
  parseEmptyTrashBody,
  parseListQuery,
  parseMarkIdParam,
  parsePatchBody,
  parsePutTagsBody,
  parseReassignTo,
  parseRestoreBody,
  parseTagCreateBody,
  parseTagPatchBody,
  type ListQuery,
} from '../src/services/records/validation.js';

function errorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('Expected the parser to throw.');
}

function todoContent(title = 'Buy milk'): string {
  return JSON.stringify({ title, description: '2 liters', priority: 'high', completed: false });
}

describe('parseCreateBody', () => {
  it('applies the text desc default (desc = content)', () => {
    const input = parseCreateBody({ type: 'text', content: 'hello' }, undefined);
    expect(input.desc).toBe('hello');
    expect(input.url).toBe('');
    expect(input.sourceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('applies the empty desc default for non-text types', () => {
    const input = parseCreateBody({ type: 'link', url: 'https://example.invalid/x' }, undefined);
    expect(input.desc).toBe('');
    expect(input.content).toBe('');
  });

  it('requires the todo desc to equal the parsed title (S-05)', () => {
    const input = parseCreateBody({ type: 'todo', content: todoContent('Buy milk') }, undefined);
    expect(input.desc).toBe('Buy milk');
    const err = errorOf(() =>
      parseCreateBody({ type: 'todo', content: todoContent('Buy milk'), desc: 'Other' }, undefined),
    );
    expect(err.code).toBe('validation_failed');
  });

  it('rejects todo content that is not the strict four-key JSON object', () => {
    expect(errorOf(() => parseCreateBody({ type: 'todo', content: 'plain text' }, undefined)).code).toBe(
      'validation_failed',
    );
    expect(
      errorOf(() =>
        parseCreateBody(
          {
            type: 'todo',
            content: JSON.stringify({ title: 'T', description: '', priority: 'high', completed: false, extra: 1 }),
          },
          undefined,
        ),
      ).code,
    ).toBe('validation_failed');
    expect(
      errorOf(() =>
        parseCreateBody(
          { type: 'todo', content: JSON.stringify({ title: 'T', description: '', priority: 'urgent', completed: false }) },
          undefined,
        ),
      ).code,
    ).toBe('validation_failed');
    expect(
      errorOf(() =>
        parseCreateBody(
          { type: 'todo', content: JSON.stringify({ title: '  ', description: '', priority: 'low', completed: false }) },
          undefined,
        ),
      ).code,
    ).toBe('validation_failed');
  });

  it('enforces url rules per type', () => {
    expect(errorOf(() => parseCreateBody({ type: 'link', url: 'not-a-url' }, undefined)).code).toBe(
      'validation_failed',
    );
    expect(errorOf(() => parseCreateBody({ type: 'link' }, undefined)).code).toBe('validation_failed');
    expect(errorOf(() => parseCreateBody({ type: 'text', content: 'x', url: 'https://example.invalid' }, undefined)).code).toBe(
      'validation_failed',
    );
    expect(errorOf(() => parseCreateBody({ type: 'image' }, undefined)).code).toBe('validation_failed');
    const image = parseCreateBody({ type: 'image', url: 'ast_0123456789abcdef0123456789abcdef' }, undefined);
    expect(image.url).toBe('ast_0123456789abcdef0123456789abcdef');
  });

  it('requires tagId to be a member of tagIds when both are sent', () => {
    expect(
      errorOf(() => parseCreateBody({ type: 'text', content: 'x', tagId: 3, tagIds: [1, 2] }, undefined)).code,
    ).toBe('validation_failed');
    const ok = parseCreateBody({ type: 'text', content: 'x', tagId: 2, tagIds: [1, 2] }, undefined);
    expect(ok.tagId).toBe(2);
  });

  it('resolves the source id body > Idempotency-Key header > minted UUID', () => {
    expect(parseCreateBody({ type: 'text', content: 'x', sourceId: 'src-1' }, 'hdr-1').sourceId).toBe('src-1');
    expect(parseCreateBody({ type: 'text', content: 'x' }, 'hdr-1').sourceId).toBe('hdr-1');
    expect(parseCreateBody({ type: 'text', content: 'x', sourceId: '' }, 'hdr-1').sourceId).toBe('hdr-1');
  });

  it('rejects unknown fields and an over-long source id', () => {
    expect(errorOf(() => parseCreateBody({ type: 'text', content: 'x', workspaceId: 'ws' }, undefined)).code).toBe(
      'validation_failed',
    );
    expect(
      errorOf(() => parseCreateBody({ type: 'text', content: 'x', sourceId: 's'.repeat(256) }, undefined)).code,
    ).toBe('validation_failed');
  });

  it('rejects unknown types and non-object bodies', () => {
    expect(errorOf(() => parseCreateBody({ type: 'note', content: 'x' }, undefined)).code).toBe('validation_failed');
    expect(errorOf(() => parseCreateBody(undefined, undefined)).code).toBe('validation_failed');
    expect(errorOf(() => parseCreateBody([1], undefined)).code).toBe('validation_failed');
  });
});

describe('parsePatchBody', () => {
  it('requires at least one content field', () => {
    expect(errorOf(() => parsePatchBody({}, undefined)).code).toBe('validation_failed');
    expect(parsePatchBody({ content: 'new' }, undefined).content).toBe('new');
  });

  it('merges the If-Match header with the body guard and rejects mismatches', () => {
    expect(parsePatchBody({ content: 'x' }, '7').expectedVersion).toBe(7);
    expect(parsePatchBody({ content: 'x', expectedVersion: 7 }, '7').expectedVersion).toBe(7);
    expect(errorOf(() => parsePatchBody({ content: 'x', expectedVersion: 8 }, '7')).code).toBe(
      'validation_failed',
    );
    expect(errorOf(() => parsePatchBody({ content: 'x' }, 'v7')).code).toBe('validation_failed');
    expect(errorOf(() => parsePatchBody({ content: 'x' }, '0')).code).toBe('validation_failed');
  });

  it('parses force as a boolean only', () => {
    expect(parsePatchBody({ content: 'x', force: true }, undefined).force).toBe(true);
    expect(parsePatchBody({ content: 'x' }, undefined).force).toBe(false);
    expect(errorOf(() => parsePatchBody({ content: 'x', force: 'yes' }, undefined)).code).toBe(
      'validation_failed',
    );
  });
});

describe('parsePutTagsBody', () => {
  it('rejects duplicate tag ids', () => {
    expect(errorOf(() => parsePutTagsBody({ tagIds: [1, 1], force: true })).code).toBe('validation_failed');
  });

  it('requires a guard unless force is set', () => {
    expect(errorOf(() => parsePutTagsBody({ tagIds: [1] })).code).toBe('validation_failed');
    expect(parsePutTagsBody({ tagIds: [1], expectedTagIds: [1] }).expectedTagIds).toEqual([1]);
    expect(parsePutTagsBody({ tagIds: [1], expectedTagVersion: 3 }).expectedTagVersion).toBe(3);
    expect(parsePutTagsBody({ tagIds: [1], force: true }).force).toBe(true);
  });

  it('requires tagIds to be a non-empty array of positive integers', () => {
    expect(errorOf(() => parsePutTagsBody({ force: true })).code).toBe('validation_failed');
    expect(errorOf(() => parsePutTagsBody({ tagIds: [], force: true })).code).toBe('validation_failed');
    expect(errorOf(() => parsePutTagsBody({ tagIds: [0], force: true })).code).toBe('validation_failed');
  });
});

describe('tag body parsers', () => {
  it('normalizes tag names on create (leading # and slash segments trimmed)', () => {
    expect(parseTagCreateBody({ name: '  #Work / Deep  ' }).name).toBe('Work/Deep');
    expect(errorOf(() => parseTagCreateBody({ name: 'a//b' })).code).toBe('validation_failed');
    expect(errorOf(() => parseTagCreateBody({ name: 'a\tb' })).code).toBe('validation_failed');
    expect(errorOf(() => parseTagCreateBody({ name: 'n'.repeat(101) })).code).toBe('validation_failed');
  });

  it('requires at least one of name/pinned on patch', () => {
    expect(errorOf(() => parseTagPatchBody({})).code).toBe('validation_failed');
    expect(parseTagPatchBody({ pinned: true }).pinned).toBe(true);
    expect(parseTagPatchBody({ name: 'New' }).name).toBe('New');
  });
});

describe('parseListQuery', () => {
  it('applies defaults', () => {
    const query = parseListQuery({});
    expect(query.status).toBe('active');
    expect(query.sort).toBe('created_desc');
    expect(query.limit).toBe(50);
    expect(query.tagMatch).toBe('all');
    expect(query.cursor).toBeUndefined();
  });

  it('rejects out-of-range limits with invalid_limit', () => {
    expect(errorOf(() => parseListQuery({ limit: '0' })).code).toBe('invalid_limit');
    expect(errorOf(() => parseListQuery({ limit: '201' })).code).toBe('invalid_limit');
    expect(errorOf(() => parseListQuery({ limit: 'abc' })).code).toBe('invalid_limit');
    expect(parseListQuery({ limit: '200' }).limit).toBe(200);
  });

  it('forbids trash combined with other filters, and tagId combined with tagIds', () => {
    expect(errorOf(() => parseListQuery({ status: 'trash', q: 'x' })).code).toBe('validation_failed');
    expect(errorOf(() => parseListQuery({ tagId: '1', tagIds: '2' })).code).toBe('validation_failed');
    expect(parseListQuery({ status: 'trash' }).status).toBe('trash');
  });

  it('parses comma lists and epoch bounds', () => {
    const query = parseListQuery({
      tagIds: '1, 2,2',
      type: 'text,todo',
      tagInclude: 'Work, Personal',
      createdAfter: '1000',
      createdBefore: '2000',
      sort: 'type',
    });
    expect(query.tagIds).toEqual([1, 2, 2]);
    expect(query.types).toEqual(['text', 'todo']);
    expect(query.tagInclude).toEqual(['Work', 'Personal']);
    expect(query.createdAfter).toBe(1000);
    expect(query.createdBefore).toBe(2000);
    expect(query.sort).toBe('type');
  });
});

describe('id params, trash confirm, reassignTo, restore body', () => {
  it('answers 404 for non-numeric, zero, or negative ids', () => {
    expect(parseMarkIdParam('42')).toBe(42);
    expect(errorOf(() => parseMarkIdParam('abc')).code).toBe('not_found');
    expect(errorOf(() => parseMarkIdParam('0')).code).toBe('not_found');
    expect(errorOf(() => parseMarkIdParam('-3')).code).toBe('not_found');
    expect(errorOf(() => parseMarkIdParam(undefined)).code).toBe('not_found');
  });

  it('requires confirm: true to empty the trash', () => {
    expect(errorOf(() => parseEmptyTrashBody(undefined)).code).toBe('confirm_required');
    expect(errorOf(() => parseEmptyTrashBody({})).code).toBe('confirm_required');
    expect(errorOf(() => parseEmptyTrashBody({ confirm: false })).code).toBe('confirm_required');
    expect(errorOf(() => parseEmptyTrashBody({ confirm: true, extra: 1 })).code).toBe('validation_failed');
    parseEmptyTrashBody({ confirm: true });
  });

  it('parses reassignTo as an optional positive integer', () => {
    expect(parseReassignTo({})).toBeUndefined();
    expect(parseReassignTo({ reassignTo: '9' })).toBe(9);
    expect(errorOf(() => parseReassignTo({ reassignTo: 'x' })).code).toBe('validation_failed');
  });

  it('accepts an absent or empty restore body, rejects fields', () => {
    parseRestoreBody(undefined);
    parseRestoreBody({});
    expect(errorOf(() => parseRestoreBody({ force: true })).code).toBe('validation_failed');
  });
});

function scanRow(overrides: Partial<ListScanRow> & { id: number }): ListScanRow {
  return {
    workspaceId: 'ws-1',
    type: 'text',
    content: '',
    desc: '',
    url: '',
    tagId: 1,
    tagIds: [1],
    version: 1,
    deletedAt: null,
    sourceId: null,
    createdAt: 1000,
    updatedAt: 1000,
    tagNames: ['Idea'],
    ...overrides,
  };
}

const BASE_QUERY: ListQuery = {
  status: 'active',
  tagId: undefined,
  tagIds: undefined,
  tagInclude: undefined,
  tagExclude: undefined,
  tagMatch: 'all',
  types: undefined,
  q: undefined,
  createdAfter: undefined,
  createdBefore: undefined,
  sort: 'created_desc',
  limit: 50,
  cursor: undefined,
};

describe('scanList', () => {
  it('sorts created_desc with id descending as the tiebreak', () => {
    const rows = [
      scanRow({ id: 1, createdAt: 1000 }),
      scanRow({ id: 2, createdAt: 1000 }),
      scanRow({ id: 3, createdAt: 900 }),
    ];
    const page = scanList(rows, BASE_QUERY, new Map([[1, 'Idea']]));
    expect(page.items.map((item) => item.id)).toEqual([2, 1, 3]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('paginates with a cursor that binds the query but not the limit', () => {
    const rows = [1, 2, 3, 4, 5].map((id) => scanRow({ id, createdAt: 1000 + id }));
    const first = scanList(rows, { ...BASE_QUERY, limit: 2 }, new Map([[1, 'Idea']]));
    expect(first.items.map((item) => item.id)).toEqual([5, 4]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = scanList(rows, { ...BASE_QUERY, limit: 3, cursor: first.nextCursor as string }, new Map([[1, 'Idea']]));
    expect(second.items.map((item) => item.id)).toEqual([3, 2, 1]);
    expect(second.hasMore).toBe(false);
    expect(errorOf(() => scanList(rows, { ...BASE_QUERY, cursor: first.nextCursor as string, q: 'x' }, new Map([[1, 'Idea']]))).code).toBe(
      'invalid_cursor',
    );
    expect(errorOf(() => scanList(rows, { ...BASE_QUERY, cursor: 'garbage' }, new Map([[1, 'Idea']]))).code).toBe(
      'invalid_cursor',
    );
  });

  it('applies tagId subtree matching via name prefixes', () => {
    const tagNameById = new Map([
      [1, 'Work'],
      [2, 'Work/Deep'],
      [3, 'Personal'],
    ]);
    const rows = [
      scanRow({ id: 1, tagIds: [2], tagNames: ['Work/Deep'] }),
      scanRow({ id: 2, tagIds: [3], tagNames: ['Personal'] }),
      scanRow({ id: 3, tagIds: [1], tagNames: ['Work'] }),
    ];
    const page = scanList(rows, { ...BASE_QUERY, tagId: 1 }, tagNameById);
    expect(page.items.map((item) => item.id).sort()).toEqual([1, 3]);
    const empty = scanList(rows, { ...BASE_QUERY, tagId: 99 }, tagNameById);
    expect(empty.items).toEqual([]);
  });

  it('applies tagInclude/tagExclude with tagMatch, exclude always wins', () => {
    const tagNameById = new Map([
      [1, 'Work'],
      [2, 'Work/Deep'],
      [3, 'Personal'],
    ]);
    const rows = [
      scanRow({ id: 1, tagIds: [1, 2], tagNames: ['Work', 'Work/Deep'] }),
      scanRow({ id: 2, tagIds: [1, 3], tagNames: ['Work', 'Personal'] }),
    ];
    const all = scanList(
      rows,
      { ...BASE_QUERY, tagInclude: ['Work', 'Personal'], tagMatch: 'all' },
      tagNameById,
    );
    expect(all.items.map((item) => item.id)).toEqual([2]);
    const any = scanList(
      rows,
      { ...BASE_QUERY, tagInclude: ['Personal'], tagMatch: 'any', tagExclude: ['Work'] },
      tagNameById,
    );
    expect(any.items).toEqual([]);
  });

  it('matches q as one case-insensitive substring over todo title + description, not JSON keys', () => {
    const rows = [
      scanRow({ id: 1, type: 'todo', content: todoContent('Buy milk'), desc: 'Buy milk' }),
      scanRow({ id: 2, type: 'text', content: 'buying guide', desc: 'guide' }),
    ];
    const byTitle = scanList(rows, { ...BASE_QUERY, q: 'MILK' }, new Map([[1, 'Idea']]));
    expect(byTitle.items.map((item) => item.id)).toEqual([1]);
    const byJsonKey = scanList(rows, { ...BASE_QUERY, q: 'completed' }, new Map([[1, 'Idea']]));
    expect(byJsonKey.items).toEqual([]);
    const bySubstring = scanList(rows, { ...BASE_QUERY, q: 'buy' }, new Map([[1, 'Idea']]));
    expect(bySubstring.items.map((item) => item.id).sort()).toEqual([1, 2]);
  });

  it('filters by status, type, and inclusive time bounds', () => {
    const rows = [
      scanRow({ id: 1, deletedAt: 500 }),
      scanRow({ id: 2, type: 'link', createdAt: 1500 }),
      scanRow({ id: 3, type: 'text', createdAt: 2500 }),
    ];
    expect(scanList(rows, { ...BASE_QUERY, status: 'trash' }, new Map()).items.map((i) => i.id)).toEqual([1]);
    expect(scanList(rows, { ...BASE_QUERY, status: 'all' }, new Map()).items).toHaveLength(3);
    expect(scanList(rows, { ...BASE_QUERY, types: ['link'] }, new Map()).items.map((i) => i.id)).toEqual([2]);
    expect(
      scanList(rows, { ...BASE_QUERY, createdAfter: 1500, createdBefore: 1500 }, new Map()).items.map((i) => i.id),
    ).toEqual([2]);
  });

  it('sorts by type ascending, then createdAt descending, then id descending', () => {
    const rows = [
      scanRow({ id: 1, type: 'text', createdAt: 1000 }),
      scanRow({ id: 2, type: 'link', createdAt: 500 }),
      scanRow({ id: 3, type: 'link', createdAt: 900 }),
    ];
    const page = scanList(rows, { ...BASE_QUERY, sort: 'type' }, new Map());
    expect(page.items.map((item) => item.id)).toEqual([3, 2, 1]);
  });
});
