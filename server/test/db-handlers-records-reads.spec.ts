// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the records read handlers (V3-25, wave 3B overlap): marks
// list, get, and list by tag.
//
// Validation tests run always. Database tests run only when
// RECORDS_READS_DATABASE_URL is set; they seed one user plus two
// workspaces in that database, exercise handlers through
// db.transaction, and remove the seeded rows afterwards. Example:
//   RECORDS_READS_DATABASE_URL=postgres://postgres@127.0.0.1:55433/v3b_25a_db pnpm test test/db-handlers-records-reads.spec.ts
//
// The database must already carry the canonical M8 schema; migrate a
// scratch database with the fase1 m8gate runner before running the
// live section.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApiError } from '../src/plugins/envelope.js';
import {
  createDb,
  markTags,
  marks,
  tags,
  users,
  workspaceMembers,
  workspaces,
  type Database,
  type DbHandle,
} from '../src/db/index.js';
import * as marksGet from '../src/services/db/marks-get.js';
import * as marksList from '../src/services/db/marks-list.js';
import * as marksListByTag from '../src/services/db/marks-list-by-tag.js';

type Ctx = {
  tx: Parameters<Parameters<Database['transaction']>[0]>[0];
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
};

function expectApiError(error: unknown, status: number, code: string): ApiError {
  expect(error).toBeInstanceOf(ApiError);
  const apiError = error as ApiError;
  expect(apiError.statusCode).toBe(status);
  expect(apiError.code).toBe(code);
  return apiError;
}

describe('marks read handler validation (no database)', () => {
  it('pins the handler kind markers', () => {
    expect(marksList.HANDLER_KIND).toBe('marks.list');
    expect(marksGet.HANDLER_KIND).toBe('marks.get');
    expect(marksListByTag.HANDLER_KIND).toBe('marks.listByTag');
  });

  it('rejects a tag filter on marks.list (D-01) and unknown fields', () => {
    let caught: unknown;
    try {
      marksList.validate({ kind: 'marks.list', tagId: 1 });
    } catch (error) {
      caught = error;
    }
    expectApiError(caught, 400, 'validation_failed');
    expect(() =>
      marksList.validate({ kind: 'marks.list', tagIds: [1] }),
    ).toThrow(ApiError);
    expect(() => marksList.validate({ kind: 'marks.list', extra: true })).toThrow(ApiError);
    expect(() => marksList.validate({ kind: 'marks.get' })).toThrow(ApiError);
    expect(() => marksList.validate(null)).toThrow(ApiError);
  });

  it('accepts the three deleted states and rejects other values', () => {
    for (const deleted of ['active', 'deleted', 'all'] as const) {
      expect(() => marksList.validate({ kind: 'marks.list', deleted })).not.toThrow();
      expect(() =>
        marksListByTag.validate({ kind: 'marks.listByTag', tagId: 1, deleted }),
      ).not.toThrow();
    }
    expect(() => marksList.validate({ kind: 'marks.list', deleted: 'trash' })).toThrow(ApiError);
    expect(() => marksList.validate({ kind: 'marks.list', deleted: true })).toThrow(ApiError);
    expect(() =>
      marksListByTag.validate({ kind: 'marks.listByTag', tagId: 1, deleted: 'trash' }),
    ).toThrow(ApiError);
  });

  it('rejects a malformed pagination cursor and an invalid limit', () => {
    for (const validate of [marksList.validate, marksListByTag.validate]) {
      const base =
        validate === marksList.validate ? { kind: 'marks.list' } : { kind: 'marks.listByTag', tagId: 1 };
      let caught: unknown;
      try {
        validate({ ...base, cursor: 'bogus' });
      } catch (error) {
        caught = error;
      }
      expectApiError(caught, 400, 'invalid_cursor');
      caught = undefined;
      try {
        validate({ ...base, cursor: '12:34:56' });
      } catch (error) {
        caught = error;
      }
      expectApiError(caught, 400, 'invalid_cursor');
      caught = undefined;
      try {
        validate({ ...base, limit: 0 });
      } catch (error) {
        caught = error;
      }
      expectApiError(caught, 400, 'invalid_limit');
      expect(() => validate({ ...base, limit: 1.5 })).toThrow(ApiError);
      expect(() => validate({ ...base, limit: '50' })).toThrow(ApiError);
      expect(() => validate({ ...base, limit: 500 })).not.toThrow();
      expect(() => validate({ ...base, cursor: '1700000000000:42' })).not.toThrow();
    }
  });

  it('requires an integer id for marks.get', () => {
    expect(() => marksGet.validate({ kind: 'marks.get', id: 1 })).not.toThrow();
    expect(() => marksGet.validate({ kind: 'marks.get' })).toThrow(ApiError);
    expect(() => marksGet.validate({ kind: 'marks.get', id: 1.5 })).toThrow(ApiError);
    expect(() => marksGet.validate({ kind: 'marks.get', id: '1' })).toThrow(ApiError);
    expect(() => marksGet.validate({ kind: 'marks.get', id: 1, deleted: 'all' })).toThrow(ApiError);
  });

  it('requires an integer tagId for marks.listByTag', () => {
    expect(() => marksListByTag.validate({ kind: 'marks.listByTag', tagId: 1 })).not.toThrow();
    expect(() => marksListByTag.validate({ kind: 'marks.listByTag' })).toThrow(ApiError);
    expect(() => marksListByTag.validate({ kind: 'marks.listByTag', tagId: '1' })).toThrow(
      ApiError,
    );
    expect(() =>
      marksListByTag.validate({ kind: 'marks.listByTag', tagId: 1, tagIds: [1] }),
    ).toThrow(ApiError);
  });
});

