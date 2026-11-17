// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the tags write handler kinds (v3b-25e, V3-25, wave 3B;
// tags.delete and tags.reorder added by W4-CODEMOD, wave 4):
// tags.create, tags.rename, tags.delete, and tags.reorder.
//
// Validation and name-normalization tests run always, without a
// database: the handlers take a Drizzle transaction, and there is no
// fake transaction in the V3-13b/c precedent, so the no-database
// section covers the pure surface (validate + normalizeTagName) and
// the database section covers handle() against live Postgres.
//
// Database tests run only when TAGS_WRITE_DATABASE_URL is set. They
// seed one user in that database, use a fresh workspace per test,
// exercise the handlers through db.transaction, and remove the seeded
// rows afterwards. The database must already carry migrations M1-M8.
// Scratch setup (own database, never a shared one):
//   psql <admin> -c "DROP DATABASE IF EXISTS v3b_25e_db;" -c "CREATE DATABASE v3b_25e_db;"
//   DATABASE_URL=postgres://postgres@127.0.0.1:55433/v3b_25e_db node <m8gate-runner> migrate
//   TAGS_WRITE_DATABASE_URL=postgres://postgres@127.0.0.1:55433/v3b_25e_db pnpm --dir server exec vitest run test/db-handlers-records-tagswrite.spec.ts
//
// Env var name: TAGS_WRITE_DATABASE_URL. It is the only gate for the
// live section; without it the live tests report as skipped.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApiError } from '../src/plugins/envelope.js';
import {
  createDb,
  marks,
  markTags,
  notes,
  tags,
  users,
  workspaceMembers,
  workspaces,
  type Database,
  type DbHandle,
} from '../src/db/index.js';
import * as tagsCreate from '../src/services/db/tags-create.js';
import * as tagsDelete from '../src/services/db/tags-delete.js';
import * as tagsRename from '../src/services/db/tags-rename.js';
import * as tagsReorder from '../src/services/db/tags-reorder.js';

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

async function expectHandleError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<ApiError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  return expectApiError(caught, status, code);
}

