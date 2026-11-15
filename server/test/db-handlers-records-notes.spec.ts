// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the records notes and activity db handlers
// (notes.insert, notes.latestByTag, activity.list, activity.insert).
//
// The validation suite always runs and needs no database. The live
// suite runs against real Postgres with the versioned migrations
// when RECORDS_NOTES_DATABASE_URL is set, for example:
//
//   RECORDS_NOTES_DATABASE_URL=postgres://postgres@127.0.0.1:55434/records_notes
//
// The setup creates the database when it does not exist, applies the
// versioned migrations, and seeds one user plus one fresh workspace
// pair per test (deleted afterwards, so domain rows cascade away).
// When the variable is unset the live suite is skipped and the skip
// is reported honestly. Seeding writes rows directly through
// Drizzle; handler behavior is always exercised through the handler
// modules, inside one Drizzle transaction per call, the way the
// route layer calls them.

import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApiError } from '../src/plugins/envelope.js';
import {
  activityEvents,
  createDb,
  notes,
  tags,
  users,
  workspaces,
  type Database,
} from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  HANDLER_KIND as ACTIVITY_INSERT_KIND,
  handle as handleActivityInsert,
  validate as validateActivityInsert,
} from '../src/services/db/activity-insert.js';
import {
  HANDLER_KIND as ACTIVITY_LIST_KIND,
  handle as handleActivityList,
  validate as validateActivityList,
} from '../src/services/db/activity-list.js';
import {
  HANDLER_KIND as NOTES_INSERT_KIND,
  handle as handleNotesInsert,
  validate as validateNotesInsert,
} from '../src/services/db/notes-insert.js';
import {
  HANDLER_KIND as NOTES_LATEST_KIND,
  handle as handleNotesLatestByTag,
  validate as validateNotesLatestByTag,
} from '../src/services/db/notes-latest-by-tag.js';

function expectValidationError(fn: () => unknown, field: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.statusCode).toBe(400);
    expect(apiError.code).toBe('validation_failed');
    const fields = apiError.details.fields as Array<{ field: string }> | undefined;
    expect(fields).toBeDefined();
    expect(fields?.some((entry) => entry.field === field)).toBe(true);
    return;
  }
  throw new Error(`expected validation_failed for field ${field}, but nothing was thrown`);
}

function expectApiError(fn: () => unknown, statusCode: number, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.statusCode).toBe(statusCode);
    expect(apiError.code).toBe(code);
    return;
  }
  throw new Error(`expected ApiError ${statusCode} ${code}, but nothing was thrown`);
}

async function expectApiErrorAsync(
  promise: Promise<unknown>,
  statusCode: number,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.statusCode).toBe(statusCode);
    expect(apiError.code).toBe(code);
    return;
  }
  throw new Error(`expected ApiError ${statusCode} ${code}, but nothing was thrown`);
}

describe('records notes and activity handler markers', () => {
  it('carries the exact catalog kind literals', () => {
    expect(NOTES_INSERT_KIND).toBe('notes.insert');
    expect(NOTES_LATEST_KIND).toBe('notes.latestByTag');
    expect(ACTIVITY_LIST_KIND).toBe('activity.list');
    expect(ACTIVITY_INSERT_KIND).toBe('activity.insert');
  });
});

describe('notes.latestByTag validation', () => {
  it('accepts a well-formed operation', () => {
    expect(() => validateNotesLatestByTag({ kind: 'notes.latestByTag', tagId: 7 })).not.toThrow();
  });

  it('rejects a non-object operation', () => {
    expectValidationError(() => validateNotesLatestByTag(null), 'operation');
  });

  it('rejects unknown fields', () => {
    expectValidationError(
      () => validateNotesLatestByTag({ kind: 'notes.latestByTag', tagId: 7, limit: 5 }),
      'limit',
    );
  });

  it('rejects a mismatched kind', () => {
    expectValidationError(
      () => validateNotesLatestByTag({ kind: 'notes.insert', tagId: 7 }),
      'kind',
    );
  });

  it('rejects a non-integer tagId', () => {
    expectValidationError(
      () => validateNotesLatestByTag({ kind: 'notes.latestByTag', tagId: '7' }),
      'tagId',
    );
    expectValidationError(
      () => validateNotesLatestByTag({ kind: 'notes.latestByTag', tagId: 1.5 }),
      'tagId',
    );
  });

  it('rejects a missing tagId', () => {
    expectValidationError(() => validateNotesLatestByTag({ kind: 'notes.latestByTag' }), 'tagId');
  });
});

