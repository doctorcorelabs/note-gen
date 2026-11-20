// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// REST marks/tags routes over the in-memory fake repository
// (W4-WIRE, kontrak 3.5/3.6). The app is standalone with the
// frozen plugins (request id, error handling, auth hooks), so
// these specs prove the HTTP surface, the envelope shapes, the
// guard semantics, and the asset sweep without a database. The
// Drizzle repository behind the same interface is covered by
// records-live.spec.ts (skip-guarded, live Postgres).

import Fastify, { LogController, type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
  type VerifySessionFn,
} from '../src/middleware/auth-hook.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import { registerRequestId, requestIdFromHeaders } from '../src/plugins/request-id.js';
import { registerMarksRoutes, type RecordsAssetPort } from '../src/routes/records-marks.js';
import { registerTagsRoutes } from '../src/routes/records-tags.js';
import {
  createFakeRecordsRepository,
  type FakeRecordsRepository,
} from '../src/services/records/fake-repository.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TEST_PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'sess-1' };

interface Fixture {
  app: FastifyInstance;
  repository: FakeRecordsRepository;
  removedAssets: string[];
  existingAssets: Set<string>;
}

let fixture: Fixture | undefined;

const verifySession: VerifySessionFn = async ({ sessionId }) =>
  sessionId === 'good-session' ? TEST_PRINCIPAL : null;

async function setup(): Promise<Fixture> {
  const repository = createFakeRecordsRepository(WORKSPACE_ID);
  const removedAssets: string[] = [];
  const existingAssets = new Set<string>();
  const assets: RecordsAssetPort = {
    exists: async (_workspaceId, assetKey) => existingAssets.has(assetKey),
    remove: async (_workspaceId, assetKey) => {
      removedAssets.push(assetKey);
      return existingAssets.delete(assetKey);
    },
  };
  const app = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  registerAuthHooks(app, {
    verifySession,
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
    canonicalOrigin: TEST_ORIGIN,
  });
  const deps = {
    repository,
    resolveWorkspaceId: async () => WORKSPACE_ID,
    assets,
  };
  await registerMarksRoutes(app, deps);
  await registerTagsRoutes(app, deps);
  await app.ready();
  fixture = { app, repository, removedAssets, existingAssets };
  return fixture;
}

beforeEach(() => {
  fixture = undefined;
});

afterEach(async () => {
  if (fixture !== undefined) {
    await fixture.app.close();
    fixture = undefined;
  }
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: 'notegen_session=good-session',
    origin: TEST_ORIGIN,
    'x-csrf-token': 'good-csrf',
    'content-type': 'application/json',
    ...extra,
  };
}

// Mutations without a body must not carry a JSON content-type:
// Fastify answers 400 for an empty body under application/json.
function authHeadersNoBody(): Record<string, string> {
  return {
    cookie: 'notegen_session=good-session',
    origin: TEST_ORIGIN,
    'x-csrf-token': 'good-csrf',
  };
}

function dataOf<T>(response: LightMyRequestResponse): T {
  const body = response.json() as { ok: boolean; data: T };
  expect(body.ok).toBe(true);
  return body.data;
}

function errorOf(response: LightMyRequestResponse): { code: string; details?: Record<string, unknown> } {
  const body = response.json() as { ok: boolean; error: { code: string; details?: Record<string, unknown> } };
  expect(body.ok).toBe(false);
  return body.error;
}

async function createTag(app: FastifyInstance, name: string): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/tags',
    headers: authHeaders(),
    payload: JSON.stringify({ name }),
  });
  expect(res.statusCode).toBe(201);
  return (dataOf<{ id: number }>(res)).id;
}

async function createRecord(
  app: FastifyInstance,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/marks',
    headers: authHeaders(extraHeaders),
    payload: JSON.stringify(body),
  });
}