describe('tags write validation (no database)', () => {
  it('accepts valid create and rename operations', () => {
    expect(() => tagsCreate.validate({ kind: 'tags.create', name: 'Work' })).not.toThrow();
    expect(() =>
      tagsRename.validate({ kind: 'tags.rename', id: 1, name: 'Work', isPin: true, sortOrder: 2 }),
    ).not.toThrow();
    expect(() => tagsRename.validate({ kind: 'tags.rename', id: 1, name: 'Work' })).not.toThrow();
  });

  it('rejects unknown fields, a wrong kind, and a non-object operation', () => {
    expect(() => tagsCreate.validate({ kind: 'tags.create', name: 'A', extra: 1 })).toThrow(ApiError);
    expect(() => tagsCreate.validate({ kind: 'tags.rename', name: 'A' })).toThrow(ApiError);
    expect(() => tagsCreate.validate(null)).toThrow(ApiError);
    expect(() =>
      tagsRename.validate({ kind: 'tags.rename', id: 1, name: 'A', isLocked: true }),
    ).toThrow(ApiError);
    expect(() => tagsRename.validate({ kind: 'tags.create', id: 1, name: 'A' })).toThrow(ApiError);
  });

  it('rejects a non-string, empty, or empty-segment create name', () => {
    for (const name of [42, '', '   ', '#', 'a//b', '/a', 'a/', '/']) {
      expect(() => tagsCreate.validate({ kind: 'tags.create', name })).toThrow(ApiError);
    }
    expect(() => tagsCreate.validate({ kind: 'tags.create' })).toThrow(ApiError);
  });

  it('rejects an over-long or control-character name in both kinds', () => {
    const longName = 'a'.repeat(101);
    expect(() => tagsCreate.validate({ kind: 'tags.create', name: longName })).toThrow(ApiError);
    expect(() => tagsRename.validate({ kind: 'tags.rename', id: 1, name: longName })).toThrow(
      ApiError,
    );
    expect(() => tagsCreate.validate({ kind: 'tags.create', name: 'a\tb' })).toThrow(ApiError);
    expect(() => tagsRename.validate({ kind: 'tags.rename', id: 1, name: 'a\nb' })).toThrow(
      ApiError,
    );
    expect(() => tagsCreate.validate({ kind: 'tags.create', name: 'a'.repeat(100) })).not.toThrow();
  });

  it('rejects a non-integer id and non-boolean/non-integer optionals in rename', () => {
    expect(() => tagsRename.validate({ kind: 'tags.rename', id: 1.5, name: 'A' })).toThrow(ApiError);
    expect(() => tagsRename.validate({ kind: 'tags.rename', id: '1', name: 'A' })).toThrow(ApiError);
    expect(() =>
      tagsRename.validate({ kind: 'tags.rename', id: 1, name: 'A', isPin: 'yes' }),
    ).toThrow(ApiError);
    expect(() =>
      tagsRename.validate({ kind: 'tags.rename', id: 1, name: 'A', sortOrder: 1.5 }),
    ).toThrow(ApiError);
  });

  it('normalizes names identically in both handlers, like upstream normalizeTagName', () => {
    const cases: Array<[string, string | null]> = [
      ['Work', 'Work'],
      ['  Work  ', 'Work'],
      ['#Work', 'Work'],
      ['##Work', '#Work'],
      [' a / b ', 'a/b'],
      ['a/b/c', 'a/b/c'],
      ['', null],
      ['   ', null],
      ['#', null],
      ['a//b', null],
      ['/a', null],
      ['a/', null],
      ['/', null],
    ];
    for (const [input, expected] of cases) {
      expect(tagsCreate.normalizeTagName(input)).toBe(expected);
      expect(tagsRename.normalizeTagName(input)).toBe(expected);
    }
  });

  it('accepts valid delete and reorder operations', () => {
    expect(() => tagsDelete.validate({ kind: 'tags.delete', id: 1 })).not.toThrow();
    expect(() =>
      tagsDelete.validate({ kind: 'tags.delete', id: 1, reassignTo: 2 }),
    ).not.toThrow();
    expect(() => tagsReorder.validate({ kind: 'tags.reorder', order: [] })).not.toThrow();
    expect(() =>
      tagsReorder.validate({
        kind: 'tags.reorder',
        order: [
          { id: 1, sortOrder: 0 },
          { id: 2, sortOrder: 1 },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects unknown fields, a wrong kind, and a non-object delete/reorder operation', () => {
    expect(() => tagsDelete.validate({ kind: 'tags.delete', id: 1, extra: 1 })).toThrow(ApiError);
    expect(() => tagsDelete.validate({ kind: 'tags.reorder', id: 1 })).toThrow(ApiError);
    expect(() => tagsDelete.validate(null)).toThrow(ApiError);
    expect(() => tagsReorder.validate({ kind: 'tags.reorder', order: [], extra: 1 })).toThrow(
      ApiError,
    );
    expect(() => tagsReorder.validate({ kind: 'tags.delete', order: [] })).toThrow(ApiError);
    expect(() => tagsReorder.validate('tags.reorder')).toThrow(ApiError);
  });

  it('rejects a non-integer delete id/reassignTo and a self reassignTo', () => {
    expect(() => tagsDelete.validate({ kind: 'tags.delete', id: 1.5 })).toThrow(ApiError);
    expect(() => tagsDelete.validate({ kind: 'tags.delete', id: '1' })).toThrow(ApiError);
    expect(() => tagsDelete.validate({ kind: 'tags.delete' })).toThrow(ApiError);
    expect(() => tagsDelete.validate({ kind: 'tags.delete', id: 1, reassignTo: 1.5 })).toThrow(
      ApiError,
    );
    expect(() => tagsDelete.validate({ kind: 'tags.delete', id: 1, reassignTo: 1 })).toThrow(
      ApiError,
    );
  });

  it('rejects a non-array reorder list and malformed or duplicate entries', () => {
    expect(() => tagsReorder.validate({ kind: 'tags.reorder', order: 'x' })).toThrow(ApiError);
    expect(() => tagsReorder.validate({ kind: 'tags.reorder' })).toThrow(ApiError);
    expect(() => tagsReorder.validate({ kind: 'tags.reorder', order: [7] })).toThrow(ApiError);
    expect(() =>
      tagsReorder.validate({ kind: 'tags.reorder', order: [{ id: 1, sortOrder: 0, name: 'A' }] }),
    ).toThrow(ApiError);
    expect(() =>
      tagsReorder.validate({ kind: 'tags.reorder', order: [{ id: 1.5, sortOrder: 0 }] }),
    ).toThrow(ApiError);
    expect(() =>
      tagsReorder.validate({ kind: 'tags.reorder', order: [{ id: 1, sortOrder: 0.5 }] }),
    ).toThrow(ApiError);
    expect(() =>
      tagsReorder.validate({
        kind: 'tags.reorder',
        order: [
          { id: 1, sortOrder: 0 },
          { id: 1, sortOrder: 1 },
        ],
      }),
    ).toThrow(ApiError);
  });
});

const DATABASE_URL = process.env['TAGS_WRITE_DATABASE_URL'];
const dbDescribe = DATABASE_URL === undefined ? describe.skip : describe;

dbDescribe('tags write handlers against Postgres', () => {
  let db: Database;
  let handle: DbHandle;
  let userId = '';
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    handle = createDb(DATABASE_URL as string, { max: 5 });
    db = handle.db;
    const userRows = await db
      .insert(users)
      .values({ email: `v3b25e-${randomUUID()}`, passwordHash: 'test-hash' })
      .returning({ id: users.id });
    userId = userRows[0]?.id as string;
  });

  afterAll(async () => {
    for (const id of workspaceIds) {
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
    await db.delete(users).where(eq(users.id, userId));
    await handle.close();
  });

  async function freshWorkspace(): Promise<string> {
    const rows = await db
      .insert(workspaces)
      .values({ ownerUserId: userId, name: `v3b25e-${randomUUID()}` })
      .returning({ id: workspaces.id });
    const id = rows[0]?.id as string;
    await db.insert(workspaceMembers).values({ workspaceId: id, userId, role: 'owner' });
    workspaceIds.push(id);
    return id;
  }

  async function run<T>(
    handler: { handle: (ctx: Ctx, op: unknown) => Promise<T> },
    op: unknown,
    ws: string,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      return handler.handle(
        { tx, workspaceId: ws, userId, requestId: 'v3b25e-test', transactionId: null },
        op,
      );
    });
  }

  async function listTags(ws: string) {
    return db.select().from(tags).where(eq(tags.workspaceId, ws)).orderBy(tags.id);
  }

  async function makeTag(ws: string, name: string): Promise<number> {
    const result = await run(tagsCreate, { kind: 'tags.create', name }, ws);
    return result.id as number;
  }

  async function makeLockedTag(ws: string, name: string): Promise<number> {
    const rows = await db
      .insert(tags)
      .values({ workspaceId: ws, name, isLocked: true })
      .returning({ id: tags.id });
    return rows[0]?.id as number;
  }

  async function makeMark(
    ws: string,
    tagId: number,
    extraTagIds: number[] = [],
    deleted = false,
  ): Promise<number> {
    const rows = await db
      .insert(marks)
      .values({
        workspaceId: ws,
        tagId,
        type: 'text',
        content: 'tagswrite',
        deletedAt: deleted ? new Date('2026-01-01T00:00:00.000Z') : null,
      })
      .returning({ id: marks.id });
    const id = rows[0]?.id as number;
    const tagIds = [...new Set([tagId, ...extraTagIds])];
    await db
      .insert(markTags)
      .values(tagIds.map((tag) => ({ markId: id, tagId: tag, workspaceId: ws })));
    return id;
  }

  async function readMark(id: number) {
    const rows = await db.select().from(marks).where(eq(marks.id, id)).limit(1);
    return rows[0];
  }

  async function markTagIds(markId: number): Promise<number[]> {
    const rows = await db
      .select({ tagId: markTags.tagId })
      .from(markTags)
      .where(eq(markTags.markId, markId));
    return rows.map((row) => row.tagId).sort((a, b) => a - b);
  }

  async function makeNote(ws: string, tagId: number): Promise<number> {
    const rows = await db
      .insert(notes)
      .values({ workspaceId: ws, tagId, locale: 'en', count: '1' })
      .returning({ id: notes.id });
    return rows[0]?.id as number;
  }

  async function readNote(id: number) {
    const rows = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
    return rows[0];
  }

  it('create: inserts a new tag with defaults and reports affected 1', async () => {
    const ws = await freshWorkspace();
    const result = await run(tagsCreate, { kind: 'tags.create', name: 'Work' }, ws);
    expect(result.affected).toBe(1);
    expect(typeof result.id).toBe('number');
    const rows = await listTags(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Work');
    expect(rows[0]?.isLocked).toBe(false);
    expect(rows[0]?.isPin).toBe(false);
    expect(rows[0]?.sortOrder).toBe(0);
  });

  it('create: a duplicate name answers affected 0 with the existing id', async () => {
    const ws = await freshWorkspace();
    const first = await makeTag(ws, 'Work');
    const second = await run(tagsCreate, { kind: 'tags.create', name: 'Work' }, ws);
    expect(second.affected).toBe(0);
    expect(second.id).toBe(first);
    expect(await listTags(ws)).toHaveLength(1);
  });

  it('create: normalizes the name and deduplicates the normalized form', async () => {
    const ws = await freshWorkspace();
    const first = await run(tagsCreate, { kind: 'tags.create', name: '  #Work / Notes  ' }, ws);
    expect(first.affected).toBe(1);
    expect((await listTags(ws))[0]?.name).toBe('Work/Notes');
    const second = await run(tagsCreate, { kind: 'tags.create', name: 'Work/Notes' }, ws);
    expect(second.affected).toBe(0);
    expect(second.id).toBe(first.id);
  });

  it('create: names are case-sensitive and workspace-scoped', async () => {
    const ws = await freshWorkspace();
    const other = await freshWorkspace();
    const upper = await makeTag(ws, 'Tag');
    const lower = await makeTag(ws, 'tag');
    expect(lower).not.toBe(upper);
    const elsewhere = await run(tagsCreate, { kind: 'tags.create', name: 'Tag' }, other);
    expect(elsewhere.affected).toBe(1);
    expect(elsewhere.id).not.toBe(upper);
    expect(await listTags(ws)).toHaveLength(2);
    expect(await listTags(other)).toHaveLength(1);
  });

  it('create: invalid names answer 400 validation_failed through handle', async () => {
    const ws = await freshWorkspace();
    await expectHandleError(
      run(tagsCreate, { kind: 'tags.create', name: '  ' }, ws),
      400,
      'validation_failed',
    );
    await expectHandleError(
      run(tagsCreate, { kind: 'tags.create', name: 'a'.repeat(101) }, ws),
      400,
      'validation_failed',
    );
    await expectHandleError(
      run(tagsCreate, { kind: 'tags.create', name: 'a//b' }, ws),
      400,
      'validation_failed',
    );
    expect(await listTags(ws)).toHaveLength(0);
  });

  it('rename: renames one tag and reports affected 1', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'Old');
    const result = await run(tagsRename, { kind: 'tags.rename', id, name: 'New' }, ws);
    expect(result).toEqual({ affected: 1, id });
    expect((await listTags(ws))[0]?.name).toBe('New');
  });

  it('rename: renames descendant paths and leaves other tags alone', async () => {
    const ws = await freshWorkspace();
    const parent = await makeTag(ws, 'A');
    await makeTag(ws, 'A/B');
    await makeTag(ws, 'A/B/C');
    await makeTag(ws, 'Other');
    await makeTag(ws, 'Ax');
    const result = await run(tagsRename, { kind: 'tags.rename', id: parent, name: 'Z' }, ws);
    expect(result.affected).toBe(3);
    const names = (await listTags(ws)).map((row) => row.name).sort();
    expect(names).toEqual(['Ax', 'Other', 'Z', 'Z/B', 'Z/B/C']);
  });

  it('rename: normalizes the new name', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'Old');
    await run(tagsRename, { kind: 'tags.rename', id, name: '  #New / Name ' }, ws);
    expect((await listTags(ws))[0]?.name).toBe('New/Name');
  });

  it('rename: pin/order only on an unchanged name writes the target only', async () => {
    const ws = await freshWorkspace();
    const parent = await makeTag(ws, 'A');
    await makeTag(ws, 'A/B');
    const result = await run(
      tagsRename,
      { kind: 'tags.rename', id: parent, name: 'A', isPin: true, sortOrder: 7 },
      ws,
    );
    expect(result.affected).toBe(1);
    const rows = await listTags(ws);
    expect(rows[0]).toMatchObject({ name: 'A', isPin: true, sortOrder: 7 });
    expect(rows[1]).toMatchObject({ name: 'A/B', isPin: false, sortOrder: 0 });
  });

  it('rename: pin/order with a rename apply to the target only', async () => {
    const ws = await freshWorkspace();
    const parent = await makeTag(ws, 'A');
    await makeTag(ws, 'A/B');
    const result = await run(
      tagsRename,
      { kind: 'tags.rename', id: parent, name: 'Z', isPin: true, sortOrder: 3 },
      ws,
    );
    expect(result.affected).toBe(2);
    const rows = await listTags(ws);
    expect(rows.find((row) => row.id === parent)).toMatchObject({
      name: 'Z',
      isPin: true,
      sortOrder: 3,
    });
    expect(rows.find((row) => row.name === 'Z/B')).toMatchObject({ isPin: false, sortOrder: 0 });
  });

  it('rename: the same name with no pin/order is a no-op with affected 0', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    const result = await run(tagsRename, { kind: 'tags.rename', id, name: 'A' }, ws);
    expect(result).toEqual({ affected: 0, id });
  });

  it('rename: an unknown id and a foreign-workspace id answer 404 not_found', async () => {
    const ws = await freshWorkspace();
    const other = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    await expectHandleError(
      run(tagsRename, { kind: 'tags.rename', id: 999_999_999, name: 'B' }, ws),
      404,
      'not_found',
    );
    await expectHandleError(
      run(tagsRename, { kind: 'tags.rename', id, name: 'B' }, other),
      404,
      'not_found',
    );
    expect((await listTags(ws))[0]?.name).toBe('A');
  });

  it('rename: a locked tag cannot change its name, but a pin-only change is allowed', async () => {
    const ws = await freshWorkspace();
    const rows = await db
      .insert(tags)
      .values({ workspaceId: ws, name: 'Locked', isLocked: true })
      .returning({ id: tags.id });
    const id = rows[0]?.id as number;
    await expectHandleError(
      run(tagsRename, { kind: 'tags.rename', id, name: 'Other' }, ws),
      409,
      'tag_locked',
    );
    expect((await listTags(ws))[0]?.name).toBe('Locked');
    const pinOnly = await run(
      tagsRename,
      { kind: 'tags.rename', id, name: 'Locked', isPin: true },
      ws,
    );
    expect(pinOnly.affected).toBe(1);
    expect((await listTags(ws))[0]).toMatchObject({ name: 'Locked', isPin: true });
  });

  it('rename: a name collision answers 409 tag_name_taken and writes nothing', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    await makeTag(ws, 'B');
    await expectHandleError(
      run(tagsRename, { kind: 'tags.rename', id, name: 'B' }, ws),
      409,
      'tag_name_taken',
    );
    const names = (await listTags(ws)).map((row) => row.name).sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('rename: a descendant collision answers 409 and writes nothing', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    await makeTag(ws, 'A/B');
    await makeTag(ws, 'C/B');
    await expectHandleError(
      run(tagsRename, { kind: 'tags.rename', id, name: 'C' }, ws),
      409,
      'tag_name_taken',
    );
    const names = (await listTags(ws)).map((row) => row.name).sort();
    expect(names).toEqual(['A', 'A/B', 'C/B']);
  });

  it('rename: renaming into an own child succeeds via the two-phase rewrite', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    await makeTag(ws, 'A/B');
    const result = await run(tagsRename, { kind: 'tags.rename', id, name: 'A/B' }, ws);
    expect(result.affected).toBe(2);
    const names = (await listTags(ws)).map((row) => row.name).sort();
    expect(names).toEqual(['A/B', 'A/B/B']);
  });

  it('rename: re-applying the same rename is idempotent', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    await makeTag(ws, 'A/B');
    const first = await run(tagsRename, { kind: 'tags.rename', id, name: 'Z' }, ws);
    expect(first.affected).toBe(2);
    const second = await run(tagsRename, { kind: 'tags.rename', id, name: 'Z' }, ws);
    expect(second.affected).toBe(0);
    const names = (await listTags(ws)).map((row) => row.name).sort();
    expect(names).toEqual(['Z', 'Z/B']);
  });

  it('rename: invalid operations answer 400 validation_failed through handle', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    await expectHandleError(
      run(tagsRename, { kind: 'tags.rename', id, name: 'x'.repeat(101) }, ws),
      400,
      'validation_failed',
    );
    await expectHandleError(
      run(tagsRename, { kind: 'tags.rename', id: 1.5, name: 'B' }, ws),
      400,
      'validation_failed',
    );
    expect((await listTags(ws))[0]?.name).toBe('A');
  });

  it('delete: removes an unused tag and reports affected 1', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    await makeTag(ws, 'B');
    const result = await run(tagsDelete, { kind: 'tags.delete', id }, ws);
    expect(result).toEqual({ affected: 1, id });
    expect((await listTags(ws)).map((row) => row.name)).toEqual(['B']);
  });

  it('delete: an unknown id and a foreign-workspace id answer 404 not_found', async () => {
    const ws = await freshWorkspace();
    const other = await freshWorkspace();
    const foreign = await makeTag(other, 'Foreign');
    const own = await makeTag(ws, 'Own');
    await expectHandleError(
      run(tagsDelete, { kind: 'tags.delete', id: 987654321 }, ws),
      404,
      'not_found',
    );
    await expectHandleError(
      run(tagsDelete, { kind: 'tags.delete', id: foreign }, ws),
      404,
      'not_found',
    );
    expect((await listTags(ws)).map((row) => row.name)).toEqual(['Own']);
    expect((await listTags(other)).map((row) => row.name)).toEqual(['Foreign']);
    expect(own).toBeGreaterThan(0);
  });

  it('delete: a locked tag answers 409 tag_locked and stays', async () => {
    const ws = await freshWorkspace();
    const id = await makeLockedTag(ws, 'Idea');
    await expectHandleError(run(tagsDelete, { kind: 'tags.delete', id }, ws), 409, 'tag_locked');
    expect((await listTags(ws)).map((row) => row.name)).toEqual(['Idea']);
  });

  it('delete: a used tag without reassignTo answers 409 tag_in_use with recordCount and writes nothing', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    const other = await makeTag(ws, 'B');
    const first = await makeMark(ws, id);
    const second = await makeMark(ws, other, [id]);
    const error = await expectHandleError(
      run(tagsDelete, { kind: 'tags.delete', id }, ws),
      409,
      'tag_in_use',
    );
    expect(error.details).toEqual({ recordCount: 2 });
    expect((await listTags(ws)).map((row) => row.name).sort()).toEqual(['A', 'B']);
    expect((await readMark(first))?.tagId).toBe(id);
    expect((await readMark(first))?.deletedAt).toBeNull();
    expect(await markTagIds(first)).toEqual([id]);
    expect(await markTagIds(second)).toEqual([id, other].sort((a, b) => a - b));
  });

  it('delete: a soft-deleted mark still counts as use', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    await makeMark(ws, id, [], true);
    const error = await expectHandleError(
      run(tagsDelete, { kind: 'tags.delete', id }, ws),
      409,
      'tag_in_use',
    );
    expect(error.details).toEqual({ recordCount: 1 });
    expect((await listTags(ws)).length).toBe(1);
  });

  it('delete: with reassignTo, primaries and memberships move, duplicates drop, and no record is discarded', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    const target = await makeTag(ws, 'B');
    const extra = await makeTag(ws, 'C');
    const primary = await makeMark(ws, id);
    const member = await makeMark(ws, extra, [id, target]);
    const result = await run(tagsDelete, { kind: 'tags.delete', id, reassignTo: target }, ws);
    expect(result).toEqual({ affected: 1, id });
    expect((await listTags(ws)).map((row) => row.name).sort()).toEqual(['B', 'C']);
    const moved = await readMark(primary);
    expect(moved?.tagId).toBe(target);
    expect(moved?.deletedAt).toBeNull();
    expect(await markTagIds(primary)).toEqual([target]);
    expect((await readMark(member))?.tagId).toBe(extra);
    expect(await markTagIds(member)).toEqual([extra, target].sort((a, b) => a - b));
  });

  it('delete: a missing or foreign reassignTo answers 400 tag_not_found and writes nothing', async () => {
    const ws = await freshWorkspace();
    const other = await freshWorkspace();
    const foreign = await makeTag(other, 'Foreign');
    const id = await makeTag(ws, 'A');
    const mark = await makeMark(ws, id);
    await expectHandleError(
      run(tagsDelete, { kind: 'tags.delete', id, reassignTo: 987654321 }, ws),
      400,
      'tag_not_found',
    );
    await expectHandleError(
      run(tagsDelete, { kind: 'tags.delete', id, reassignTo: foreign }, ws),
      400,
      'tag_not_found',
    );
    expect((await listTags(ws)).map((row) => row.name)).toEqual(['A']);
    expect((await readMark(mark))?.tagId).toBe(id);
  });

  it('delete: notes referencing the tag count as use and move with reassignTo', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    const target = await makeTag(ws, 'B');
    const note = await makeNote(ws, id);
    await expectHandleError(run(tagsDelete, { kind: 'tags.delete', id }, ws), 409, 'tag_in_use');
    const result = await run(tagsDelete, { kind: 'tags.delete', id, reassignTo: target }, ws);
    expect(result).toEqual({ affected: 1, id });
    expect((await readNote(note))?.tagId).toBe(target);
    expect((await listTags(ws)).map((row) => row.name)).toEqual(['B']);
  });

  it('delete: invalid operations answer 400 validation_failed through handle', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    await expectHandleError(
      run(tagsDelete, { kind: 'tags.delete', id, reassignTo: id }, ws),
      400,
      'validation_failed',
    );
    await expectHandleError(
      run(tagsDelete, { kind: 'tags.delete', id: 'x' }, ws),
      400,
      'validation_failed',
    );
    expect((await listTags(ws)).length).toBe(1);
  });

  it('reorder: applies the given sort orders and reports affected entries', async () => {
    const ws = await freshWorkspace();
    const first = await makeTag(ws, 'A');
    const second = await makeTag(ws, 'B');
    const third = await makeTag(ws, 'C');
    const result = await run(
      tagsReorder,
      {
        kind: 'tags.reorder',
        order: [
          { id: third, sortOrder: 0 },
          { id: first, sortOrder: 1 },
          { id: second, sortOrder: 2 },
        ],
      },
      ws,
    );
    expect(result).toEqual({ affected: 3 });
    const rows = await listTags(ws);
    expect(rows.map((row) => [row.id, row.sortOrder])).toEqual([
      [first, 1],
      [second, 2],
      [third, 0],
    ]);
  });

  it('reorder: an empty order list is a no-op with affected 0', async () => {
    const ws = await freshWorkspace();
    await makeTag(ws, 'A');
    const result = await run(tagsReorder, { kind: 'tags.reorder', order: [] }, ws);
    expect(result).toEqual({ affected: 0 });
  });

  it('reorder: an unknown id answers 404 and writes nothing', async () => {
    const ws = await freshWorkspace();
    const other = await freshWorkspace();
    const foreign = await makeTag(other, 'Foreign');
    const id = await makeTag(ws, 'A');
    await expectHandleError(
      run(
        tagsReorder,
        {
          kind: 'tags.reorder',
          order: [
            { id, sortOrder: 5 },
            { id: 987654321, sortOrder: 6 },
          ],
        },
        ws,
      ),
      404,
      'not_found',
    );
    await expectHandleError(
      run(tagsReorder, { kind: 'tags.reorder', order: [{ id: foreign, sortOrder: 1 }] }, ws),
      404,
      'not_found',
    );
    expect((await listTags(ws))[0]?.sortOrder).toBe(0);
  });

  it('reorder: re-applying the same order leaves the same values', async () => {
    const ws = await freshWorkspace();
    const first = await makeTag(ws, 'A');
    const second = await makeTag(ws, 'B');
    const order = [
      { id: first, sortOrder: 2 },
      { id: second, sortOrder: 1 },
    ];
    await run(tagsReorder, { kind: 'tags.reorder', order }, ws);
    const secondRun = await run(tagsReorder, { kind: 'tags.reorder', order }, ws);
    expect(secondRun).toEqual({ affected: 2 });
    expect((await listTags(ws)).map((row) => row.sortOrder)).toEqual([2, 1]);
  });

  it('reorder: invalid operations answer 400 validation_failed through handle', async () => {
    const ws = await freshWorkspace();
    const id = await makeTag(ws, 'A');
    await expectHandleError(
      run(
        tagsReorder,
        {
          kind: 'tags.reorder',
          order: [
            { id, sortOrder: 0 },
            { id, sortOrder: 1 },
          ],
        },
        ws,
      ),
      400,
      'validation_failed',
    );
    expect((await listTags(ws))[0]?.sortOrder).toBe(0);
  });
});
