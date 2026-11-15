// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// HTTP tests for the workspace read routes (owner V3-04a): list,
// file, HEAD, scan, and stat over a real scratch directory, through
// buildApp with an injected session verifier. The session stub
// accepts only the cookie value "valid"; anything else exercises the
// frozen deny-by-default hook.

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { ServerConfig } from '../../src/config.js';
import type { SessionPrincipal, VerifySessionFn } from '../../src/middleware/auth-hook.js';
import { buildRevision } from '../../src/lib/revision.js';

const VALID_COOKIE = 'notegen_session=valid';

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
    publicBaseUrl: undefined,
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

const verifySession: VerifySessionFn = async ({ sessionId }) => {
  if (sessionId !== 'valid') {
    return null;
  }
  const principal: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'sess-1' };
  return principal;
};

function q(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `?${search.toString()}`;
}

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; requestId: string; retryable: boolean; details: Record<string, unknown> };
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

describe('workspace read routes', () => {
  let dir: string;
  let rootReal: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'v3-04a-ws-'));
    rootReal = await realpath(dir);
    await mkdir(join(dir, 'sort', 'afolder'), { recursive: true });
    await mkdir(join(dir, 'sort', 'zfolder'), { recursive: true });
    await writeFile(join(dir, 'sort', 'zebra.md'), 'z');
    await writeFile(join(dir, 'sort', 'apple.md'), 'a');
    await writeFile(join(dir, 'read.md'), 'line one\nline two\n');
    await writeFile(join(dir, 'notes.txt'), 'plain');
    await writeFile(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    await writeFile(join(dir, 'bad-utf8.md'), Buffer.from([0x41, 0xff, 0xfe, 0x42]));
    await mkdir(join(dir, 'vault', 'sub'), { recursive: true });
    await writeFile(join(dir, 'vault', 'b.md'), 'b');
    await writeFile(join(dir, 'vault', 'sub', 'a.md'), 'a');
    await writeFile(join(dir, 'vault', 'sub', 'note.txt'), 't');
    await writeFile(join(dir, 'vault', 'UPPER.MD'), 'u');
    await writeFile(join(dir, 'vault', 'doc.markdown'), 'm');
    await mkdir(join(dir, '.secret'), { recursive: true });
    await writeFile(join(dir, '.secret', 'h.md'), 'secret');
    await mkdir(join(dir, 'pages'), { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(dir, 'pages', `p${i}.md`), `p${i}`);
    }
    app = await buildApp({
      config: testConfig({ workspaceRoot: dir }),
      pool: null,
      version: 'test',
      verifySession,
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  function expectedRevision(path: string, content: Buffer | string): string {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const parts = [
      Buffer.from(rootReal, 'utf8'),
      Buffer.from([0]),
      Buffer.from(path, 'utf8'),
      Buffer.from([0]),
      bytes,
    ];
    return `sha256:${createHash('sha256').update(Buffer.concat(parts)).digest('hex')}`;
  }

  it('GET file returns raw text with revision headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file${q({ path: 'read.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('line one\nline two\n');
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    const revision = expectedRevision('read.md', 'line one\nline two\n');
    expect(res.headers['etag']).toBe(`"${revision}"`);
    expect(res.headers['x-revision']).toBe(revision);
    expect(res.headers['x-version']).toBeUndefined();
    expect(res.headers['last-modified']).toBeDefined();
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(revision).toBe(buildRevision(rootReal, 'read.md', 'line one\nline two\n'));
  });

  it('GET .txt returns text/plain', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file${q({ path: 'notes.txt' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.body).toBe('plain');
  });

  it('GET with matching If-None-Match returns 304 without a body', async () => {
    const revision = expectedRevision('read.md', 'line one\nline two\n');
    for (const header of [`"${revision}"`, revision, `W/"${revision}"`, '*', `"sha256:deadbeef", "${revision}"`]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/workspace/file${q({ path: 'read.md' })}`,
        headers: { cookie: VALID_COOKIE, 'if-none-match': header },
      });
      expect(res.statusCode).toBe(304);
      expect(res.body).toBe('');
      expect(res.headers['etag']).toBe(`"${revision}"`);
    }
  });

  it('GET with a non-matching If-None-Match returns 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file${q({ path: 'read.md' })}`,
      headers: { cookie: VALID_COOKIE, 'if-none-match': '"sha256:other"' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('line one\nline two\n');
  });

  it('GET missing file, folder, and hidden paths return 404 without distinction', async () => {
    for (const path of ['missing.md', 'sort', '.secret/h.md', '.secret']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/workspace/file${q({ path })}`,
        headers: { cookie: VALID_COOKIE },
      });
      expectError(res, 404, 'not_found');
    }
  });

  it('GET non-text extension returns 415 and invalid UTF-8 returns 422', async () => {
    const png = await app.inject({
      method: 'GET',
      url: `/api/workspace/file${q({ path: 'pic.png' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(png, 415, 'not_text_file');
    const bad = await app.inject({
      method: 'GET',
      url: `/api/workspace/file${q({ path: 'bad-utf8.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(bad, 422, 'invalid_text_encoding');
  });

  it('GET needs only the session: a wrong Origin header is ignored', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file${q({ path: 'read.md' })}`,
      headers: { cookie: VALID_COOKIE, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('HEAD returns GET headers without a body', async () => {
    const res = await app.inject({
      method: 'HEAD',
      url: `/api/workspace/file${q({ path: 'read.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['etag']).toBe(`"${expectedRevision('read.md', 'line one\nline two\n')}"`);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
  });

  it('HEAD returns 200 for non-text and invalid-UTF-8 files', async () => {
    for (const path of ['pic.png', 'bad-utf8.md']) {
      const res = await app.inject({
        method: 'HEAD',
        url: `/api/workspace/file${q({ path })}`,
        headers: { cookie: VALID_COOKIE },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('');
      expect(String(res.headers['etag'] ?? '')).toMatch(/^"sha256:[0-9a-f]{64}"$/);
    }
  });

  it('HEAD missing file returns 404', async () => {
    const res = await app.inject({
      method: 'HEAD',
      url: `/api/workspace/file${q({ path: 'nope.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(404);
  });

  it('stat returns the DirEntry shape for file and folder', async () => {
    const fileRes = await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: 'read.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(fileRes.statusCode).toBe(200);
    const fileData = JSON.parse(fileRes.body) as { ok: boolean; data: Record<string, unknown> };
    expect(fileData.ok).toBe(true);
    expect(fileData.data).toMatchObject({
      name: 'read.md',
      path: 'read.md',
      isDirectory: false,
      isFile: true,
      size: 18,
      revision: expectedRevision('read.md', 'line one\nline two\n'),
      version: null,
      isLocale: true,
    });
    expect(typeof fileData.data['modifiedAt']).toBe('string');
    expect(fileRes.headers['etag']).toBe(`"${expectedRevision('read.md', 'line one\nline two\n')}"`);
    expect(fileRes.headers['last-modified']).toBeDefined();

    const folderRes = await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: 'sort' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    const folderData = JSON.parse(folderRes.body) as { ok: boolean; data: Record<string, unknown> };
    expect(folderData.data).toMatchObject({
      name: 'sort',
      isDirectory: true,
      isFile: false,
      size: null,
      revision: null,
      version: null,
    });
    expect(folderRes.headers['etag']).toBeUndefined();
  });

  it('stat answers 200 with a revision for binary files', async () => {
    const bytes = await readFile(join(dir, 'pic.png'));
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: 'pic.png' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { data: Record<string, unknown> };
    expect(data.data['revision']).toBe(expectedRevision('pic.png', bytes));
  });

  it('stat errors: missing 404, invalid 400, no param 400, hidden 404', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: 'ghost.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(missing, 404, 'not_found');
    const invalid = await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: '../escape.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(invalid, 400, 'invalid_path');
    const noParam = await app.inject({
      method: 'GET',
      url: '/api/workspace/stat',
      headers: { cookie: VALID_COOKIE },
    });
    expectError(noParam, 400, 'invalid_path');
    const hidden = await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: '.secret/h.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(hidden, 404, 'not_found');
  });

  it('list sorts folders first then files alphabetically and hides dot entries', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'sort' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as {
      ok: boolean;
      data: { path: string; entries: Array<{ name: string }>; nextCursor: string | null; hasMore: boolean };
    };
    expect(data.ok).toBe(true);
    expect(data.data.path).toBe('sort');
    expect(data.data.entries.map((e) => e.name)).toEqual(['afolder', 'zfolder', 'apple.md', 'zebra.md']);
    expect(data.data.hasMore).toBe(false);
    expect(data.data.nextCursor).toBeNull();

    const root = await app.inject({
      method: 'GET',
      url: '/api/workspace/list',
      headers: { cookie: VALID_COOKIE },
    });
    const rootData = JSON.parse(root.body) as {
      data: { path: string; entries: Array<{ name: string }> };
    };
    expect(rootData.data.path).toBe('');
    expect(rootData.data.entries.map((e) => e.name)).not.toContain('.secret');
  });

  it('list includeMetadata=false nulls size and timestamps but keeps revision', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'sort', includeMetadata: 'false' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    const data = JSON.parse(res.body) as {
      data: { entries: Array<Record<string, unknown>> };
    };
    const file = data.data.entries.find((e) => e['name'] === 'apple.md');
    expect(file).toBeDefined();
    expect(file?.['size']).toBeNull();
    expect(file?.['modifiedAt']).toBeNull();
    expect(file?.['createdAt']).toBeNull();
    expect(String(file?.['revision'] ?? '')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('list on a file returns 400 not_a_directory and missing folder returns 404', async () => {
    const onFile = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'read.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(onFile, 400, 'not_a_directory');
    const missing = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'ghost' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(missing, 404, 'not_found');
  });

  it('list pagination walks cursors with consistent hasMore', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const params: Record<string, string> = { path: 'pages', limit: '2' };
      if (cursor !== null) {
        params['cursor'] = cursor;
      }
      const res = await app.inject({
        method: 'GET',
        url: `/api/workspace/list${q(params)}`,
        headers: { cookie: VALID_COOKIE },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body) as {
        data: { entries: Array<{ name: string }>; nextCursor: string | null; hasMore: boolean };
      };
      expect(data.data.hasMore).toBe(data.data.nextCursor !== null);
      seen.push(...data.data.entries.map((e) => e.name));
      cursor = data.data.nextCursor;
      guard += 1;
      expect(guard).toBeLessThan(10);
    } while (cursor !== null);
    expect(seen).toEqual(['p0.md', 'p1.md', 'p2.md', 'p3.md', 'p4.md']);
  });

  it('list limit validation and clamping', async () => {
    const zero = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', limit: '0' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(zero, 400, 'invalid_limit');
    const text = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', limit: 'abc' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(text, 400, 'invalid_limit');
    const huge = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', limit: '5000' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(huge.statusCode).toBe(200);
    const hugeData = JSON.parse(huge.body) as { data: { entries: unknown[] } };
    expect(hugeData.data.entries).toHaveLength(5);
    const beyondSafeInteger = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', limit: '99999999999999999999999999' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(beyondSafeInteger.statusCode).toBe(200);
    const beyondData = JSON.parse(beyondSafeInteger.body) as { data: { entries: unknown[] } };
    expect(beyondData.data.entries).toHaveLength(5);
    const badCursor = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', cursor: 'not-a-cursor!!' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(badCursor, 400, 'invalid_cursor');
    const wrongKind = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', cursor: Buffer.from(JSON.stringify({ v: 2, kind: 'scan', scope: 'pages', afterPath: 'x' })).toString('base64url') })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(wrongKind, 400, 'invalid_cursor');
  });

  it('list rejects a cursor from another folder with 400 invalid_cursor (AD-65)', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', limit: '2' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    const firstData = JSON.parse(first.body) as {
      data: { nextCursor: string; hasMore: boolean };
    };
    expect(firstData.data.hasMore).toBe(true);
    const pagesCursor = firstData.data.nextCursor;
    const crossFolder = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'sort', cursor: pagesCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(crossFolder, 400, 'invalid_cursor');
    const crossToRoot = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ cursor: pagesCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(crossToRoot, 400, 'invalid_cursor');
    const sameFolder = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', limit: '2', cursor: pagesCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(sameFolder.statusCode).toBe(200);
    const sameData = JSON.parse(sameFolder.body) as {
      data: { entries: Array<{ name: string }> };
    };
    expect(sameData.data.entries.map((e) => e.name)).toEqual(['p2.md', 'p3.md']);
  });

  it('scan rejects a cursor from another folder with 400 invalid_cursor (AD-65)', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault', limit: '1' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    const firstData = JSON.parse(first.body) as {
      data: { nextCursor: string; hasMore: boolean };
    };
    expect(firstData.data.hasMore).toBe(true);
    const vaultCursor = firstData.data.nextCursor;
    const crossToSubfolder = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault/sub', cursor: vaultCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(crossToSubfolder, 400, 'invalid_cursor');
    const crossToRoot = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ cursor: vaultCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(crossToRoot, 400, 'invalid_cursor');
    const rootFirst = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ limit: '1' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    const rootData = JSON.parse(rootFirst.body) as { data: { nextCursor: string } };
    const crossFromRoot = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault', cursor: rootData.data.nextCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(crossFromRoot, 400, 'invalid_cursor');
    const sameFolder = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault', limit: '1', cursor: vaultCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(sameFolder.statusCode).toBe(200);
    const sameData = JSON.parse(sameFolder.body) as {
      data: { entries: Array<{ path: string }> };
    };
    expect(sameData.data.entries.map((e) => e.path)).toEqual(['vault/sub/a.md']);
  });

  it('v:1 cursors without scope are rejected with 400 invalid_cursor (AD-65)', async () => {
    const v1List = Buffer.from(
      JSON.stringify({ v: 1, kind: 'list', afterName: 'p0.md', afterIsDirectory: false, afterPath: 'pages/p0.md' }),
    ).toString('base64url');
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', cursor: v1List })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(listRes, 400, 'invalid_cursor');
    const v1Scan = Buffer.from(
      JSON.stringify({ v: 1, kind: 'scan', afterPath: 'vault/b.md' }),
    ).toString('base64url');
    const scanRes = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault', cursor: v1Scan })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(scanRes, 400, 'invalid_cursor');
    const v2NoScope = Buffer.from(
      JSON.stringify({ v: 2, kind: 'list', afterName: 'p0.md', afterIsDirectory: false, afterPath: 'pages/p0.md' }),
    ).toString('base64url');
    const noScopeRes = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', cursor: v2NoScope })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(noScopeRes, 400, 'invalid_cursor');
  });

  it('root cursor works with an absent or explicitly empty path (AD-65)', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ limit: '2' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(first.statusCode).toBe(200);
    const firstData = JSON.parse(first.body) as {
      data: { entries: Array<{ name: string }>; nextCursor: string; hasMore: boolean };
    };
    expect(firstData.data.entries.map((e) => e.name)).toEqual(['pages', 'sort']);
    expect(firstData.data.hasMore).toBe(true);
    const second = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: '', limit: '2', cursor: firstData.data.nextCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(second.statusCode).toBe(200);
    const secondData = JSON.parse(second.body) as {
      data: { entries: Array<{ name: string }> };
    };
    expect(secondData.data.entries.map((e) => e.name)).toEqual(['vault', 'bad-utf8.md']);
  });

  it('cursor accepts a different limit and includeMetadata flag (AD-65)', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', limit: '2' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    const firstData = JSON.parse(first.body) as { data: { nextCursor: string } };
    const otherLimit = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', limit: '10', cursor: firstData.data.nextCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(otherLimit.statusCode).toBe(200);
    const otherLimitData = JSON.parse(otherLimit.body) as {
      data: { entries: Array<{ name: string }>; hasMore: boolean; nextCursor: string | null };
    };
    expect(otherLimitData.data.entries.map((e) => e.name)).toEqual(['p2.md', 'p3.md', 'p4.md']);
    expect(otherLimitData.data.hasMore).toBe(false);
    expect(otherLimitData.data.nextCursor).toBeNull();
    const otherMetadata = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', limit: '2', includeMetadata: 'false', cursor: firstData.data.nextCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(otherMetadata.statusCode).toBe(200);
    const otherMetadataData = JSON.parse(otherMetadata.body) as {
      data: { entries: Array<{ name: string; size: number | null }> };
    };
    expect(otherMetadataData.data.entries.map((e) => e.name)).toEqual(['p2.md', 'p3.md']);
    expect(otherMetadataData.data.entries[0]?.size).toBeNull();
  });

  it('malformed cursor beats invalid path and hidden folder still answers 404 (AD-65)', async () => {
    const malformedBeatsPath = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: '..', cursor: 'not-a-cursor!!' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(malformedBeatsPath, 400, 'invalid_cursor');
    const first = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'pages', limit: '2' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    const firstData = JSON.parse(first.body) as { data: { nextCursor: string } };
    const hiddenBeatsScope = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: '.secret', cursor: firstData.data.nextCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(hiddenBeatsScope, 404, 'not_found');
    const scanFirst = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault', limit: '1' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    const scanData = JSON.parse(scanFirst.body) as { data: { nextCursor: string } };
    const scanHidden = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: '.secret', cursor: scanData.data.nextCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(scanHidden, 404, 'not_found');
  });

  it('scan returns only .md recursively with relativePath sorted by path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault', includeMetadata: 'true' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as {
      data: {
        folder: string;
        entries: Array<{ path: string; relativePath: string; size: number | null }>;
        nextCursor: string | null;
        hasMore: boolean;
      };
    };
    expect(data.data.folder).toBe('vault');
    expect(data.data.entries.map((e) => e.path)).toEqual(['vault/b.md', 'vault/sub/a.md']);
    expect(data.data.entries[1]?.relativePath).toBe('sub/a.md');
    expect(data.data.entries[0]?.relativePath).toBe('b.md');
    expect(data.data.hasMore).toBe(false);
    expect(data.data.nextCursor).toBeNull();
  });

  it('scan defaults includeMetadata to false and paginates consistently', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault', limit: '1' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    const firstData = JSON.parse(first.body) as {
      data: { entries: Array<Record<string, unknown>>; nextCursor: string; hasMore: boolean };
    };
    expect(firstData.data.entries).toHaveLength(1);
    expect(firstData.data.hasMore).toBe(true);
    expect(firstData.data.entries[0]?.['size']).toBeNull();
    const second = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault', limit: '1', cursor: firstData.data.nextCursor })}`,
      headers: { cookie: VALID_COOKIE },
    });
    const secondData = JSON.parse(second.body) as {
      data: { entries: Array<{ path: string }>; hasMore: boolean; nextCursor: string | null };
    };
    expect(secondData.data.entries).toHaveLength(1);
    expect(secondData.data.hasMore).toBe(false);
    expect(secondData.data.nextCursor).toBeNull();
    expect(secondData.data.entries[0]?.path).toBe('vault/sub/a.md');
  });

  it('scan missing folder returns 404 and rejects invalid cursor and limit', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault/ghost' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(missing, 404, 'not_found');
    const badLimit = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault', limit: '0' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(badLimit, 400, 'invalid_limit');
    const badCursor = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault', cursor: 'nope!!' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(badCursor, 400, 'invalid_cursor');
    const clamped = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault', limit: '99999' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(clamped.statusCode).toBe(200);
  });

  it('scan over a file returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'read.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(res, 404, 'not_found');
  });

  it('paths through a regular file answer 404 not_found on all read routes (ENOTDIR)', async () => {
    const through = 'read.md/child.md';
    const checks = [
      { method: 'GET', url: `/api/workspace/file${q({ path: through })}` },
      { method: 'HEAD', url: `/api/workspace/file${q({ path: through })}` },
      { method: 'GET', url: `/api/workspace/list${q({ path: through })}` },
      { method: 'GET', url: `/api/workspace/scan${q({ folder: through })}` },
      { method: 'GET', url: `/api/workspace/stat${q({ path: through })}` },
    ] as const;
    for (const check of checks) {
      const res = await app.inject({ ...check, headers: { cookie: VALID_COOKIE } });
      expect(res.statusCode).toBe(404);
      if (check.method !== 'HEAD') {
        expectError(res, 404, 'not_found');
      }
    }
  });

  it('an overlong single segment answers 404 not_found on all read routes (ENAMETOOLONG)', async () => {
    const longSegment = `${'a'.repeat(1021)}.md`;
    expect(Buffer.byteLength(longSegment, 'utf8')).toBe(1024);
    const checks = [
      { method: 'GET', url: `/api/workspace/file${q({ path: longSegment })}` },
      { method: 'HEAD', url: `/api/workspace/file${q({ path: longSegment })}` },
      { method: 'GET', url: `/api/workspace/list${q({ path: longSegment })}` },
      { method: 'GET', url: `/api/workspace/scan${q({ folder: longSegment })}` },
      { method: 'GET', url: `/api/workspace/stat${q({ path: longSegment })}` },
    ] as const;
    for (const check of checks) {
      const res = await app.inject({ ...check, headers: { cookie: VALID_COOKIE } });
      expect(res.statusCode).toBe(404);
      if (check.method !== 'HEAD') {
        expectError(res, 404, 'not_found');
      }
    }
  });

  it('traversal and absolute paths are rejected with invalid_path', async () => {
    const bad = ['../escape.md', 'a/../../escape.md', '/abs.md', 'C:/win.md', '..', 'a/../b.md'];
    for (const badPath of bad) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/workspace/file${q({ path: badPath })}`,
        headers: { cookie: VALID_COOKIE },
      });
      expectError(res, 400, 'invalid_path');
    }
  });

  it('strict segment forms are rejected with invalid_path', async () => {
    const bad = ['a//b.md', 'a/./b.md', 'a\\b.md', 'a/b.md/'];
    for (const badPath of bad) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/workspace/file${q({ path: badPath })}`,
        headers: { cookie: VALID_COOKIE },
      });
      expectError(res, 400, 'invalid_path');
    }
  });

  it('unknown query parameters are ignored', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'sort', bogusParam: '1' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(200);
  });

  it('trailing-slash, versioned prefix, and wrong case return 404', async () => {
    for (const url of ['/api/workspace/list/', '/api/v1/workspace/list', '/api/workspace/List']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: VALID_COOKIE } });
      expectError(res, 404, 'not_found');
    }
  });

  it('reads never mutate disk', async () => {
    const before = await readFile(join(dir, 'read.md'), 'utf8');
    await app.inject({
      method: 'GET',
      url: `/api/workspace/file${q({ path: 'read.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'sort' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'vault' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: 'read.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(await readFile(join(dir, 'read.md'), 'utf8')).toBe(before);
  });

  it('symlink reads return 404 and list/scan skip symlinks silently', async () => {
    await writeFile(join(dir, 'target.md'), 'real');
    await symlink(join(dir, 'target.md'), join(dir, 'link.md'));
    await symlink(join(dir, 'vault'), join(dir, 'vault-link'));
    const get = await app.inject({
      method: 'GET',
      url: `/api/workspace/file${q({ path: 'link.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(get, 404, 'not_found');
    const statRes = await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: 'link.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(statRes, 404, 'not_found');
    const throughDir = await app.inject({
      method: 'GET',
      url: `/api/workspace/file${q({ path: 'vault-link/b.md' })}`,
      headers: { cookie: VALID_COOKIE },
    });
    expectError(throughDir, 404, 'not_found');
    const list = await app.inject({
      method: 'GET',
      url: '/api/workspace/list',
      headers: { cookie: VALID_COOKIE },
    });
    const listData = JSON.parse(list.body) as { data: { entries: Array<{ name: string }> } };
    expect(listData.data.entries.map((e) => e.name)).not.toContain('link.md');
    expect(listData.data.entries.map((e) => e.name)).not.toContain('vault-link');
    const scan = await app.inject({
      method: 'GET',
      url: '/api/workspace/scan',
      headers: { cookie: VALID_COOKIE },
    });
    const scanData = JSON.parse(scan.body) as { data: { entries: Array<{ path: string }> } };
    expect(scanData.data.entries.map((e) => e.path)).not.toContain('vault-link/b.md');
  });

  it('rejects requests without a valid session', async () => {
    const noCookie = await app.inject({ method: 'GET', url: '/api/workspace/list' });
    expectError(noCookie, 401, 'unauthenticated');
    const bearerOnly = await app.inject({
      method: 'GET',
      url: '/api/workspace/list',
      headers: { authorization: 'Bearer some-token' },
    });
    expectError(bearerOnly, 401, 'unauthenticated');
    const badCookie = await app.inject({
      method: 'GET',
      url: '/api/workspace/list',
      headers: { cookie: 'notegen_session=nope' },
    });
    expectError(badCookie, 401, 'unauthenticated');
  });
});

describe('workspace read routes without an injected verifier', () => {
  it('deny by default with 401', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v3-04a-deny-'));
    try {
      const app = await buildApp({
        config: testConfig({ workspaceRoot: dir }),
        pool: null,
        version: 'test',
      });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/workspace/list',
          headers: { cookie: VALID_COOKIE },
        });
        expectError(res, 401, 'unauthenticated');
      } finally {
        await app.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('workspace read routes with an unconfigured workspace', () => {
  it('answer 503 service_unavailable', async () => {
    const app = await buildApp({
      config: testConfig({ workspaceRoot: undefined }),
      pool: null,
      version: 'test',
      verifySession,
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/workspace/list',
        headers: { cookie: VALID_COOKIE },
      });
      const body = expectError(res, 503, 'service_unavailable');
      expect(body.error.retryable).toBe(true);
      const file = await app.inject({
        method: 'GET',
        url: `/api/workspace/file${q({ path: 'a.md' })}`,
        headers: { cookie: VALID_COOKIE },
      });
      expectError(file, 503, 'service_unavailable');
    } finally {
      await app.close();
    }
  });

  it('answer 503 when the root is a regular file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v3-04a-rootfile-'));
    try {
      const fileRoot = join(dir, 'not-a-dir');
      await writeFile(fileRoot, 'x');
      const app = await buildApp({
        config: testConfig({ workspaceRoot: fileRoot }),
        pool: null,
        version: 'test',
        verifySession,
      });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/workspace/list',
          headers: { cookie: VALID_COOKIE },
        });
        expectError(res, 503, 'service_unavailable');
      } finally {
        await app.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
