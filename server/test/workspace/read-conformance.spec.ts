// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// HTTP conformance specs for the workspace READ endpoints, wired
// with the REAL V3-04a read routes and service plus the REAL V3-04b
// write routes behind the REAL V3-04a path and revision modules.
//
// What is real in this wiring: the Fastify routes, the frozen auth
// hooks, the read service (list, file, HEAD, scan, stat), the write
// routes, guards, queue, and service, validateWorkspacePath,
// assertNoSymlinkComponents, and buildRevision. What is faked, and
// why: the index, event, and idempotency ports use the V3-04b fakes
// (Postgres wiring is an integrator step, fan-out belongs to V3-08,
// key storage belongs to the auth worker); the session/CSRF
// verifiers are stubs behind the real hooks; the workspace identity
// comes from a test resolver; the read version lookup reads the
// fake index, so versions are null for files never written through
// the write routes until the V3-06 index lands. Nothing here claims
// a result against a live server with real auth: that run is the
// real-runner.mjs real mode, which stays blocked until the auth
// routes land (see the V3-04c report in fase1/).
//
// Every revision asserted here is recomputed independently with
// node:crypto from the desain section 3.1 formula, never by calling
// buildRevision: revision = "sha256:" + hex(SHA-256(workspaceKey +
// NUL + filePath + NUL + content bytes)). The V3-04a read.spec.ts
// suite pins the same routes while computing expected revisions
// with buildRevision itself, so a wrong formula would hide there;
// these specs close that gap, and add the read/write ETag round
// trip, which no single-branch suite can pin.
//
// Contract: kontrak-api-kanonis.md section 3.1 and section 1.4
// (pagination, clamping, hasMore), desain-workspace-api.md sections
// 1.4, 1.6, 2.1, 2.2, 2.9, 2.10, 3.1, 3.2, and 8 (path validation,
// 400 vs 404 matrix).
//
// Deliberately not duplicated here (pinned by V3-04a read.spec.ts
// against the same real modules): GET 415 not_text_file and 422
// invalid_text_encoding, 401 without a valid session, and 503
// service_unavailable for an unconfigured workspace root.

import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
} from '../../src/middleware/auth-hook.js';
import { registerErrorHandling } from '../../src/plugins/error-handler.js';
import { registerRequestId, requestIdFromHeaders } from '../../src/plugins/request-id.js';
import { registerWorkspaceReadRoutes } from '../../src/routes/workspace-read.js';
import { registerWorkspaceWriteRoutes } from '../../src/routes/workspace-write.js';
import { AUTH_HEADERS, errorBody } from '../helpers/workspace-test-app.js';
import { TEST_USER_ID, TEST_WORKSPACE_ID, type TestPortsBundle } from '../helpers/workspace-test-ports.js';
import { createRealPortsBundle, REAL_WORKSPACE_KEY } from './real-ports.js';

const TEST_ORIGIN = 'https://app.example.invalid';

// Independent revision computation: the desain section 3.1 formula
// recomputed here with node:crypto, never through buildRevision.
function independentRevision(path: string, content: Buffer | string, key: string = REAL_WORKSPACE_KEY): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const digest = createHash('sha256')
    .update(key, 'utf8')
    .update(Buffer.from([0]))
    .update(path, 'utf8')
    .update(Buffer.from([0]))
    .update(bytes)
    .digest('hex');
  return `sha256:${digest}`;
}

interface Fixture {
  app: FastifyInstance;
  root: string;
  bundle: TestPortsBundle;
}

let fixture: Fixture | undefined;

async function buildCombinedApp(root: string, bundle: TestPortsBundle): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024 * 1024,
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  const principal: SessionPrincipal = { userId: TEST_USER_ID, role: 'user', sessionId: 'good-session' };
  registerAuthHooks(app, {
    verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? principal : null),
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
    canonicalOrigin: TEST_ORIGIN,
  });
  await registerWorkspaceReadRoutes(app, {
    workspaceRoot: root,
    workspaceKey: REAL_WORKSPACE_KEY,
    resolveVersion: (path) => bundle.index.currentVersion(TEST_WORKSPACE_ID, path),
  });
  await registerWorkspaceWriteRoutes(app, {
    ports: bundle.ports,
    resolveIdentity: bundle.resolveIdentity,
  });
  await app.ready();
  return app;
}

