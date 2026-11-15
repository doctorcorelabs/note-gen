// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the records tag handlers (V3-25, wave 3B overlap): tags
// list/get reads and the two mark tag-set writes.
//
// Validation tests run always, without a database. Database tests run
// only when RECORDS_TAGS_DATABASE_URL is set; they seed one user plus
// two workspaces in that database, exercise handlers through
// db.transaction, and use a fresh workspace per test so domain rows
// never leak across cases. Example:
//   RECORDS_TAGS_DATABASE_URL=postgres://postgres@127.0.0.1:55433/v3b_25d_db pnpm test test/db-handlers-records-tags.spec.ts

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ApiError } from '../src/plugins/envelope.js';
import {
  createDb,
  markTags,
  marks,
  tags,
  users,
  workspaces,
  type Database,
} from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import * as marksSaveTagIds from '../src/services/db/marks-save-tag-ids.js';
import * as marksUpdateTags from '../src/services/db/marks-update-tags.js';
import * as tagsGet from '../src/services/db/tags-get.js';
import * as tagsList from '../src/services/db/tags-list.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

interface Ctx {
  tx: Tx;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

function expectValidationError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.statusCode).toBe(400);
    expect(apiError.code).toBe('validation_failed');
    return apiError;
  }
  throw new Error('expected a validation error, but nothing was thrown');
}

async function expectApiErrorAsync(
  promise: Promise<unknown>,
  statusCode: number,
  code: string,
): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.statusCode).toBe(statusCode);
    expect(apiError.code).toBe(code);
    return apiError;
  }
  throw new Error(`expected ApiError ${statusCode} ${code}, but nothing was thrown`);
}

