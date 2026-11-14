// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Database tests for the group B db handlers (wiki, knowledge,
// vector) over real Postgres 17 with the frozen 0000 schema.
//
// Run with a scratch database URL, for example:
//
//   NOTEGEN_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/v3_13cr2_db pnpm vitest run test/db/handlers-b.spec.ts
//
// The setup creates the database when it does not exist, applies the
// versioned migrations, and seeds one user plus one fresh workspace
// per test (deleted afterwards, so domain rows cascade away). When
// the variable is unset the whole suite is skipped; the conformance
// suite in handlers-b-conformance.spec.ts always runs.
//
// Seeding writes rows directly through Drizzle (the test plays the
// Fase 2 writer for wiki payloads). Handler behavior is always
// exercised through the handler modules, inside one Drizzle
// transaction per call, the way the route layer calls them.

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ApiError } from '../../src/plugins/envelope.js';
import {
  createDb,
  knowledgeSources,
  users,
  vectorChunks,
  wikiJobs,
  wikiMeta,
  wikiPages,
  wikiRevisions,
  wikiSegments,
  wikiSources,
  workspaces,
  type Database,
} from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { handle as handleKnowledgeGetSource } from '../../src/services/db/knowledge-get-source.js';
import { handle as handleKnowledgeListSources } from '../../src/services/db/knowledge-list-sources.js';
import { handle as handleKnowledgeRemoveSource } from '../../src/services/db/knowledge-remove-source.js';
import { handle as handleKnowledgeStats } from '../../src/services/db/knowledge-stats.js';
import { handle as handleKnowledgeUpdateStatus } from '../../src/services/db/knowledge-update-status.js';
import { handle as handleKnowledgeUpsertSource } from '../../src/services/db/knowledge-upsert-source.js';
import { handle as handleVectorReplaceChunks } from '../../src/services/db/vector-replace-chunks.js';
import { handle as handleVectorSummaries } from '../../src/services/db/vector-summaries.js';
import { handle as handleWikiCommitRevision } from '../../src/services/db/wiki-commit-revision.js';
import { handle as handleWikiFindRevision } from '../../src/services/db/wiki-find-revision-by-input-hash.js';
import { handle as handleWikiGetActiveRevisions } from '../../src/services/db/wiki-get-active-revisions.js';
import { handle as handleWikiGetMeta } from '../../src/services/db/wiki-get-meta.js';
import { handle as handleWikiGetPage } from '../../src/services/db/wiki-get-page.js';
import { handle as handleWikiGetRevision } from '../../src/services/db/wiki-get-revision.js';
import { handle as handleWikiGetSegment } from '../../src/services/db/wiki-get-segment.js';
import { handle as handleWikiGetSourceState } from '../../src/services/db/wiki-get-source-state.js';
import { handle as handleWikiListJobs } from '../../src/services/db/wiki-list-jobs.js';
import { handle as handleWikiListPages } from '../../src/services/db/wiki-list-pages.js';
import { handle as handleWikiListSourceStates } from '../../src/services/db/wiki-list-source-states.js';
import { handle as handleWikiPutMeta } from '../../src/services/db/wiki-put-meta.js';
import { handle as handleWikiPutSegment } from '../../src/services/db/wiki-put-segment.js';
import { handle as handleWikiRemoveJob } from '../../src/services/db/wiki-remove-job.js';
import { handle as handleWikiUpsertJob } from '../../src/services/db/wiki-upsert-job.js';
import { handle as handleWikiUpsertPage } from '../../src/services/db/wiki-upsert-page.js';
import { handle as handleWikiUpsertSource } from '../../src/services/db/wiki-upsert-source.js';

const TEST_DATABASE_URL = process.env.NOTEGEN_TEST_DATABASE_URL;
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

