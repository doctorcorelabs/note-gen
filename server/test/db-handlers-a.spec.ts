// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the group A handler kinds (V3-13bR, wave 3A): conversations,
// messages, compactions, canvases, memories, policy, imageCache.
//
// Validation tests and the W2 410 tests run always. Database tests run
// only when HANDLERS_A_DATABASE_URL is set; they seed one user plus two
// workspaces in that database, exercise handlers through
// db.transaction, and remove the seeded rows afterwards. Example:
//   HANDLERS_A_DATABASE_URL=postgres://postgres@127.0.0.1:55433/v3_13b_db pnpm test test/db-handlers-a.spec.ts
//
// The W2 stubs (memories.create/update/delete, policy.put) must reject
// from validate with 410 capability_unavailable naming kind and phase,
// so the dispatch preflight rejects the request before execution.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ApiError } from '../src/plugins/envelope.js';
import {
  activityEvents,
  canvases,
  chatMessages,
  conversationCompactions,
  conversations,
  createDb,
  imageAnalysisCache,
  memories,
  memoryJobs,
  memoryPolicies,
  tags,
  users,
  workspaceMembers,
  workspaces,
  type Database,
  type DbHandle,
} from '../src/db/index.js';
import * as canvasesCreate from '../src/services/db/canvases-create.js';
import * as canvasesGet from '../src/services/db/canvases-get.js';
import * as canvasesList from '../src/services/db/canvases-list.js';
import * as canvasesRestore from '../src/services/db/canvases-restore.js';
import * as canvasesSave from '../src/services/db/canvases-save.js';
import * as canvasesSoftDelete from '../src/services/db/canvases-soft-delete.js';
import * as compactionsInsert from '../src/services/db/compactions-insert.js';
import * as compactionsList from '../src/services/db/compactions-list-by-conversation.js';
import * as conversationsCreate from '../src/services/db/conversations-create.js';
import * as conversationsDelete from '../src/services/db/conversations-delete.js';
import * as conversationsGet from '../src/services/db/conversations-get.js';
import * as conversationsList from '../src/services/db/conversations-list.js';
import * as conversationsUpdate from '../src/services/db/conversations-update.js';
import * as imageCacheGet from '../src/services/db/image-cache-get.js';
import * as imageCachePut from '../src/services/db/image-cache-put.js';
import * as memoriesCreate from '../src/services/db/memories-create.js';
import * as memoriesDelete from '../src/services/db/memories-delete.js';
import * as memoriesGet from '../src/services/db/memories-get.js';
import * as memoriesList from '../src/services/db/memories-list.js';
import * as memoriesStats from '../src/services/db/memories-stats.js';
import * as memoriesUpdate from '../src/services/db/memories-update.js';
import * as messagesAppend from '../src/services/db/messages-append.js';
import * as messagesDelete from '../src/services/db/messages-delete.js';
import * as messagesGet from '../src/services/db/messages-get.js';
import * as messagesListByConversation from '../src/services/db/messages-list-by-conversation.js';
import * as messagesListByTag from '../src/services/db/messages-list-by-tag.js';
import * as messagesUpdate from '../src/services/db/messages-update.js';
import * as policyGet from '../src/services/db/policy-get.js';
import * as policyPut from '../src/services/db/policy-put.js';

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

