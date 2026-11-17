// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// HTTP contract tests for the workspace trash routes (V3-05 part 3):
// DELETE file/folder to trash, batch move to trash, list, restore,
// purge one, and empty all
// (kontrak 3.1, desain-workspace-api.md 2.8 and 5.2). The app is buildApp
// with a temp workspace root; the trash routes arrive through the
// workspace-structure registration adapter (rank 60, W4-WIRE), and
// this spec proves the routes behave end to end under the frozen
// auth hook and envelope.
//
// File name note: the root .gitignore ignores "*.test.*", which
// would silently drop a file named workspace-trash.test.ts from
// git. This file uses the .spec.ts suffix instead, which Vitest
// also picks up by default (same convention as the other specs).

import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const TEST_PRINCIPAL: SessionPrincipal = {
  userId: 'test-user',
  role: 'user',
  sessionId: 'good-session',
};

const AUTH_HEADERS = {
  cookie: 'notegen_session=good-session',
  origin: TEST_ORIGIN,
  'x-csrf-token': 'good-csrf',
} as const;

const READ_HEADERS = {
  cookie: 'notegen_session=good-session',
} as const;

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3001,
    databaseUrl: 'postgres://placeholder/placeholder',
    workspaceRoot: '/tmp',
    nodeEnv: 'development',
    logLevel: 'silent',
    checkTimeoutMs: 2000,
    overallTimeoutMs: 5000,
    warnings: [],
    registrationMode: 'closed',
    publicBaseUrl: TEST_ORIGIN,
    trustProxy: false,
    cookieSecure: true,
    cfAccessEnabled: false,
    cfAccessTeamDomain: undefined,
    cfAccessAud: undefined,
    cfAccessServiceAud: undefined,
    cfAccessJwksCacheTtlSeconds: 3600,
    jwtAudience: undefined,
    authSecretConfigured: false,
    authSecretLengthOk: false,
    encryptionKeyConfigured: false,
    setupTokenConfigured: false,
    setupTokenLengthOk: false,
    maxBodyBytes: 1048576,
    ...overrides,
  };
}

interface Fixture {
  app: FastifyInstance;
  root: string;
  parent: string;
}

let fixture: Fixture | undefined;

async function setup(): Promise<Fixture> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'notegen-trash-')));
  const root = join(parent, 'workspace');
  await mkdir(root, { recursive: true });
  const app = await buildApp({
    config: testConfig({ workspaceRoot: root }),
    pool: null,
    version: 'test',
    verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? TEST_PRINCIPAL : null),
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
  });
  fixture = { app, root, parent };
  return fixture;
}

beforeEach(() => {
  fixture = undefined;
});

afterEach(async () => {
  if (fixture !== undefined) {
    await fixture.app.close();
    await rm(fixture.parent, { recursive: true, force: true });
    fixture = undefined;
  }
});

async function seed(root: string, relPath: string, content: Buffer | string): Promise<void> {
  const absolute = join(root, relPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function exists(fsPath: string): Promise<boolean> {
  return (await lstat(fsPath).catch(() => null)) !== null;
}

async function trashRootOf(parent: string): Promise<string | null> {
  const names = await readdir(parent);
  const found = names.find((name) => name.startsWith('.notegen-trash-'));
  return found === undefined ? null : join(parent, found);
}

function dataOf(res: { json(): unknown }): Record<string, unknown> {
  return (res.json() as { data: Record<string, unknown> }).data;
}

function errorOf(res: { json(): unknown }): {
  code: string;
  details: Record<string, unknown>;
} {
  const body = res.json() as { error: { code: string; details: Record<string, unknown> } };
  return body.error;
}

async function trashPaths(
  app: FastifyInstance,
  paths: unknown[],
): Promise<{ statusCode: number; data: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/workspace/trash',
    headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
    payload: JSON.stringify({ paths }),
  });
  return { statusCode: res.statusCode, data: dataOf(res) };
}