function sourceKeyFor(n: number): string {
  return `article:notes/n${n}.md`;
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

describe.skipIf(TEST_DATABASE_URL === undefined)('group B handlers over Postgres', () => {
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
      .values({ login: `v3-13cr2-${Date.now()}`, passwordHash: 'test-only-not-a-secret' })
      .returning({ id: users.id });
    userId = inserted[0].id;
  }, 120_000);

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    const mine = await db
      .insert(workspaces)
      .values({ ownerId: userId, name: 'handlers-b' })
      .returning({ id: workspaces.id });
    workspaceId = mine[0].id;
    const other = await db
      .insert(workspaces)
      .values({ ownerId: userId, name: 'handlers-b-other' })
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

  async function seedKnowledge(
    ws: string,
    rows: Array<{
      key: string;
      type: 'article' | 'record' | 'canvas';
      id: string;
      hash: string;
      indexed?: string | null;
      status: 'pending' | 'indexing' | 'ready' | 'failed';
      updatedAt: number;
      title?: string;
      error?: string | null;
    }>,
  ): Promise<void> {
    for (const row of rows) {
      await db.insert(knowledgeSources).values({
        workspaceId: ws,
        sourceKey: row.key,
        sourceType: row.type,
        sourceId: row.id,
        title: row.title ?? row.id,
        locator: {},
        contentHash: row.hash,
        indexedHash: row.indexed ?? null,
        status: row.status,
        error: row.error ?? null,
        updatedAt: new Date(row.updatedAt),
      });
    }
  }

  async function readSource(ws: string, key: string) {
    const rows = await db
      .select()
      .from(knowledgeSources)
      .where(sql`${knowledgeSources.workspaceId} = ${ws} AND ${knowledgeSources.sourceKey} = ${key}`);
    return rows[0];
  }

  describe('knowledge reads', () => {
    it('returns the mapped row, and an empty array when missing', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', status: 'ready', updatedAt: BASE_TIME, indexed: 'h1' },
      ]);
      const found = await run(handleKnowledgeGetSource, {
        kind: 'knowledge.getSource',
        sourceKey: sourceKeyFor(1),
      });
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        sourceKey: sourceKeyFor(1),
        sourceType: 'article',
        sourceId: 'notes/n1.md',
        contentHash: 'h1',
        indexedHash: 'h1',
        status: 'ready',
        updatedAt: BASE_TIME,
      });
      const missing = await run(handleKnowledgeGetSource, {
        kind: 'knowledge.getSource',
        sourceKey: 'article:absent',
      });
      expect(missing).toEqual([]);
    });

    it('never returns a row owned by another workspace', async () => {
      await seedKnowledge(otherWorkspaceId, [
        { key: sourceKeyFor(2), type: 'article', id: 'notes/n2.md', hash: 'h2', status: 'ready', updatedAt: BASE_TIME },
      ]);
      const rows = await run(handleKnowledgeGetSource, {
        kind: 'knowledge.getSource',
        sourceKey: sourceKeyFor(2),
      });
      expect(rows).toEqual([]);
    });

    it('lists in updatedAt descending order with filters and empty-array means no filter', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', status: 'pending', updatedAt: BASE_TIME + 1000 },
        { key: 'record:7', type: 'record', id: '7', hash: 'h7', status: 'ready', updatedAt: BASE_TIME + 3000 },
        { key: 'canvas:c1', type: 'canvas', id: 'c1', hash: 'hc', status: 'failed', updatedAt: BASE_TIME + 2000 },
      ]);
      const all = await run(handleKnowledgeListSources, { kind: 'knowledge.listSources' });
      expect(all.map((row) => row.sourceKey)).toEqual(['record:7', 'canvas:c1', sourceKeyFor(1)]);
      const filtered = await run(handleKnowledgeListSources, {
        kind: 'knowledge.listSources',
        sourceTypes: ['article', 'canvas'],
        statuses: ['pending', 'failed'],
      });
      expect(filtered.map((row) => row.sourceKey)).toEqual(['canvas:c1', sourceKeyFor(1)]);
      const emptyFilter = await run(handleKnowledgeListSources, {
        kind: 'knowledge.listSources',
        sourceTypes: [],
        statuses: [],
      });
      expect(emptyFilter).toHaveLength(3);
    });

    it('pages with a cursor derived from the last row, without overlap', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', status: 'pending', updatedAt: BASE_TIME + 1000 },
        { key: sourceKeyFor(2), type: 'article', id: 'notes/n2.md', hash: 'h2', status: 'pending', updatedAt: BASE_TIME + 2000 },
        { key: sourceKeyFor(3), type: 'article', id: 'notes/n3.md', hash: 'h3', status: 'pending', updatedAt: BASE_TIME + 3000 },
      ]);
      const page1 = await run(handleKnowledgeListSources, {
        kind: 'knowledge.listSources',
        limit: 2,
      });
      expect(page1.map((row) => row.sourceKey)).toEqual([sourceKeyFor(3), sourceKeyFor(2)]);
      const last = page1[page1.length - 1];
      const cursor = `${last.updatedAt}:${encodeURIComponent(last.sourceKey)}`;
      const page2 = await run(handleKnowledgeListSources, {
        kind: 'knowledge.listSources',
        limit: 2,
        cursor,
      });
      expect(page2.map((row) => row.sourceKey)).toEqual([sourceKeyFor(1)]);
    });

    it('orders equal updatedAt rows by sourceKey and pages across the tie', async () => {
      await seedKnowledge(workspaceId, [
        { key: 'article:z', type: 'article', id: 'z', hash: 'hz', status: 'pending', updatedAt: BASE_TIME },
        { key: 'article:m', type: 'article', id: 'm', hash: 'hm', status: 'pending', updatedAt: BASE_TIME },
      ]);
      const page1 = await run(handleKnowledgeListSources, {
        kind: 'knowledge.listSources',
        limit: 1,
      });
      expect(page1.map((row) => row.sourceKey)).toEqual(['article:m']);
      const cursor = `${page1[0].updatedAt}:${encodeURIComponent(page1[0].sourceKey)}`;
      const page2 = await run(handleKnowledgeListSources, {
        kind: 'knowledge.listSources',
        limit: 1,
        cursor,
      });
      expect(page2.map((row) => row.sourceKey)).toEqual(['article:z']);
    });

    it('clamps an oversized limit instead of failing', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', status: 'pending', updatedAt: BASE_TIME },
      ]);
      const rows = await run(handleKnowledgeListSources, {
        kind: 'knowledge.listSources',
        limit: 500,
      });
      expect(rows).toHaveLength(1);
    });

    it('returns the full 12-cell stats grid with zeros', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', status: 'pending', updatedAt: BASE_TIME },
        { key: sourceKeyFor(2), type: 'article', id: 'notes/n2.md', hash: 'h2', status: 'pending', updatedAt: BASE_TIME },
        { key: sourceKeyFor(3), type: 'article', id: 'notes/n3.md', hash: 'h3', status: 'ready', updatedAt: BASE_TIME },
        { key: 'record:7', type: 'record', id: '7', hash: 'h7', status: 'failed', updatedAt: BASE_TIME },
      ]);
      await seedKnowledge(otherWorkspaceId, [
        { key: sourceKeyFor(9), type: 'canvas', id: 'c9', hash: 'h9', status: 'ready', updatedAt: BASE_TIME },
      ]);
      const [stats] = await run(handleKnowledgeStats, { kind: 'knowledge.stats' });
      expect(stats).toEqual({
        article: { pending: 2, indexing: 0, ready: 1, failed: 0 },
        record: { pending: 0, indexing: 0, ready: 0, failed: 1 },
        canvas: { pending: 0, indexing: 0, ready: 0, failed: 0 },
      });
    });
  });

  describe('knowledge.upsertSource hash machine', () => {
    function upsertOp(overrides: Record<string, unknown> = {}) {
      return {
        kind: 'knowledge.upsertSource',
        source: {
          sourceKey: sourceKeyFor(1),
          sourceType: 'article',
          sourceId: 'notes/n1.md',
          title: 'N1',
          contentHash: 'h1',
          updatedAt: BASE_TIME,
          locator: {},
          status: 'pending',
          ...overrides,
        },
      };
    }

    it('inserts a new source', async () => {
      const result = await run(handleKnowledgeUpsertSource, upsertOp());
      expect(result).toEqual({ affected: 1, id: sourceKeyFor(1) });
      const row = await readSource(workspaceId, sourceKeyFor(1));
      expect(row?.status).toBe('pending');
      expect(row?.contentHash).toBe('h1');
    });

    it('is a no-op for an unchanged hash on a ready source', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', indexed: 'h1', status: 'ready', updatedAt: BASE_TIME, title: 'Old' },
      ]);
      const result = await run(
        handleKnowledgeUpsertSource,
        upsertOp({ title: 'New', status: 'pending' }),
      );
      expect(result).toEqual({ affected: 0, id: sourceKeyFor(1) });
      const row = await readSource(workspaceId, sourceKeyFor(1));
      expect(row?.title).toBe('Old');
      expect(row?.status).toBe('ready');
      expect(row?.indexedHash).toBe('h1');
    });

    it('resets a ready source to pending on hash change and keeps the old indexed hash', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', indexed: 'h1', status: 'ready', updatedAt: BASE_TIME },
      ]);
      const result = await run(handleKnowledgeUpsertSource, upsertOp({ contentHash: 'h2', title: 'New' }));
      expect(result.affected).toBe(1);
      const row = await readSource(workspaceId, sourceKeyFor(1));
      expect(row?.status).toBe('pending');
      expect(row?.indexedHash).toBe('h1');
      expect(row?.contentHash).toBe('h2');
      expect(row?.title).toBe('New');
    });

    it('overwrites a non-ready source with the same hash', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', status: 'pending', updatedAt: BASE_TIME, title: 'Old' },
      ]);
      const result = await run(
        handleKnowledgeUpsertSource,
        upsertOp({ status: 'indexing', indexedHash: 'ix', title: 'New' }),
      );
      expect(result.affected).toBe(1);
      const row = await readSource(workspaceId, sourceKeyFor(1));
      expect(row?.status).toBe('indexing');
      expect(row?.indexedHash).toBe('ix');
      expect(row?.title).toBe('New');
    });
  });

  describe('knowledge.updateStatus guard and transitions', () => {
    it('applies a legal transition and overwrites hash and error', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', status: 'pending', updatedAt: BASE_TIME },
      ]);
      const result = await run(handleKnowledgeUpdateStatus, {
        kind: 'knowledge.updateStatus',
        sourceKey: sourceKeyFor(1),
        update: { status: 'indexing', indexedHash: 'ix', error: 'e' },
      });
      expect(result).toEqual({ affected: 1, id: sourceKeyFor(1) });
      const row = await readSource(workspaceId, sourceKeyFor(1));
      expect(row?.status).toBe('indexing');
      expect(row?.indexedHash).toBe('ix');
      expect(row?.error).toBe('e');
    });

    it('rejects a stale expectedStatus with 409 and the current status, writing nothing', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', status: 'pending', updatedAt: BASE_TIME },
      ]);
      const error = await expectApiErrorAsync(
        run(handleKnowledgeUpdateStatus, {
          kind: 'knowledge.updateStatus',
          sourceKey: sourceKeyFor(1),
          update: { status: 'indexing', expectedStatus: 'ready' },
        }),
        409,
        'revision_conflict',
      );
      expect(error.details.currentStatus).toBe('pending');
      const row = await readSource(workspaceId, sourceKeyFor(1));
      expect(row?.status).toBe('pending');
    });

    it('accepts a matching expectedStatus guard', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', status: 'pending', updatedAt: BASE_TIME },
      ]);
      const result = await run(handleKnowledgeUpdateStatus, {
        kind: 'knowledge.updateStatus',
        sourceKey: sourceKeyFor(1),
        update: { status: 'indexing', expectedStatus: 'pending' },
      });
      expect(result.affected).toBe(1);
    });

    it('rejects an illegal transition with 409, writing nothing', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', indexed: 'h1', status: 'ready', updatedAt: BASE_TIME },
      ]);
      await expectApiErrorAsync(
        run(handleKnowledgeUpdateStatus, {
          kind: 'knowledge.updateStatus',
          sourceKey: sourceKeyFor(1),
          update: { status: 'indexing' },
        }),
        409,
        'revision_conflict',
      );
      const row = await readSource(workspaceId, sourceKeyFor(1));
      expect(row?.status).toBe('ready');
    });

    it('retries a failed source to pending and clears the error', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', status: 'failed', updatedAt: BASE_TIME, error: 'boom' },
      ]);
      const result = await run(handleKnowledgeUpdateStatus, {
        kind: 'knowledge.updateStatus',
        sourceKey: sourceKeyFor(1),
        update: { status: 'pending' },
      });
      expect(result.affected).toBe(1);
      const row = await readSource(workspaceId, sourceKeyFor(1));
      expect(row?.status).toBe('pending');
      expect(row?.error).toBeNull();
    });

    it('answers affected 0 for a missing source and for another workspace', async () => {
      const missing = await run(handleKnowledgeUpdateStatus, {
        kind: 'knowledge.updateStatus',
        sourceKey: 'article:absent',
        update: { status: 'indexing' },
      });
      expect(missing).toEqual({ affected: 0, id: 'article:absent' });
      await seedKnowledge(otherWorkspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', status: 'pending', updatedAt: BASE_TIME },
      ]);
      const foreign = await run(handleKnowledgeUpdateStatus, {
        kind: 'knowledge.updateStatus',
        sourceKey: sourceKeyFor(1),
        update: { status: 'indexing' },
      });
      expect(foreign.affected).toBe(0);
      const row = await readSource(otherWorkspaceId, sourceKeyFor(1));
      expect(row?.status).toBe('pending');
    });
  });

  describe('knowledge.removeSource (D-12)', () => {
    it('deletes only the source row and leaves chunks for the index job', async () => {
      await seedKnowledge(workspaceId, [
        { key: sourceKeyFor(1), type: 'article', id: 'notes/n1.md', hash: 'h1', status: 'ready', updatedAt: BASE_TIME },
      ]);
      await db.insert(vectorChunks).values({
        workspaceId,
        sourceType: 'article',
        sourceId: 'notes/n1.md',
        chunkId: 0,
        content: 'chunk',
        embedding: '[0.1]',
        updatedAt: new Date(BASE_TIME),
      });
      const result = await run(handleKnowledgeRemoveSource, {
        kind: 'knowledge.removeSource',
        sourceKey: sourceKeyFor(1),
      });
      expect(result).toEqual({ affected: 1, id: sourceKeyFor(1) });
      expect(await readSource(workspaceId, sourceKeyFor(1))).toBeUndefined();
      const chunks = await db.select().from(vectorChunks);
      expect(chunks.filter((chunk) => chunk.workspaceId === workspaceId)).toHaveLength(1);
    });

    it('answers affected 0 for an absent source', async () => {
      const result = await run(handleKnowledgeRemoveSource, {
        kind: 'knowledge.removeSource',
        sourceKey: 'article:absent',
      });
      expect(result).toEqual({ affected: 0, id: 'article:absent' });
    });
  });

  describe('vector.summaries', () => {
    it('summarizes per source with the newest chunk time and no embedding', async () => {
      await db.insert(vectorChunks).values([
        { workspaceId, sourceType: 'article', sourceId: 'a.md', chunkId: 0, content: 'c0', embedding: '[0.1]', updatedAt: new Date(BASE_TIME + 1000) },
        { workspaceId, sourceType: 'article', sourceId: 'a.md', chunkId: 1, content: 'c1', embedding: '[0.2]', updatedAt: new Date(BASE_TIME + 3000) },
        { workspaceId, sourceType: 'record', sourceId: '7', chunkId: 0, content: 'c0', embedding: '[0.3]', updatedAt: new Date(BASE_TIME + 2000) },
      ]);
      await db.insert(vectorChunks).values({
        workspaceId: otherWorkspaceId,
        sourceType: 'canvas',
        sourceId: 'c1',
        chunkId: 0,
        content: 'other',
        embedding: '[0.9]',
        updatedAt: new Date(BASE_TIME),
      });
      const rows = await run(handleVectorSummaries, { kind: 'vector.summaries' });
      expect(rows).toEqual([
        { sourceType: 'article', sourceId: 'a.md', updatedAt: BASE_TIME + 3000 },
        { sourceType: 'record', sourceId: '7', updatedAt: BASE_TIME + 2000 },
      ]);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(['sourceId', 'sourceType', 'updatedAt']);
      }
    });

    it('returns an empty array when no chunks exist', async () => {
      const rows = await run(handleVectorSummaries, { kind: 'vector.summaries' });
      expect(rows).toEqual([]);
    });
  });

  describe('wiki reads', () => {
    const CONTEXT = 'ctx-a';
    const OTHER_CONTEXT = 'ctx-b';

    function sourceRef(stableId: string, overrides: Record<string, unknown> = {}) {
      return {
        stableId,
        sourceKey: `article:${stableId}`,
        sourceType: 'article',
        title: `Title ${stableId}`,
        locator: {},
        contentHash: 'h1',
        updatedAt: BASE_TIME,
        ...overrides,
      };
    }

    function statePayload(stableId: string, overrides: Record<string, unknown> = {}) {
      return {
        source: sourceRef(stableId),
        state: 'ready',
        status: 'ready',
        revisionId: null,
        ...overrides,
      };
    }

    function revisionPayload(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        revisionId: id,
        source: sourceRef('S1'),
        inputHash: 'in-1',
        outputHash: 'out-1',
        segments: [],
        ...overrides,
      };
    }

    async function seedWikiBasics(ws: string, contextId: string): Promise<void> {
      await db.insert(wikiSources).values([
        {
          workspaceId: ws,
          contextId,
          stableId: 'S2',
          sourceKey: 'article:S2',
          contentHash: 'h2',
          status: 'pending',
          revisionId: null,
          version: 1,
          payload: statePayload('S2', { state: 'pending', status: 'pending' }),
        },
        {
          workspaceId: ws,
          contextId,
          stableId: 'S1',
          sourceKey: 'article:S1',
          contentHash: 'h1',
          status: 'ready',
          revisionId: 'rev-1',
          version: 2,
          payload: statePayload('S1'),
        },
      ]);
      await db.insert(wikiRevisions).values([
        {
          workspaceId: ws,
          contextId,
          id: 'rev-2',
          sourceId: 'S1',
          inputHash: 'in-1',
          outputHash: 'out-b',
          payload: revisionPayload('rev-2', { outputHash: 'out-b' }),
        },
        {
          workspaceId: ws,
          contextId,
          id: 'rev-1',
          sourceId: 'S1',
          inputHash: 'in-1',
          outputHash: 'out-a',
          payload: revisionPayload('rev-1', { outputHash: 'out-a' }),
        },
      ]);
      await db.insert(wikiPages).values([
        { workspaceId: ws, contextId, id: 'p2', kind: 'topic', status: 'draft', payload: { id: 'p2', title: 'P2' } },
        { workspaceId: ws, contextId, id: 'p1', kind: 'topic', status: 'ready', payload: { id: 'p1', title: 'P1' } },
      ]);
      await db.insert(wikiJobs).values([
        { workspaceId: ws, contextId, id: 'j2', status: 'pending', readyAt: new Date(BASE_TIME + 2000), payload: { id: 'j2' } },
        { workspaceId: ws, contextId, id: 'j1', status: 'pending', readyAt: new Date(BASE_TIME + 1000), payload: { id: 'j1' } },
        { workspaceId: ws, contextId, id: 'j3', status: 'pending', readyAt: null, payload: { id: 'j3' } },
      ]);
      await db.insert(wikiSegments).values({
        workspaceId: ws,
        contextId,
        cacheKey: 'seg-1',
        payload: { key: 'seg-1', text: 'hello' },
      });
      await db.insert(wikiMeta).values({
        workspaceId: ws,
        contextId,
        key: 'meta-1',
        value: { version: 3 },
      });
    }

    it('gets and lists source states in stableId order, scoped by context and workspace', async () => {
      await seedWikiBasics(workspaceId, CONTEXT);
      await seedWikiBasics(otherWorkspaceId, CONTEXT);
      await seedWikiBasics(workspaceId, OTHER_CONTEXT);
      const one = await run(handleWikiGetSourceState, {
        kind: 'wiki.getSourceState',
        contextId: CONTEXT,
        stableId: 'S1',
      });
      expect(one).toHaveLength(1);
      expect(one[0]).toMatchObject({ state: 'ready', status: 'ready' });
      expect(one[0].source).toMatchObject({ stableId: 'S1' });
      const missing = await run(handleWikiGetSourceState, {
        kind: 'wiki.getSourceState',
        contextId: CONTEXT,
        stableId: 'absent',
      });
      expect(missing).toEqual([]);
      const all = await run(handleWikiListSourceStates, {
        kind: 'wiki.listSourceStates',
        contextId: CONTEXT,
      });
      expect(all.map((row) => row.source.stableId)).toEqual(['S1', 'S2']);
      const otherContext = await run(handleWikiListSourceStates, {
        kind: 'wiki.listSourceStates',
        contextId: OTHER_CONTEXT,
      });
      expect(otherContext).toHaveLength(2);
    });

    it('gets a revision and finds the smallest outputHash for an input hash', async () => {
      await seedWikiBasics(workspaceId, CONTEXT);
      const one = await run(handleWikiGetRevision, {
        kind: 'wiki.getRevision',
        contextId: CONTEXT,
        id: 'rev-2',
      });
      expect(one).toHaveLength(1);
      expect(one[0].id).toBe('rev-2');
      const found = await run(handleWikiFindRevision, {
        kind: 'wiki.findRevisionByInputHash',
        contextId: CONTEXT,
        inputHash: 'in-1',
      });
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe('rev-1');
      const absent = await run(handleWikiFindRevision, {
        kind: 'wiki.findRevisionByInputHash',
        contextId: CONTEXT,
        inputHash: 'nope',
      });
      expect(absent).toEqual([]);
    });

    it('returns only active revisions whose source state agrees on ready, id, and hash', async () => {
      const active = statePayload('S1', {
        source: sourceRef('S1', { title: 'State title' }),
        revisionId: 'rev-1',
      });
      await db.insert(wikiSources).values([
        { workspaceId, contextId: CONTEXT, stableId: 'S1', sourceKey: 'article:S1', contentHash: 'h1', status: 'ready', revisionId: 'rev-1', version: 1, payload: active },
        { workspaceId, contextId: CONTEXT, stableId: 'S2', sourceKey: 'article:S2', contentHash: 'h2', status: 'pending', revisionId: 'rev-2', version: 1, payload: statePayload('S2', { state: 'pending', status: 'pending', revisionId: 'rev-2' }) },
        { workspaceId, contextId: CONTEXT, stableId: 'S3', sourceKey: 'article:S3', contentHash: 'h3', status: 'ready', revisionId: 'rev-missing', version: 1, payload: statePayload('S3', { revisionId: 'rev-missing' }) },
        { workspaceId, contextId: CONTEXT, stableId: 'S4', sourceKey: 'article:S4', contentHash: 'h4-new', status: 'ready', revisionId: 'rev-4', version: 1, payload: statePayload('S4', { revisionId: 'rev-4' }) },
      ]);
      await db.insert(wikiRevisions).values([
        { workspaceId, contextId: CONTEXT, id: 'rev-1', sourceId: 'S1', inputHash: 'i1', outputHash: 'o1', payload: revisionPayload('rev-1', { source: sourceRef('S1', { title: 'Revision title', contentHash: 'h1' }) }) },
        { workspaceId, contextId: CONTEXT, id: 'rev-2', sourceId: 'S2', inputHash: 'i2', outputHash: 'o2', payload: revisionPayload('rev-2', { source: sourceRef('S2', { contentHash: 'h2' }) }) },
        { workspaceId, contextId: CONTEXT, id: 'rev-3', sourceId: 'S3', inputHash: 'i3', outputHash: 'o3', payload: revisionPayload('rev-3', { source: sourceRef('S3', { contentHash: 'h3' }) }) },
        { workspaceId, contextId: CONTEXT, id: 'rev-4', sourceId: 'S4', inputHash: 'i4', outputHash: 'o4', payload: revisionPayload('rev-4', { source: sourceRef('S4', { contentHash: 'h4-old' }) }) },
      ]);
      const rows = await run(handleWikiGetActiveRevisions, {
        kind: 'wiki.getActiveRevisions',
        contextId: CONTEXT,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('rev-1');
      expect(rows[0].source.title).toBe('State title');
    });

    it('lists pages in id order and gets one page', async () => {
      await seedWikiBasics(workspaceId, CONTEXT);
      const all = await run(handleWikiListPages, { kind: 'wiki.listPages', contextId: CONTEXT });
      expect(all.map((row) => row.id)).toEqual(['p1', 'p2']);
      const one = await run(handleWikiGetPage, { kind: 'wiki.getPage', contextId: CONTEXT, id: 'p2' });
      expect(one).toHaveLength(1);
      expect(one[0]).toMatchObject({ id: 'p2', title: 'P2' });
      const missing = await run(handleWikiGetPage, { kind: 'wiki.getPage', contextId: CONTEXT, id: 'absent' });
      expect(missing).toEqual([]);
    });

    it('lists jobs in readyAt order with nulls last', async () => {
      await seedWikiBasics(workspaceId, CONTEXT);
      const rows = await run(handleWikiListJobs, { kind: 'wiki.listJobs', contextId: CONTEXT });
      expect(rows.map((row) => row.id)).toEqual(['j1', 'j2', 'j3']);
    });

    it('gets a segment by key and an empty array on a miss', async () => {
      await seedWikiBasics(workspaceId, CONTEXT);
      const one = await run(handleWikiGetSegment, {
        kind: 'wiki.getSegment',
        contextId: CONTEXT,
        key: 'seg-1',
      });
      expect(one).toEqual([{ key: 'seg-1', text: 'hello' }]);
      const missing = await run(handleWikiGetSegment, {
        kind: 'wiki.getSegment',
        contextId: CONTEXT,
        key: 'absent',
      });
      expect(missing).toEqual([]);
    });

    it('gets meta as stored, distinguishes a miss from a stored JSON null', async () => {
      await seedWikiBasics(workspaceId, CONTEXT);
      const one = await run(handleWikiGetMeta, {
        kind: 'wiki.getMeta',
        contextId: CONTEXT,
        key: 'meta-1',
      });
      expect(one).toEqual([{ version: 3 }]);
      const missing = await run(handleWikiGetMeta, {
        kind: 'wiki.getMeta',
        contextId: CONTEXT,
        key: 'absent',
      });
      expect(missing).toEqual([]);
      await db.execute(
        sql`insert into wiki_meta (workspace_id, context_id, key, value) values (${workspaceId}, ${CONTEXT}, 'meta-null', 'null'::jsonb)`,
      );
      const storedNull = await run(handleWikiGetMeta, {
        kind: 'wiki.getMeta',
        contextId: CONTEXT,
        key: 'meta-null',
      });
      expect(storedNull).toEqual([null]);
    });
  });

  describe('all-or-nothing transactions', () => {
    it('rolls back an upsert when a later guard fails in the same transaction', async () => {
      await expectApiErrorAsync(
        db.transaction(async (tx) => {
          const ctx: Ctx = { tx, workspaceId, userId, requestId: 'test', transactionId: null };
          await handleKnowledgeUpsertSource(ctx, {
            kind: 'knowledge.upsertSource',
            source: {
              sourceKey: sourceKeyFor(1),
              sourceType: 'article',
              sourceId: 'notes/n1.md',
              title: 'N1',
              contentHash: 'h1',
              updatedAt: BASE_TIME,
              locator: {},
              status: 'pending',
            },
          });
          await handleKnowledgeUpdateStatus(ctx, {
            kind: 'knowledge.updateStatus',
            sourceKey: sourceKeyFor(1),
            update: { status: 'indexing', expectedStatus: 'ready' },
          });
        }),
        409,
        'revision_conflict',
      );
      expect(await readSource(workspaceId, sourceKeyFor(1))).toBeUndefined();
    });

    it('rolls back an upsert when a W2 stub throws 410 in the same transaction', async () => {
      const error = await expectApiErrorAsync(
        db.transaction(async (tx) => {
          const ctx: Ctx = { tx, workspaceId, userId, requestId: 'test', transactionId: null };
          await handleKnowledgeUpsertSource(ctx, {
            kind: 'knowledge.upsertSource',
            source: {
              sourceKey: sourceKeyFor(1),
              sourceType: 'article',
              sourceId: 'notes/n1.md',
              title: 'N1',
              contentHash: 'h1',
              updatedAt: BASE_TIME,
              locator: {},
              status: 'pending',
            },
          });
          await handleWikiUpsertSource(ctx, {
            kind: 'wiki.upsertSource',
            contextId: 'ctx',
            source: {},
          });
        }),
        410,
        'capability_unavailable',
      );
      expect(error.details.phase).toBe('Fase 2');
      expect(await readSource(workspaceId, sourceKeyFor(1))).toBeUndefined();
    });

    it('commits a multi-operation transaction when every operation succeeds', async () => {
      await db.transaction(async (tx) => {
        const ctx: Ctx = { tx, workspaceId, userId, requestId: 'test', transactionId: null };
        await handleKnowledgeUpsertSource(ctx, {
          kind: 'knowledge.upsertSource',
          source: {
            sourceKey: sourceKeyFor(1),
            sourceType: 'article',
            sourceId: 'notes/n1.md',
            title: 'N1',
            contentHash: 'h1',
            updatedAt: BASE_TIME,
            locator: {},
            status: 'pending',
          },
        });
        await handleKnowledgeUpdateStatus(ctx, {
          kind: 'knowledge.updateStatus',
          sourceKey: sourceKeyFor(1),
          update: { status: 'indexing' },
        });
      });
      const row = await readSource(workspaceId, sourceKeyFor(1));
      expect(row?.status).toBe('indexing');
    });

    it('rejects a forbidden field inside handle before any query runs', async () => {
      await expectApiErrorAsync(
        run(handleKnowledgeGetSource, {
          kind: 'knowledge.getSource',
          sourceKey: sourceKeyFor(1),
          sql: 'select 1',
        }),
        400,
        'validation_failed',
      );
    });
  });

  describe('W2 stubs inside a transaction', () => {
    it('answers 410 for every W2 kind without touching the database', async () => {
      const stubs: Array<{ kind: string; op: Record<string, unknown>; handle: (ctx: Ctx, op: unknown) => Promise<never> }> = [
        { kind: 'vector.replaceChunks', op: { kind: 'vector.replaceChunks', sourceType: 'article', sourceId: 'a', chunks: [], updatedAt: BASE_TIME }, handle: handleVectorReplaceChunks as (ctx: Ctx, op: unknown) => Promise<never> },
        { kind: 'wiki.upsertSource', op: { kind: 'wiki.upsertSource', contextId: 'ctx', source: {} }, handle: handleWikiUpsertSource as (ctx: Ctx, op: unknown) => Promise<never> },
        { kind: 'wiki.commitRevision', op: { kind: 'wiki.commitRevision', contextId: 'ctx', stableId: 'S1', revision: {} }, handle: handleWikiCommitRevision as (ctx: Ctx, op: unknown) => Promise<never> },
        { kind: 'wiki.upsertPage', op: { kind: 'wiki.upsertPage', contextId: 'ctx', page: {} }, handle: handleWikiUpsertPage as (ctx: Ctx, op: unknown) => Promise<never> },
        { kind: 'wiki.upsertJob', op: { kind: 'wiki.upsertJob', contextId: 'ctx', job: {} }, handle: handleWikiUpsertJob as (ctx: Ctx, op: unknown) => Promise<never> },
        { kind: 'wiki.removeJob', op: { kind: 'wiki.removeJob', contextId: 'ctx', id: 'j1' }, handle: handleWikiRemoveJob as (ctx: Ctx, op: unknown) => Promise<never> },
        { kind: 'wiki.putSegment', op: { kind: 'wiki.putSegment', contextId: 'ctx', key: 'k', value: {} }, handle: handleWikiPutSegment as (ctx: Ctx, op: unknown) => Promise<never> },
        { kind: 'wiki.putMeta', op: { kind: 'wiki.putMeta', contextId: 'ctx', key: 'k', value: {} }, handle: handleWikiPutMeta as (ctx: Ctx, op: unknown) => Promise<never> },
      ];
      for (const stub of stubs) {
        const error = await expectApiErrorAsync(
          db.transaction(async (tx) => {
            const ctx: Ctx = { tx, workspaceId, userId, requestId: 'test', transactionId: null };
            await stub.handle(ctx, stub.op);
          }),
          410,
          'capability_unavailable',
        );
        expect(error.details.kind).toBe(stub.kind);
        expect(error.details.phase).toBe('Fase 2');
      }
    });
  });
});