async function buildReadOnlyApp(root: string): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024 * 1024,
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  const principal: SessionPrincipal = { userId: TEST_USER_ID, role: 'user', sessionId: 'good-session' };
  registerAuthHooks(app, {
    verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? principal : null),
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
    canonicalOrigin: TEST_ORIGIN,
  });
  // No workspaceKey: the reader defaults to the resolved root path.
  await registerWorkspaceReadRoutes(app, { workspaceRoot: root });
  await app.ready();
  return app;
}

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'notegen-read-conformance-'));
  const bundle = createRealPortsBundle(root);
  const app = await buildCombinedApp(root, bundle);
  fixture = { app, root, bundle };
  return fixture;
}

async function setupReadOnly(): Promise<{ app: FastifyInstance; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'notegen-read-conformance-'));
  const app = await buildReadOnlyApp(root);
  fixture = { app, root, bundle: createRealPortsBundle(root) };
  return { app, root };
}

beforeEach(() => {
  fixture = undefined;
});

afterEach(async () => {
  if (fixture !== undefined) {
    await fixture.app.close();
    await rm(fixture.root, { recursive: true, force: true });
    fixture = undefined;
  }
});

function dataOf(res: { json(): unknown }): Record<string, unknown> {
  return (res.json() as { data: Record<string, unknown> }).data;
}

function entriesOf(res: { json(): unknown }): Array<Record<string, unknown>> {
  return dataOf(res)['entries'] as Array<Record<string, unknown>>;
}

function q(params: Record<string, string>): string {
  return `?${new URLSearchParams(params).toString()}`;
}

function fileUrl(path: string): string {
  return `/api/workspace/file?path=${encodeURIComponent(path)}`;
}

async function writeDisk(root: string, rel: string, content: Buffer | string): Promise<void> {
  const absolute = join(root, ...rel.split('/'));
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content);
}

async function createViaPut(
  app: FastifyInstance,
  path: string,
  content: string,
): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'PUT',
    url: fileUrl(path),
    headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
    payload: content,
  });
  expect(res.statusCode).toBe(201);
  return dataOf(res);
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  async function walk(dir: string, prefix: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      const absolute = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(absolute, rel);
      } else if (dirent.isFile()) {
        const bytes = await readFile(absolute);
        const digest = createHash('sha256').update(bytes).digest('hex');
        const info = await stat(absolute);
        seen.set(rel, `${digest}:${info.mtimeMs}:${info.size}`);
      }
    }
  }
  await walk(root, '');
  return seen;
}

describe('GET file: raw text with an independently recomputed revision', () => {
  it('returns the exact bytes with quoted ETag, X-Revision, and no line-ending normalization', async () => {
    const { app, root } = await setup();
    const bytes = Buffer.from('line one\r\nline two\r\n', 'utf8');
    await writeDisk(root, 'notes/crlf.md', bytes);
    const res = await app.inject({ method: 'GET', url: fileUrl('notes/crlf.md'), headers: { ...AUTH_HEADERS } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('line one\r\nline two\r\n');
    const expected = independentRevision('notes/crlf.md', bytes);
    expect(res.headers['etag']).toBe(`"${expected}"`);
    expect(res.headers['x-revision']).toBe(expected);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(res.headers['last-modified']).toBeDefined();
  });

  it('returns text/plain for .txt with the same revision formula', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'plain.txt', 'plain');
    const res = await app.inject({ method: 'GET', url: fileUrl('plain.txt'), headers: { ...AUTH_HEADERS } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('plain');
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['x-revision']).toBe(independentRevision('plain.txt', 'plain'));
  });

  it('sends nosniff and a sandbox CSP so a directly opened file cannot be sniffed as HTML', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'markup.md', '<html><body>not a page</body></html>');
    const res = await app.inject({ method: 'GET', url: fileUrl('markup.md'), headers: { ...AUTH_HEADERS } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    const head = await app.inject({ method: 'HEAD', url: fileUrl('markup.md'), headers: { ...AUTH_HEADERS } });
    expect(head.statusCode).toBe(200);
    expect(head.headers['x-content-type-options']).toBe('nosniff');
    expect(head.headers['content-security-policy']).toBe('sandbox');
  });

  it('changes the revision when the path changes even if the bytes are identical', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'a.md', 'same');
    await writeDisk(root, 'b.md', 'same');
    const first = await app.inject({ method: 'GET', url: fileUrl('a.md'), headers: { ...AUTH_HEADERS } });
    const second = await app.inject({ method: 'GET', url: fileUrl('b.md'), headers: { ...AUTH_HEADERS } });
    expect(first.headers['x-revision']).toBe(independentRevision('a.md', 'same'));
    expect(second.headers['x-revision']).toBe(independentRevision('b.md', 'same'));
    expect(first.headers['x-revision']).not.toBe(second.headers['x-revision']);
  });

  it('defaults the workspace key to the resolved root when no key is injected', async () => {
    const { app, root } = await setupReadOnly();
    await writeDisk(root, 'keyed.md', 'keyed');
    const res = await app.inject({ method: 'GET', url: fileUrl('keyed.md'), headers: { ...AUTH_HEADERS } });
    expect(res.statusCode).toBe(200);
    const rootReal = await realpath(root);
    expect(res.headers['x-revision']).toBe(independentRevision('keyed.md', 'keyed', rootReal));
  });
});

