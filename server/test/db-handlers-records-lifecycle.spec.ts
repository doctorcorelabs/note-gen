// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the marks lifecycle handler kinds (V3-25 part 3, wave 3B):
// marks.softDelete, marks.restore, marks.deletePermanent.
//
// Validation tests and the HANDLER_KIND marker tests run always, with
// no database. Database tests run only when MARKS_LIFECYCLE_DATABASE_URL
// is set; they seed one user plus two workspaces in that database,
// exercise handlers through db.transaction, and remove the seeded
// workspaces afterwards (domain rows cascade away). The database must
// already exist with migrations applied (DROP/CREATE via psql, then
// migrate via fase1/scripts/m8gate-runner.mjs); this spec creates no
// database and runs no migration. Example:
//
//   MARKS_LIFECYCLE_DATABASE_URL=<scratch-db-url>

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
import * as marksDeletePermanent from '../src/services/db/marks-delete-permanent.js';
import * as marksRestore from '../src/services/db/marks-restore.js';
import * as marksSoftDelete from '../src/services/db/marks-soft-delete.js';

type Ctx = {
  tx: Parameters<Parameters<Database['transaction']>[0]>[0];
  workspaceId: string;
  userId: string;
  requestId: string;
  transactionId: string | null;
};

const HANDLERS = [marksSoftDelete, marksRestore, marksDeletePermanent] as const;

