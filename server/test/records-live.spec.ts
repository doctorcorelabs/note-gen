// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Records wiring through buildApp (W4-WIRE, adapter rank
// 110). The always-run section pins the fail-closed wiring:
// without DATABASE_URL, records requests answer 503 (the
// routes stay registered, so wrong-method probes still answer
// 405). The live section runs only when
// RECORDS_LIVE_DATABASE_URL is set, against a scratch database
// carrying the canonical M8 schema, and proves the Drizzle
// repository end to end through the real adapter, the real
// resolver, and the real asset store: create/read/list, guard
// conflicts, the trash lifecycle, tag subtree rename, and the
// post-commit asset sweep.

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import {
  createDb,
  users,
  workspaceMembers,
  workspaces,
  type DbHandle,
} from '../src/db/index.js';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';
import { testConfig } from './auth/helpers.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const TEST_PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'sess-1' };
const BOUNDARY = '----records-live-boundary-3';
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png-payload-bytes'),
]);

function sessionHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: 'notegen_session=good-session',
    origin: TEST_ORIGIN,
    'x-csrf-token': 'good-csrf',
    ...extra,
  };
}

function dataOf<T>(response: LightMyRequestResponse): T {
  const body = response.json() as { ok: boolean; data: T };
  expect(body.ok).toBe(true);
  return body.data;
}