describe('HEAD and GET revalidation', () => {
  it('HEAD returns the GET headers with an empty body', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'head.md', 'head body');
    const get = await app.inject({ method: 'GET', url: fileUrl('head.md'), headers: { ...AUTH_HEADERS } });
    const head = await app.inject({ method: 'HEAD', url: fileUrl('head.md'), headers: { ...AUTH_HEADERS } });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['etag']).toBe(get.headers['etag']);
    expect(head.headers['x-revision']).toBe(get.headers['x-revision']);
    expect(head.headers['last-modified']).toBe(get.headers['last-modified']);
    expect(head.headers['content-type']).toBe(get.headers['content-type']);
    expect(head.headers['content-length']).toBe(get.headers['content-length']);
  });

  it('HEAD answers 200 for binary files with a revision computed from the bytes', async () => {
    const { app, root } = await setup();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
    await writeDisk(root, 'pic.png', png);
    const res = await app.inject({ method: 'HEAD', url: fileUrl('pic.png'), headers: { ...AUTH_HEADERS } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['x-revision']).toBe(independentRevision('pic.png', png));
  });

  it('HEAD answers 200 for invalid UTF-8 files', async () => {
    const { app, root } = await setup();
    const bad = Buffer.from([0x41, 0xff, 0xfe, 0x42]);
    await writeDisk(root, 'bad.md', bad);
    const res = await app.inject({ method: 'HEAD', url: fileUrl('bad.md'), headers: { ...AUTH_HEADERS } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-revision']).toBe(independentRevision('bad.md', bad));
  });

  it('GET with a matching If-None-Match answers 304 with no body', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'fresh.md', 'fresh');
    const revision = independentRevision('fresh.md', 'fresh');
    const res = await app.inject({
      method: 'GET',
      url: fileUrl('fresh.md'),
      headers: { ...AUTH_HEADERS, 'if-none-match': `"${revision}"` },
    });
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe('');
    expect(res.headers['etag']).toBe(`"${revision}"`);
  });

  it('GET with a list If-None-Match containing the revision answers 304', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'fresh.md', 'fresh');
    const revision = independentRevision('fresh.md', 'fresh');
    const res = await app.inject({
      method: 'GET',
      url: fileUrl('fresh.md'),
      headers: { ...AUTH_HEADERS, 'if-none-match': `"sha256:other", "${revision}"` },
    });
    expect(res.statusCode).toBe(304);
  });

  it('GET with a non-matching If-None-Match answers 200 with the body', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'fresh.md', 'fresh');
    const res = await app.inject({
      method: 'GET',
      url: fileUrl('fresh.md'),
      headers: { ...AUTH_HEADERS, 'if-none-match': '"sha256:other"' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('fresh');
  });
});

describe('stat: entry shape, revision, and version', () => {
  it('returns the DirEntry shape with an independent revision and the index version after a PUT', async () => {
    const { app } = await setup();
    const created = await createViaPut(app, 'statted.md', 'stat me');
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: 'statted.md' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    const entry = dataOf(res);
    expect(entry['name']).toBe('statted.md');
    expect(entry['path']).toBe('statted.md');
    expect(entry['isDirectory']).toBe(false);
    expect(entry['isFile']).toBe(true);
    expect(entry['size']).toBe(7);
    expect(typeof entry['modifiedAt']).toBe('string');
    expect(entry['revision']).toBe(independentRevision('statted.md', 'stat me'));
    expect(entry['revision']).toBe(created['revision']);
    expect(entry['version']).toBe(1);
    expect(entry['isLocale']).toBe(true);
    expect(res.headers['etag']).toBe(`"${String(created['revision'])}"`);
    expect(res.headers['last-modified']).toBeDefined();
  });

  it('reports version null for a disk-only file but still computes the revision', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'disk-only.md', 'disk');
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: 'disk-only.md' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)['version']).toBeNull();
    expect(dataOf(res)['revision']).toBe(independentRevision('disk-only.md', 'disk'));
  });

  it('reports a folder with null size, revision, and version and no ETag header', async () => {
    const { app, root } = await setup();
    await mkdir(join(root, 'folder'), { recursive: true });
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: 'folder' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    const entry = dataOf(res);
    expect(entry['isDirectory']).toBe(true);
    expect(entry['isFile']).toBe(false);
    expect(entry['size']).toBeNull();
    expect(entry['revision']).toBeNull();
    expect(entry['version']).toBeNull();
    expect(res.headers['etag']).toBeUndefined();
  });

  it('answers 200 with a byte revision for binary files', async () => {
    const { app, root } = await setup();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x09, 0x08]);
    await writeDisk(root, 'bin.png', png);
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: 'bin.png' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)['revision']).toBe(independentRevision('bin.png', png));
  });
});