function expectValidationError(op: unknown, handler: (typeof HANDLERS)[number]): void {
  let caught: unknown;
  try {
    handler.validate(op);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  const apiError = caught as ApiError;
  expect(apiError.statusCode).toBe(400);
  expect(apiError.code).toBe('validation_failed');
}

describe('marks lifecycle handler validation (no database)', () => {
  it('exposes the catalog kind marker', () => {
    expect(marksSoftDelete.HANDLER_KIND).toBe('marks.softDelete');
    expect(marksRestore.HANDLER_KIND).toBe('marks.restore');
    expect(marksDeletePermanent.HANDLER_KIND).toBe('marks.deletePermanent');
  });

  it('accepts a valid operation for each kind', () => {
    for (const handler of HANDLERS) {
      expect(() => handler.validate({ kind: handler.HANDLER_KIND, id: 42 })).not.toThrow();
    }
  });

  it('rejects unknown operation fields', () => {
    for (const handler of HANDLERS) {
      expectValidationError({ kind: handler.HANDLER_KIND, id: 1, expected: { version: 1 } }, handler);
      expectValidationError({ kind: handler.HANDLER_KIND, id: 1, extra: true }, handler);
    }
  });

  it('rejects a wrong kind', () => {
    for (const handler of HANDLERS) {
      expectValidationError({ kind: 'marks.update', id: 1 }, handler);
    }
  });

  it('rejects a non-integer, missing, or non-numeric id', () => {
    for (const handler of HANDLERS) {
      expectValidationError({ kind: handler.HANDLER_KIND, id: '42' }, handler);
      expectValidationError({ kind: handler.HANDLER_KIND, id: 1.5 }, handler);
      expectValidationError({ kind: handler.HANDLER_KIND }, handler);
      expectValidationError({ kind: handler.HANDLER_KIND, id: null }, handler);
    }
  });

  it('rejects a non-object operation', () => {
    for (const handler of HANDLERS) {
      expectValidationError(null, handler);
      expectValidationError('marks.softDelete', handler);
      expectValidationError([{ kind: handler.HANDLER_KIND, id: 1 }], handler);
    }
  });
});

const DATABASE_URL = process.env['MARKS_LIFECYCLE_DATABASE_URL'];
const dbDescribe = DATABASE_URL === undefined ? describe.skip : describe;

dbDescribe('marks lifecycle handlers against Postgres', () => {
  let db: Database;
  let handle: DbHandle;
  let userId = '';
  let workspaceId = '';
  let otherWorkspaceId = '';
  let tagId = 0;
  let secondTagId = 0;
  let otherTagId = 0;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL as string, { max: 2 });
    db = handle.db;
    const userRows = await db
      .insert(users)
      .values({ email: `v3b25c-${randomUUID()}`, passwordHash: 'test-hash' })
      .returning({ id: users.id });
    userId = userRows[0]?.id as string;
    const wsRows = await db
      .insert(workspaces)
      .values([
        { ownerUserId: userId, name: 'v3b25c main' },
        { ownerUserId: userId, name: 'v3b25c other' },
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
        { workspaceId, name: 'v3b25c-tag' },
        { workspaceId, name: 'v3b25c-second' },
        { workspaceId: otherWorkspaceId, name: 'v3b25c-other' },
      ])
      .returning({ id: tags.id });
    tagId = tagRows[0]?.id as number;
    secondTagId = tagRows[1]?.id as number;
    otherTagId = tagRows[2]?.id as number;
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
        { tx, workspaceId: ws, userId, requestId: 'v3b25c-test', transactionId: null },
        op,
      );
    });
  }

  async function makeMark(
    options: { ws?: string; tag?: number; deleted?: boolean; type?: string; url?: string } = {},
  ): Promise<number> {
    const ws = options.ws ?? workspaceId;
    const tag = options.tag ?? tagId;
    const past = new Date('2026-01-01T00:00:00.000Z');
    const rows = await db
      .insert(marks)
      .values({
        workspaceId: ws,
        tagId: tag,
        type: options.type ?? 'text',
        url: options.url ?? null,
        content: 'lifecycle',
        deletedAt: options.deleted === true ? past : null,
        createdAt: past,
        updatedAt: past,
      })
      .returning({ id: marks.id });
    const id = rows[0]?.id as number;
    await db.insert(markTags).values([
      { markId: id, tagId: tag, workspaceId: ws },
      ...(ws === workspaceId ? [{ markId: id, tagId: secondTagId, workspaceId: ws }] : []),
    ]);
    return id;
  }

  async function readMark(id: number) {
    const rows = await db.select().from(marks).where(eq(marks.id, id)).limit(1);
    return rows[0];
  }

  async function readTagIds(id: number): Promise<number[]> {
    const rows = await db
      .select({ tagId: markTags.tagId })
      .from(markTags)
      .where(eq(markTags.markId, id));
    return rows.map((row) => row.tagId).sort((a, b) => a - b);
  }

  async function expectNotFound(promise: Promise<unknown>): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.statusCode).toBe(404);
    expect(apiError.code).toBe('not_found');
  }

  it('softDelete sets deletedAt, bumps version, preserves tags and createdAt', async () => {
    const id = await makeMark();
    const before = await readMark(id);
    const result = await run(marksSoftDelete, { kind: 'marks.softDelete', id });
    expect(result).toEqual({ affected: 1, id, version: 2 });
    const after = await readMark(id);
    expect(after?.deletedAt).not.toBeNull();
    expect(after?.deletedAt?.getTime()).toBeGreaterThan(before?.updatedAt?.getTime() as number);
    expect(after?.updatedAt?.getTime()).toBeGreaterThan(before?.updatedAt?.getTime() as number);
    expect(after?.version).toBe(2);
    expect(after?.createdAt).toEqual(before?.createdAt);
    expect(await readTagIds(id)).toEqual([tagId, secondTagId].sort((a, b) => a - b));
  });

  it('softDelete repeat is a no-op without a new change', async () => {
    const id = await makeMark();
    await run(marksSoftDelete, { kind: 'marks.softDelete', id });
    const before = await readMark(id);
    const result = await run(marksSoftDelete, { kind: 'marks.softDelete', id });
    expect(result).toEqual({ affected: 0, id, version: before?.version });
    const after = await readMark(id);
    expect(after?.deletedAt).toEqual(before?.deletedAt);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(after?.version).toBe(before?.version);
  });

  it('softDelete answers 404 for a missing row and a foreign-workspace row', async () => {
    await expectNotFound(run(marksSoftDelete, { kind: 'marks.softDelete', id: 999999999 }));
    const foreign = await makeMark({ ws: otherWorkspaceId, tag: otherTagId });
    await expectNotFound(run(marksSoftDelete, { kind: 'marks.softDelete', id: foreign }));
    expect((await readMark(foreign))?.deletedAt).toBeNull();
  });

  it('restore clears deletedAt, bumps version, and preserves tags and createdAt', async () => {
    const id = await makeMark({ deleted: true });
    const before = await readMark(id);
    const result = await run(marksRestore, { kind: 'marks.restore', id });
    expect(result).toEqual({ affected: 1, id, version: 2 });
    const after = await readMark(id);
    expect(after?.deletedAt).toBeNull();
    expect(after?.updatedAt?.getTime()).toBeGreaterThan(before?.updatedAt?.getTime() as number);
    expect(after?.version).toBe(2);
    expect(after?.createdAt).toEqual(before?.createdAt);
    expect(await readTagIds(id)).toEqual([tagId, secondTagId].sort((a, b) => a - b));
  });

  it('restore repeat on an active mark is a no-op without a new change', async () => {
    const id = await makeMark();
    const before = await readMark(id);
    const result = await run(marksRestore, { kind: 'marks.restore', id });
    expect(result).toEqual({ affected: 0, id, version: before?.version });
    const after = await readMark(id);
    expect(after?.deletedAt).toBeNull();
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(after?.version).toBe(before?.version);
  });

  it('restore answers 404 for a missing row and a foreign-workspace row', async () => {
    await expectNotFound(run(marksRestore, { kind: 'marks.restore', id: 999999999 }));
    const foreign = await makeMark({ ws: otherWorkspaceId, tag: otherTagId, deleted: true });
    await expectNotFound(run(marksRestore, { kind: 'marks.restore', id: foreign }));
    expect((await readMark(foreign))?.deletedAt).not.toBeNull();
  });

  it('deletePermanent removes the row, cascades mark_tags, and keeps tags', async () => {
    const id = await makeMark();
    const result = await run(marksDeletePermanent, { kind: 'marks.deletePermanent', id });
    expect(result).toEqual({ affected: 1, id });
    expect(await readMark(id)).toBeUndefined();
    expect(await readTagIds(id)).toEqual([]);
    const tagRows = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1);
    expect(tagRows).toHaveLength(1);
  });

  it('deletePermanent works from the soft-deleted state and repeats with 404', async () => {
    const id = await makeMark({ deleted: true });
    const result = await run(marksDeletePermanent, { kind: 'marks.deletePermanent', id });
    expect(result).toEqual({ affected: 1, id });
    await expectNotFound(run(marksDeletePermanent, { kind: 'marks.deletePermanent', id }));
  });

  it('deletePermanent answers 404 for a missing row and a foreign-workspace row', async () => {
    await expectNotFound(run(marksDeletePermanent, { kind: 'marks.deletePermanent', id: 999999999 }));
    const foreign = await makeMark({ ws: otherWorkspaceId, tag: otherTagId });
    await expectNotFound(run(marksDeletePermanent, { kind: 'marks.deletePermanent', id: foreign }));
    expect(await readMark(foreign)).toBeDefined();
    expect(await readTagIds(foreign)).toEqual([otherTagId]);
  });

  it('deletePermanent returns internal assetKeys for asset-bearing rows only (F02-04b)', async () => {
    const imageId = await makeMark({ type: 'image', url: 'asset-key-image-1' });
    const imageResult = await run(marksDeletePermanent, { kind: 'marks.deletePermanent', id: imageId });
    expect(imageResult).toEqual({ affected: 1, id: imageId, assetKeys: ['asset-key-image-1'] });
    const textId = await makeMark();
    const textResult = await run(marksDeletePermanent, { kind: 'marks.deletePermanent', id: textId });
    expect(textResult).toEqual({ affected: 1, id: textId });
  });

  it('runs the full lifecycle: softDelete, restore, softDelete, deletePermanent', async () => {
    const id = await makeMark();
    const first = await run(marksSoftDelete, { kind: 'marks.softDelete', id });
    expect(first.version).toBe(2);
    const restored = await run(marksRestore, { kind: 'marks.restore', id });
    expect(restored.version).toBe(3);
    const deleted = await run(marksSoftDelete, { kind: 'marks.softDelete', id });
    expect(deleted.version).toBe(4);
    expect(await readTagIds(id)).toEqual([tagId, secondTagId].sort((a, b) => a - b));
    const gone = await run(marksDeletePermanent, { kind: 'marks.deletePermanent', id });
    expect(gone).toEqual({ affected: 1, id });
    expect(await readMark(id)).toBeUndefined();
  });

  it('keeps foreign-workspace marks untouched across all three kinds', async () => {
    const foreign = await makeMark({ ws: otherWorkspaceId, tag: otherTagId });
    await expectNotFound(run(marksSoftDelete, { kind: 'marks.softDelete', id: foreign }));
    await expectNotFound(run(marksRestore, { kind: 'marks.restore', id: foreign }));
    await expectNotFound(run(marksDeletePermanent, { kind: 'marks.deletePermanent', id: foreign }));
    const row = await readMark(foreign);
    expect(row?.deletedAt).toBeNull();
    expect(row?.version).toBe(1);
  });
});
