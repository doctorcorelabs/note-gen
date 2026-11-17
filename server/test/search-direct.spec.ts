// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Direct keyword search port (W4-WIRE, production loader) and
// the search wiring through buildApp. The shared engine's
// matching, ranking, snippet, and cursor behavior is pinned by
// search.spec.ts against the fake; this file pins the loader:
// the files walk (dot segments, symlinks, non-Markdown files),
// fail-closed behavior without a database or root, todo text
// extraction, and the fuzzy stub riding along through buildApp.
// The live section runs only when SEARCH_DIRECT_DATABASE_URL is
// set, against a scratch database carrying the canonical M8
// schema.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import {
  createDb,
  files,
  markTags,
  marks,
  tags,
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
import { ApiError } from '../src/plugins/envelope.js';
import { createDirectKeywordSearchPort } from '../src/services/search/direct.js';
import type { KeywordSearchInput } from '../src/services/search/port.js';
import { createDrizzleWorkspaceIdentityResolver } from '../src/services/workspace/reconcile-index-pg.js';
import { testConfig } from './auth/helpers.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'sess-1' };

function searchInput(overrides: Partial<KeywordSearchInput> = {}): KeywordSearchInput {
  return {
    principal: PRINCIPAL,
    query: 'jantung',
    scope: 'all',
    tagId: undefined,
    type: undefined,
    cursor: undefined,
    limit: 50,
    ...overrides,
  };
}

async function seedFiles(root: string): Promise<void> {
  await writeFile(join(root, 'jantung.md'), '# Gagal jantung\nTanda gagal jantung kanan.\n');
  await writeFile(join(root, 'obat.md'), 'Furosemid untuk jantung.\n');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'dalam.md'), 'Tidak ada kata kunci di sini.\n');
  await writeFile(join(root, 'notes.txt'), 'jantung dalam berkas txt.\n');
  await mkdir(join(root, '.hidden'), { recursive: true });
  await writeFile(join(root, '.hidden', 'rahasia.md'), 'jantung tersembunyi.\n');
  await symlink(join(root, 'jantung.md'), join(root, 'tautan.md'));
}