describe('notes.insert validation', () => {
  const valid = () => ({
    kind: 'notes.insert',
    note: { tagId: 3, content: 'hello', locale: 'en', count: '2' },
  });

  it('accepts a well-formed operation', () => {
    expect(() => validateNotesInsert(valid())).not.toThrow();
  });

  it('accepts a note without content', () => {
    const op = valid();
    delete (op.note as { content?: string }).content;
    expect(() => validateNotesInsert(op)).not.toThrow();
  });

  it('rejects unknown top-level fields', () => {
    expectValidationError(
      () => validateNotesInsert({ ...valid(), extra: 1 }),
      'extra',
    );
  });

  it('rejects unknown note fields, including createdAt', () => {
    expectValidationError(
      () => validateNotesInsert({ kind: 'notes.insert', note: { ...valid().note, createdAt: 1 } }),
      'note.createdAt',
    );
  });

  it('rejects a non-object note', () => {
    expectValidationError(() => validateNotesInsert({ kind: 'notes.insert', note: 'x' }), 'note');
  });

  it('rejects a non-integer tagId', () => {
    expectValidationError(
      () =>
        validateNotesInsert({
          kind: 'notes.insert',
          note: { tagId: 1.5, locale: 'en', count: '1' },
        }),
      'note.tagId',
    );
  });

  it('rejects a non-string locale or count', () => {
    expectValidationError(
      () =>
        validateNotesInsert({
          kind: 'notes.insert',
          note: { tagId: 1, locale: 9, count: '1' },
        }),
      'note.locale',
    );
    expectValidationError(
      () =>
        validateNotesInsert({
          kind: 'notes.insert',
          note: { tagId: 1, locale: 'en', count: 9 },
        }),
      'note.count',
    );
  });

  it('rejects a mismatched kind', () => {
    expectValidationError(
      () => validateNotesInsert({ kind: 'notes.latestByTag', note: valid().note }),
      'kind',
    );
  });
});

describe('activity.list validation', () => {
  it('accepts a bare operation', () => {
    expect(() => validateActivityList({ kind: 'activity.list' })).not.toThrow();
  });

  it('accepts every fixed source value', () => {
    for (const source of ['record', 'chat', 'writing', 'canvas']) {
      expect(() => validateActivityList({ kind: 'activity.list', source })).not.toThrow();
    }
  });

  it('rejects an unknown source', () => {
    expectValidationError(
      () => validateActivityList({ kind: 'activity.list', source: 'sync' }),
      'source',
    );
  });

  it('rejects unknown fields', () => {
    expectValidationError(
      () => validateActivityList({ kind: 'activity.list', tagId: 1 }),
      'tagId',
    );
  });

  it('rejects a mismatched kind', () => {
    expectValidationError(() => validateActivityList({ kind: 'activity.insert' }), 'kind');
  });

  it('rejects malformed cursors with invalid_cursor', () => {
    for (const cursor of ['nope', '12', '12:', ':34', 'a:b', '12:34:56', '-1:5']) {
      expectApiError(
        () => validateActivityList({ kind: 'activity.list', cursor }),
        400,
        'invalid_cursor',
      );
    }
  });

  it('accepts a well-formed cursor', () => {
    expect(() =>
      validateActivityList({ kind: 'activity.list', cursor: '1700000000000:42' }),
    ).not.toThrow();
  });

  it('rejects a bad limit with invalid_limit', () => {
    expectApiError(() => validateActivityList({ kind: 'activity.list', limit: 0 }), 400, 'invalid_limit');
    expectApiError(
      () => validateActivityList({ kind: 'activity.list', limit: -3 }),
      400,
      'invalid_limit',
    );
    expectApiError(
      () => validateActivityList({ kind: 'activity.list', limit: 1.5 }),
      400,
      'invalid_limit',
    );
  });

  it('accepts a limit above the clamp, clamped by the handler', () => {
    expect(() => validateActivityList({ kind: 'activity.list', limit: 500 })).not.toThrow();
  });
});