const SCAN_FILES = [
  'a.md',
  'b/c.md',
  'b/d.md',
  'c.md',
  'deep/e/f.md',
  'deep/e/g.md',
  'deep/h.md',
];

async function seedScanTree(app: FastifyInstance, root: string): Promise<string> {
  for (const rel of SCAN_FILES) {
    await writeDisk(root, rel, `content of ${rel}`);
  }
  await writeDisk(root, 'b/note.txt', 'not markdown');
  await writeDisk(root, 'b/UPPER.MD', 'upper');
  await writeDisk(root, 'b/doc.markdown', 'long extension');
  await writeDisk(root, '.hidden/secret.md', 'hidden');
  await writeDisk(root, 'b/.dot.md', 'dot file');
  const outside = await mkdtemp(join(tmpdir(), 'notegen-outside-'));
  const target = join(outside, 'outside.md');
  await writeFile(target, 'outside');
  await symlink(target, join(root, 'b', 'link.md'));
  await symlink(outside, join(root, 'linked'));
  return outside;
}

describe('scan: paginated, .md only, lexicographic', () => {
  it('walks cursors over every page with no duplicates, no gaps, and consistent hasMore', async () => {
    const { app, root } = await setup();
    const outside = await seedScanTree(app, root);
    try {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      let hasMore = true;
      while (hasMore) {
        const params: Record<string, string> = { limit: '2' };
        if (cursor !== null) {
          params['cursor'] = cursor;
        }
        const res = await app.inject({
          method: 'GET',
          url: `/api/workspace/scan${q(params)}`,
          headers: { ...AUTH_HEADERS },
        });
        expect(res.statusCode).toBe(200);
        const data = dataOf(res);
        const entries = entriesOf(res);
        expect(data['folder']).toBe('');
        hasMore = data['hasMore'] as boolean;
        const next = data['nextCursor'] as string | null;
        expect(hasMore).toBe(next !== null);
        for (const entry of entries) {
          seen.push(String(entry['path']));
        }
        cursor = next;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(10);
      }
      expect(pages).toBe(4);
      expect(seen).toEqual(SCAN_FILES);
      expect(new Set(seen).size).toBe(seen.length);
      for (let i = 1; i < seen.length; i += 1) {
        expect(seen[i - 1]! < seen[i]!).toBe(true);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('returns only .md files, skipping hidden entries and symlinks', async () => {
    const { app, root } = await setup();
    const outside = await seedScanTree(app, root);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/workspace/scan', headers: { ...AUTH_HEADERS } });
      expect(res.statusCode).toBe(200);
      expect(entriesOf(res).map((entry) => entry['path'])).toEqual(SCAN_FILES);
      expect(dataOf(res)['hasMore']).toBe(false);
      expect(dataOf(res)['nextCursor']).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports relativePath against the requested folder', async () => {
    const { app, root } = await setup();
    const outside = await seedScanTree(app, root);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/workspace/scan${q({ folder: 'deep/e' })}`,
        headers: { ...AUTH_HEADERS },
      });
      expect(res.statusCode).toBe(200);
      expect(dataOf(res)['folder']).toBe('deep/e');
      expect(entriesOf(res).map((entry) => entry['relativePath'])).toEqual(['f.md', 'g.md']);
      expect(entriesOf(res).map((entry) => entry['path'])).toEqual(['deep/e/f.md', 'deep/e/g.md']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('defaults includeMetadata to false: null size and timestamps, revision still present', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'only.md', 'only');
    const res = await app.inject({ method: 'GET', url: '/api/workspace/scan', headers: { ...AUTH_HEADERS } });
    expect(res.statusCode).toBe(200);
    const entry = entriesOf(res)[0]!;
    expect(entry['size']).toBeNull();
    expect(entry['modifiedAt']).toBeNull();
    expect(entry['revision']).toBe(independentRevision('only.md', 'only'));
    expect(entry['version']).toBeNull();
  });

  it('populates size and timestamps when includeMetadata is true', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'only.md', 'only');
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ includeMetadata: 'true' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    const entry = entriesOf(res)[0]!;
    expect(entry['size']).toBe(4);
    expect(typeof entry['modifiedAt']).toBe('string');
  });

  it.each(['0', 'abc', '-1', '1.5'])('rejects limit %s with 400 invalid_limit', async (limit) => {
    const { app, root } = await setup();
    await writeDisk(root, 'only.md', 'only');
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ limit })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('invalid_limit');
  });

  it('clamps a limit above the maximum instead of erroring, including over-safe-integer values', async () => {
    const { app, root } = await setup();
    const outside = await seedScanTree(app, root);
    try {
      for (const limit of ['5000', '9'.repeat(30)]) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/workspace/scan${q({ limit })}`,
          headers: { ...AUTH_HEADERS },
        });
        expect(res.statusCode).toBe(200);
        expect(entriesOf(res).map((entry) => entry['path'])).toEqual(SCAN_FILES);
        expect(dataOf(res)['hasMore']).toBe(false);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a garbage cursor and a list cursor with 400 invalid_cursor', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'x.md', 'x');
    await writeDisk(root, 'y.md', 'y');
    const garbage = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ cursor: 'not-a-cursor!!!' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(garbage.statusCode).toBe(400);
    expect(errorBody(garbage).code).toBe('invalid_cursor');
    const listed = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ limit: '1' })}`,
      headers: { ...AUTH_HEADERS },
    });
    const listCursor = String(dataOf(listed)['nextCursor']);
    expect(listCursor.length).toBeGreaterThan(0);
    const wrongKind = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ cursor: listCursor })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(wrongKind.statusCode).toBe(400);
    expect(errorBody(wrongKind).code).toBe('invalid_cursor');
  });

  it('rejects a scan cursor from another folder and a v:1 cursor with 400 invalid_cursor (AD-65)', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'folderA/m01.md', 'm01');
    await writeDisk(root, 'folderA/m02.md', 'm02');
    await writeDisk(root, 'folderB/a01.md', 'a01');
    await writeDisk(root, 'folderB/b01.md', 'b01');
    const first = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'folderA', limit: '1' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(first.statusCode).toBe(200);
    const cursorA = String(dataOf(first)['nextCursor']);
    expect(cursorA.length).toBeGreaterThan(0);
    const crossFolder = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'folderB', limit: '10', cursor: cursorA })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(crossFolder.statusCode).toBe(400);
    expect(errorBody(crossFolder).code).toBe('invalid_cursor');
    const crossToRoot = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ cursor: cursorA })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(crossToRoot.statusCode).toBe(400);
    expect(errorBody(crossToRoot).code).toBe('invalid_cursor');
    const v1Cursor = Buffer.from(JSON.stringify({ v: 1, kind: 'scan', afterPath: 'folderA/m01.md' })).toString('base64url');
    const v1Res = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'folderA', cursor: v1Cursor })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(v1Res.statusCode).toBe(400);
    expect(errorBody(v1Res).code).toBe('invalid_cursor');
    const sameFolder = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'folderA', limit: '10', cursor: cursorA })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(sameFolder.statusCode).toBe(200);
    expect(entriesOf(sameFolder).map((entry) => entry['path'])).toEqual(['folderA/m02.md']);
  });

  it('answers 404 for a missing folder and for a file folder, 400 for traversal', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'file.md', 'file');
    const missing = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'nope' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(missing.statusCode).toBe(404);
    expect(errorBody(missing).code).toBe('not_found');
    const fileFolder = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: 'file.md' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(fileFolder.statusCode).toBe(404);
    expect(errorBody(fileFolder).code).toBe('not_found');
    const traversal = await app.inject({
      method: 'GET',
      url: `/api/workspace/scan${q({ folder: '..' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(traversal.statusCode).toBe(400);
    expect(errorBody(traversal).code).toBe('invalid_path');
  });
});

async function seedListTree(root: string): Promise<void> {
  await mkdir(join(root, 'sort', 'afolder'), { recursive: true });
  await mkdir(join(root, 'sort', 'zfolder'), { recursive: true });
  await writeDisk(root, 'sort/zebra.md', 'z');
  await writeDisk(root, 'sort/apple.md', 'a');
  await writeDisk(root, 'sort/.hidden.md', 'hidden');
}

describe('list: one level, folders first, paginated', () => {
  it('returns one level only, folders first then files, hiding dot entries', async () => {
    const { app, root } = await setup();
    await seedListTree(root);
    await writeDisk(root, 'sort/afolder/nested.md', 'nested');
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'sort' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)['path']).toBe('sort');
    const names = entriesOf(res).map((entry) => entry['name']);
    expect(names).toEqual(['afolder', 'zfolder', 'apple.md', 'zebra.md']);
    expect(entriesOf(res).map((entry) => entry['isDirectory'])).toEqual([true, true, false, false]);
  });

  it('lists the root when the path parameter is absent', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'root-a.md', 'a');
    await writeDisk(root, 'root-b.md', 'b');
    const res = await app.inject({ method: 'GET', url: '/api/workspace/list', headers: { ...AUTH_HEADERS } });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)['path']).toBe('');
    expect(entriesOf(res).map((entry) => entry['name'])).toEqual(['root-a.md', 'root-b.md']);
  });

  it('walks cursors with limit 1 preserving the folders-first order', async () => {
    const { app, root } = await setup();
    await seedListTree(root);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let hasMore = true;
    while (hasMore) {
      const params: Record<string, string> = { path: 'sort', limit: '1' };
      if (cursor !== null) {
        params['cursor'] = cursor;
      }
      const res = await app.inject({
        method: 'GET',
        url: `/api/workspace/list${q(params)}`,
        headers: { ...AUTH_HEADERS },
      });
      expect(res.statusCode).toBe(200);
      const data = dataOf(res);
      expect(entriesOf(res)).toHaveLength(1);
      seen.push(String(entriesOf(res)[0]!['name']));
      hasMore = data['hasMore'] as boolean;
      expect(hasMore).toBe((data['nextCursor'] as string | null) !== null);
      cursor = data['nextCursor'] as string | null;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(10);
    }
    expect(pages).toBe(4);
    expect(seen).toEqual(['afolder', 'zfolder', 'apple.md', 'zebra.md']);
  });

  it('rejects bad limits and cursors and clamps huge limits', async () => {
    const { app, root } = await setup();
    await seedListTree(root);
    for (const limit of ['0', 'abc']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/workspace/list${q({ path: 'sort', limit })}`,
        headers: { ...AUTH_HEADERS },
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe('invalid_limit');
    }
    const badCursor = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'sort', cursor: '%%%' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(badCursor.statusCode).toBe(400);
    expect(errorBody(badCursor).code).toBe('invalid_cursor');
    const clamped = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'sort', limit: '999999' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(clamped.statusCode).toBe(200);
    expect(entriesOf(clamped)).toHaveLength(4);
    expect(dataOf(clamped)['hasMore']).toBe(false);
  });

  it('rejects a list cursor from another folder and a v:1 cursor with 400 invalid_cursor (AD-65)', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'folderA/m01.md', 'm01');
    await writeDisk(root, 'folderA/m02.md', 'm02');
    await writeDisk(root, 'folderA/m03.md', 'm03');
    await writeDisk(root, 'folderB/a01.md', 'a01');
    await writeDisk(root, 'folderB/b01.md', 'b01');
    const first = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'folderA', limit: '1' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(first.statusCode).toBe(200);
    const cursorA = String(dataOf(first)['nextCursor']);
    expect(cursorA.length).toBeGreaterThan(0);
    const crossFolder = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'folderB', limit: '10', cursor: cursorA })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(crossFolder.statusCode).toBe(400);
    expect(errorBody(crossFolder).code).toBe('invalid_cursor');
    const crossToRoot = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ cursor: cursorA })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(crossToRoot.statusCode).toBe(400);
    expect(errorBody(crossToRoot).code).toBe('invalid_cursor');
    const v1Cursor = Buffer.from(
      JSON.stringify({ v: 1, kind: 'list', afterName: 'm01.md', afterIsDirectory: false, afterPath: 'folderA/m01.md' }),
    ).toString('base64url');
    const v1Res = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'folderA', cursor: v1Cursor })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(v1Res.statusCode).toBe(400);
    expect(errorBody(v1Res).code).toBe('invalid_cursor');
    const sameFolder = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'folderA', limit: '10', cursor: cursorA })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(sameFolder.statusCode).toBe(200);
    expect(entriesOf(sameFolder).map((entry) => entry['name'])).toEqual(['m02.md', 'm03.md']);
  });

  it('answers 400 not_a_directory for a file path and 404 for a missing folder', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'file.md', 'file');
    const filePath = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'file.md' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(filePath.statusCode).toBe(400);
    expect(errorBody(filePath).code).toBe('not_a_directory');
    const missing = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: 'nope' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(missing.statusCode).toBe(404);
    expect(errorBody(missing).code).toBe('not_found');
  });

  it('nulls size and timestamps with includeMetadata=false but keeps the independent revision', async () => {
    const { app, root } = await setup();
    await writeDisk(root, 'meta.md', 'meta');
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ includeMetadata: 'false' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    const entry = entriesOf(res)[0]!;
    expect(entry['size']).toBeNull();
    expect(entry['modifiedAt']).toBeNull();
    expect(entry['createdAt']).toBeNull();
    expect(entry['revision']).toBe(independentRevision('meta.md', 'meta'));
  });

  it('skips symlink entries silently', async () => {
    const { app, root } = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'notegen-outside-'));
    try {
      await writeDisk(root, 'real.md', 'real');
      await symlink(join(outside, 'target.md'), join(root, 'alias.md'));
      await writeFile(join(outside, 'target.md'), 'target');
      const res = await app.inject({ method: 'GET', url: '/api/workspace/list', headers: { ...AUTH_HEADERS } });
      expect(res.statusCode).toBe(200);
      expect(entriesOf(res).map((entry) => entry['name'])).toEqual(['real.md']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('read-side path matrix: 400 for syntax, 404 for hidden and symlinks', () => {
  it.each(['..', '../x.md', 'a/../b.md', 'a/b/..'])(
    'answers 400 invalid_path for traversal %s on GET, stat, and list',
    async (path) => {
      const { app } = await setup();
      for (const url of [fileUrl(path), `/api/workspace/stat${q({ path })}`, `/api/workspace/list${q({ path })}`]) {
        const res = await app.inject({ method: 'GET', url, headers: { ...AUTH_HEADERS } });
        expect(res.statusCode).toBe(400);
        expect(errorBody(res).code).toBe('invalid_path');
      }
    },
  );

  it('answers 404 not_found for hidden paths, indistinguishable from missing files', async () => {
    const { app, root } = await setup();
    await writeDisk(root, '.secret/h.md', 'secret');
    for (const path of ['.secret/h.md', '.hidden.md']) {
      const get = await app.inject({ method: 'GET', url: fileUrl(path), headers: { ...AUTH_HEADERS } });
      expect(get.statusCode).toBe(404);
      expect(errorBody(get).code).toBe('not_found');
      const statted = await app.inject({
        method: 'GET',
        url: `/api/workspace/stat${q({ path })}`,
        headers: { ...AUTH_HEADERS },
      });
      expect(statted.statusCode).toBe(404);
      expect(errorBody(statted).code).toBe('not_found');
    }
    const listed = await app.inject({
      method: 'GET',
      url: `/api/workspace/list${q({ path: '.secret' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(listed.statusCode).toBe(404);
    expect(errorBody(listed).code).toBe('not_found');
  });

  it('answers 404 for symlink files and symlinked parents and leaves the outside file untouched', async () => {
    const { app, root } = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'notegen-outside-'));
    try {
      const target = join(outside, 'secret.md');
      await writeFile(target, 'outside');
      await symlink(target, join(root, 'escape.md'));
      await symlink(outside, join(root, 'linked'));
      for (const path of ['escape.md', 'linked/secret.md']) {
        const get = await app.inject({ method: 'GET', url: fileUrl(path), headers: { ...AUTH_HEADERS } });
        expect(get.statusCode).toBe(404);
        expect(errorBody(get).code).toBe('not_found');
        const statted = await app.inject({
          method: 'GET',
          url: `/api/workspace/stat${q({ path })}`,
          headers: { ...AUTH_HEADERS },
        });
        expect(statted.statusCode).toBe(404);
        expect(errorBody(statted).code).toBe('not_found');
      }
      expect(await readFile(target, 'utf8')).toBe('outside');
      expect((await lstat(join(root, 'escape.md'))).isSymbolicLink()).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('answers 404 for a missing file and for a folder without distinction', async () => {
    const { app, root } = await setup();
    await mkdir(join(root, 'folder'), { recursive: true });
    for (const path of ['missing.md', 'folder']) {
      const res = await app.inject({ method: 'GET', url: fileUrl(path), headers: { ...AUTH_HEADERS } });
      expect(res.statusCode).toBe(404);
      expect(errorBody(res).code).toBe('not_found');
    }
  });

  it('treats a double-encoded traversal spelling as a literal file name', async () => {
    const { app, root } = await setup();
    await writeDisk(root, '%2e%2e.md', 'literal');
    const res = await app.inject({ method: 'GET', url: fileUrl('%2e%2e.md'), headers: { ...AUTH_HEADERS } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('literal');
    expect(res.headers['x-revision']).toBe(independentRevision('%2e%2e.md', 'literal'));
  });
});

describe('ETag and If-Match consistency across read and write routes', () => {
  it('round-trips: the verbatim GET ETag works as the PUT If-Match guard', async () => {
    const { app } = await setup();
    await createViaPut(app, 'round.md', 'first');
    const get = await app.inject({ method: 'GET', url: fileUrl('round.md'), headers: { ...AUTH_HEADERS } });
    const etag = String(get.headers['etag']);
    const put = await app.inject({
      method: 'PUT',
      url: fileUrl('round.md'),
      headers: { ...AUTH_HEADERS, 'if-match': etag, 'content-type': 'text/plain' },
      payload: 'second',
    });
    expect(put.statusCode).toBe(200);
    expect(dataOf(put)['revision']).toBe(independentRevision('round.md', 'second'));
    const getAgain = await app.inject({ method: 'GET', url: fileUrl('round.md'), headers: { ...AUTH_HEADERS } });
    expect(getAgain.headers['x-revision']).toBe(dataOf(put)['revision']);
    expect(getAgain.body).toBe('second');
  });

  it('a stale GET ETag answers 412 and leaves the newer bytes untouched', async () => {
    const { app, root } = await setup();
    await createViaPut(app, 'stale.md', 'first');
    const get = await app.inject({ method: 'GET', url: fileUrl('stale.md'), headers: { ...AUTH_HEADERS } });
    const staleETag = String(get.headers['etag']);
    const forced = await app.inject({
      method: 'PUT',
      url: fileUrl('stale.md'),
      headers: { ...AUTH_HEADERS, 'if-match': '*', 'content-type': 'text/plain' },
      payload: 'newer',
    });
    expect(forced.statusCode).toBe(200);
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('stale.md'),
      headers: { ...AUTH_HEADERS, 'if-match': staleETag, 'content-type': 'text/plain' },
      payload: 'client text',
    });
    expect(res.statusCode).toBe(412);
    expect(errorBody(res).code).toBe('revision_conflict');
    expect(await readFile(join(root, 'stale.md'), 'utf8')).toBe('newer');
  });

  it('stat, GET, and write responses agree on revision and version after an append', async () => {
    const { app } = await setup();
    const created = await createViaPut(app, 'agree.md', 'line one\n');
    const appended = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=agree.md',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ expectedRevision: created['revision'], content: 'line two\n' }),
    });
    expect(appended.statusCode).toBe(200);
    const revision = String(dataOf(appended)['revision']);
    expect(revision).toBe(independentRevision('agree.md', 'line one\nline two\n'));
    const get = await app.inject({ method: 'GET', url: fileUrl('agree.md'), headers: { ...AUTH_HEADERS } });
    expect(get.headers['x-revision']).toBe(revision);
    expect(get.headers['x-version']).toBe('2');
    const statted = await app.inject({
      method: 'GET',
      url: `/api/workspace/stat${q({ path: 'agree.md' })}`,
      headers: { ...AUTH_HEADERS },
    });
    expect(dataOf(statted)['revision']).toBe(revision);
    expect(dataOf(statted)['version']).toBe(2);
    expect(statted.headers['etag']).toBe(`"${revision}"`);
  });

  it('reads never mutate disk or the index', async () => {
    const { app, root, bundle } = await setup();
    await writeDisk(root, 'a.md', 'a');
    await writeDisk(root, 'sub/b.md', 'b');
    await writeDisk(root, 'sub/c.txt', 'c');
    const before = await snapshot(root);
    const beforeRows = bundle.index.rows.size;
    const urls = [
      '/api/workspace/list',
      `/api/workspace/list${q({ path: 'sub' })}`,
      '/api/workspace/scan',
      fileUrl('a.md'),
      `/api/workspace/stat${q({ path: 'a.md' })}`,
      fileUrl('missing.md'),
      `/api/workspace/stat${q({ path: '..' })}`,
    ];
    for (const url of urls) {
      await app.inject({ method: 'GET', url, headers: { ...AUTH_HEADERS } });
    }
    await app.inject({ method: 'HEAD', url: fileUrl('a.md'), headers: { ...AUTH_HEADERS } });
    const after = await snapshot(root);
    expect([...after.entries()]).toEqual([...before.entries()]);
    expect(bundle.index.rows.size).toBe(beforeRows);
  });
});