async function listTrash(app: FastifyInstance, query = ''): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/workspace/trash${query}`,
    headers: { ...READ_HEADERS },
  });
  expect(res.statusCode).toBe(200);
  return dataOf(res);
}

describe('POST /api/workspace/trash', () => {
  it('trashes a file outside the visible tree', async () => {
    const { app, root, parent } = await setup();
    await seed(root, 'notes/one.md', '# hello');
    const { statusCode, data } = await trashPaths(app, ['notes/one.md']);
    expect(statusCode).toBe(200);
    expect(data['moved']).toEqual(['notes/one.md']);
    expect(data['notFound']).toEqual([]);
    expect(data['rejected']).toEqual([]);
    expect(await exists(join(root, 'notes/one.md'))).toBe(false);
    const trashRoot = await trashRootOf(parent);
    expect(trashRoot).not.toBeNull();
    expect((trashRoot as string).startsWith(`${parent}/`)).toBe(true);
    expect((trashRoot as string).startsWith(`${root}/`)).toBe(false);
    const listed = await listTrash(app);
    expect(listed['totalCount']).toBe(1);
    expect(listed['totalSize']).toBe(7);
    const entries = listed['entries'] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.['originalPath']).toBe('notes/one.md');
    expect(entries[0]?.['name']).toBe('one.md');
    expect(entries[0]?.['kind']).toBe('file');
    expect(entries[0]?.['size']).toBe(7);
    expect(entries[0]?.['entryCount']).toBe(1);
    expect(entries[0]?.['revision']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(typeof entries[0]?.['deletedAt']).toBe('string');
    expect(entries[0]?.['id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('trashes a folder as one entry with subtree stats', async () => {
    const { app, root } = await setup();
    await seed(root, 'dir/a.md', 'aa');
    await seed(root, 'dir/b.md', 'bbb');
    await seed(root, 'dir/sub/c.md', 'cccc');
    const { statusCode, data } = await trashPaths(app, ['dir']);
    expect(statusCode).toBe(200);
    expect(data['moved']).toEqual(['dir']);
    expect(await exists(join(root, 'dir'))).toBe(false);
    const listed = await listTrash(app);
    const entries = listed['entries'] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.['kind']).toBe('folder');
    expect(entries[0]?.['entryCount']).toBe(5);
    expect(entries[0]?.['size']).toBe(9);
    expect(entries[0]?.['revision']).toBeNull();
  });

  it('reports per-item results without failing the batch', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    const { statusCode, data } = await trashPaths(app, ['a.md', 'missing.md', '../escape.md']);
    expect(statusCode).toBe(200);
    expect(data['moved']).toEqual(['a.md']);
    expect(data['notFound']).toEqual(['missing.md']);
    expect(data['rejected']).toEqual([{ path: '../escape.md', reason: 'path_escapes_workspace' }]);
  });

  it('reports an already-trashed path as moved without duplication', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    await trashPaths(app, ['a.md']);
    const second = await trashPaths(app, ['a.md']);
    expect(second.data['moved']).toEqual(['a.md']);
    expect(second.data['notFound']).toEqual([]);
    const listed = await listTrash(app);
    expect(listed['totalCount']).toBe(1);
  });

  it('rejects traversal, absolute, backslash, and empty-segment paths', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    const { statusCode, data } = await trashPaths(app, [
      '../escape.md',
      '/abs.md',
      'a/../../b.md',
      'a\\b.md',
      'a//b.md',
      'a/./b.md',
      '',
    ]);
    expect(statusCode).toBe(200);
    expect(data['moved']).toEqual([]);
    expect(data['notFound']).toEqual([]);
    const rejected = data['rejected'] as Array<{ path: string; reason: string }>;
    expect(rejected).toHaveLength(7);
    expect(rejected.find((r) => r.path === '../escape.md')?.reason).toBe('path_escapes_workspace');
    expect(rejected.find((r) => r.path === '/abs.md')?.reason).toBe('path_escapes_workspace');
    expect(rejected.find((r) => r.path === 'a\\b.md')?.reason).toBe('invalid_path');
    expect(await exists(join(root, 'a.md'))).toBe(true);
    const listed = await listTrash(app);
    expect(listed['totalCount']).toBe(0);
  });

  it('rejects hidden paths and symlink paths', async () => {
    const { app, root } = await setup();
    await seed(root, '.secret.md', 's');
    await seed(root, 'real.md', 'r');
    await symlink(join(root, 'real.md'), join(root, 'link.md'));
    const { data } = await trashPaths(app, ['.secret.md', 'link.md']);
    expect(data['moved']).toEqual([]);
    expect(data['rejected']).toEqual([
      { path: '.secret.md', reason: 'hidden_path' },
      { path: 'link.md', reason: 'symlink_not_allowed' },
    ]);
    expect(await exists(join(root, '.secret.md'))).toBe(true);
    expect(await exists(join(root, 'real.md'))).toBe(true);
  });

  it('validates the batch body', async () => {
    const { app } = await setup();
    const empty = await app.inject({
      method: 'POST',
      url: '/api/workspace/trash',
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({ paths: [] }),
    });
    expect(empty.statusCode).toBe(400);
    expect(errorOf(empty).code).toBe('validation_failed');
    const over = await app.inject({
      method: 'POST',
      url: '/api/workspace/trash',
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({ paths: Array.from({ length: 101 }, (_, i) => `f${i}.md`) }),
    });
    expect(over.statusCode).toBe(400);
    expect(errorOf(over).code).toBe('validation_failed');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/workspace/trash',
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({}),
    });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing).code).toBe('validation_failed');
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/workspace/trash',
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({ paths: ['a.md'], workspaceId: 'x' }),
    });
    expect(unknown.statusCode).toBe(400);
    expect(errorOf(unknown).code).toBe('validation_failed');
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/workspace/trash',
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: '{bad json',
    });
    expect(malformed.statusCode).toBe(400);
    expect(errorOf(malformed).code).toBe('invalid_json');
  });

  it('requires a session, origin, and CSRF token', async () => {
    const { app } = await setup();
    const noSession = await app.inject({
      method: 'POST',
      url: '/api/workspace/trash',
      headers: { ...JSON_HEADERS },
      payload: JSON.stringify({ paths: ['a.md'] }),
    });
    expect(noSession.statusCode).toBe(401);
    expect(errorOf(noSession).code).toBe('unauthenticated');
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/workspace/trash',
      headers: { cookie: AUTH_HEADERS.cookie, origin: TEST_ORIGIN, ...JSON_HEADERS },
      payload: JSON.stringify({ paths: ['a.md'] }),
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(errorOf(noCsrf).code).toBe('csrf_invalid');
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/workspace/trash',
      headers: { ...AUTH_HEADERS, origin: 'https://evil.example.invalid', ...JSON_HEADERS },
      payload: JSON.stringify({ paths: ['a.md'] }),
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(errorOf(badOrigin).code).toBe('origin_rejected');
  });
});

describe('GET /api/workspace/trash', () => {
  it('answers an empty trash without creating a trash directory', async () => {
    const { app, parent } = await setup();
    const listed = await listTrash(app);
    expect(listed['entries']).toEqual([]);
    expect(listed['nextCursor']).toBeNull();
    expect(listed['hasMore']).toBe(false);
    expect(listed['totalCount']).toBe(0);
    expect(listed['totalSize']).toBe(0);
    expect(await trashRootOf(parent)).toBeNull();
  });

  it('paginates with totals over all entries', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    await seed(root, 'b.md', 'bb');
    await seed(root, 'c.md', 'ccc');
    await trashPaths(app, ['a.md', 'b.md', 'c.md']);
    const first = await listTrash(app, '?limit=2');
    const firstEntries = first['entries'] as Array<Record<string, unknown>>;
    expect(firstEntries).toHaveLength(2);
    expect(first['hasMore']).toBe(true);
    expect(typeof first['nextCursor']).toBe('string');
    expect(first['totalCount']).toBe(3);
    expect(first['totalSize']).toBe(6);
    const second = await listTrash(app, `?limit=2&cursor=${first['nextCursor'] as string}`);
    const secondEntries = second['entries'] as Array<Record<string, unknown>>;
    expect(secondEntries).toHaveLength(1);
    expect(second['hasMore']).toBe(false);
    expect(second['nextCursor']).toBeNull();
    expect(second['totalCount']).toBe(3);
    const ids = [...firstEntries, ...secondEntries].map((e) => e['id']);
    expect(new Set(ids).size).toBe(3);
    const deletedAts = [...firstEntries, ...secondEntries].map((e) => e['deletedAt'] as string);
    for (let i = 1; i < deletedAts.length; i += 1) {
      expect(deletedAts[i] as string <= (deletedAts[i - 1] as string)).toBe(true);
    }
  });

  it('rejects bad cursors and limits, and clamps an over-max limit', async () => {
    const { app } = await setup();
    const badCursor = await app.inject({
      method: 'GET',
      url: '/api/workspace/trash?cursor=not-a-cursor!!',
      headers: { ...READ_HEADERS },
    });
    expect(badCursor.statusCode).toBe(400);
    expect(errorOf(badCursor).code).toBe('invalid_cursor');
    for (const limit of ['0', 'abc', '-1', '1.5']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/workspace/trash?limit=${limit}`,
        headers: { ...READ_HEADERS },
      });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('invalid_limit');
    }
    const clamped = await listTrash(app, '?limit=999');
    expect(clamped['totalCount']).toBe(0);
  });

  it('requires a session', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/workspace/trash' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
  });
});