describe('marks create and read', () => {
  it('creates a record with 201 and the full wire shape', async () => {
    const { app } = await setup();
    const tagId = await createTag(app, 'Work');
    const res = await createRecord(app, { type: 'text', content: 'hello', tagId });
    expect(res.statusCode).toBe(201);
    const data = dataOf<Record<string, unknown>>(res);
    expect(data['type']).toBe('text');
    expect(data['content']).toBe('hello');
    expect(data['desc']).toBe('hello');
    expect(data['tagId']).toBe(tagId);
    expect(data['tagIds']).toEqual([tagId]);
    expect(data['tagVersion']).toBe(data['version']);
    expect(data['fileName']).toBeNull();
    expect(data['enrichmentStatus']).toBe('none');
    expect(data['thumbnailUrl']).toBeNull();
    expect(data['deleted']).toBe(false);
    expect(data['deletedAt']).toBeNull();
    expect(data['duplicate']).toBeUndefined();
  });

  it('returns 200 with duplicate: true on sourceId first-write-wins, changing nothing', async () => {
    const { app } = await setup();
    const tagId = await createTag(app, 'Work');
    const first = await createRecord(app, { type: 'text', content: 'one', tagId, sourceId: 'src-1' });
    expect(first.statusCode).toBe(201);
    const second = await createRecord(app, { type: 'text', content: 'two', tagId, sourceId: 'src-1' });
    expect(second.statusCode).toBe(200);
    const data = dataOf<Record<string, unknown>>(second);
    expect(data['duplicate']).toBe(true);
    expect(data['content']).toBe('one');
    expect(data['id']).toBe(dataOf<Record<string, unknown>>(first)['id']);
  });

  it('uses the Idempotency-Key header as the source id', async () => {
    const { app } = await setup();
    const tagId = await createTag(app, 'Work');
    const first = await createRecord(app, { type: 'text', content: 'one', tagId }, { 'idempotency-key': 'key-1' });
    const second = await createRecord(app, { type: 'text', content: 'two', tagId }, { 'idempotency-key': 'key-1' });
    expect(dataOf<Record<string, unknown>>(second)['duplicate']).toBe(true);
    expect(dataOf<Record<string, unknown>>(second)['id']).toBe(dataOf<Record<string, unknown>>(first)['id']);
  });

  it('creates the locked Idea tag as the default save target in an empty workspace', async () => {
    const { app, repository } = await setup();
    const res = await createRecord(app, { type: 'text', content: 'orphan' });
    expect(res.statusCode).toBe(201);
    const data = dataOf<Record<string, unknown>>(res);
    const tags = await repository.listTags(WORKSPACE_ID);
    expect(tags).toHaveLength(1);
    expect(tags[0].name).toBe('Idea');
    expect(tags[0].locked).toBe(true);
    expect(tags[0].pinned).toBe(true);
    expect(data['tagId']).toBe(tags[0].id);
  });

  it('answers 400 tag_not_found for an unknown tag and 400 asset_not_found for an unknown asset key', async () => {
    const { app } = await setup();
    const badTag = await createRecord(app, { type: 'text', content: 'x', tagId: 99 });
    expect(badTag.statusCode).toBe(400);
    expect(errorOf(badTag).code).toBe('tag_not_found');
    const badAsset = await createRecord(app, { type: 'image', url: 'ast_0123456789abcdef0123456789abcdef' });
    expect(badAsset.statusCode).toBe(400);
    expect(errorOf(badAsset).code).toBe('asset_not_found');
  });

  it('reads a single record, including a soft-deleted one, and 404s unknown ids', async () => {
    const { app } = await setup();
    const tagId = await createTag(app, 'Work');
    const created = dataOf<{ id: number }>(await createRecord(app, { type: 'text', content: 'x', tagId }));
    const read = await app.inject({
      method: 'GET',
      url: `/api/marks/${created.id}`,
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    expect(read.statusCode).toBe(200);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/marks/999',
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    expect(missing.statusCode).toBe(404);
    const nonNumeric = await app.inject({
      method: 'GET',
      url: '/api/marks/abc',
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    expect(nonNumeric.statusCode).toBe(404);
  });

  it('requires a session (401) and answers 405 for a wrong method on a registered path', async () => {
    const { app } = await setup();
    const anon = await app.inject({ method: 'GET', url: '/api/marks' });
    expect(anon.statusCode).toBe(401);
    const wrongMethod = await app.inject({
      method: 'POST',
      url: '/api/marks/1',
      headers: authHeaders(),
      payload: JSON.stringify({}),
    });
    expect(wrongMethod.statusCode).toBe(405);
    expect(errorOf(wrongMethod).code).toBe('method_not_allowed');
  });
});

describe('marks PATCH guards', () => {
  it('fails closed without a guard and 409 revision_conflict on a stale guard', async () => {
    const { app } = await setup();
    const tagId = await createTag(app, 'Work');
    const created = dataOf<{ id: number; version: number }>(
      await createRecord(app, { type: 'text', content: 'v1', tagId }),
    );
    const guarded = await app.inject({
      method: 'PATCH',
      url: `/api/marks/${created.id}`,
      headers: authHeaders(),
      payload: JSON.stringify({ content: 'v2', expectedVersion: created.version }),
    });
    expect(guarded.statusCode).toBe(200);
    expect(dataOf<Record<string, unknown>>(guarded)['version']).toBe(created.version + 1);
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/marks/${created.id}`,
      headers: authHeaders(),
      payload: JSON.stringify({ content: 'v3', expectedVersion: created.version }),
    });
    expect(stale.statusCode).toBe(409);
    const error = errorOf(stale);
    expect(error.code).toBe('revision_conflict');
    expect((error.details as { current: { version: number } }).current.version).toBe(created.version + 1);
    const unguarded = await app.inject({
      method: 'PATCH',
      url: `/api/marks/${created.id}`,
      headers: authHeaders(),
      payload: JSON.stringify({ content: 'v3' }),
    });
    // DATA2D-4 (AD-799): no expectedVersion/If-Match and no force fails
    // closed with 400 validation_failed instead of last-write-wins.
    expect(unguarded.statusCode).toBe(400);
    expect(errorOf(unguarded).code).toBe('validation_failed');
    const forcedUnguarded = await app.inject({
      method: 'PATCH',
      url: `/api/marks/${created.id}`,
      headers: authHeaders(),
      payload: JSON.stringify({ content: 'v3', force: true }),
    });
    expect(forcedUnguarded.statusCode).toBe(200);
  });

  it('overwrites with force on a stale guard and writes a force activity event', async () => {
    const { app, repository } = await setup();
    const tagId = await createTag(app, 'Work');
    const created = dataOf<{ id: number; version: number }>(
      await createRecord(app, { type: 'text', content: 'v1', tagId }),
    );
    const forced = await app.inject({
      method: 'PATCH',
      url: `/api/marks/${created.id}`,
      headers: authHeaders(),
      payload: JSON.stringify({ content: 'forced', expectedVersion: 99, force: true }),
    });
    expect(forced.statusCode).toBe(200);
    expect(repository.events.some((event) => event.description === 'Record overwritten with force.')).toBe(true);
  });

  it('edits a soft-deleted record without changing its deleted status', async () => {
    const { app } = await setup();
    const tagId = await createTag(app, 'Work');
    const created = dataOf<{ id: number; version: number }>(await createRecord(app, { type: 'text', content: 'v1', tagId }));
    await app.inject({ method: 'DELETE', url: `/api/marks/${created.id}`, headers: authHeadersNoBody() });
    // The soft delete bumps the version, so the guarded PATCH must carry
    // the post-delete version read back from the record.
    const afterDelete = dataOf<{ version: number }>(await app.inject({
      method: 'GET',
      url: `/api/marks/${created.id}`,
      headers: authHeadersNoBody(),
    }));
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/marks/${created.id}`,
      headers: authHeaders(),
      payload: JSON.stringify({ content: 'edited in trash', expectedVersion: afterDelete.version }),
    });
    expect(patched.statusCode).toBe(200);
    const data = dataOf<Record<string, unknown>>(patched);
    expect(data['content']).toBe('edited in trash');
    expect(data['deleted']).toBe(true);
  });

  it('recomputes the todo desc from a rewritten todo body', async () => {
    const { app } = await setup();
    const tagId = await createTag(app, 'Work');
    const todo = JSON.stringify({ title: 'Old', description: '', priority: 'low', completed: false });
    const created = dataOf<{ id: number; version: number }>(await createRecord(app, { type: 'todo', content: todo, tagId }));
    const next = JSON.stringify({ title: 'New', description: 'd', priority: 'high', completed: true });
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/marks/${created.id}`,
      headers: authHeaders(),
      payload: JSON.stringify({ content: next, expectedVersion: created.version }),
    });
    expect(patched.statusCode).toBe(200);
    expect(dataOf<Record<string, unknown>>(patched)['desc']).toBe('New');
    const badDesc = await app.inject({
      method: 'PATCH',
      url: `/api/marks/${created.id}`,
      headers: authHeaders(),
      payload: JSON.stringify({ desc: 'Not the title', expectedVersion: created.version + 1 }),
    });
    expect(badDesc.statusCode).toBe(400);
  });
});

describe('marks PUT tags', () => {
  it('changes the primary tag to the first element and answers 409 with currentTagIds on a stale guard', async () => {
    const { app } = await setup();
    const first = await createTag(app, 'First');
    const second = await createTag(app, 'Second');
    const created = dataOf<{ id: number; tagIds: number[] }>(
      await createRecord(app, { type: 'text', content: 'x', tagId: first }),
    );
    const moved = await app.inject({
      method: 'PUT',
      url: `/api/marks/${created.id}/tags`,
      headers: authHeaders(),
      payload: JSON.stringify({ tagIds: [second, first], expectedTagIds: [first] }),
    });
    expect(moved.statusCode).toBe(200);
    const data = dataOf<Record<string, unknown>>(moved);
    expect(data['tagId']).toBe(second);
    expect(data['tagIds']).toEqual([first, second].sort((a, b) => a - b));
    const stale = await app.inject({
      method: 'PUT',
      url: `/api/marks/${created.id}/tags`,
      headers: authHeaders(),
      payload: JSON.stringify({ tagIds: [first], expectedTagIds: [first] }),
    });
    expect(stale.statusCode).toBe(409);
    const error = errorOf(stale);
    expect(error.code).toBe('record_tags_changed');
    expect((error.details as { currentTagIds: number[] }).currentTagIds).toEqual(
      [first, second].sort((a, b) => a - b),
    );
  });

  it('answers 400 tag_not_found for unknown tag ids (no silent drop)', async () => {
    const { app } = await setup();
    const tagId = await createTag(app, 'Work');
    const created = dataOf<{ id: number }>(await createRecord(app, { type: 'text', content: 'x', tagId }));
    const res = await app.inject({
      method: 'PUT',
      url: `/api/marks/${created.id}/tags`,
      headers: authHeaders(),
      payload: JSON.stringify({ tagIds: [tagId, 999], force: true }),
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('tag_not_found');
  });
});

describe('marks trash lifecycle', () => {
  it('soft-deletes idempotently, restores idempotently, and permanently deletes', async () => {
    const { app } = await setup();
    const tagId = await createTag(app, 'Work');
    const created = dataOf<{ id: number; version: number }>(
      await createRecord(app, { type: 'text', content: 'x', tagId }),
    );
    const deleted = await app.inject({ method: 'DELETE', url: `/api/marks/${created.id}`, headers: authHeadersNoBody() });
    expect(deleted.statusCode).toBe(200);
    expect(dataOf<Record<string, unknown>>(deleted)['deleted']).toBe(true);
    const deletedAgain = await app.inject({ method: 'DELETE', url: `/api/marks/${created.id}`, headers: authHeadersNoBody() });
    expect(dataOf<Record<string, unknown>>(deletedAgain)['version']).toBe(
      dataOf<Record<string, unknown>>(deleted)['version'],
    );
    const restored = await app.inject({
      method: 'POST',
      url: `/api/marks/${created.id}/restore`,
      headers: authHeaders(),
      payload: JSON.stringify({}),
    });
    expect(restored.statusCode).toBe(200);
    expect(dataOf<Record<string, unknown>>(restored)['deleted']).toBe(false);
    const permanent = await app.inject({
      method: 'DELETE',
      url: `/api/marks/${created.id}/permanent`,
      headers: authHeadersNoBody(),
    });
    expect(permanent.statusCode).toBe(200);
    expect(dataOf(permanent)).toEqual({ id: created.id, deleted: true, permanent: true });
    const gone = await app.inject({
      method: 'GET',
      url: `/api/marks/${created.id}`,
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('empties the trash only with confirm: true and reports the purge count', async () => {
    const { app } = await setup();
    const tagId = await createTag(app, 'Work');
    const first = dataOf<{ id: number }>(await createRecord(app, { type: 'text', content: 'a', tagId }));
    const second = dataOf<{ id: number }>(await createRecord(app, { type: 'text', content: 'b', tagId }));
    await app.inject({ method: 'DELETE', url: `/api/marks/${first.id}`, headers: authHeadersNoBody() });
    const unconfirmed = await app.inject({
      method: 'DELETE',
      url: '/api/marks/trash',
      headers: authHeaders(),
      payload: JSON.stringify({}),
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(errorOf(unconfirmed).code).toBe('confirm_required');
    const emptied = await app.inject({
      method: 'DELETE',
      url: '/api/marks/trash',
      headers: authHeaders(),
      payload: JSON.stringify({ confirm: true }),
    });
    expect(emptied.statusCode).toBe(200);
    const data = dataOf<{ purged: number; purgedAt: number }>(emptied);
    expect(data.purged).toBe(1);
    expect(data.purgedAt).toBeGreaterThan(0);
    const survivor = await app.inject({
      method: 'GET',
      url: `/api/marks/${second.id}`,
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    expect(survivor.statusCode).toBe(200);
  });

  it('sweeps unreferenced asset keys on permanent delete but keeps shared keys', async () => {
    const { app, removedAssets, existingAssets } = await setup();
    const tagId = await createTag(app, 'Work');
    const sharedKey = 'ast_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const soloKey = 'ast_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    existingAssets.add(sharedKey);
    existingAssets.add(soloKey);
    const first = dataOf<{ id: number }>(
      await createRecord(app, { type: 'image', url: sharedKey, tagId }),
    );
    const second = dataOf<{ id: number }>(
      await createRecord(app, { type: 'image', url: sharedKey, tagId }),
    );
    const solo = dataOf<{ id: number }>(await createRecord(app, { type: 'image', url: soloKey, tagId }));
    await app.inject({ method: 'DELETE', url: `/api/marks/${first.id}/permanent`, headers: authHeadersNoBody() });
    expect(removedAssets).not.toContain(sharedKey);
    await app.inject({ method: 'DELETE', url: `/api/marks/${second.id}/permanent`, headers: authHeadersNoBody() });
    expect(removedAssets).toContain(sharedKey);
    await app.inject({ method: 'DELETE', url: `/api/marks/${solo.id}/permanent`, headers: authHeadersNoBody() });
    expect(removedAssets).toContain(soloKey);
  });
});

describe('marks list', () => {
  it('pages through created_desc with a cursor', async () => {
    const { app } = await setup();
    const tagId = await createTag(app, 'Work');
    for (let i = 0; i < 3; i += 1) {
      await createRecord(app, { type: 'text', content: `note ${i}`, tagId });
    }
    const first = await app.inject({
      method: 'GET',
      url: '/api/marks?limit=2',
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    const firstData = dataOf<{ items: { id: number }[]; nextCursor: string | null; hasMore: boolean }>(first);
    expect(firstData.items).toHaveLength(2);
    expect(firstData.hasMore).toBe(true);
    const second = await app.inject({
      method: 'GET',
      url: `/api/marks?limit=2&cursor=${encodeURIComponent(firstData.nextCursor as string)}`,
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    const secondData = dataOf<{ items: { id: number }[]; hasMore: boolean }>(second);
    expect(secondData.items).toHaveLength(1);
    expect(secondData.hasMore).toBe(false);
    const seen = new Set([...firstData.items.map((item) => item.id), ...secondData.items.map((item) => item.id)]);
    expect(seen.size).toBe(3);
  });
});

describe('tags routes', () => {
  it('lists tags pinned-first with direct-membership counts', async () => {
    const { app } = await setup();
    const plain = await createTag(app, 'Zebra');
    const pinned = await createTag(app, 'Apple');
    await app.inject({
      method: 'PATCH',
      url: `/api/tags/${pinned}`,
      headers: authHeaders(),
      payload: JSON.stringify({ pinned: true }),
    });
    await createRecord(app, { type: 'text', content: 'a', tagId: plain });
    await createRecord(app, { type: 'text', content: 'b', tagId: plain });
    const res = await app.inject({
      method: 'GET',
      url: '/api/tags',
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    const data = dataOf<{ tags: { id: number; name: string; pinned: boolean; recordCount: number }[] }>(res);
    expect(data.tags.map((tag) => tag.name)).toEqual(['Apple', 'Zebra']);
    expect(data.tags.find((tag) => tag.id === plain)?.recordCount).toBe(2);
    expect(data.tags.find((tag) => tag.id === pinned)?.recordCount).toBe(0);
  });

  it('answers 409 tag_name_taken on a duplicate create', async () => {
    const { app } = await setup();
    await createTag(app, 'Work');
    const dup = await app.inject({
      method: 'POST',
      url: '/api/tags',
      headers: authHeaders(),
      payload: JSON.stringify({ name: 'Work' }),
    });
    expect(dup.statusCode).toBe(409);
    expect(errorOf(dup).code).toBe('tag_name_taken');
  });

  it('renames a whole subtree and rejects collisions', async () => {
    const { app } = await setup();
    const parent = await createTag(app, 'Work');
    await createTag(app, 'Work/Deep');
    await createTag(app, 'Other');
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/tags/${parent}`,
      headers: authHeaders(),
      payload: JSON.stringify({ name: 'Job' }),
    });
    expect(renamed.statusCode).toBe(200);
    const list = await app.inject({
      method: 'GET',
      url: '/api/tags',
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    expect(dataOf<{ tags: { name: string }[] }>(list).tags.map((tag) => tag.name).sort()).toEqual([
      'Job',
      'Job/Deep',
      'Other',
    ]);
    const collision = await app.inject({
      method: 'PATCH',
      url: `/api/tags/${parent}`,
      headers: authHeaders(),
      payload: JSON.stringify({ name: 'Other' }),
    });
    expect(collision.statusCode).toBe(409);
    expect(errorOf(collision).code).toBe('tag_name_taken');
  });

  it('forbids renaming or pin-changing a locked tag, except a same-value pin no-op', async () => {
    const { app, repository } = await setup();
    const locked = repository.seedTag('Idea', { locked: true, pinned: true });
    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/tags/${locked.id}`,
      headers: authHeaders(),
      payload: JSON.stringify({ name: 'NotIdea' }),
    });
    expect(rename.statusCode).toBe(409);
    expect(errorOf(rename).code).toBe('tag_locked');
    const unpin = await app.inject({
      method: 'PATCH',
      url: `/api/tags/${locked.id}`,
      headers: authHeaders(),
      payload: JSON.stringify({ pinned: false }),
    });
    expect(unpin.statusCode).toBe(409);
    const noop = await app.inject({
      method: 'PATCH',
      url: `/api/tags/${locked.id}`,
      headers: authHeaders(),
      payload: JSON.stringify({ pinned: true }),
    });
    expect(noop.statusCode).toBe(200);
  });

  it('refuses to delete an in-use tag without reassignTo, and moves memberships with it', async () => {
    const { app } = await setup();
    const source = await createTag(app, 'Source');
    const target = await createTag(app, 'Target');
    const created = dataOf<{ id: number }>(await createRecord(app, { type: 'text', content: 'x', tagId: source }));
    const refused = await app.inject({ method: 'DELETE', url: `/api/tags/${source}`, headers: authHeadersNoBody() });
    expect(refused.statusCode).toBe(409);
    const error = errorOf(refused);
    expect(error.code).toBe('tag_in_use');
    expect((error.details as { recordCount: number }).recordCount).toBe(1);
    const moved = await app.inject({
      method: 'DELETE',
      url: `/api/tags/${source}?reassignTo=${target}`,
      headers: authHeadersNoBody(),
    });
    expect(moved.statusCode).toBe(200);
    expect(dataOf(moved)).toEqual({ id: source, deleted: true, reassignedTo: target });
    const read = await app.inject({
      method: 'GET',
      url: `/api/marks/${created.id}`,
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    expect(dataOf<Record<string, unknown>>(read)['tagId']).toBe(target);
  });

  it('deletes an unused tag and answers 404 for unknown tags', async () => {
    const { app } = await setup();
    const tagId = await createTag(app, 'Temp');
    const deleted = await app.inject({ method: 'DELETE', url: `/api/tags/${tagId}`, headers: authHeadersNoBody() });
    expect(deleted.statusCode).toBe(200);
    expect(dataOf(deleted)).toEqual({ id: tagId, deleted: true, reassignedTo: null });
    const missing = await app.inject({
      method: 'GET',
      url: '/api/tags/999',
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    expect(missing.statusCode).toBe(404);
  });
});
