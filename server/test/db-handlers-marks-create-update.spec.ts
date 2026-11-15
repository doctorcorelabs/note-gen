// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the marks create/update handlers (V3-25b, wave 3B
// overlap): marks.create and marks.update.
//
// Validation tests run always, without a database. Database tests
// run only when MARKS_CREATE_UPDATE_DATABASE_URL is set; they seed
// one user plus two workspaces in that database, exercise handlers
// through db.transaction, and use a fresh workspace per test so
// domain rows never leak across cases. Example:
//   MARKS_CREATE_UPDATE_DATABASE_URL=postgres://postgres@127.0.0.1:55434/marks_create_update

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApiError } from '../src/plugins/envelope.js';
import {
  activityEvents,
  createDb,
  markTags,
  marks,
  tags,
  users,
  workspaces,
  type Database,
} from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import * as marksCreate from '../src/services/db/marks-create.js';
import * as marksUpdate from '../src/services/db/marks-update.js';

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

describe('marks create/update markers and validation (no database)', () => {
  it('exposes the catalog kind on each handler file', () => {
    expect(marksCreate.HANDLER_KIND).toBe('marks.create');
    expect(marksUpdate.HANDLER_KIND).toBe('marks.update');
  });

  it('rejects non-object operations, unknown fields, and kind mismatches', () => {
    expectValidationError(() => marksCreate.validate(null));
    expectValidationError(() => marksUpdate.validate('nope'));
    expectValidationError(() =>
      marksCreate.validate({ kind: 'marks.create', mark: { tagId: 1, type: 'text', url: '' }, extra: 1 }),
    );
    expectValidationError(() =>
      marksUpdate.validate({ kind: 'marks.update', id: 1, patch: {}, force: true }),
    );
    expectValidationError(() =>
      marksCreate.validate({ kind: 'marks.update', mark: { tagId: 1, type: 'text', url: '' } }),
    );
    expectValidationError(() =>
      marksUpdate.validate({ kind: 'marks.create', id: 1, patch: {} }),
    );
  });

  it('validates the marks.create shape', () => {
    expect(() =>
      marksCreate.validate({ kind: 'marks.create', mark: { tagId: 1, type: 'text', url: '' } }),
    ).not.toThrow();
    expect(() =>
      marksCreate.validate({
        kind: 'marks.create',
        mark: { tagId: 1, type: 'link', url: 'https://example.invalid', sourceId: 's-1' },
        tagIds: [1, 2],
        activity: { title: 'Saved', description: null },
      }),
    ).not.toThrow();
    expectValidationError(() => marksCreate.validate({ kind: 'marks.create' }));
    expectValidationError(() =>
      marksCreate.validate({ kind: 'marks.create', mark: { tagId: 0, type: 'text', url: '' } }),
    );
    expectValidationError(() =>
      marksCreate.validate({ kind: 'marks.create', mark: { tagId: 1.5, type: 'text', url: '' } }),
    );
    expectValidationError(() =>
      marksCreate.validate({ kind: 'marks.create', mark: { tagId: 1, type: 'bogus', url: '' } }),
    );
    expectValidationError(() =>
      marksCreate.validate({ kind: 'marks.create', mark: { tagId: 1, type: 'text' } }),
    );
    expectValidationError(() =>
      marksCreate.validate({
        kind: 'marks.create',
        mark: { tagId: 1, type: 'text', url: '', sourceId: '' },
      }),
    );
    expectValidationError(() =>
      marksCreate.validate({
        kind: 'marks.create',
        mark: { tagId: 1, type: 'text', url: '', id: 9 },
      }),
    );
    expectValidationError(() =>
      marksCreate.validate({
        kind: 'marks.create',
        mark: { tagId: 1, type: 'text', url: '' },
        tagIds: [1, -2],
      }),
    );
    expectValidationError(() =>
      marksCreate.validate({
        kind: 'marks.create',
        mark: { tagId: 1, type: 'text', url: '' },
        tagIds: 'nope',
      }),
    );
    expectValidationError(() =>
      marksCreate.validate({
        kind: 'marks.create',
        mark: { tagId: 1, type: 'text', url: '' },
        activity: { title: 'x', source: 'record' },
      }),
    );
    expectValidationError(() =>
      marksCreate.validate({
        kind: 'marks.create',
        mark: { tagId: 1, type: 'text', url: '' },
        activity: { title: 'x', dedupeKey: 'record:1' },
      }),
    );
    expectValidationError(() =>
      marksCreate.validate({
        kind: 'marks.create',
        mark: { tagId: 1, type: 'text', url: '' },
        activity: { description: 'no title' },
      }),
    );
  });

  it('validates the marks.update shape', () => {
    expect(() =>
      marksUpdate.validate({ kind: 'marks.update', id: 1, patch: { content: 'hi' } }),
    ).not.toThrow();
    expect(() =>
      marksUpdate.validate({
        kind: 'marks.update',
        id: 1,
        patch: { content: null, desc: null, url: 'u', type: 'todo', tagId: 2 },
        expected: { version: 3 },
      }),
    ).not.toThrow();
    expect(() => marksUpdate.validate({ kind: 'marks.update', id: 1, patch: {} })).not.toThrow();
    expectValidationError(() => marksUpdate.validate({ kind: 'marks.update', id: 1 }));
    expectValidationError(() => marksUpdate.validate({ kind: 'marks.update', id: '1', patch: {} }));
    expectValidationError(() =>
      marksUpdate.validate({ kind: 'marks.update', id: 1, patch: { createdAt: 5 } }),
    );
    expectValidationError(() =>
      marksUpdate.validate({ kind: 'marks.update', id: 1, patch: { url: null } }),
    );
    expectValidationError(() =>
      marksUpdate.validate({ kind: 'marks.update', id: 1, patch: { type: 'bogus' } }),
    );
    expectValidationError(() =>
      marksUpdate.validate({ kind: 'marks.update', id: 1, patch: { tagId: 0 } }),
    );
    expectValidationError(() =>
      marksUpdate.validate({ kind: 'marks.update', id: 1, patch: {}, expected: { version: 1.5 } }),
    );
    expectValidationError(() =>
      marksUpdate.validate({ kind: 'marks.update', id: 1, patch: {}, expected: { revision: 1 } }),
    );
    expectValidationError(() =>
      marksUpdate.validate({ kind: 'marks.update', id: 1, patch: {}, expected: 1 }),
    );
  });
});