describe('POST /api/workspace/trash/:id/restore', () => {
  it('restores a file to its original path with the same revision', async () => {
    const { app, root } = await setup();
    await seed(root, 'notes/one.md', '# hello');
    await trashPaths(app, ['notes/one.md']);
    const listed = await listTrash(app);
    const entry = (listed['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspace/trash/${entry['id'] as string}/restore`,
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['id']).toBe(entry['id']);
    expect(data['originalPath']).toBe('notes/one.md');
    expect(data['restoredPath']).toBe('notes/one.md');
    expect(data['kind']).toBe('file');
    expect(data['revision']).toBe(entry['revision']);
    expect(data['size']).toBe(7);
    expect(typeof data['restoredAt']).toBe('string');
    expect(await readFile(join(root, 'notes/one.md'), 'utf8')).toBe('# hello');
    expect((await listTrash(app))['totalCount']).toBe(0);
    const again = await app.inject({
      method: 'POST',
      url: `/api/workspace/trash/${entry['id'] as string}/restore`,
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({}),
    });
    expect(again.statusCode).toBe(404);
    expect(errorOf(again).code).toBe('not_found');
  });

  it('restores a folder subtree whole', async () => {
    const { app, root } = await setup();
    await seed(root, 'dir/a.md', 'aa');
    await seed(root, 'dir/sub/c.md', 'cccc');
    await trashPaths(app, ['dir']);
    const listed = await listTrash(app);
    const entry = (listed['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspace/trash/${entry['id'] as string}/restore`,
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)['kind']).toBe('folder');
    expect(dataOf(res)['revision']).toBeNull();
    expect(await readFile(join(root, 'dir/a.md'), 'utf8')).toBe('aa');
    expect(await readFile(join(root, 'dir/sub/c.md'), 'utf8')).toBe('cccc');
  });

  it('restores to a target with a new revision and creates parents', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'hello');
    await trashPaths(app, ['a.md']);
    const listed = await listTrash(app);
    const entry = (listed['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspace/trash/${entry['id'] as string}/restore`,
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({ target: 'new/deep/renamed.md' }),
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['originalPath']).toBe('a.md');
    expect(data['restoredPath']).toBe('new/deep/renamed.md');
    expect(data['revision']).not.toBe(entry['revision']);
    expect(await readFile(join(root, 'new/deep/renamed.md'), 'utf8')).toBe('hello');
    expect(await exists(join(root, 'a.md'))).toBe(false);
  });

  it('never overwrites an occupied target and suggests a copy name', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'old');
    await trashPaths(app, ['a.md']);
    await seed(root, 'a.md', 'new');
    const listed = await listTrash(app);
    const entry = (listed['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspace/trash/${entry['id'] as string}/restore`,
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(409);
    const error = errorOf(res);
    expect(error.code).toBe('target_exists');
    expect(error.details['suggestedTarget']).toBe('a (salinan).md');
    expect(error.details['existingKind']).toBe('file');
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('new');
    expect((await listTrash(app))['totalCount']).toBe(1);
    const toSuggestion = await app.inject({
      method: 'POST',
      url: `/api/workspace/trash/${entry['id'] as string}/restore`,
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({ target: 'a (salinan).md' }),
    });
    expect(toSuggestion.statusCode).toBe(200);
    expect(await readFile(join(root, 'a (salinan).md'), 'utf8')).toBe('old');
  });

  it('reports an occupied folder target with existingKind folder', async () => {
    const { app, root } = await setup();
    await seed(root, 'x.md', 'x');
    await trashPaths(app, ['x.md']);
    await mkdir(join(root, 'taken'), { recursive: true });
    const listed = await listTrash(app);
    const entry = (listed['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspace/trash/${entry['id'] as string}/restore`,
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({ target: 'taken' }),
    });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('target_exists');
    expect(errorOf(res).details['existingKind']).toBe('folder');
  });

  it('rejects invalid targets and unknown body fields', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    await trashPaths(app, ['a.md']);
    const listed = await listTrash(app);
    const entry = (listed['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    for (const target of ['../escape.md', '/abs.md', '.hidden.md', '']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspace/trash/${entry['id'] as string}/restore`,
        headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
        payload: JSON.stringify({ target }),
      });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('invalid_path');
    }
    const wrongType = await app.inject({
      method: 'POST',
      url: `/api/workspace/trash/${entry['id'] as string}/restore`,
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({ target: 42 }),
    });
    expect(wrongType.statusCode).toBe(400);
    expect(errorOf(wrongType).code).toBe('validation_failed');
    const unknown = await app.inject({
      method: 'POST',
      url: `/api/workspace/trash/${entry['id'] as string}/restore`,
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({ target: 'b.md', force: true }),
    });
    expect(unknown.statusCode).toBe(400);
    expect(errorOf(unknown).code).toBe('validation_failed');
  });

  it('answers 404 for unknown and malformed ids', async () => {
    const { app } = await setup();
    for (const id of ['3f8a2c1e-0000-4000-8000-000000000001', 'not-a-uuid', '..']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspace/trash/${id}/restore`,
        headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('not_found');
    }
  });

  it('answers 500 trash_blob_missing when the blob is gone, keeping the entry', async () => {
    const { app, root, parent } = await setup();
    await seed(root, 'a.md', 'a');
    await trashPaths(app, ['a.md']);
    const listed = await listTrash(app);
    const entry = (listed['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const trashRoot = (await trashRootOf(parent)) as string;
    await rm(join(trashRoot, entry['id'] as string, 'blob'), { recursive: true, force: true });
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspace/trash/${entry['id'] as string}/restore`,
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(500);
    const error = errorOf(res);
    expect(error.code).toBe('trash_blob_missing');
    expect(error.details['id']).toBe(entry['id']);
    expect(error.details['originalPath']).toBe('a.md');
    expect((await listTrash(app))['totalCount']).toBe(1);
  });

  it('accepts a restore with no body', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    await trashPaths(app, ['a.md']);
    const listed = await listTrash(app);
    const entry = (listed['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspace/trash/${entry['id'] as string}/restore`,
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('a');
  });
});

