// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// HTTP contract tests for POST /api/workspace/mkdir (owner V3-05,
// wave 3B overlap AD-57): kontrak 3.1, desain-workspace-api.md
// section 2.6. The route runs over a real scratch directory through
// a test-only Fastify instance built from the same frozen plugin
// functions buildApp uses (request id, error handling, auth hooks),
// mirroring test/helpers/workspace-test-app.ts. The session stub
// accepts only the cookie value "good-session"; the CSRF stub
// accepts only the token "good-csrf"; the Origin check uses the
// default verifier against the canonical test origin.
//
// The mkdir route is wired into buildApp by the workspace
// structure adapter (rank 60, W4-WIRE); these tests register
// it directly on a standalone app, so they stay green
// independent of the wiring.

import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import { registerRequestId, requestIdFromHeaders } from '../src/plugins/request-id.js';
import { registerWorkspaceMkdirRoutes } from '../src/routes/workspace-mkdir.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const TEST_PRINCIPAL: SessionPrincipal = {
  userId: 'user-1',
  role: 'user',
  sessionId: 'good-session',
};

const AUTH_HEADERS = {
  cookie: 'notegen_session=good-session',
  origin: TEST_ORIGIN,
  'x-csrf-token': 'good-csrf',
} as const;

const JSON_HEADERS = { ...AUTH_HEADERS, 'content-type': 'application/json' } as const;

async function buildMkdirTestApp(workspaceRoot: string | undefined): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  registerAuthHooks(app, {
    verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? TEST_PRINCIPAL : null),
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
    canonicalOrigin: TEST_ORIGIN,
  });
  await registerWorkspaceMkdirRoutes(app, { workspaceRoot });
  await app.ready();
  return app;
}

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; requestId: string; retryable: boolean; details: Record<string, unknown> };
}

interface MkdirData {
  path: string;
  created: boolean;
  entry: {
    name: string;
    path: string;
    isDirectory: boolean;
    isFile: boolean;
    size: number | null;
    modifiedAt: string | null;
    createdAt: string | null;
    revision: string | null;
    version: number | null;
    isLocale: boolean;
  };
}

function dataOf(res: { body: string }): MkdirData {
  const body = JSON.parse(res.body) as { ok: boolean; data: MkdirData };
  expect(body.ok).toBe(true);
  return body.data;
}

function expectError(res: { statusCode: number; body: string }, status: number, code: string): ErrorBody {
  expect(res.statusCode).toBe(status);
  const body = JSON.parse(res.body) as ErrorBody;
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.requestId).toBe('string');
  expect(body.error.requestId).not.toBe('');
  expect(typeof body.error.details).toBe('object');
  return body;
}

function expectFolderEntry(data: MkdirData, path: string, name: string): void {
  expect(data.path).toBe(path);
  expect(data.entry.name).toBe(name);
  expect(data.entry.path).toBe(path);
  expect(data.entry.isDirectory).toBe(true);
  expect(data.entry.isFile).toBe(false);
  expect(data.entry.size).toBeNull();
  expect(data.entry.revision).toBeNull();
  expect(data.entry.version).toBeNull();
  expect(data.entry.isLocale).toBe(true);
  expect(typeof data.entry.modifiedAt).toBe('string');
}