const TEST_DATABASE_URL = process.env.MARKS_CREATE_UPDATE_DATABASE_URL;
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

describe.skipIf(TEST_DATABASE_URL === undefined)('marks create/update over Postgres', () => {
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
      .values({ email: `v3b-25b-${Date.now()}@example.invalid`, passwordHash: 'test-only-not-a-secret' })
      .returning({ id: users.id });
    userId = inserted[0].id;
  }, 120_000);

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    const mine = await db
      .insert(workspaces)
      .values({ ownerUserId: userId, name: 'marks-create-update' })
      .returning({ id: workspaces.id });
    workspaceId = mine[0].id;
    const other = await db
      .insert(workspaces)
      .values({ ownerUserId: userId, name: 'marks-create-update-other' })
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

  async function seedTag(ws: string, name: string): Promise<number> {
    const rows = await db
      .insert(tags)
      .values({ workspaceId: ws, name })
      .returning({ id: tags.id });
    return rows[0].id;
  }

  async function seedMark(ws: string, tagId: number, deleted: boolean): Promise<number> {
    const rows = await db
      .insert(marks)
      .values({
        workspaceId: ws,
        tagId,
        type: 'text',
        url: '',
        content: 'seed',
        deletedAt: deleted ? new Date() : null,
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

  async function readActivityEvents(ws: string) {
    return db.select().from(activityEvents).where(eq(activityEvents.workspaceId, ws));
  }

  describe('marks.create', () => {
    it('writes the mark, its tag links, and a derived activity event', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const extra = await seedTag(workspaceId, 'Other');
      const result = await run(marksCreate.handle, {
        kind: 'marks.create',
        mark: { tagId: primary, type: 'text', content: 'body', desc: 'summary', url: '' },
        tagIds: [extra, primary, extra],
      });
      expect(result.affected).toBe(1);
      expect(result.version).toBe(1);
      const created = await readMark(result.id as number);
      expect(created.tagId).toBe(primary);
      expect(created.type).toBe('text');
      expect(created.content).toBe('body');
      expect(created.desc).toBe('summary');
      expect(created.deletedAt).toBeNull();
      expect(created.sourceId).toBeTruthy();
      expect(created.tagUpdatedAt).not.toBeNull();
      expect(await readMarkTagIds(created.id)).toEqual([primary, extra].sort((a, b) => a - b));
      const events = await readActivityEvents(workspaceId);
      expect(events).toHaveLength(1);
      expect(events[0].source).toBe('record');
      expect(events[0].title).toBe('summary');
      expect(events[0].description).toBe('summary');
      expect(events[0].tagId).toBe(primary);
      expect(events[0].dedupeKey).toBe(`record:${created.id}`);
    });

    it('defaults tagIds to the primary tag and derives the preview from content', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const result = await run(marksCreate.handle, {
        kind: 'marks.create',
        mark: { tagId: primary, type: 'link', content: '  hello   world  ', url: 'https://example.invalid' },
      });
      expect(await readMarkTagIds(result.id as number)).toEqual([primary]);
      const events = await readActivityEvents(workspaceId);
      expect(events[0].title).toBe('hello world');
    });

    it('falls back to the mark type when desc, content, and url are empty', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      await run(marksCreate.handle, {
        kind: 'marks.create',
        mark: { tagId: primary, type: 'todo', url: '' },
      });
      const events = await readActivityEvents(workspaceId);
      expect(events[0].title).toBe('todo');
      expect(events[0].description).toBe('todo');
    });

    it('truncates a long derived preview to 140 characters plus an ellipsis', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      await run(marksCreate.handle, {
        kind: 'marks.create',
        mark: { tagId: primary, type: 'text', desc: 'x'.repeat(200), url: '' },
      });
      const events = await readActivityEvents(workspaceId);
      expect(events[0].title.length).toBe(142);
      expect(events[0].title.endsWith('...')).toBe(true);
    });

    it('uses a supplied activity title and description', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      await run(marksCreate.handle, {
        kind: 'marks.create',
        mark: { tagId: primary, type: 'text', desc: 'ignored', url: '' },
        activity: { title: 'Custom', description: 'detail' },
      });
      const events = await readActivityEvents(workspaceId);
      expect(events[0].title).toBe('Custom');
      expect(events[0].description).toBe('detail');
    });

    it('returns the existing mark for a repeated sourceId without writing', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const first = await run(marksCreate.handle, {
        kind: 'marks.create',
        mark: { tagId: primary, type: 'text', content: 'first', url: '', sourceId: 'ext-1' },
      });
      const second = await run(marksCreate.handle, {
        kind: 'marks.create',
        mark: { tagId: primary, type: 'text', content: 'second', url: '', sourceId: 'ext-1' },
      });
      expect(second).toEqual({ affected: 0, id: first.id, version: 1 });
      const stored = await readMark(first.id as number);
      expect(stored.content).toBe('first');
      expect(await readActivityEvents(workspaceId)).toHaveLength(1);
    });

    it('scopes sourceId uniqueness to the workspace', async () => {
      const mine = await seedTag(workspaceId, 'Idea');
      const theirs = await seedTag(otherWorkspaceId, 'Idea');
      const first = await run(marksCreate.handle, {
        kind: 'marks.create',
        mark: { tagId: mine, type: 'text', url: '', sourceId: 'shared' },
      });
      const second = await run(
        marksCreate.handle,
        {
          kind: 'marks.create',
          mark: { tagId: theirs, type: 'text', url: '', sourceId: 'shared' },
        },
        otherWorkspaceId,
      );
      expect(second.affected).toBe(1);
      expect(second.id).not.toBe(first.id);
    });

    it('rejects unknown and foreign tags with tag_not_found', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const foreign = await seedTag(otherWorkspaceId, 'Foreign');
      await expectApiErrorAsync(
        run(marksCreate.handle, {
          kind: 'marks.create',
          mark: { tagId: 987654321, type: 'text', url: '' },
        }),
        400,
        'tag_not_found',
      );
      await expectApiErrorAsync(
        run(marksCreate.handle, {
          kind: 'marks.create',
          mark: { tagId: primary, type: 'text', url: '' },
          tagIds: [foreign],
        }),
        400,
        'tag_not_found',
      );
      await expectApiErrorAsync(
        run(marksCreate.handle, {
          kind: 'marks.create',
          mark: { tagId: foreign, type: 'text', url: '' },
        }),
        400,
        'tag_not_found',
      );
    });
  });

  describe('marks.update', () => {
    it('patches fields, bumps the version, and preserves createdAt', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const id = await seedMark(workspaceId, primary, false);
      const before = await readMark(id);
      const result = await run(marksUpdate.handle, {
        kind: 'marks.update',
        id,
        patch: { content: 'new', url: 'https://example.invalid', type: 'link' },
        expected: { version: before.version },
      });
      expect(result).toEqual({ affected: 1, id, version: before.version + 1 });
      const after = await readMark(id);
      expect(after.content).toBe('new');
      expect(after.url).toBe('https://example.invalid');
      expect(after.type).toBe('link');
      expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
      expect(after.tagId).toBe(primary);
    });

    it('clears content and desc with null', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const id = await seedMark(workspaceId, primary, false);
      await run(marksUpdate.handle, { kind: 'marks.update', id, patch: { content: null, desc: null } });
      const after = await readMark(id);
      expect(after.content).toBeNull();
      expect(after.desc).toBeNull();
    });

    it('answers 409 on a stale guard and writes nothing', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const id = await seedMark(workspaceId, primary, false);
      const before = await readMark(id);
      const error = await expectApiErrorAsync(
        run(marksUpdate.handle, {
          kind: 'marks.update',
          id,
          patch: { content: 'lost' },
          expected: { version: before.version + 5 },
        }),
        409,
        'revision_conflict',
      );
      expect(error.details).toMatchObject({ currentVersion: before.version });
      const after = await readMark(id);
      expect(after.content).toBe('seed');
      expect(after.version).toBe(before.version);
    });

    it('reports affected 0 for an empty patch without bumping the version', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const id = await seedMark(workspaceId, primary, false);
      const before = await readMark(id);
      const result = await run(marksUpdate.handle, { kind: 'marks.update', id, patch: {} });
      expect(result).toEqual({ affected: 0, id, version: before.version });
      await expectApiErrorAsync(
        run(marksUpdate.handle, {
          kind: 'marks.update',
          id,
          patch: {},
          expected: { version: before.version + 1 },
        }),
        409,
        'revision_conflict',
      );
    });

    it('answers 404 for missing, foreign, and soft-deleted marks', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const mine = await seedMark(workspaceId, primary, false);
      const deleted = await seedMark(workspaceId, primary, true);
      await expectApiErrorAsync(
        run(marksUpdate.handle, { kind: 'marks.update', id: 987654321, patch: { content: 'x' } }),
        404,
        'not_found',
      );
      await expectApiErrorAsync(
        run(marksUpdate.handle, { kind: 'marks.update', id: mine, patch: { content: 'x' } }, otherWorkspaceId),
        404,
        'not_found',
      );
      await expectApiErrorAsync(
        run(marksUpdate.handle, { kind: 'marks.update', id: deleted, patch: { content: 'x' } }),
        404,
        'not_found',
      );
    });

    it('moves the primary tag while additional tags survive', async () => {
      const oldPrimary = await seedTag(workspaceId, 'Old');
      const extra = await seedTag(workspaceId, 'Extra');
      const next = await seedTag(workspaceId, 'Next');
      const id = await seedMark(workspaceId, oldPrimary, false);
      await seedLinks(workspaceId, id, [oldPrimary, extra]);
      const result = await run(marksUpdate.handle, {
        kind: 'marks.update',
        id,
        patch: { tagId: next },
      });
      expect(result.affected).toBe(1);
      const after = await readMark(id);
      expect(after.tagId).toBe(next);
      expect(after.tagUpdatedAt).not.toBeNull();
      expect(await readMarkTagIds(id)).toEqual([oldPrimary, extra, next].sort((a, b) => a - b));
    });

    it('keeps the tag set untouched when the patch names the current primary', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const id = await seedMark(workspaceId, primary, false);
      await seedLinks(workspaceId, id, [primary]);
      await run(marksUpdate.handle, { kind: 'marks.update', id, patch: { tagId: primary } });
      const after = await readMark(id);
      expect(after.tagUpdatedAt).toBeNull();
      expect(await readMarkTagIds(id)).toEqual([primary]);
    });

    it('rejects a move to an unknown tag with tag_not_found and writes nothing', async () => {
      const primary = await seedTag(workspaceId, 'Idea');
      const foreign = await seedTag(otherWorkspaceId, 'Foreign');
      const id = await seedMark(workspaceId, primary, false);
      const before = await readMark(id);
      await expectApiErrorAsync(
        run(marksUpdate.handle, { kind: 'marks.update', id, patch: { tagId: 987654321 } }),
        400,
        'tag_not_found',
      );
      await expectApiErrorAsync(
        run(marksUpdate.handle, { kind: 'marks.update', id, patch: { tagId: foreign } }),
        400,
        'tag_not_found',
      );
      const after = await readMark(id);
      expect(after.tagId).toBe(primary);
      expect(after.version).toBe(before.version);
    });
  });
});