describe('DELETE /api/workspace/trash/:id', () => {
  it('purges one entry permanently', async () => {
    const { app, root, parent } = await setup();
    await seed(root, 'a.md', 'a');
    await trashPaths(app, ['a.md']);
    const listed = await listTrash(app);
    const entry = (listed['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/workspace/trash/${entry['id'] as string}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['id']).toBe(entry['id']);
    expect(data['purged']).toBe(true);
    expect(typeof data['purgedAt']).toBe('string');
    const trashRoot = (await trashRootOf(parent)) as string;
    expect(await exists(join(trashRoot, entry['id'] as string))).toBe(false);
    expect((await listTrash(app))['totalCount']).toBe(0);
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/workspace/trash/${entry['id'] as string}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(again.statusCode).toBe(404);
    expect(errorOf(again).code).toBe('not_found');
  });

  it('answers 404 for unknown ids and 500 when the blob is gone', async () => {
    const { app, root, parent } = await setup();
    const unknown = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/trash/3f8a2c1e-0000-4000-8000-000000000001',
      headers: { ...AUTH_HEADERS },
    });
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown).code).toBe('not_found');
    await seed(root, 'a.md', 'a');
    await trashPaths(app, ['a.md']);
    const listed = await listTrash(app);
    const entry = (listed['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const trashRoot = (await trashRootOf(parent)) as string;
    await rm(join(trashRoot, entry['id'] as string, 'blob'), { recursive: true, force: true });
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/workspace/trash/${entry['id'] as string}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(missing.statusCode).toBe(500);
    expect(errorOf(missing).code).toBe('trash_blob_missing');
    expect((await listTrash(app))['totalCount']).toBe(1);
  });
});