describe('tag handler markers and validation (no database)', () => {
  it('exposes the catalog kind on each handler file', () => {
    expect(tagsList.HANDLER_KIND).toBe('tags.list');
    expect(tagsGet.HANDLER_KIND).toBe('tags.get');
    expect(marksUpdateTags.HANDLER_KIND).toBe('marks.updateTags');
    expect(marksSaveTagIds.HANDLER_KIND).toBe('marks.saveTagIds');
  });

  it('rejects non-object operations and unknown fields', () => {
    expectValidationError(() => tagsList.validate(null));
    expectValidationError(() => tagsList.validate({ kind: 'tags.list', extra: 1 }));
    expectValidationError(() => tagsGet.validate({ kind: 'tags.get', id: 1, extra: 1 }));
    expectValidationError(() => marksUpdateTags.validate({ kind: 'marks.updateTags', id: 1 }));
    expectValidationError(() =>
      marksSaveTagIds.validate({ kind: 'marks.saveTagIds', id: 1, tagId: 2, force: true }),
    );
  });

  it('rejects a kind mismatch', () => {
    expectValidationError(() => tagsGet.validate({ kind: 'tags.list', id: 1 }));
    expectValidationError(() =>
      marksSaveTagIds.validate({ kind: 'marks.updateTags', id: 1, tagId: 2 }),
    );
  });

  it('accepts the minimal list shape and rejects a bad tag id', () => {
    expect(() => tagsList.validate({ kind: 'tags.list' })).not.toThrow();
    expectValidationError(() => tagsGet.validate({ kind: 'tags.get' }));
    expectValidationError(() => tagsGet.validate({ kind: 'tags.get', id: 1.5 }));
    expectValidationError(() => tagsGet.validate({ kind: 'tags.get', id: '7' }));
  });

  it('validates the updateTags shape', () => {
    expect(() => marksUpdateTags.validate({ kind: 'marks.updateTags', id: 1, tagIds: [2] })).not.toThrow();
    expect(() =>
      marksUpdateTags.validate({
        kind: 'marks.updateTags',
        id: 1,
        tagIds: [2],
        newNames: ['Riset'],
        expected: { tagIds: [2], primaryTagId: 2 },
      }),
    ).not.toThrow();
    expectValidationError(() =>
      marksUpdateTags.validate({ kind: 'marks.updateTags', id: 1, tagIds: 'nope' }),
    );
    expectValidationError(() =>
      marksUpdateTags.validate({ kind: 'marks.updateTags', id: 1, tagIds: [2, 2.5] }),
    );
    expectValidationError(() =>
      marksUpdateTags.validate({ kind: 'marks.updateTags', id: 1, tagIds: [], newNames: 'Riset' }),
    );
    expectValidationError(() =>
      marksUpdateTags.validate({
        kind: 'marks.updateTags',
        id: 1,
        tagIds: [],
        newNames: Array.from({ length: 11 }, (_, i) => `Tag${i}`),
      }),
    );
    expectValidationError(() =>
      marksUpdateTags.validate({
        kind: 'marks.updateTags',
        id: 1,
        tagIds: [],
        newNames: ['x'.repeat(101)],
      }),
    );
    expectValidationError(() =>
      marksUpdateTags.validate({
        kind: 'marks.updateTags',
        id: 1,
        tagIds: [],
        newNames: ['a//b'],
      }),
    );
    expect(() =>
      marksUpdateTags.validate({ kind: 'marks.updateTags', id: 1, tagIds: [], newNames: ['   '] }),
    ).not.toThrow();
    expectValidationError(() =>
      marksUpdateTags.validate({
        kind: 'marks.updateTags',
        id: 1,
        tagIds: [],
        expected: { tagIds: [2] },
      }),
    );
    expectValidationError(() =>
      marksUpdateTags.validate({
        kind: 'marks.updateTags',
        id: 1,
        tagIds: [],
        expected: { tagIds: [2], primaryTagId: 2, version: 1 },
      }),
    );
    expectValidationError(() =>
      marksUpdateTags.validate({
        kind: 'marks.updateTags',
        id: 1,
        tagIds: [],
        expected: { tagIds: 'x', primaryTagId: 2 },
      }),
    );
  });

  it('validates the saveTagIds shape', () => {
    expect(() =>
      marksSaveTagIds.validate({ kind: 'marks.saveTagIds', id: 1, tagId: 2 }),
    ).not.toThrow();
    expect(() =>
      marksSaveTagIds.validate({ kind: 'marks.saveTagIds', id: 1, tagId: 2, tagIds: [2, 3] }),
    ).not.toThrow();
    expectValidationError(() => marksSaveTagIds.validate({ kind: 'marks.saveTagIds', id: 1 }));
    expectValidationError(() =>
      marksSaveTagIds.validate({ kind: 'marks.saveTagIds', id: 1, tagId: 1.5 }),
    );
    expectValidationError(() =>
      marksSaveTagIds.validate({ kind: 'marks.saveTagIds', id: 1, tagId: 2, tagIds: 'x' }),
    );
    expectValidationError(() =>
      marksSaveTagIds.validate({ kind: 'marks.saveTagIds', id: 1, tagId: 2, tagIds: [2, '3'] }),
    );
  });
});

const TEST_DATABASE_URL = process.env.RECORDS_TAGS_DATABASE_URL;
const DB_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const parsed = new URL(databaseUrl);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!DB_NAME_PATTERN.test(dbName)) {
    throw new Error('Test database name must be a plain identifier.');
  }
  const maintenance = new URL(databaseUrl);
  maintenance.pathname = '/postgres';
  const admin = postgres(maintenance.toString(), { max: 1 });
  try {
    const found = await admin`select 1 as one from pg_database where datname = ${dbName}`;
    if (found.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }
}