describe('direct keyword search port (files scope, no database)', () => {
  let root: string;

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function filesPort(rootOverride?: string) {
    root = await mkdtemp(join(tmpdir(), 'w4wire-search-'));
    await seedFiles(root);
    return createDirectKeywordSearchPort({
      workspaceRoot: rootOverride !== undefined ? rootOverride : root,
      resolveWorkspaceId: async () => null,
    });
  }

  it('finds Markdown files by content and name, skipping txt, dot segments, and symlinks', async () => {
    const port = await filesPort();
    const page = await port.search(searchInput({ scope: 'files' }));
    const paths = page.results.map((result) => (result.kind === 'file' ? result.path : '?')).sort();
    expect(paths).toEqual(['jantung.md', 'obat.md']);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    for (const result of page.results) {
      expect(result.kind).toBe('file');
      if (result.kind === 'file') {
        expect(result.version).toBe(0);
        expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(result.snippet.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it('requires every term (AND) and ranks name matches first', async () => {
    const port = await filesPort();
    const both = await port.search(searchInput({ query: 'gagal jantung', scope: 'files' }));
    expect(both.results.map((r) => (r.kind === 'file' ? r.path : '?'))).toEqual(['jantung.md']);
    const ranked = await port.search(searchInput({ query: 'jantung', scope: 'files' }));
    expect(ranked.results[0]?.kind).toBe('file');
    if (ranked.results[0]?.kind === 'file') {
      expect(ranked.results[0].path).toBe('jantung.md');
    }
  });

  it('paginates with opaque cursors replayable under a different limit', async () => {
    const port = await filesPort();
    const first = await port.search(searchInput({ scope: 'files', limit: 1 }));
    expect(first.results).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = await port.search(
      searchInput({ scope: 'files', limit: 10, cursor: first.nextCursor as string }),
    );
    expect(second.results).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.results[0]).not.toEqual(first.results[0]);
  });

  it('rejects a cursor carried to a different query', async () => {
    const port = await filesPort();
    const first = await port.search(searchInput({ scope: 'files', limit: 1 }));
    await expect(
      port.search(searchInput({ query: 'furosemid', scope: 'files', cursor: first.nextCursor as string })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_cursor' });
  });

  it('answers 503 for record scope without a database, and for files scope without a root', async () => {
    const port = await filesPort();
    await expect(port.search(searchInput({ scope: 'records' }))).rejects.toMatchObject({
      statusCode: 503,
      code: 'service_unavailable',
    });
    await expect(port.search(searchInput({ scope: 'all' }))).rejects.toMatchObject({
      statusCode: 503,
      code: 'service_unavailable',
    });
    const noRoot = createDirectKeywordSearchPort({
      workspaceRoot: undefined,
      resolveWorkspaceId: async () => null,
    });
    await expect(noRoot.search(searchInput({ scope: 'files' }))).rejects.toMatchObject({
      statusCode: 503,
      code: 'service_unavailable',
    });
  });
});

describe('search wiring through buildApp', () => {
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

  async function wiringApp(): Promise<FastifyInstance> {
    dir = await mkdtemp(join(tmpdir(), 'w4wire-search-app-'));
    app = await buildApp({
      config: testConfig({ workspaceRoot: dir }),
      pool: null,
      version: 'test',
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? PRINCIPAL : null),
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
      verifyOrigin: defaultVerifyOrigin,
    });
    return app;
  }

  it('answers 503 for keyword search without a database (default scope all)', async () => {
    const built = await wiringApp();
    const res = await built.inject({
      method: 'GET',
      url: '/api/search?q=jantung',
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('service_unavailable');
  });

  it('answers the 501 fuzzy stub through buildApp after auth and shape validation', async () => {
    const built = await wiringApp();
    const res = await built.inject({
      method: 'POST',
      url: '/api/search/fuzzy',
      headers: {
        cookie: 'notegen_session=good-session',
        origin: TEST_ORIGIN,
        'x-csrf-token': 'good-csrf',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        query: 'ggl jnt',
        items: [{ id: 'record:42', keys: { title: 'Catatan gagal jantung' } }],
        keys: ['title'],
      }),
    });
    expect(res.statusCode).toBe(501);
    expect((res.json() as { error: { code: string } }).error.code).toBe('fuzzy_search_unavailable');
  });
});

const PG_URL = process.env.SEARCH_DIRECT_DATABASE_URL;
const describePg = PG_URL === undefined ? describe.skip : describe;

describePg('direct keyword search port over Postgres (live)', () => {
  let handle: DbHandle;
  let root: string;
  let userId: string;
  let workspaceId: string;
  let tagId: number;
  let markIds: number[] = [];

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
    const tagRows = await handle.db
      .insert(tags)
      .values({ workspaceId, name: 'kardiologi' })
      .returning({ id: tags.id });
    tagId = tagRows[0]?.id as number;
    const markRows = await handle.db
      .insert(marks)
      .values([
        {
          workspaceId,
          tagId,
          type: 'text',
          content: 'Tanda gagal jantung kanan.',
          desc: 'Gagal jantung',
          url: '',
        },
        {
          workspaceId,
          tagId,
          type: 'todo',
          content: JSON.stringify({
            title: 'Beli furosemid',
            description: 'Untuk pasien jantung',
            priority: 'high',
            completed: false,
          }),
          desc: 'Beli furosemid',
          url: '',
        },
        {
          workspaceId,
          tagId,
          type: 'text',
          content: 'jantung yang sudah dihapus.',
          desc: 'Sampah',
          url: '',
          deletedAt: new Date(),
        },
      ])
      .returning({ id: marks.id });
    markIds = markRows.map((row) => row.id);
    for (const markId of markIds) {
      await handle.db.insert(markTags).values({ markId, tagId, workspaceId });
    }
    root = await mkdtemp(join(tmpdir(), 'w4wire-search-live-'));
    await writeFile(join(root, 'jantung.md'), 'Gagal jantung di berkas.\n');
    await handle.db.insert(files).values({
      workspaceId,
      path: 'jantung.md',
      contentHash: '0'.repeat(64),
      sizeBytes: 26,
      version: 7,
      mimeType: 'text/markdown',
    });
  });

  afterAll(async () => {
    await handle.db.delete(markTags).where(eq(markTags.workspaceId, workspaceId));
    for (const markId of markIds) {
      await handle.db.delete(marks).where(eq(marks.id, markId));
    }
    await handle.db.delete(files).where(eq(files.workspaceId, workspaceId));
    await handle.db.delete(tags).where(eq(tags.id, tagId));
    await handle.db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
    await handle.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await handle.db.delete(users).where(eq(users.id, userId));
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });

  function livePort() {
    const principal: SessionPrincipal = { userId, role: 'user', sessionId: 'sess-live' };
    return {
      principal,
      port: createDirectKeywordSearchPort({
        db: handle.db,
        workspaceRoot: root,
        resolveWorkspaceId: async (p) => {
          const identity = await createDrizzleWorkspaceIdentityResolver(handle.db)(p);
          return identity?.workspaceId ?? null;
        },
      }),
    };
  }

  it('searches records by desc/content, excludes trash, and honors the tag filter', async () => {
    const { principal, port } = livePort();
    const page = await port.search(searchInput({ principal, scope: 'records' }));
    const ids = page.results
      .map((r) => (r.kind === 'record' ? r.id : -1))
      .sort((a, b) => a - b);
    expect(ids).toEqual([markIds[0] as number, markIds[1] as number]);
    const tagged = await port.search(searchInput({ principal, scope: 'records', tagId }));
    expect(tagged.results).toHaveLength(2);
    const otherTag = await port.search(
      searchInput({ principal, scope: 'records', tagId: tagId + 100000 }),
    );
    expect(otherTag.results).toHaveLength(0);
  });

  it('matches todos over title and description, not over JSON envelope keys', async () => {
    const { principal, port } = livePort();
    const byDescription = await port.search(
      searchInput({ principal, query: 'pasien', scope: 'records' }),
    );
    expect(byDescription.results.map((r) => (r.kind === 'record' ? r.id : -1))).toEqual([
      markIds[1],
    ]);
    const byEnvelopeKey = await port.search(
      searchInput({ principal, query: 'completed', scope: 'records' }),
    );
    expect(byEnvelopeKey.results).toHaveLength(0);
  });

  it('fills file versions from the index when the database is available', async () => {
    const { principal, port } = livePort();
    const page = await port.search(searchInput({ principal, scope: 'files' }));
    expect(page.results).toHaveLength(1);
    const hit = page.results[0];
    expect(hit?.kind).toBe('file');
    if (hit?.kind === 'file') {
      expect(hit.path).toBe('jantung.md');
      expect(hit.version).toBe(7);
    }
  });

  it('answers 404 for a principal with no workspace', async () => {
    const { port } = livePort();
    const stranger: SessionPrincipal = {
      userId: '00000000-0000-4000-8000-000000000000',
      role: 'user',
      sessionId: 'sess-stranger',
    };
    let caught: unknown;
    try {
      await port.search(searchInput({ principal: stranger, scope: 'records' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).statusCode).toBe(404);
    expect((caught as ApiError).code).toBe('not_found');
  });
});