describe('records wiring without a database URL (fail-closed)', () => {
  let app: FastifyInstance | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('answers 503 service_unavailable for records requests, not 404', async () => {
    dir = await mkdtemp(join(tmpdir(), 'w4wire-records-nodb-'));
    app = await buildApp({
      config: testConfig({ workspaceRoot: dir }),
      pool: null,
      version: 'test',
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? TEST_PRINCIPAL : null),
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
      verifyOrigin: defaultVerifyOrigin,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/marks',
      headers: sessionHeaders(),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('service_unavailable');
  });

  it('still answers 405 for a wrong method on a registered records path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'w4wire-records-nodb-'));
    app = await buildApp({
      config: testConfig({ workspaceRoot: dir }),
      pool: null,
      version: 'test',
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? TEST_PRINCIPAL : null),
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
      verifyOrigin: defaultVerifyOrigin,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/marks/1',
      headers: sessionHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(405);
  });
});

const PG_URL = process.env.RECORDS_LIVE_DATABASE_URL;
const describePg = PG_URL === undefined ? describe.skip : describe;

describePg('records over Postgres (live)', () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let assetRoot: string;
  let workspaceRoot: string;
  let userId: string;
  let workspaceId: string;

  beforeAll(async () => {
    handle = createDb(PG_URL as string);
    const suffix = `w4wire-records-${Date.now()}`;
    const userRows = await handle.db
      .insert(users)
      .values({ email: `${suffix}@example.invalid`, passwordHash: 'test-hash' })
      .returning({ id: users.id });
    userId = userRows[0]?.id as string;
    const wsRows = await handle.db
      .insert(workspaces)
      .values({ ownerUserId: userId, name: `${suffix} main` })
      .returning({ id: workspaces.id });
    workspaceId = wsRows[0]?.id as string;
    await handle.db.insert(workspaceMembers).values({ workspaceId, userId, role: 'owner' });
    assetRoot = await mkdtemp(join(tmpdir(), 'w4wire-records-live-assets-'));
    workspaceRoot = await mkdtemp(join(tmpdir(), 'w4wire-records-live-ws-'));
    const principal: SessionPrincipal = { userId, role: 'user', sessionId: 'sess-live' };
    app = await buildApp({
      config: testConfig({ workspaceRoot, databaseUrl: PG_URL, assetRoot }),
      pool: null,
      version: 'test',
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? principal : null),
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
      verifyOrigin: defaultVerifyOrigin,
    });
  });

  afterAll(async () => {
    await app.close();
    await handle.db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
    await handle.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await handle.db.delete(users).where(eq(users.id, userId));
    await handle.close();
    await rm(assetRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function createTag(name: string): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tags',
      headers: sessionHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ name }),
    });
    expect(res.statusCode).toBe(201);
    return dataOf<{ id: number }>(res).id;
  }

  it('runs the full marks lifecycle through the Drizzle repository', async () => {
    const tagId = await createTag('LiveWork');
    const created = await app.inject({
      method: 'POST',
      url: '/api/marks',
      headers: sessionHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ type: 'text', content: 'live note', tagId }),
    });
    expect(created.statusCode).toBe(201);
    const record = dataOf<{ id: number; version: number; tagVersion: number }>(created);
    expect(record.tagVersion).toBe(record.version);
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/marks/${record.id}`,
      headers: sessionHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ content: 'stale', expectedVersion: record.version + 5 }),
    });
    expect(stale.statusCode).toBe(409);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/marks?q=live',
      headers: sessionHeaders(),
    });
    expect(listed.statusCode).toBe(200);
    expect(dataOf<{ items: { id: number }[] }>(listed).items.map((item) => item.id)).toContain(record.id);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/marks/${record.id}`,
      headers: sessionHeaders(),
    });
    expect(deleted.statusCode).toBe(200);
    const restored = await app.inject({
      method: 'POST',
      url: `/api/marks/${record.id}/restore`,
      headers: sessionHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({}),
    });
    expect(dataOf<{ deleted: boolean }>(restored).deleted).toBe(false);
    const permanent = await app.inject({
      method: 'DELETE',
      url: `/api/marks/${record.id}/permanent`,
      headers: sessionHeaders(),
    });
    expect(permanent.statusCode).toBe(200);
    const gone = await app.inject({
      method: 'GET',
      url: `/api/marks/${record.id}`,
      headers: sessionHeaders(),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('renames a tag subtree and enforces tag_in_use with reassignTo', async () => {
    const parent = await createTag('LiveParent');
    await createTag('LiveParent/Child');
    const target = await createTag('LiveTarget');
    const created = await app.inject({
      method: 'POST',
      url: '/api/marks',
      headers: sessionHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ type: 'text', content: 'tagged', tagId: parent }),
    });
    const recordId = dataOf<{ id: number }>(created).id;
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/tags/${parent}`,
      headers: sessionHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ name: 'LiveRenamed' }),
    });
    expect(renamed.statusCode).toBe(200);
    const tags = await app.inject({ method: 'GET', url: '/api/tags', headers: sessionHeaders() });
    expect(dataOf<{ tags: { name: string }[] }>(tags).tags.map((tag) => tag.name)).toContain('LiveRenamed/Child');
    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/tags/${parent}`,
      headers: sessionHeaders(),
    });
    expect(refused.statusCode).toBe(409);
    const moved = await app.inject({
      method: 'DELETE',
      url: `/api/tags/${parent}?reassignTo=${target}`,
      headers: sessionHeaders(),
    });
    expect(moved.statusCode).toBe(200);
    const read = await app.inject({ method: 'GET', url: `/api/marks/${recordId}`, headers: sessionHeaders() });
    expect(dataOf<{ tagId: number }>(read).tagId).toBe(target);
  });

  it('sweeps the asset file when its only referencing record is permanently deleted', async () => {
    const header =
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="pic.png"\r\n` +
      'Content-Type: image/png\r\n\r\n';
    const upload = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: sessionHeaders({ 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }),
      payload: Buffer.concat([
        Buffer.from(header, 'utf8'),
        PNG_BYTES,
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8'),
      ]),
    });
    expect(upload.statusCode).toBe(201);
    const assetKey = dataOf<{ assetKey: string }>(upload).assetKey;
    const before = await readdir(join(assetRoot, workspaceId));
    expect(before).toContain(`${assetKey}.bin`);
    const tagId = await createTag('LiveAssets');
    const created = await app.inject({
      method: 'POST',
      url: '/api/marks',
      headers: sessionHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ type: 'image', url: assetKey, tagId }),
    });
    expect(created.statusCode).toBe(201);
    const recordId = dataOf<{ id: number }>(created).id;
    const permanent = await app.inject({
      method: 'DELETE',
      url: `/api/marks/${recordId}/permanent`,
      headers: sessionHeaders(),
    });
    expect(permanent.statusCode).toBe(200);
    const after = await readdir(join(assetRoot, workspaceId));
    expect(after).not.toContain(`${assetKey}.bin`);
    expect(after).not.toContain(`${assetKey}.json`);
  });
});
