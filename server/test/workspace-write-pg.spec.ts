// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Postgres-backed tests for the workspace write path (V3-04b): the
// files index (version increments, content hash, file_events rows
// in one transaction) and the idempotency store (replay, reuse,
// expiry) against a real Postgres 17 database.
//
// These tests run ONLY when WORKSPACE_WRITE_PG_URL is set; CI has
// no Postgres, so the suite skips there. The database must exist
// but may be empty: migrations run from the frozen manifest before
// the tests, and the seeded rows are truncated first so reruns are
// idempotent. The database used by this worker is v3_04b_ws on the
// shared local Postgres; nothing here touches any other database.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  fileEvents,
  files,
  idempotencyKeys,
  users,
  workspaces,
  type Database,
  type DbHandle,
} from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPgWorkspaceIndex } from '../src/services/workspace/write-index-pg.js';
import { createPgIdempotencyStore, IDEMPOTENCY_SCOPE } from '../src/services/workspace/write-idempotency.js';
import type { WorkspaceWritePorts } from '../src/services/workspace/write-ports.js';
import { AUTH_HEADERS, buildWriteTestApp } from './helpers/workspace-test-app.js';
import {
  createTestPorts,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
  type TestPortsBundle,
} from './helpers/workspace-test-ports.js';

const PG_URL = process.env['WORKSPACE_WRITE_PG_URL'];
const describePg = PG_URL === undefined ? describe.skip : describe;

function contentHashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

describePg('workspace writes against Postgres', () => {
  let handle: DbHandle;
  let db: Database;
  let app: FastifyInstance;
  let root: string;
  let bundle: TestPortsBundle;

  beforeAll(async () => {
    const url = PG_URL as string;
    await runMigrations({ databaseUrl: url });
    handle = createDb(url);
    db = handle.db;
    await handle.client.unsafe(
      'TRUNCATE TABLE file_events, files, idempotency_keys, workspace_members, workspaces, users RESTART IDENTITY CASCADE',
    );
    await db.insert(users).values({
      id: TEST_USER_ID,
      login: 'v3-04b-test',
      passwordHash: 'not-a-real-hash',
    });
    await db.insert(workspaces).values({
      id: TEST_WORKSPACE_ID,
      ownerId: TEST_USER_ID,
      name: 'v3-04b workspace',
    });
    root = await mkdtemp(join(tmpdir(), 'notegen-write-pg-'));
    bundle = createTestPorts(root);
    const ports: WorkspaceWritePorts = {
      ...bundle.ports,
      index: createPgWorkspaceIndex(db),
      idempotency: createPgIdempotencyStore(db),
    };
    app = await buildWriteTestApp({ ...bundle, ports });
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
    await handle?.close();
  });

  it('records index rows and file_events in one transaction per write', async () => {
    const created = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=pg%2Fdoc.md',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'first',
    });
    expect(created.statusCode).toBe(201);
    const createdData = created.json() as { data: { revision: string; version: number } };
    expect(createdData.data.version).toBe(1);

    const rev = createdData.data.revision;
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=pg%2Fdoc.md',
      headers: { ...AUTH_HEADERS, 'if-match': `"${rev}"`, 'content-type': 'text/plain' },
      payload: 'second',
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { data: { version: number } }).data.version).toBe(2);

    const rows = await db
      .select()
      .from(files)
      .where(and(eq(files.workspaceId, TEST_WORKSPACE_ID), eq(files.path, 'pg/doc.md')));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(2);
    expect(rows[0]?.contentHash).toBe(contentHashOf('second'));
    expect(rows[0]?.sizeBytes).toBe(6);
    expect(rows[0]?.mimeType).toBe('text/markdown');
    expect(rows[0]?.deletedAt).toBeNull();

    const events = await db
      .select()
      .from(fileEvents)
      .where(and(eq(fileEvents.workspaceId, TEST_WORKSPACE_ID), eq(fileEvents.path, 'pg/doc.md')))
      .orderBy(asc(fileEvents.id));
    expect(events.map((e) => e.eventType)).toEqual(['created', 'changed']);
    expect(events[0]?.actorId).toBe(TEST_USER_ID);
    expect(await readFile(join(root, 'pg', 'doc.md'), 'utf8')).toBe('second');
  });

  it('returns null from currentVersion for an unindexed path', async () => {
    const index = createPgWorkspaceIndex(db);
    expect(await index.currentVersion(TEST_WORKSPACE_ID, 'pg/never.md')).toBeNull();
  });

  it('replays through the Postgres idempotency store and rejects reuse', async () => {
    const created = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=pg%2Fidem.md',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'one\n',
    });
    expect(created.statusCode).toBe(201);
    const rev = (created.json() as { data: { revision: string } }).data.revision;
    const headers = {
      ...AUTH_HEADERS,
      'content-type': 'application/json',
      'idempotency-key': 'pg-key-1',
    };
    const payload = JSON.stringify({ expectedRevision: rev, content: 'two\n' });
    const first = await app.inject({ method: 'POST', url: '/api/workspace/file/append?path=pg%2Fidem.md', headers, payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/api/workspace/file/append?path=pg%2Fidem.md', headers, payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const rows = await db
      .select()
      .from(files)
      .where(and(eq(files.workspaceId, TEST_WORKSPACE_ID), eq(files.path, 'pg/idem.md')));
    expect(rows[0]?.version).toBe(2);
    const reused = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=pg%2Fidem.md',
      headers,
      payload: JSON.stringify({ expectedRevision: rev, content: 'THREE\n' }),
    });
    expect(reused.statusCode).toBe(409);
    expect((reused.json() as { error: { code: string } }).error.code).toBe('idempotency_key_reused');
  });

  it('treats an expired idempotency row as a miss', async () => {
    const store = createPgIdempotencyStore(db);
    await db.insert(idempotencyKeys).values({
      userId: TEST_USER_ID,
      scope: IDEMPOTENCY_SCOPE,
      key: 'pg-expired',
      requestHash: 'hash-old',
      responseStatus: 200,
      responseBody: {
        status: 200,
        data: { path: 'pg/old.md' },
        headers: { etag: '"x"', revision: 'x', lastModified: new Date(0).toUTCString(), version: undefined },
      },
      expiresAt: new Date(Date.now() - 1000),
    });
    const result = await store.lookup({
      userId: TEST_USER_ID,
      scope: IDEMPOTENCY_SCOPE,
      key: 'pg-expired',
      requestHash: 'hash-old',
    });
    expect(result.outcome).toBe('miss');
  });

  it('reports reuse from the store directly when the hash differs', async () => {
    const store = createPgIdempotencyStore(db);
    const response = {
      status: 201 as const,
      data: { path: 'pg/direct.md' },
      headers: { etag: '"r"', revision: 'r', lastModified: new Date().toUTCString(), version: '1' },
    };
    await store.store({
      userId: TEST_USER_ID,
      scope: IDEMPOTENCY_SCOPE,
      key: 'pg-direct',
      requestHash: 'hash-a',
      response,
    });
    const hit = await store.lookup({
      userId: TEST_USER_ID,
      scope: IDEMPOTENCY_SCOPE,
      key: 'pg-direct',
      requestHash: 'hash-a',
    });
    expect(hit.outcome).toBe('hit');
    if (hit.outcome === 'hit') {
      expect(hit.response.status).toBe(201);
    }
    const reused = await store.lookup({
      userId: TEST_USER_ID,
      scope: IDEMPOTENCY_SCOPE,
      key: 'pg-direct',
      requestHash: 'hash-b',
    });
    expect(reused.outcome).toBe('reused');
  });
});