const DATABASE_URL = process.env.RECORDS_READS_DATABASE_URL;
const dbDescribe = DATABASE_URL === undefined ? describe.skip : describe;

dbDescribe('marks read handlers against Postgres', () => {
  let db: Database;
  let handle: DbHandle;
  let userId = '';
  let workspaceId = '';
  let otherWorkspaceId = '';
  let parentTagId = 0;
  let childTagId = 0;
  let siblingTagId = 0;
  let prefixTrapTagId = 0;
  let otherTagId = 0;

  let newestId = 0;
  let middleId = 0;
  let tieEarlyId = 0;
  let tieLateId = 0;
  let deletedId = 0;
  let bareId = 0;
  let trapId = 0;
  let otherWsId = 0;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL as string, { max: 5 });
    db = handle.db;
    const suffix = randomUUID();
    const userRows = await db
      .insert(users)
      .values({ email: `v3b25a-${suffix}`, passwordHash: 'test-hash' })
      .returning({ id: users.id });
    userId = userRows[0]?.id as string;
    const wsRows = await db
      .insert(workspaces)
      .values([
        { ownerUserId: userId, name: 'v3b25a main' },
        { ownerUserId: userId, name: 'v3b25a other' },
      ])
      .returning({ id: workspaces.id });
    workspaceId = wsRows[0]?.id as string;
    otherWorkspaceId = wsRows[1]?.id as string;
    await db.insert(workspaceMembers).values([
      { workspaceId, userId, role: 'owner' },
      { workspaceId: otherWorkspaceId, userId, role: 'owner' },
    ]);
    const tagRows = await db
      .insert(tags)
      .values([
        { workspaceId, name: 'inbox' },
        { workspaceId, name: 'inbox/music' },
        { workspaceId, name: 'other' },
        { workspaceId, name: 'inbox2' },
        { workspaceId: otherWorkspaceId, name: 'inbox' },
      ])
      .returning({ id: tags.id });
    parentTagId = tagRows[0]?.id as number;
    childTagId = tagRows[1]?.id as number;
    siblingTagId = tagRows[2]?.id as number;
    prefixTrapTagId = tagRows[3]?.id as number;
    otherTagId = tagRows[4]?.id as number;

    const base = Date.UTC(2026, 0, 1);
    async function makeMark(values: {
      ws: string;
      tagId: number;
      createdAt: Date;
      deletedAt?: Date | null;
      tagUpdatedAt?: Date | null;
      content?: string | null;
      desc?: string | null;
      url?: string | null;
      sourceId?: string | null;
    }): Promise<number> {
      const rows = await db
        .insert(marks)
        .values({
          workspaceId: values.ws,
          tagId: values.tagId,
          type: 'text',
          content: values.content ?? 'body',
          desc: values.desc ?? 'summary',
          url: values.url ?? 'https://example.test/x',
          deletedAt: values.deletedAt ?? null,
          tagUpdatedAt: values.tagUpdatedAt ?? null,
          sourceId: values.sourceId ?? null,
          createdAt: values.createdAt,
        })
        .returning({ id: marks.id });
      return rows[0]?.id as number;
    }

    newestId = await makeMark({
      ws: workspaceId,
      tagId: parentTagId,
      createdAt: new Date(base + 5000),
      tagUpdatedAt: new Date(base + 9000),
      sourceId: `v3b25a-newest-${suffix}`,
    });
    middleId = await makeMark({
      ws: workspaceId,
      tagId: childTagId,
      createdAt: new Date(base + 4000),
    });
    tieEarlyId = await makeMark({
      ws: workspaceId,
      tagId: siblingTagId,
      createdAt: new Date(base + 3000),
      content: null,
      desc: null,
      url: null,
    });
    tieLateId = await makeMark({
      ws: workspaceId,
      tagId: parentTagId,
      createdAt: new Date(base + 3000),
    });
    deletedId = await makeMark({
      ws: workspaceId,
      tagId: parentTagId,
      createdAt: new Date(base + 2000),
      deletedAt: new Date(base + 6000),
    });
    bareId = await makeMark({
      ws: workspaceId,
      tagId: parentTagId,
      createdAt: new Date(base + 1000),
    });
    trapId = await makeMark({
      ws: workspaceId,
      tagId: prefixTrapTagId,
      createdAt: new Date(base + 4500),
    });
    otherWsId = await makeMark({
      ws: otherWorkspaceId,
      tagId: otherTagId,
      createdAt: new Date(base + 8000),
    });

    // Effective sets: newest carries child membership out of order;
    // middle carries the parent as an extra membership; tie rows and
    // the deleted row carry only their primary; bare carries no
    // mark_tags rows at all, so its effective set is just its primary.
    await db.insert(markTags).values([
      { markId: newestId, tagId: childTagId, workspaceId },
      { markId: newestId, tagId: parentTagId, workspaceId },
      { markId: middleId, tagId: parentTagId, workspaceId },
      { markId: middleId, tagId: childTagId, workspaceId },
      { markId: tieEarlyId, tagId: siblingTagId, workspaceId },
      { markId: tieLateId, tagId: parentTagId, workspaceId },
      { markId: deletedId, tagId: parentTagId, workspaceId },
      { markId: trapId, tagId: prefixTrapTagId, workspaceId },
      { markId: otherWsId, tagId: otherTagId, workspaceId: otherWorkspaceId },
    ]);
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, otherWorkspaceId));
    await db.delete(users).where(eq(users.id, userId));
    await handle.close();
  });

  async function run<T>(
    handler: { handle: (ctx: Ctx, op: unknown) => Promise<T> },
    op: unknown,
    ws: string = workspaceId,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      return handler.handle(
        { tx, workspaceId: ws, userId, requestId: 'v3b25a-test', transactionId: null },
        op,
      );
    });
  }

  it('marks.list: active default, createdAt desc with id desc tiebreak, effective tag sets', async () => {
    const rows = await run(marksList, { kind: 'marks.list' });
    expect(rows.map((row) => row.id)).toEqual([
      newestId,
      trapId,
      middleId,
      tieLateId,
      tieEarlyId,
      bareId,
    ]);
    const newest = rows[0];
    expect(newest?.tagId).toBe(parentTagId);
    expect(newest?.tagIds).toEqual([parentTagId, childTagId].sort((a, b) => a - b));
    expect(newest?.tagUpdatedAt).toBe(Date.UTC(2026, 0, 1) + 9000);
    expect(newest?.deleted).toBe(false);
    expect(newest?.sourceId).toMatch(/^v3b25a-newest-/);
    expect(newest?.version).toBe(1);
    const bare = rows.find((row) => row.id === bareId);
    expect(bare?.tagIds).toEqual([parentTagId]);
    expect(bare?.tagUpdatedAt).toBe(0);
    const tieEarly = rows.find((row) => row.id === tieEarlyId);
    expect(tieEarly?.content).toBeUndefined();
    expect(tieEarly?.desc).toBeUndefined();
    expect(tieEarly?.url).toBe('');
    expect(rows.map((row) => row.id)).not.toContain(deletedId);
    expect(rows.map((row) => row.id)).not.toContain(otherWsId);
  });

  it('marks.list: deleted and all filters, and cursor pagination without gaps', async () => {
    const deleted = await run(marksList, { kind: 'marks.list', deleted: 'deleted' });
    expect(deleted.map((row) => row.id)).toEqual([deletedId]);
    expect(deleted[0]?.deleted).toBe(true);
    const all = await run(marksList, { kind: 'marks.list', deleted: 'all' });
    expect(all.map((row) => row.id)).toEqual([
      newestId,
      trapId,
      middleId,
      tieLateId,
      tieEarlyId,
      deletedId,
      bareId,
    ]);
    const first = await run(marksList, { kind: 'marks.list', limit: 3 });
    expect(first).toHaveLength(3);
    const last = first[2];
    const rest = await run(marksList, {
      kind: 'marks.list',
      limit: 3,
      cursor: `${last?.createdAt}:${last?.id}`,
    });
    expect(rest.map((row) => row.id)).toEqual([tieLateId, tieEarlyId, bareId]);
    const tail = await run(marksList, {
      kind: 'marks.list',
      limit: 3,
      cursor: `${rest[2]?.createdAt}:${rest[2]?.id}`,
    });
    expect(tail).toEqual([]);
  });

  it('marks.get: effective tagIds plus tagUpdatedAt, deleted rows included, missing rows empty', async () => {
    const fetched = await run(marksGet, { kind: 'marks.get', id: newestId });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.tagIds).toEqual([parentTagId, childTagId].sort((a, b) => a - b));
    expect(fetched[0]?.tagUpdatedAt).toBe(Date.UTC(2026, 0, 1) + 9000);
    const deleted = await run(marksGet, { kind: 'marks.get', id: deletedId });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.deleted).toBe(true);
    expect(await run(marksGet, { kind: 'marks.get', id: 999_999_999 })).toEqual([]);
    expect(await run(marksGet, { kind: 'marks.get', id: newestId }, otherWorkspaceId)).toEqual([]);
  });

  it('marks.listByTag: descendant tags match, sibling and prefix-trap names do not', async () => {
    const byParent = await run(marksListByTag, { kind: 'marks.listByTag', tagId: parentTagId });
    expect(byParent.map((row) => row.id)).toEqual([newestId, middleId, tieLateId, bareId]);
    const byChild = await run(marksListByTag, { kind: 'marks.listByTag', tagId: childTagId });
    expect(byChild.map((row) => row.id)).toEqual([newestId, middleId]);
    const bySibling = await run(marksListByTag, { kind: 'marks.listByTag', tagId: siblingTagId });
    expect(bySibling.map((row) => row.id)).toEqual([tieEarlyId]);
    const byTrap = await run(marksListByTag, { kind: 'marks.listByTag', tagId: prefixTrapTagId });
    expect(byTrap.map((row) => row.id)).toEqual([trapId]);
    expect(await run(marksListByTag, { kind: 'marks.listByTag', tagId: 999_999_999 })).toEqual([]);
  });

  it('marks.listByTag: deleted filter, pagination, and workspace isolation', async () => {
    const deleted = await run(marksListByTag, {
      kind: 'marks.listByTag',
      tagId: parentTagId,
      deleted: 'deleted',
    });
    expect(deleted.map((row) => row.id)).toEqual([deletedId]);
    const all = await run(marksListByTag, {
      kind: 'marks.listByTag',
      tagId: parentTagId,
      deleted: 'all',
    });
    expect(all.map((row) => row.id)).toEqual([newestId, middleId, tieLateId, deletedId, bareId]);
    const first = await run(marksListByTag, {
      kind: 'marks.listByTag',
      tagId: parentTagId,
      limit: 2,
    });
    expect(first.map((row) => row.id)).toEqual([newestId, middleId]);
    const rest = await run(marksListByTag, {
      kind: 'marks.listByTag',
      tagId: parentTagId,
      limit: 2,
      cursor: `${first[1]?.createdAt}:${first[1]?.id}`,
    });
    expect(rest.map((row) => row.id)).toEqual([tieLateId, bareId]);
    const other = await run(
      marksListByTag,
      { kind: 'marks.listByTag', tagId: otherTagId },
      otherWorkspaceId,
    );
    expect(other.map((row) => row.id)).toEqual([otherWsId]);
    const cross = await run(
      marksListByTag,
      { kind: 'marks.listByTag', tagId: parentTagId },
      otherWorkspaceId,
    );
    expect(cross).toEqual([]);
  });
});