describe('DELETE /api/workspace/trash', () => {
  it('empties the trash with confirmation', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    await seed(root, 'dir/b.md', 'bb');
    await trashPaths(app, ['a.md', 'dir']);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/trash',
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({ confirm: true }),
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['purged']).toBe(2);
    expect(data['failed']).toBe(0);
    expect(data['failures']).toEqual([]);
    expect(typeof data['purgedAt']).toBe('string');
    expect((await listTrash(app))['totalCount']).toBe(0);
  });

  it('answers purged 0 for an empty trash', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/trash',
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({ confirm: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)['purged']).toBe(0);
    expect(dataOf(res)['failed']).toBe(0);
  });

  it('requires confirm true', async () => {
    const { app } = await setup();
    const noBody = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/trash',
      headers: { ...AUTH_HEADERS },
    });
    expect(noBody.statusCode).toBe(400);
    expect(errorOf(noBody).code).toBe('confirm_required');
    for (const payload of ['{}', '{"confirm":false}', '{"confirm":"true"}']) {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/workspace/trash',
        headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('confirm_required');
    }
    const unknown = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/trash',
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({ confirm: true, extra: 1 }),
    });
    expect(unknown.statusCode).toBe(400);
    expect(errorOf(unknown).code).toBe('validation_failed');
  });

  it('reports per-entry failures and keeps the failed entries', async () => {
    const { app, root, parent } = await setup();
    await seed(root, 'a.md', 'a');
    await seed(root, 'b.md', 'bb');
    await trashPaths(app, ['a.md', 'b.md']);
    const listed = await listTrash(app);
    const entries = listed['entries'] as Array<Record<string, unknown>>;
    const bad = entries.find((e) => e['originalPath'] === 'a.md') as Record<string, unknown>;
    const trashRoot = (await trashRootOf(parent)) as string;
    await rm(join(trashRoot, bad['id'] as string, 'blob'), { recursive: true, force: true });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/trash',
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({ confirm: true }),
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['purged']).toBe(1);
    expect(data['failed']).toBe(1);
    expect(data['failures']).toEqual([{ id: bad['id'], code: 'trash_blob_missing' }]);
    expect((await listTrash(app))['totalCount']).toBe(1);
  });
});

