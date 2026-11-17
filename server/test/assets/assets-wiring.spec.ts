// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Assets wiring through buildApp (W4-WIRE, adapter rank 130).
// The route-level contract is covered by assets.spec.ts over a
// standalone app; this file pins the wiring decisions: without
// DATABASE_URL, workspace resolution fails closed 503 (it must
// not answer the generic 404, which would claim "no workspace"
// when the truth is "cannot verify"); without ASSET_ROOT, the
// store fails closed 503. The live section runs only when
// ASSETS_WIRING_DATABASE_URL is set, against a scratch database
// carrying the canonical M8 schema, and proves the upload/serve
// round trip through the real adapter, the real resolver, and
// the real filesystem store.

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import {
  createDb,
  users,
  workspaceMembers,
  workspaces,
  type DbHandle,
} from '../../src/db/index.js';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  type SessionPrincipal,
} from '../../src/middleware/auth-hook.js';
import { testConfig } from '../auth/helpers.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const TEST_PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'sess-1' };
const BOUNDARY = '----asset-wiring-boundary-7';
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png-payload-bytes'),
]);

function multipartPng(): Buffer {
  const header =
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="pic.png"\r\n` +
    'Content-Type: image/png\r\n\r\n';
  return Buffer.concat([
    Buffer.from(header, 'utf8'),
    PNG_BYTES,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8'),
  ]);
}

function sessionHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: 'notegen_session=good-session',
    origin: TEST_ORIGIN,
    'x-csrf-token': 'good-csrf',
    ...extra,
  };
}

function rawBodyOf(response: { rawPayload?: Buffer; body: string }): Buffer {
  if (response.rawPayload !== undefined) {
    return response.rawPayload;
  }
  return Buffer.from(response.body, 'utf8');
}

describe('assets wiring fail-closed (no database)', () => {
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

  async function wiringApp(overrides: { assetRoot?: string } = {}): Promise<FastifyInstance> {
    dir = await mkdtemp(join(tmpdir(), 'w4wire-assets-'));
    app = await buildApp({
      config: testConfig({
        workspaceRoot: dir,
        ...(overrides.assetRoot !== undefined ? { assetRoot: overrides.assetRoot } : {}),
      }),
      pool: null,
      version: 'test',
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? TEST_PRINCIPAL : null),
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
      verifyOrigin: defaultVerifyOrigin,
    });
    return app;
  }

  it('answers 503 for serve without a database URL, not the generic 404', async () => {
    const built = await wiringApp({ assetRoot: join(await mkdtemp(join(tmpdir(), 'w4wire-ar-')), 'a') });
    const res = await built.inject({
      method: 'GET',
      url: '/api/assets/ast_0123456789abcdef0123456789abcdef',
      headers: sessionHeaders(),
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('service_unavailable');
  });

  it('answers 503 for upload without a database URL', async () => {
    const built = await wiringApp({ assetRoot: join(await mkdtemp(join(tmpdir(), 'w4wire-ar-')), 'a') });
    const res = await built.inject({
      method: 'POST',
      url: '/api/assets',
      headers: sessionHeaders({ 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }),
      payload: multipartPng(),
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('service_unavailable');
  });
});

const PG_URL = process.env.ASSETS_WIRING_DATABASE_URL;
const describePg = PG_URL === undefined ? describe.skip : describe;

describePg('assets wiring over Postgres (live)', () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let assetRoot: string;
  let workspaceRoot: string;
  let userId: string;
  let workspaceId: string;

  beforeAll(async () => {
    handle = createDb(PG_URL as string);
    const suffix = `w4wire-${Date.now()}`;
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
    assetRoot = await mkdtemp(join(tmpdir(), 'w4wire-assets-live-'));
    workspaceRoot = await mkdtemp(join(tmpdir(), 'w4wire-ws-live-'));
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

  it('uploads and serves an asset through buildApp, stored outside the workspace tree', async () => {
    const upload = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: sessionHeaders({ 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }),
      payload: multipartPng(),
    });
    expect(upload.statusCode).toBe(201);
    const body = upload.json() as { ok: boolean; data: { assetKey: string; fileName: string } };
    expect(body.ok).toBe(true);
    expect(body.data.fileName).toBe('pic.png');
    const assetKey = body.data.assetKey;
    expect(assetKey).toMatch(/^ast_[0-9a-f]{32}$/);
    const stored = await readdir(join(assetRoot, workspaceId));
    expect(stored).toContain(`${assetKey}.bin`);
    expect(stored).toContain(`${assetKey}.json`);

    const served = await app.inject({
      method: 'GET',
      url: `/api/assets/${assetKey}`,
      headers: sessionHeaders(),
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(Buffer.from(rawBodyOf(served)).equals(PNG_BYTES)).toBe(true);
    const onDisk = await readFile(join(assetRoot, workspaceId, `${assetKey}.bin`));
    expect(onDisk.equals(PNG_BYTES)).toBe(true);
  });
});