describe.skipIf(TEST_DATABASE_URL === undefined)('tag handlers over Postgres', () => {
  let db: Database;
  let close: () => Promise<void>;
  let userId: string;
  let workspaceId: string;
  let otherWorkspaceId: string;

  beforeAll(async () => {
    const url = TEST_DATABASE_URL as string;
    await ensureDatabaseExists(url);
    await runMigrations({ databaseUrl: url });
    const handle = createDb(url, { max: 5 });
    db = handle.db;
    close = handle.close;
    const inserted = await db
      .insert(users)
      .values({ email: `v3b-25d-${Date.now()}@example.invalid`, passwordHash: 'test-only-not-a-secret' })
      .returning({ id: users.id });
    userId = inserted[0].id;
  }, 120_000);

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    const mine = await db
      .insert(workspaces)
      .values({ ownerUserId: userId, name: 'records-tags' })
      .returning({ id: workspaces.id });
    workspaceId = mine[0].id;
    const other = await db
      .insert(workspaces)
      .values({ ownerUserId: userId, name: 'records-tags-other' })
      .returning({ id: workspaces.id });
    otherWorkspaceId = other[0].id;
  });

  async function run<T>(
    handler: (ctx: Ctx, op: unknown) => Promise<T>,
    op: unknown,
    ws: string = workspaceId,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      const ctx: Ctx = { tx, workspaceId: ws, userId, requestId: 'test', transactionId: null };
      return handler(ctx, op);
    });
  }

  async function seedTag(
    ws: string,
    name: string,
    options: { sortOrder?: number; isPin?: boolean; isLocked?: boolean } = {},
  ): Promise<number> {
    const rows = await db
      .insert(tags)
      .values({
        workspaceId: ws,
        name,
        sortOrder: options.sortOrder ?? 0,
        isPin: options.isPin ?? false,
        isLocked: options.isLocked ?? false,
      })
      .returning({ id: tags.id });
    return rows[0].id;
  }

  async function seedMark(
    ws: string,
    tagId: number,
    options: { deleted?: boolean } = {},
  ): Promise<number> {
    const rows = await db
      .insert(marks)
      .values({
        workspaceId: ws,
        tagId,
        type: 'text',
        url: '',
        deletedAt: options.deleted === true ? new Date() : null,
      })
      .returning({ id: marks.id });
    return rows[0].id;
  }

  async function seedLinks(ws: string, markId: number, tagIds: number[]): Promise<void> {
    if (tagIds.length === 0) {
      return;
    }
    await db.insert(markTags).values(tagIds.map((tagId) => ({ markId, tagId, workspaceId: ws })));
  }

  async function readMark(markId: number) {
    const rows = await db.select().from(marks).where(eq(marks.id, markId)).limit(1);
    return rows[0];
  }

  async function readMarkTagIds(markId: number): Promise<number[]> {
    const rows = await db
      .select({ tagId: markTags.tagId })
      .from(markTags)
      .where(eq(markTags.markId, markId));
    return rows.map((row) => row.tagId).sort((a, b) => a - b);
  }

  describe('tags.list', () => {
    it('orders by sortOrder then id and counts subtree totals over live marks only', async () => {
      const parent = await seedTag(workspaceId, 'Idea', { sortOrder: 2 });
      const child = await seedTag(workspaceId, 'Idea/Music', { sortOrder: 1 });
      const other = await seedTag(workspaceId, 'Other', { sortOrder: 1 });
      const first = await seedMark(workspaceId, parent);
      await seedLinks(workspaceId, first, [parent, child]);
      const second = await seedMark(workspaceId, child);
      await seedLinks(workspaceId, second, [child]);
      const deleted = await seedMark(workspaceId, other, { deleted: true });
      await seedLinks(workspaceId, deleted, [other]);
      await seedTag(otherWorkspaceId, 'Foreign', { sortOrder: 0 });

      const rows = await run(tagsList.handle, { kind: 'tags.list' });

      expect(rows.map((row) => row.id)).toEqual([child, other, parent]);
      expect(rows.map((row) => row.total)).toEqual([2, 0, 2]);
      expect(rows[0]).toMatchObject({ name: 'Idea/Music', isLocked: false, isPin: false, sortOrder: 1 });
    });

    it('returns an empty array for a workspace without tags', async () => {
      const rows = await run(tagsList.handle, { kind: 'tags.list' });
      expect(rows).toEqual([]);
    });
  });

  describe('tags.get', () => {
    it('returns one row without a total, and an empty array when missing or foreign', async () => {
      const id = await seedTag(workspaceId, 'Idea', { sortOrder: 3, isPin: true, isLocked: true });
      const foreign = await seedTag(otherWorkspaceId, 'Foreign');

      const found = await run(tagsGet.handle, { kind: 'tags.get', id });
      expect(found).toHaveLength(1);
      expect(found[0]).toEqual({ id, name: 'Idea', isLocked: true, isPin: true, sortOrder: 3 });
      expect(found[0]).not.toHaveProperty('total');

      expect(await run(tagsGet.handle, { kind: 'tags.get', id: id + 100000 })).toEqual([]);
      expect(await run(tagsGet.handle, { kind: 'tags.get', id: foreign })).toEqual([]);
    });
  });

  describe('marks.updateTags', () => {
    it('replaces the set, keeps the primary, and bumps version and tagUpdatedAt', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const dropped = await seedTag(workspaceId, 'Old');
      const added = await seedTag(workspaceId, 'New');
      const markId = await seedMark(workspaceId, primary);
      await seedLinks(workspaceId, markId, [primary, dropped]);
      const before = await readMark(markId);
      expect(before.tagUpdatedAt).toBeNull();

      const result = await run(marksUpdateTags.handle, {
        kind: 'marks.updateTags',
        id: markId,
        tagIds: [primary, added],
      });

      expect(result).toEqual({ affected: 1, id: markId, version: before.version + 1 });
      const after = await readMark(markId);
      expect(after.tagId).toBe(primary);
      expect(after.version).toBe(before.version + 1);
      expect(after.tagUpdatedAt).not.toBeNull();
      expect(await readMarkTagIds(markId)).toEqual([primary, added].sort((a, b) => a - b));
    });

    it('keeps the primary even when the caller omits it from tagIds', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const added = await seedTag(workspaceId, 'New');
      const markId = await seedMark(workspaceId, primary);
      await seedLinks(workspaceId, markId, [primary]);

      await run(marksUpdateTags.handle, { kind: 'marks.updateTags', id: markId, tagIds: [added] });

      expect(await readMarkTagIds(markId)).toEqual([primary, added].sort((a, b) => a - b));
    });

    it('ignores unknown ids and rejects a request naming no valid tag', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const kept = await seedTag(workspaceId, 'Kept');
      const markId = await seedMark(workspaceId, primary);
      await seedLinks(workspaceId, markId, [primary, kept]);

      await run(marksUpdateTags.handle, {
        kind: 'marks.updateTags',
        id: markId,
        tagIds: [primary, kept, primary + 100000],
      });
      expect(await readMarkTagIds(markId)).toEqual([primary, kept].sort((a, b) => a - b));
      const versionAfterIgnore = (await readMark(markId)).version;

      await expectApiErrorAsync(
        run(marksUpdateTags.handle, {
          kind: 'marks.updateTags',
          id: markId,
          tagIds: [primary + 100000],
        }),
        400,
        'validation_failed',
      );
      expect((await readMark(markId)).version).toBe(versionAfterIgnore);
      expect(await readMarkTagIds(markId)).toEqual([primary, kept].sort((a, b) => a - b));
    });

    it('creates new tags from newNames, normalizes names, and reuses existing names', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const existing = await seedTag(workspaceId, 'Riset');
      const markId = await seedMark(workspaceId, primary);
      await seedLinks(workspaceId, markId, [primary]);

      await run(marksUpdateTags.handle, {
        kind: 'marks.updateTags',
        id: markId,
        tagIds: [primary],
        newNames: ['Riset', ' #Fresh / Leaf ', '   '],
      });

      const names = await db
        .select({ name: tags.name })
        .from(tags)
        .where(eq(tags.workspaceId, workspaceId));
      expect(names.map((row) => row.name).sort()).toEqual(['Fresh/Leaf', 'Idea', 'Riset']);
      const fresh = await db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.workspaceId, workspaceId), eq(tags.name, 'Fresh/Leaf')));
      expect(await readMarkTagIds(markId)).toEqual(
        [primary, existing, fresh[0].id].sort((a, b) => a - b),
      );
    });

    it('honors a matching guard and rejects a stale guard with current state, changing nothing', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const extra = await seedTag(workspaceId, 'Extra');
      const markId = await seedMark(workspaceId, primary);
      await seedLinks(workspaceId, markId, [primary, extra]);
      const before = await readMark(markId);

      const ok = await run(marksUpdateTags.handle, {
        kind: 'marks.updateTags',
        id: markId,
        tagIds: [primary],
        expected: { tagIds: [extra, primary], primaryTagId: primary },
      });
      expect(ok.affected).toBe(1);

      const stale = await expectApiErrorAsync(
        run(marksUpdateTags.handle, {
          kind: 'marks.updateTags',
          id: markId,
          tagIds: [primary, extra],
          expected: { tagIds: [primary, extra], primaryTagId: primary },
        }),
        409,
        'record_tags_changed',
      );
      expect(stale.message).toBe('Record tags changed. Reopen the tag editor and try again.');
      expect(stale.details).toMatchObject({
        currentTagIds: [primary],
        currentPrimaryTagId: primary,
        currentVersion: before.version + 1,
      });
      expect(await readMarkTagIds(markId)).toEqual([primary]);

      await expectApiErrorAsync(
        run(marksUpdateTags.handle, {
          kind: 'marks.updateTags',
          id: markId,
          tagIds: [primary],
          expected: { tagIds: [primary], primaryTagId: extra },
        }),
        409,
        'record_tags_changed',
      );
    });

    it('reads the current set from the primary alone when no join rows exist', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const added = await seedTag(workspaceId, 'New');
      const markId = await seedMark(workspaceId, primary);

      const result = await run(marksUpdateTags.handle, {
        kind: 'marks.updateTags',
        id: markId,
        tagIds: [primary, added],
        expected: { tagIds: [primary], primaryTagId: primary },
      });
      expect(result.affected).toBe(1);
      expect(await readMarkTagIds(markId)).toEqual([primary, added].sort((a, b) => a - b));
    });

    it('answers 404 for a missing, foreign, or soft-deleted mark', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const foreignTag = await seedTag(otherWorkspaceId, 'Foreign');
      const foreignMark = await seedMark(otherWorkspaceId, foreignTag);
      const deletedMark = await seedMark(workspaceId, primary, { deleted: true });

      await expectApiErrorAsync(
        run(marksUpdateTags.handle, { kind: 'marks.updateTags', id: 987654321, tagIds: [primary] }),
        404,
        'not_found',
      );
      await expectApiErrorAsync(
        run(marksUpdateTags.handle, { kind: 'marks.updateTags', id: foreignMark, tagIds: [primary] }),
        404,
        'not_found',
      );
      await expectApiErrorAsync(
        run(marksUpdateTags.handle, { kind: 'marks.updateTags', id: deletedMark, tagIds: [primary] }),
        404,
        'not_found',
      );
    });
  });

  describe('marks.saveTagIds', () => {
    it('replaces the set, moves the primary, refreshes tagUpdatedAt, and keeps the version', async () => {
      const oldPrimary = await seedTag(workspaceId, 'Old');
      const nextPrimary = await seedTag(workspaceId, 'Next');
      const extra = await seedTag(workspaceId, 'Extra');
      const markId = await seedMark(workspaceId, oldPrimary);
      await seedLinks(workspaceId, markId, [oldPrimary]);
      const before = await readMark(markId);

      const result = await run(marksSaveTagIds.handle, {
        kind: 'marks.saveTagIds',
        id: markId,
        tagId: nextPrimary,
        tagIds: [nextPrimary, extra],
      });

      expect(result).toEqual({ affected: 1, id: markId, version: before.version });
      const after = await readMark(markId);
      expect(after.tagId).toBe(nextPrimary);
      expect(after.version).toBe(before.version);
      expect(after.tagUpdatedAt).not.toBeNull();
      expect(await readMarkTagIds(markId)).toEqual([nextPrimary, extra].sort((a, b) => a - b));
    });

    it('treats undefined tagIds as a preserve no-op', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const extra = await seedTag(workspaceId, 'Extra');
      const markId = await seedMark(workspaceId, primary);
      await seedLinks(workspaceId, markId, [primary, extra]);
      const before = await readMark(markId);

      const result = await run(marksSaveTagIds.handle, {
        kind: 'marks.saveTagIds',
        id: markId,
        tagId: primary,
      });

      expect(result).toEqual({ affected: 0, id: markId, version: before.version });
      const after = await readMark(markId);
      expect(after.tagUpdatedAt).toBeNull();
      expect(await readMarkTagIds(markId)).toEqual([primary, extra].sort((a, b) => a - b));
    });

    it('stores the primary alone for an empty tagIds array', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const extra = await seedTag(workspaceId, 'Extra');
      const markId = await seedMark(workspaceId, primary);
      await seedLinks(workspaceId, markId, [primary, extra]);

      const result = await run(marksSaveTagIds.handle, {
        kind: 'marks.saveTagIds',
        id: markId,
        tagId: primary,
        tagIds: [],
      });

      expect(result.affected).toBe(1);
      expect(await readMarkTagIds(markId)).toEqual([primary]);
    });

    it('rejects unknown or foreign tag references with tag_not_found, changing nothing', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const foreign = await seedTag(otherWorkspaceId, 'Foreign');
      const markId = await seedMark(workspaceId, primary);
      await seedLinks(workspaceId, markId, [primary]);
      const before = await readMark(markId);

      await expectApiErrorAsync(
        run(marksSaveTagIds.handle, {
          kind: 'marks.saveTagIds',
          id: markId,
          tagId: primary,
          tagIds: [primary, primary + 100000],
        }),
        400,
        'tag_not_found',
      );
      await expectApiErrorAsync(
        run(marksSaveTagIds.handle, {
          kind: 'marks.saveTagIds',
          id: markId,
          tagId: primary,
          tagIds: [foreign],
        }),
        400,
        'tag_not_found',
      );
      await expectApiErrorAsync(
        run(marksSaveTagIds.handle, {
          kind: 'marks.saveTagIds',
          id: markId,
          tagId: foreign,
          tagIds: [primary],
        }),
        400,
        'tag_not_found',
      );
      expect((await readMark(markId)).version).toBe(before.version);
      expect(await readMarkTagIds(markId)).toEqual([primary]);
    });

    it('answers 404 for a missing or foreign mark', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const foreignTag = await seedTag(otherWorkspaceId, 'Foreign');
      const foreignMark = await seedMark(otherWorkspaceId, foreignTag);

      await expectApiErrorAsync(
        run(marksSaveTagIds.handle, {
          kind: 'marks.saveTagIds',
          id: 987654321,
          tagId: primary,
          tagIds: [primary],
        }),
        404,
        'not_found',
      );
      await expectApiErrorAsync(
        run(marksSaveTagIds.handle, {
          kind: 'marks.saveTagIds',
          id: foreignMark,
          tagId: foreignTag,
          tagIds: [foreignTag],
        }),
        404,
        'not_found',
      );
    });

    it('writes the tag set of a soft-deleted mark, matching upstream save behavior', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const extra = await seedTag(workspaceId, 'Extra');
      const markId = await seedMark(workspaceId, primary, { deleted: true });
      await seedLinks(workspaceId, markId, [primary]);

      const result = await run(marksSaveTagIds.handle, {
        kind: 'marks.saveTagIds',
        id: markId,
        tagId: primary,
        tagIds: [primary, extra],
      });

      expect(result.affected).toBe(1);
      expect(await readMarkTagIds(markId)).toEqual([primary, extra].sort((a, b) => a - b));
    });
  });
});