describe('DELETE /api/workspace/file', () => {
  it('moves a file to trash with the contract shape', async () => {
    const { app, root } = await setup();
    await seed(root, 'notes/one.md', '# hello');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=notes/one.md',
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['path']).toBe('notes/one.md');
    expect(data['trashId']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(data['kind']).toBe('file');
    expect(data['entryCount']).toBe(1);
    expect(data['size']).toBe(7);
    expect(typeof data['deletedAt']).toBe('string');
    expect(await exists(join(root, 'notes/one.md'))).toBe(false);
    const listed = await listTrash(app);
    expect(listed['totalCount']).toBe(1);
    const entries = listed['entries'] as Array<Record<string, unknown>>;
    expect(entries[0]?.['id']).toBe(data['trashId']);
    expect(entries[0]?.['originalPath']).toBe('notes/one.md');
  });

  it('rejects permanent=true and leaves the file in place', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=a.md&permanent=true',
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('invalid_query');
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('a');
    expect((await listTrash(app))['totalCount']).toBe(0);
  });

  it('treats permanent=false as a normal move to trash', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=a.md&permanent=false',
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)['path']).toBe('a.md');
    expect(await exists(join(root, 'a.md'))).toBe(false);
  });

  it('answers 409 wrong_kind for a folder and leaves it in place', async () => {
    const { app, root } = await setup();
    await seed(root, 'dir/a.md', 'aa');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=dir',
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('wrong_kind');
    expect(await exists(join(root, 'dir/a.md'))).toBe(true);
    expect((await listTrash(app))['totalCount']).toBe(0);
  });

  it('answers 404 on repeat without creating a duplicate trash entry', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    const first = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=a.md',
      headers: { ...AUTH_HEADERS },
    });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=a.md',
      headers: { ...AUTH_HEADERS },
    });
    expect(again.statusCode).toBe(404);
    expect(errorOf(again).code).toBe('not_found');
    expect((await listTrash(app))['totalCount']).toBe(1);
  });

  it('answers 404 for a missing path and 400 for invalid paths', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=missing.md',
      headers: { ...AUTH_HEADERS },
    });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('not_found');
    for (const url of [
      '/api/workspace/file?path=../escape.md',
      '/api/workspace/file?path=/abs.md',
      '/api/workspace/file?path=',
      '/api/workspace/file',
    ]) {
      const res = await app.inject({ method: 'DELETE', url, headers: { ...AUTH_HEADERS } });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('invalid_path');
    }
    expect(await exists(join(root, 'a.md'))).toBe(true);
  });

  it('requires a session and a CSRF token', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    const noSession = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=a.md',
    });
    expect(noSession.statusCode).toBe(401);
    expect(errorOf(noSession).code).toBe('unauthenticated');
    const noCsrf = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=a.md',
      headers: { cookie: AUTH_HEADERS.cookie, origin: TEST_ORIGIN },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(errorOf(noCsrf).code).toBe('csrf_invalid');
    expect(await exists(join(root, 'a.md'))).toBe(true);
  });
});