describe('activity.insert validation', () => {
  const valid = () => ({
    kind: 'activity.insert',
    event: { source: 'record', title: 'saved' },
  });

  it('accepts a minimal event', () => {
    expect(() => validateActivityInsert(valid())).not.toThrow();
  });

  it('accepts a full event with explicit nulls and createdAt', () => {
    expect(() =>
      validateActivityInsert({
        kind: 'activity.insert',
        event: {
          source: 'writing',
          title: 'edited',
          description: null,
          path: 'notes/a.md',
          tagId: null,
          dedupeKey: 'writing:notes/a.md:1',
          createdAt: 1700000000000,
        },
      }),
    ).not.toThrow();
  });

  it('rejects an unknown source', () => {
    expectValidationError(
      () =>
        validateActivityInsert({
          kind: 'activity.insert',
          event: { source: 'sync', title: 'x' },
        }),
      'event.source',
    );
  });

  it('rejects unknown event fields', () => {
    expectValidationError(
      () =>
        validateActivityInsert({
          kind: 'activity.insert',
          event: { source: 'record', title: 'x', workspaceId: 'w' },
        }),
      'event.workspaceId',
    );
  });

  it('rejects a non-object event', () => {
    expectValidationError(
      () => validateActivityInsert({ kind: 'activity.insert', event: null }),
      'event',
    );
  });

  it('rejects a non-string title', () => {
    expectValidationError(
      () =>
        validateActivityInsert({
          kind: 'activity.insert',
          event: { source: 'record', title: 5 },
        }),
      'event.title',
    );
  });

  it('rejects a non-integer tagId or createdAt', () => {
    expectValidationError(
      () =>
        validateActivityInsert({
          kind: 'activity.insert',
          event: { source: 'record', title: 'x', tagId: '3' },
        }),
      'event.tagId',
    );
    expectValidationError(
      () =>
        validateActivityInsert({
          kind: 'activity.insert',
          event: { source: 'record', title: 'x', createdAt: 1.5 },
        }),
      'event.createdAt',
    );
  });

  it('rejects a mismatched kind', () => {
    expectValidationError(
      () => validateActivityInsert({ kind: 'activity.list', event: valid().event }),
      'kind',
    );
  });
});

const LIVE_DATABASE_URL = process.env.RECORDS_NOTES_DATABASE_URL;
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

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

interface Ctx {
  tx: Tx;
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
}

const BASE_TIME = 1_700_000_000_000;