describe('POST /api/workspace/mkdir', () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'v3b-05a-mkdir-'));
    app = await buildMkdirTestApp(dir);
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a new folder and answers 201 with created true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ path: 'notes' }),
    });
    expect(res.statusCode).toBe(201);
    const data = dataOf(res);
    expect(data.created).toBe(true);
    expectFolderEntry(data, 'notes', 'notes');
    expect((await stat(join(dir, 'notes'))).isDirectory()).toBe(true);
  });

  it('answers 200 with created false for a folder that already exists', async () => {
    await mkdir(join(dir, 'existing'), { recursive: true });
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ path: 'existing' }),
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data.created).toBe(false);
    expectFolderEntry(data, 'existing', 'existing');
  });

  it('creates parent folders as needed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ path: 'a/b/c' }),
    });
    expect(res.statusCode).toBe(201);
    const data = dataOf(res);
    expect(data.created).toBe(true);
    expectFolderEntry(data, 'a/b/c', 'c');
    expect((await stat(join(dir, 'a'))).isDirectory()).toBe(true);
    expect((await stat(join(dir, 'a', 'b'))).isDirectory()).toBe(true);
    expect((await stat(join(dir, 'a', 'b', 'c'))).isDirectory()).toBe(true);
  });

  it('is idempotent: a repeat answers 200 and leaves the folder in place', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ path: 'repeat/me' }),
    });
    expect(first.statusCode).toBe(201);
    expect(dataOf(first).created).toBe(true);
    const second = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ path: 'repeat/me' }),
    });
    expect(second.statusCode).toBe(200);
    const data = dataOf(second);
    expect(data.created).toBe(false);
    expectFolderEntry(data, 'repeat/me', 'me');
    expect((await stat(join(dir, 'repeat', 'me'))).isDirectory()).toBe(true);
  });

  it('answers 409 already_exists when the path is a file', async () => {
    await writeFile(join(dir, 'file.md'), 'content');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ path: 'file.md' }),
    });
    expectError(res, 409, 'already_exists');
    expect((await lstat(join(dir, 'file.md'))).isFile()).toBe(true);
  });

  it('answers 409 already_exists when a file blocks the path', async () => {
    await writeFile(join(dir, 'blocker.md'), 'content');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ path: 'blocker.md/sub' }),
    });
    expectError(res, 409, 'already_exists');
  });

  it.each(['../escape-v3b05a-nope', 'a/../b', '/abs', 'a//b', 'a/', 'a\\b', '', 'a/./b', '..'])(
    'answers 400 invalid_path for traversal or malformed path %j',
    async (badPath) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/mkdir',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ path: badPath }),
      });
      expectError(res, 400, 'invalid_path');
    },
  );

  it('does not create anything outside the workspace root on traversal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ path: '../escape-v3b05a-nope' }),
    });
    expectError(res, 400, 'invalid_path');
    await expect(stat(join(dir, '..', 'escape-v3b05a-nope'))).rejects.toThrow();
  });

  it('answers 400 symlink_not_allowed when the target is a symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'v3b-05a-outside-'));
    try {
      await symlink(outside, join(dir, 'link'));
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/mkdir',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ path: 'link' }),
      });
      expectError(res, 400, 'symlink_not_allowed');
      expect((await lstat(join(dir, 'link'))).isSymbolicLink()).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('answers 400 symlink_not_allowed when a symlink blocks the path', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'v3b-05a-outside-'));
    try {
      await symlink(outside, join(dir, 'link'));
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/mkdir',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ path: 'link/sub' }),
      });
      expectError(res, 400, 'symlink_not_allowed');
      await expect(stat(join(outside, 'sub'))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each(['.secret', 'a/.hidden', '.notegen/x'])(
    'answers 400 invalid_path for hidden path %j',
    async (hiddenPath) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/mkdir',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ path: hiddenPath }),
      });
      expectError(res, 400, 'invalid_path');
    },
  );

  it('answers 401 unauthenticated without a session cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: { origin: TEST_ORIGIN, 'x-csrf-token': 'good-csrf', 'content-type': 'application/json' },
      payload: JSON.stringify({ path: 'nope' }),
    });
    expectError(res, 401, 'unauthenticated');
    await expect(stat(join(dir, 'nope'))).rejects.toThrow();
  });

  it('answers 401 unauthenticated for an unknown session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: { ...JSON_HEADERS, cookie: 'notegen_session=bad-session' },
      payload: JSON.stringify({ path: 'nope' }),
    });
    expectError(res, 401, 'unauthenticated');
  });

  it('answers 403 csrf_invalid when the CSRF token is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: 'nope' }),
    });
    expectError(res, 403, 'csrf_invalid');
    await expect(stat(join(dir, 'nope'))).rejects.toThrow();
  });

  it('answers 403 csrf_invalid for a wrong CSRF token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: { ...JSON_HEADERS, 'x-csrf-token': 'stale-csrf' },
      payload: JSON.stringify({ path: 'nope' }),
    });
    expectError(res, 403, 'csrf_invalid');
  });

  it('answers 403 origin_rejected for a wrong Origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: { ...JSON_HEADERS, origin: 'https://evil.example.invalid' },
      payload: JSON.stringify({ path: 'nope' }),
    });
    expectError(res, 403, 'origin_rejected');
  });

  it('answers 400 invalid_json for a malformed JSON body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: '{not json',
    });
    expectError(res, 400, 'invalid_json');
  });

  it('answers 400 invalid_json for a missing body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
    });
    expectError(res, 400, 'invalid_json');
  });

  it('answers 400 validation_failed for a parsed non-object body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify(['a']),
    });
    expectError(res, 400, 'validation_failed');
  });

  it('answers 400 validation_failed for an unknown field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ path: 'ok', workspaceId: 'x' }),
    });
    const body = expectError(res, 400, 'validation_failed');
    expect(body.error.details['fields']).toEqual([{ field: 'workspaceId', issue: 'unknown field' }]);
  });

  it('answers 400 validation_failed for a non-string path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ path: 42 }),
    });
    const body = expectError(res, 400, 'validation_failed');
    expect(body.error.details['fields']).toEqual([{ field: 'path', issue: 'expected a string' }]);
  });

  it('answers 400 validation_failed when path is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify({}),
    });
    expectError(res, 400, 'validation_failed');
  });

  it('answers 413 payload_too_large for a body over 64 KiB', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/mkdir',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ path: 'x'.repeat(70 * 1024) }),
    });
    expectError(res, 413, 'payload_too_large');
  });

  it('answers 503 service_unavailable when no workspace root is configured', async () => {
    const noRootApp = await buildMkdirTestApp(undefined);
    try {
      const res = await noRootApp.inject({
        method: 'POST',
        url: '/api/workspace/mkdir',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ path: 'notes' }),
      });
      expectError(res, 503, 'service_unavailable');
    } finally {
      await noRootApp.close();
    }
  });

  it('answers 503 service_unavailable when the workspace root directory does not exist', async () => {
    const missingRoot = join(dir, 'missing-root-v3b05a');
    const missingRootApp = await buildMkdirTestApp(missingRoot);
    try {
      const res = await missingRootApp.inject({
        method: 'POST',
        url: '/api/workspace/mkdir',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ path: 'notes' }),
      });
      expectError(res, 503, 'service_unavailable');
    } finally {
      await missingRootApp.close();
    }
    await expect(stat(missingRoot)).rejects.toThrow();
  });
});