describe('DELETE /api/workspace/folder', () => {
  it('moves a folder subtree to trash as one entry', async () => {
    const { app, root } = await setup();
    await seed(root, 'dir/a.md', 'aa');
    await seed(root, 'dir/b.md', 'bbb');
    await seed(root, 'dir/sub/c.md', 'cccc');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/folder?path=dir',
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['path']).toBe('dir');
    expect(data['kind']).toBe('folder');
    expect(data['entryCount']).toBe(5);
    expect(data['size']).toBe(9);
    expect(await exists(join(root, 'dir'))).toBe(false);
    expect((await listTrash(app))['totalCount']).toBe(1);
  });

  it('answers 409 wrong_kind for a file and leaves it in place', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/folder?path=a.md',
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('wrong_kind');
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('a');
  });

  it('rejects permanent=true and answers 404 on repeat', async () => {
    const { app, root } = await setup();
    await seed(root, 'dir/a.md', 'aa');
    const rejected = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/folder?path=dir&permanent=true',
      headers: { ...AUTH_HEADERS },
    });
    expect(rejected.statusCode).toBe(400);
    expect(errorOf(rejected).code).toBe('invalid_query');
    expect(await exists(join(root, 'dir/a.md'))).toBe(true);
    const first = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/folder?path=dir',
      headers: { ...AUTH_HEADERS },
    });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({
      method: 'DELETE',
      url: '/api/workspace/folder?path=dir',
      headers: { ...AUTH_HEADERS },
    });
    expect(again.statusCode).toBe(404);
    expect(errorOf(again).code).toBe('not_found');
    expect((await listTrash(app))['totalCount']).toBe(1);
  });

  it('requires a session', async () => {
    const { app, root } = await setup();
    await seed(root, 'dir/a.md', 'aa');
    const res = await app.inject({ method: 'DELETE', url: '/api/workspace/folder?path=dir' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
    expect(await exists(join(root, 'dir/a.md'))).toBe(true);
  });
});

describe('trash and the visible tree', () => {
  it('hides trashed files from list and stat until restored', async () => {
    const { app, root } = await setup();
    await seed(root, 'a.md', 'a');
    await trashPaths(app, ['a.md']);
    const list = await app.inject({
      method: 'GET',
      url: '/api/workspace/list',
      headers: { ...READ_HEADERS },
    });
    expect(list.statusCode).toBe(200);
    expect(dataOf(list)['entries']).toEqual([]);
    const stat = await app.inject({
      method: 'GET',
      url: '/api/workspace/stat?path=a.md',
      headers: { ...READ_HEADERS },
    });
    expect(stat.statusCode).toBe(404);
    const listed = await listTrash(app);
    const entry = (listed['entries'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const restored = await app.inject({
      method: 'POST',
      url: `/api/workspace/trash/${entry['id'] as string}/restore`,
      headers: { ...AUTH_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify({}),
    });
    expect(restored.statusCode).toBe(200);
    const statAgain = await app.inject({
      method: 'GET',
      url: '/api/workspace/stat?path=a.md',
      headers: { ...READ_HEADERS },
    });
    expect(statAgain.statusCode).toBe(200);
  });
});