describe.skipIf(LIVE_DATABASE_URL === undefined)(
  'records notes and activity handlers over live Postgres',
  () => {
    let db: Database;
    let close: () => Promise<void>;
    let userId: string;
    let workspaceId: string;
    let otherWorkspaceId: string;
    let tagId: number;
    let otherTagId: number;

    beforeAll(async () => {
      const url = LIVE_DATABASE_URL as string;
      await ensureDatabaseExists(url);
      await runMigrations({ databaseUrl: url });
      const handle = createDb(url, { max: 5 });
      db = handle.db;
      close = handle.close;
      const inserted = await db
        .insert(users)
        .values({ email: `v3b-25f-${Date.now()}`, passwordHash: 'test-only-not-a-secret' })
        .returning({ id: users.id });
      userId = inserted[0].id;
    }, 120_000);

    afterAll(async () => {
      await close();
    });

    beforeEach(async () => {
      const mine = await db
        .insert(workspaces)
        .values({ ownerUserId: userId, name: 'v3b-25f' })
        .returning({ id: workspaces.id });
      workspaceId = mine[0].id;
      const other = await db
        .insert(workspaces)
        .values({ ownerUserId: userId, name: 'v3b-25f-other' })
        .returning({ id: workspaces.id });
      otherWorkspaceId = other[0].id;
      const mineTag = await db
        .insert(tags)
        .values({ workspaceId, name: 'Idea' })
        .returning({ id: tags.id });
      tagId = mineTag[0].id;
      const otherTag = await db
        .insert(tags)
        .values({ workspaceId: otherWorkspaceId, name: 'Idea' })
        .returning({ id: tags.id });
      otherTagId = otherTag[0].id;
    });

    afterEach(async () => {
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(workspaces).where(eq(workspaces.id, otherWorkspaceId));
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

    it('notes.insert stores a note and latestByTag returns it', async () => {
      const written = await run(handleNotesInsert, {
        kind: 'notes.insert',
        note: { tagId, content: 'first', locale: 'en', count: '3' },
      });
      expect(written.affected).toBe(1);
      expect(typeof written.id).toBe('number');

      const rows = await run(handleNotesLatestByTag, { kind: 'notes.latestByTag', tagId });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(written.id);
      expect(rows[0].tagId).toBe(tagId);
      expect(rows[0].content).toBe('first');
      expect(rows[0].locale).toBe('en');
      expect(rows[0].count).toBe('3');
      expect(rows[0].createdAt).toBeGreaterThan(0);
    });

    it('notes.insert without content stores a null content and the row omits it', async () => {
      await run(handleNotesInsert, {
        kind: 'notes.insert',
        note: { tagId, locale: 'id', count: '1' },
      });
      const rows = await run(handleNotesLatestByTag, { kind: 'notes.latestByTag', tagId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('content');
      const stored = await db.select().from(notes).where(eq(notes.tagId, tagId));
      expect(stored).toHaveLength(1);
      expect(stored[0].content).toBeNull();
    });

    it('notes.insert is a pure insert: several notes per tag coexist, newest wins', async () => {
      await run(handleNotesInsert, {
        kind: 'notes.insert',
        note: { tagId, content: 'old', locale: 'en', count: '1' },
      });
      const second = await run(handleNotesInsert, {
        kind: 'notes.insert',
        note: { tagId, content: 'new', locale: 'en', count: '2' },
      });
      expect(second.affected).toBe(1);
      const stored = await db.select().from(notes).where(eq(notes.tagId, tagId));
      expect(stored).toHaveLength(2);
      const rows = await run(handleNotesLatestByTag, { kind: 'notes.latestByTag', tagId });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(second.id);
      expect(rows[0].content).toBe('new');
    });

    it('notes.latestByTag answers empty when the tag has no note', async () => {
      const rows = await run(handleNotesLatestByTag, { kind: 'notes.latestByTag', tagId });
      expect(rows).toEqual([]);
    });

    it('notes.latestByTag never returns another workspace note', async () => {
      await run(
        handleNotesInsert,
        {
          kind: 'notes.insert',
          note: { tagId: otherTagId, content: 'other', locale: 'en', count: '1' },
        },
        otherWorkspaceId,
      );
      const rows = await run(handleNotesLatestByTag, {
        kind: 'notes.latestByTag',
        tagId: otherTagId,
      });
      expect(rows).toEqual([]);
    });

    it('notes.insert answers 404 for a missing tag and for another workspace tag', async () => {
      await expectApiErrorAsync(
        run(handleNotesInsert, {
          kind: 'notes.insert',
          note: { tagId: 999_999_999, locale: 'en', count: '1' },
        }),
        404,
        'not_found',
      );
      await expectApiErrorAsync(
        run(handleNotesInsert, {
          kind: 'notes.insert',
          note: { tagId: otherTagId, locale: 'en', count: '1' },
        }),
        404,
        'not_found',
      );
    });

    it('activity.insert stores an event and activity.list returns it', async () => {
      const written = await run(handleActivityInsert, {
        kind: 'activity.insert',
        event: {
          source: 'record',
          title: 'saved a mark',
          description: 'preview',
          path: null,
          tagId,
          dedupeKey: 'record:1',
          createdAt: BASE_TIME,
        },
      });
      expect(written).toEqual({ affected: 1, id: expect.any(Number) });

      const rows = await run(handleActivityList, { kind: 'activity.list' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(written.id);
      expect(rows[0].source).toBe('record');
      expect(rows[0].title).toBe('saved a mark');
      expect(rows[0].description).toBe('preview');
      expect(rows[0].path).toBeNull();
      expect(rows[0].tagId).toBe(tagId);
      expect(rows[0].dedupeKey).toBe('record:1');
      expect(rows[0].createdAt).toBe(BASE_TIME);
    });

    it('activity.insert defaults createdAt to now when omitted', async () => {
      const before = Date.now();
      await run(handleActivityInsert, {
        kind: 'activity.insert',
        event: { source: 'chat', title: 'chatted' },
      });
      const after = Date.now();
      const rows = await run(handleActivityList, { kind: 'activity.list' });
      expect(rows).toHaveLength(1);
      expect(rows[0].createdAt).toBeGreaterThanOrEqual(before);
      expect(rows[0].createdAt).toBeLessThanOrEqual(after);
    });

    it('activity.insert dedupes on dedupeKey within one workspace', async () => {
      const first = await run(handleActivityInsert, {
        kind: 'activity.insert',
        event: { source: 'record', title: 'first', dedupeKey: 'dup:1', createdAt: BASE_TIME },
      });
      expect(first.affected).toBe(1);
      const second = await run(handleActivityInsert, {
        kind: 'activity.insert',
        event: { source: 'record', title: 'repeat', dedupeKey: 'dup:1', createdAt: BASE_TIME + 1 },
      });
      expect(second).toEqual({ affected: 0 });
      const rows = await run(handleActivityList, { kind: 'activity.list' });
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('first');

      const other = await run(
        handleActivityInsert,
        {
          kind: 'activity.insert',
          event: { source: 'record', title: 'other ws', dedupeKey: 'dup:1' },
        },
        otherWorkspaceId,
      );
      expect(other.affected).toBe(1);
    });

    it('activity.insert with a null dedupeKey always inserts', async () => {
      for (const title of ['one', 'two']) {
        const written = await run(handleActivityInsert, {
          kind: 'activity.insert',
          event: { source: 'canvas', title, dedupeKey: null },
        });
        expect(written.affected).toBe(1);
      }
      const rows = await run(handleActivityList, { kind: 'activity.list' });
      expect(rows).toHaveLength(2);
    });

    it('activity.insert answers 404 for a missing tag and for another workspace tag', async () => {
      await expectApiErrorAsync(
        run(handleActivityInsert, {
          kind: 'activity.insert',
          event: { source: 'record', title: 'x', tagId: 999_999_999 },
        }),
        404,
        'not_found',
      );
      await expectApiErrorAsync(
        run(handleActivityInsert, {
          kind: 'activity.insert',
          event: { source: 'record', title: 'x', tagId: otherTagId },
        }),
        404,
        'not_found',
      );
      const stored = await db.select().from(activityEvents);
      expect(stored).toHaveLength(0);
    });

    it('activity.list orders by createdAt descending, newest first', async () => {
      await run(handleActivityInsert, {
        kind: 'activity.insert',
        event: { source: 'record', title: 'oldest', createdAt: BASE_TIME },
      });
      await run(handleActivityInsert, {
        kind: 'activity.insert',
        event: { source: 'chat', title: 'newest', createdAt: BASE_TIME + 2000 },
      });
      await run(handleActivityInsert, {
        kind: 'activity.insert',
        event: { source: 'writing', title: 'middle', createdAt: BASE_TIME + 1000 },
      });
      const rows = await run(handleActivityList, { kind: 'activity.list' });
      expect(rows.map((row) => row.title)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('activity.list filters by source', async () => {
      await run(handleActivityInsert, {
        kind: 'activity.insert',
        event: { source: 'record', title: 'a', createdAt: BASE_TIME },
      });
      await run(handleActivityInsert, {
        kind: 'activity.insert',
        event: { source: 'chat', title: 'b', createdAt: BASE_TIME + 1 },
      });
      await run(handleActivityInsert, {
        kind: 'activity.insert',
        event: { source: 'record', title: 'c', createdAt: BASE_TIME + 2 },
      });
      const rows = await run(handleActivityList, { kind: 'activity.list', source: 'record' });
      expect(rows.map((row) => row.title)).toEqual(['c', 'a']);
    });

    it('activity.list pages with a cursor across out-of-order createdAt values', async () => {
      const stamps = [BASE_TIME + 3000, BASE_TIME, BASE_TIME + 2000, BASE_TIME + 1000, BASE_TIME + 4000];
      for (let i = 0; i < stamps.length; i += 1) {
        await run(handleActivityInsert, {
          kind: 'activity.insert',
          event: { source: 'record', title: `e${i}`, createdAt: stamps[i] },
        });
      }
      const full = await run(handleActivityList, { kind: 'activity.list' });
      expect(full).toHaveLength(5);
      const seen: number[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 3; page += 1) {
        const rows = await run(handleActivityList, {
          kind: 'activity.list',
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const row of rows) {
          seen.push(row.id);
        }
        if (rows.length < 2) {
          break;
        }
        const last = rows[rows.length - 1];
        cursor = `${last.createdAt}:${last.id}`;
      }
      expect(seen).toEqual(full.map((row) => row.id));
    });

    it('activity.list honors limit and never returns another workspace events', async () => {
      for (let i = 0; i < 3; i += 1) {
        await run(handleActivityInsert, {
          kind: 'activity.insert',
          event: { source: 'record', title: `mine-${i}`, createdAt: BASE_TIME + i },
        });
      }
      await run(
        handleActivityInsert,
        {
          kind: 'activity.insert',
          event: { source: 'record', title: 'other', createdAt: BASE_TIME + 99 },
        },
        otherWorkspaceId,
      );
      const rows = await run(handleActivityList, { kind: 'activity.list', limit: 2 });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.title)).toEqual(['mine-2', 'mine-1']);
    });
  },
);