describe('handler validation (no database)', () => {
  it('rejects unknown operation fields', () => {
    expect(() => conversationsGet.validate({ kind: 'conversations.get', id: 1, extra: true })).toThrow(
      ApiError,
    );
  });

  it('rejects a bad chat role in messages.append', () => {
    expect(() =>
      messagesAppend.validate({
        kind: 'messages.append',
        conversationId: 1,
        message: { role: 'assistant', type: 'chat' },
      }),
    ).toThrow(ApiError);
  });

  it('rejects a malformed pagination cursor and an invalid limit', () => {
    expect(() =>
      conversationsList.validate({ kind: 'conversations.list', cursor: 'bogus' }),
    ).toThrow(ApiError);
    expect(() => conversationsList.validate({ kind: 'conversations.list', limit: 0 })).toThrow(
      ApiError,
    );
  });

  it('rejects an empty canvas save patch and a non-UUID canvas id', () => {
    expect(() =>
      canvasesSave.validate({ kind: 'canvases.save', id: randomUUID(), patch: {}, expected: { version: 1 } }),
    ).toThrow(ApiError);
    expect(() => canvasesGet.validate({ kind: 'canvases.get', id: 'not-a-uuid' })).toThrow(ApiError);
  });

  it('rejects unknown patch fields in messages.update', () => {
    expect(() =>
      messagesUpdate.validate({
        kind: 'messages.update',
        id: 1,
        patch: { bogusField: 1 },
      }),
    ).toThrow(ApiError);
  });

  it('answers W2 kinds with 410 capability_unavailable naming kind and phase', () => {
    const stubs = [memoriesCreate, memoriesUpdate, memoriesDelete, policyPut];
    for (const stub of stubs) {
      let caught: unknown;
      try {
        stub.validate({ kind: stub.HANDLER_KIND });
      } catch (error) {
        caught = error;
      }
      const apiError = expectApiError(caught, 410, 'capability_unavailable');
      expect(apiError.details).toMatchObject({ kind: stub.HANDLER_KIND, phase: 'Fase 2' });
      expect(apiError.message).toMatch(/Fase 2/);
    }
  });
});

const DATABASE_URL = process.env.HANDLERS_A_DATABASE_URL;
const dbDescribe = DATABASE_URL === undefined ? describe.skip : describe;

dbDescribe('group A handlers against Postgres', () => {
  let db: Database;
  let handle: DbHandle;
  let userId = '';
  let workspaceId = '';
  let otherWorkspaceId = '';
  let tagId = 0;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL as string, { max: 5 });
    db = handle.db;
    const userRows = await db
      .insert(users)
      .values({ email: `v313br-${randomUUID()}`, passwordHash: 'test-hash' })
      .returning({ id: users.id });
    userId = userRows[0]?.id as string;
    const wsRows = await db
      .insert(workspaces)
      .values([
        { ownerUserId: userId, name: 'v313br main' },
        { ownerUserId: userId, name: 'v313br other' },
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
      .values({ workspaceId, name: 'v313br-tag' })
      .returning({ id: tags.id });
    tagId = tagRows[0]?.id as number;
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
        { tx, workspaceId: ws, userId, requestId: 'v313br-test', transactionId: null },
        op,
      );
    });
  }

  async function makeConversation(title = 'Conv'): Promise<number> {
    const result = await run(conversationsCreate, {
      kind: 'conversations.create',
      title,
    });
    return result.id as number;
  }

  async function appendMessage(conversationId: number, content = 'hello'): Promise<number> {
    const result = await run(messagesAppend, {
      kind: 'messages.append',
      message: { role: 'user', type: 'chat', content, inserted: false, conversationId },
    });
    return result.id as number;
  }

  it('conversations: create, get, pin ordering, and cursor pagination', async () => {
    const first = await makeConversation('First');
    const second = await makeConversation('Second');
    const third = await makeConversation('Third');
    await run(conversationsUpdate, {
      kind: 'conversations.update',
      id: first,
      patch: { isPinned: true },
    });
    await run(conversationsUpdate, {
      kind: 'conversations.update',
      id: third,
      patch: { title: 'Third renamed' },
    });
    const page = await run(conversationsList, { kind: 'conversations.list', limit: 2 });
    expect(page.map((row) => row.id)).toEqual([first, third]);
    const cursor = `${page[1]?.isPinned ? 1 : 0}:${page[1]?.updatedAt}:${page[1]?.id}`;
    const rest = await run(conversationsList, {
      kind: 'conversations.list',
      limit: 2,
      cursor,
    });
    expect(rest.map((row) => row.id)).toContain(second);
    expect(rest.map((row) => row.id)).not.toContain(first);
    const fetched = await run(conversationsGet, { kind: 'conversations.get', id: first });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.title).toBe('First');
    expect(fetched[0]?.isPinned).toBe(true);
    expect(await run(conversationsGet, { kind: 'conversations.get', id: 999_999_999 })).toEqual([]);
    expect(await run(conversationsGet, { kind: 'conversations.get', id: first }, otherWorkspaceId)).toEqual(
      [],
    );
  });

  it('conversations.update: optimistic guard mismatch answers 409 with a snapshot', async () => {
    const id = await makeConversation('Guarded');
    const current = (await run(conversationsGet, { kind: 'conversations.get', id }))[0];
    const ok = await run(conversationsUpdate, {
      kind: 'conversations.update',
      id,
      patch: { title: 'Guarded 2' },
      expected: { version: current?.version as number },
    });
    expect(ok.affected).toBe(1);
    expect(ok.version).toBe((current?.version ?? 0) + 1);
    let caught: unknown;
    try {
      await run(conversationsUpdate, {
        kind: 'conversations.update',
        id,
        patch: { title: 'Stale' },
        expected: { version: current?.version as number },
      });
    } catch (error) {
      caught = error;
    }
    const apiError = expectApiError(caught, 409, 'revision_conflict');
    expect(apiError.details).toMatchObject({ currentVersion: ok.version });
    await expect(
      run(conversationsUpdate, { kind: 'conversations.update', id: 999_999_999, patch: { title: 'x' } }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('messages.append: bumps count and version, writes no activity event (D-04)', async () => {
    const id = await makeConversation('Append');
    const before = (await run(conversationsGet, { kind: 'conversations.get', id }))[0];
    const result = await run(messagesAppend, {
      kind: 'messages.append',
      message: { role: 'user', type: 'chat', content: 'hi', inserted: false, conversationId: id },
    });
    expect(result.affected).toBe(1);
    expect(result.version).toBe((before?.version ?? 0) + 1);
    const after = (await run(conversationsGet, { kind: 'conversations.get', id }))[0];
    expect(after?.messageCount).toBe(1);
    const events = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.workspaceId, workspaceId));
    expect(events).toHaveLength(0);
  });

  it('messages.append: guard mismatch answers 409 with count and version snapshot', async () => {
    const id = await makeConversation('Append guard');
    await appendMessage(id);
    let caught: unknown;
    try {
      await run(messagesAppend, {
        kind: 'messages.append',
        message: { role: 'user', type: 'chat', content: 'x', inserted: false, conversationId: id },
        expectedConversationVersion: 99,
      });
    } catch (error) {
      caught = error;
    }
    const apiError = expectApiError(caught, 409, 'revision_conflict');
    expect(apiError.details).toMatchObject({ currentMessageCount: 1 });
    const current = (await run(conversationsGet, { kind: 'conversations.get', id }))[0];
    const ok = await run(messagesAppend, {
      kind: 'messages.append',
      message: { role: 'user', type: 'chat', content: 'y', inserted: false, conversationId: id },
      expectedConversationVersion: current?.version,
    });
    expect(ok.affected).toBe(1);
  });

  it('messages.get: returns the row, [] when missing, [] for a negative id', async () => {
    const conversationId = await makeConversation('Get');
    const messageId = await appendMessage(conversationId);
    const found = await run(messagesGet, { kind: 'messages.get', id: messageId });
    expect(found).toHaveLength(1);
    expect(found[0]?.content).toBe('hello');
    expect(await run(messagesGet, { kind: 'messages.get', id: 999_999_999 })).toEqual([]);
    expect(await run(messagesGet, { kind: 'messages.get', id: -1 })).toEqual([]);
    expect(await run(messagesGet, { kind: 'messages.get', id: messageId }, otherWorkspaceId)).toEqual([]);
  });

  it('messages.listByConversation: id order and cursor pages', async () => {
    const conversationId = await makeConversation('List');
    const ids = [await appendMessage(conversationId, 'a'), await appendMessage(conversationId, 'b'), await appendMessage(conversationId, 'c')];
    const page = await run(messagesListByConversation, {
      kind: 'messages.listByConversation',
      conversationId,
      limit: 2,
    });
    expect(page.map((row) => row.id)).toEqual([ids[0], ids[1]]);
    const rest = await run(messagesListByConversation, {
      kind: 'messages.listByConversation',
      conversationId,
      limit: 2,
      cursor: String(ids[1]),
    });
    expect(rest.map((row) => row.id)).toEqual([ids[2]]);
  });

  it('messages.listByTag: filters by tag and orders by createdAt', async () => {
    const conversationId = await makeConversation('Tag');
    const tagged = await appendMessage(conversationId, 'tagged');
    await appendMessage(conversationId, 'plain');
    await run(messagesUpdate, {
      kind: 'messages.update',
      id: tagged,
      patch: { tagId },
    });
    const rows = await run(messagesListByTag, { kind: 'messages.listByTag', tagId });
    expect(rows.map((row) => row.id)).toContain(tagged);
    expect(rows.every((row) => row.tagId === tagId)).toBe(true);
  });

  it('messages.update: D-05 guard match writes, guard miss writes nothing and answers affected 0', async () => {
    const conversationId = await makeConversation('Patch');
    const messageId = await appendMessage(conversationId, 'original');
    await run(compactionsInsert, {
      kind: 'compactions.insert',
      compaction: { conversationId, coveredThroughChatId: messageId, summary: 's', model: 'test-model', sourceTokenCount: 10, summaryTokenCount: 5, promptVersion: 1, retainedTurnCount: 0, prunedToolResultCount: 0, prunedToolTokenCount: 0 },
    });
    const miss = await run(messagesUpdate, {
      kind: 'messages.update',
      id: messageId,
      patch: { content: 'should not land' },
      expectedAgentHistory: '{"expected":true}',
    });
    expect(miss.affected).toBe(0);
    const untouched = (await run(messagesGet, { kind: 'messages.get', id: messageId }))[0];
    expect(untouched?.content).toBe('original');
    const compactionsAfterMiss = await run(compactionsList, {
      kind: 'compactions.listByConversation',
      conversationId,
    });
    expect(compactionsAfterMiss).toHaveLength(1);
    const hit = await run(messagesUpdate, {
      kind: 'messages.update',
      id: messageId,
      patch: { content: 'patched', agentHistory: '[]' },
      expectedAgentHistory: null,
    });
    expect(hit.affected).toBe(1);
    const patched = (await run(messagesGet, { kind: 'messages.get', id: messageId }))[0];
    expect(patched?.content).toBe('patched');
    const compactionsAfterHit = await run(compactionsList, {
      kind: 'compactions.listByConversation',
      conversationId,
    });
    expect(compactionsAfterHit).toHaveLength(0);
  });

  it('messages.delete: decrements count and invalidates compactions', async () => {
    const conversationId = await makeConversation('Delete msg');
    const messageId = await appendMessage(conversationId);
    await run(compactionsInsert, {
      kind: 'compactions.insert',
      compaction: { conversationId, coveredThroughChatId: messageId, summary: 's', model: 'test-model', sourceTokenCount: 10, summaryTokenCount: 5, promptVersion: 1, retainedTurnCount: 0, prunedToolResultCount: 0, prunedToolTokenCount: 0 },
    });
    const result = await run(messagesDelete, { kind: 'messages.delete', id: messageId });
    expect(result.affected).toBe(1);
    const after = (await run(conversationsGet, { kind: 'conversations.get', id: conversationId }))[0];
    expect(after?.messageCount).toBe(0);
    const compactions = await run(compactionsList, {
      kind: 'compactions.listByConversation',
      conversationId,
    });
    expect(compactions).toHaveLength(0);
    await expect(
      run(messagesDelete, { kind: 'messages.delete', id: messageId }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('compactions: server-assigned revisions, revision descending order, limit 1 is latest (D-13)', async () => {
    const conversationId = await makeConversation('Compaction');
    const messageId = await appendMessage(conversationId);
    await run(compactionsInsert, {
      kind: 'compactions.insert',
      compaction: { conversationId, coveredThroughChatId: messageId, summary: 'first', model: 'test-model', sourceTokenCount: 10, summaryTokenCount: 5, promptVersion: 1, retainedTurnCount: 0, prunedToolResultCount: 0, prunedToolTokenCount: 0 },
    });
    await run(compactionsInsert, {
      kind: 'compactions.insert',
      compaction: { conversationId, coveredThroughChatId: messageId, summary: 'second', model: 'test-model', sourceTokenCount: 10, summaryTokenCount: 5, promptVersion: 1, retainedTurnCount: 0, prunedToolResultCount: 0, prunedToolTokenCount: 0 },
    });
    const all = await run(compactionsList, {
      kind: 'compactions.listByConversation',
      conversationId,
    });
    expect(all.map((row) => row.revision)).toEqual([2, 1]);
    const latest = await run(compactionsList, {
      kind: 'compactions.listByConversation',
      conversationId,
      limit: 1,
    });
    expect(latest).toHaveLength(1);
    expect(latest[0]?.revision).toBe(2);
    const cursor = `${latest[0]?.revision}:${latest[0]?.id}`;
    const older = await run(compactionsList, {
      kind: 'compactions.listByConversation',
      conversationId,
      cursor,
    });
    expect(older.map((row) => row.revision)).toEqual([1]);
  });

  it('conversations.delete: cascades messages, compactions, and memory_jobs (G-05)', async () => {
    const id = await makeConversation('Cascade');
    const messageId = await appendMessage(id);
    await run(compactionsInsert, {
      kind: 'compactions.insert',
      compaction: { conversationId: id, coveredThroughChatId: messageId, summary: 's', model: 'test-model', sourceTokenCount: 10, summaryTokenCount: 5, promptVersion: 1, retainedTurnCount: 0, prunedToolResultCount: 0, prunedToolTokenCount: 0 },
    });
    await db.insert(memoryJobs).values({
      workspaceId,
      conversationId: id,
      revision: 1,
      status: 'pending',
    });
    const result = await run(conversationsDelete, { kind: 'conversations.delete', id });
    expect(result.affected).toBe(1);
    expect(await db.select().from(chatMessages).where(eq(chatMessages.conversationId, id))).toHaveLength(0);
    expect(
      await db.select().from(conversationCompactions).where(eq(conversationCompactions.conversationId, id)),
    ).toHaveLength(0);
    expect(await db.select().from(memoryJobs).where(eq(memoryJobs.conversationId, id))).toHaveLength(0);
    await expect(run(conversationsDelete, { kind: 'conversations.delete', id })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('canvases: create with default document, duplicate id answers 409, get returns soft-deleted rows', async () => {
    const canvasId = randomUUID();
    const created = await run(canvasesCreate, {
      kind: 'canvases.create',
      canvas: { id: canvasId, title: 'Board', canvasType: 'mindmap' },
    });
    expect(created.affected).toBe(1);
    expect(created.id).toBe(canvasId);
    const fetched = (await run(canvasesGet, { kind: 'canvases.get', id: canvasId }))[0];
    expect(fetched?.title).toBe('Board');
    expect(fetched?.document).toMatchObject({ schemaVersion: 1, nodes: [], edges: [] });
    await expect(
      run(canvasesCreate, {
        kind: 'canvases.create',
        canvas: { id: canvasId, title: 'Dup', canvasType: 'blank' },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'already_exists' });
    await run(canvasesSoftDelete, { kind: 'canvases.softDelete', id: canvasId });
    expect(await run(canvasesGet, { kind: 'canvases.get', id: canvasId })).toHaveLength(1);
    const visible = await run(canvasesList, { kind: 'canvases.list' });
    expect(visible.map((row) => row.id)).not.toContain(canvasId);
    const withDeleted = await run(canvasesList, { kind: 'canvases.list', includeDeleted: true });
    expect(withDeleted.map((row) => row.id)).toContain(canvasId);
    await run(canvasesRestore, { kind: 'canvases.restore', id: canvasId });
    const restored = await run(canvasesList, { kind: 'canvases.list' });
    expect(restored.map((row) => row.id)).toContain(canvasId);
  });

  it('canvases.save: guard mismatch answers 409, force save wins, title-only patch keeps the document', async () => {
    const canvasId = randomUUID();
    await run(canvasesCreate, {
      kind: 'canvases.create',
      canvas: { id: canvasId, title: 'Save', canvasType: 'blank' },
    });
    const current = (await run(canvasesGet, { kind: 'canvases.get', id: canvasId }))[0];
    const document = {
      schemaVersion: 1,
      nodes: [{ id: 'n1', type: 'chat', x: 0, y: 0 }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: { layoutDirection: 'TB', showGrid: true, snapToGrid: false },
    };
    const saved = await run(canvasesSave, {
      kind: 'canvases.save',
      id: canvasId,
      patch: { document },
      expected: { version: current?.version as number },
    });
    expect(saved.affected).toBe(1);
    expect(saved.version).toBe((current?.version ?? 0) + 1);
    let caught: unknown;
    try {
      await run(canvasesSave, {
        kind: 'canvases.save',
        id: canvasId,
        patch: { title: 'stale' },
        expected: { version: current?.version as number },
      });
    } catch (error) {
      caught = error;
    }
    expectApiError(caught, 409, 'revision_conflict');
    const forced = await run(canvasesSave, {
      kind: 'canvases.save',
      id: canvasId,
      patch: { title: 'forced' },
      expected: { version: current?.version as number },
      force: true,
    });
    expect(forced.affected).toBe(1);
    const afterForce = (await run(canvasesGet, { kind: 'canvases.get', id: canvasId }))[0];
    expect(afterForce?.title).toBe('forced');
    expect(afterForce?.document).toMatchObject({ nodes: [{ id: 'n1' }] });
  });

  it('memories: list filters, get, stats, and no embedding in output', async () => {
    await db.insert(memories).values([
      {
        id: `mem-pref-${randomUUID()}`,
        workspaceId,
        content: 'likes tea',
        category: 'preference',
        kind: 'preference',
        status: 'active',
        accessCount: 3,
        embedding: 'vec',
      },
      {
        id: `mem-fact-${randomUUID()}`,
        workspaceId,
        content: 'project deadline',
        category: 'memory',
        kind: 'fact',
        status: 'active',
        accessCount: 2,
        embedding: 'vec',
      },
      {
        id: `mem-pending-${randomUUID()}`,
        workspaceId,
        content: 'draft note',
        category: 'memory',
        kind: 'fact',
        status: 'pending',
        accessCount: 1,
      },
      {
        id: `mem-archived-${randomUUID()}`,
        workspaceId,
        content: 'old note',
        category: 'memory',
        kind: 'fact',
        status: 'archived',
        accessCount: 5,
      },
    ]);
    const listed = await run(memoriesList, { kind: 'memories.list' });
    expect(listed.map((row) => row.status)).not.toContain('archived');
    expect(listed.every((row) => !('embedding' in row))).toBe(true);
    const all = await run(memoriesList, { kind: 'memories.list', includeInactive: true });
    expect(all).toHaveLength(4);
    const prefs = await run(memoriesList, { kind: 'memories.list', category: 'preference' });
    expect(prefs).toHaveLength(1);
    const archived = await run(memoriesList, { kind: 'memories.list', status: 'archived' });
    expect(archived).toHaveLength(1);
    const firstRow = listed[0];
    const fetched = await run(memoriesGet, { kind: 'memories.get', id: firstRow?.id as string });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.lastAccessedAt).toBe(0);
    const stats = (await run(memoriesStats, { kind: 'memories.stats' }))[0];
    expect(stats).toMatchObject({
      total: 3,
      preferences: 1,
      memories: 1,
      pending: 1,
      archived: 1,
      totalAccessCount: 11,
    });
  });

  it('memories.list: cursor pages through rows', async () => {
    const page = await run(memoriesList, { kind: 'memories.list', limit: 2, includeInactive: true });
    expect(page).toHaveLength(2);
    const cursor = `${page[1]?.updatedAt}:${page[1]?.id}`;
    const rest = await run(memoriesList, {
      kind: 'memories.list',
      limit: 2,
      includeInactive: true,
      cursor,
    });
    expect(rest).toHaveLength(2);
    expect(rest.map((row) => row.id)).not.toContain(page[0]?.id);
  });

  it('policy.get: defaults when no row exists, stored values when a row exists', async () => {
    const defaults = (await run(policyGet, { kind: 'policy.get' }))[0];
    expect(defaults).toMatchObject({
      useMemories: true,
      generateMemories: true,
      excludeExternalContext: true,
      generationStartedAt: 0,
    });
    await db.insert(memoryPolicies).values({
      userId,
      useMemories: false,
      generateMemories: true,
      excludeExternalContext: false,
      generationStartedAt: new Date(1_700_000_000_000),
    });
    const stored = (await run(policyGet, { kind: 'policy.get' }))[0];
    expect(stored).toMatchObject({
      useMemories: false,
      generateMemories: true,
      excludeExternalContext: false,
      generationStartedAt: 1_700_000_000_000,
    });
  });

  it('imageCache: put and get round trip, expired rows miss, default TTL is 30 days', async () => {
    const key = `key-${randomUUID()}`;
    const put = await run(imageCachePut, {
      kind: 'imageCache.put',
      entry: { cacheKey: key, imageHash: 'h1', queryHash: 'q1', ocrText: 'text' },
    });
    expect(put).toMatchObject({ affected: 1, id: key });
    const fetched = (await run(imageCacheGet, { kind: 'imageCache.get', cacheKey: key }))[0];
    expect(fetched?.ocrText).toBe('text');
    expect((fetched?.expiresAt ?? 0) - (fetched?.updatedAt ?? 0)).toBe(
      imageCachePut.IMAGE_CACHE_DEFAULT_TTL_MS,
    );
    const expiredKey = `key-${randomUUID()}`;
    await run(imageCachePut, {
      kind: 'imageCache.put',
      entry: {
        cacheKey: expiredKey,
        imageHash: 'h2',
        queryHash: 'q2',
        expiresAt: Date.now() - 1_000,
      },
    });
    expect(await run(imageCacheGet, { kind: 'imageCache.get', cacheKey: expiredKey })).toEqual([]);
    const futureKey = `key-${randomUUID()}`;
    await run(imageCachePut, {
      kind: 'imageCache.put',
      entry: {
        cacheKey: futureKey,
        imageHash: 'h3',
        queryHash: 'q3',
        expiresAt: Date.now() + 60_000,
      },
    });
    expect(await run(imageCacheGet, { kind: 'imageCache.get', cacheKey: futureKey })).toHaveLength(1);
    const rows = await db
      .select()
      .from(imageAnalysisCache)
      .where(and(eq(imageAnalysisCache.workspaceId, workspaceId), eq(imageAnalysisCache.cacheKey, expiredKey)));
    expect(rows).toHaveLength(1);
  });

  it('imageCache.put: upsert keeps the first hashes and replaces analysis fields', async () => {
    const key = `key-${randomUUID()}`;
    await run(imageCachePut, {
      kind: 'imageCache.put',
      entry: { cacheKey: key, imageHash: 'first-h', queryHash: 'first-q', ocrText: 'v1' },
    });
    await run(imageCachePut, {
      kind: 'imageCache.put',
      entry: { cacheKey: key, imageHash: 'second-h', queryHash: 'second-q', ocrText: 'v2' },
    });
    const fetched = (await run(imageCacheGet, { kind: 'imageCache.get', cacheKey: key }))[0];
    expect(fetched?.imageHash).toBe('first-h');
    expect(fetched?.queryHash).toBe('first-q');
    expect(fetched?.ocrText).toBe('v2');
  });

  it('W2 handlers reject from handle with 410 as well', async () => {
    await expect(run(memoriesCreate, { kind: 'memories.create', input: { content: 'x' } })).rejects.toMatchObject(
      { statusCode: 410, code: 'capability_unavailable' },
    );
    await expect(run(policyPut, { kind: 'policy.put', policy: { useMemories: false } })).rejects.toMatchObject(
      { statusCode: 410, code: 'capability_unavailable' },
    );
  });
});
