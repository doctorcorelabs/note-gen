// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// HTTP tests for POST /api/workspace/move and POST
// /api/workspace/move/repair-links (V3-05 part 2): file and
// folder moves, move-validity rejections, the 412 file guard,
// write-side path mapping, link rewriting, target parent creation,
// idempotency replay, and repair-links preconditions. The app comes
// from buildApp with injected
// session/CSRF/Origin verifiers, over a real scratch directory;
// the move routes arrive through the workspace-structure
// registration adapter (rank 60, W4-WIRE). The two idempotency
// tests use a standalone Fastify instance built from the same
// frozen plugin functions, because they inject a test-only
// in-memory idempotency store and identity resolver that
// production wiring deliberately does not supply; registering
// the routes a second time on the buildApp app would duplicate
// them.
//
// Expectations mirror the R1 client conformance suite
// (tests/workspace-client/move.test.mjs): affectedCount counts the
// moved entry plus its descendants, moves create target parents,
// and rewriteLinks defaults to true.

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { buildRevision } from '../src/lib/revision.js';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
  type VerifySessionFn,
} from '../src/middleware/auth-hook.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import { registerRequestId, requestIdFromHeaders } from '../src/plugins/request-id.js';
import { registerWorkspaceMoveRoutes } from '../src/routes/workspace-move.js';
import type {
  IdempotencyLookupInput,
  IdempotencyLookupResult,
  IdempotencyPort,
  StoredIdempotentResponse,
} from '../src/services/workspace/write-ports.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const VALID_COOKIE = 'notegen_session=valid';

const AUTH_HEADERS = {
  cookie: VALID_COOKIE,
  origin: TEST_ORIGIN,
  'x-csrf-token': 'good-csrf',
} as const;

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

const verifySession: VerifySessionFn = async ({ sessionId }) => {
  if (sessionId !== 'valid') {
    return null;
  }
  const principal: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'sess-1' };
  return principal;
};

interface Fixture {
  app: FastifyInstance;
  dir: string;
  rootReal: string;
}

let fixture: Fixture | undefined;

async function setup(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'v3b-05b-move-'));
  const rootReal = await realpath(dir);
  const app = await buildApp({
    config: testConfig({ workspaceRoot: dir }),
    pool: null,
    version: 'test',
    verifySession,
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
  });
  fixture = { app, dir, rootReal };
  return fixture;
}

// Standalone app for the idempotency tests: the same frozen
// plugins buildApp uses, plus the move registrar with the
// test-only in-memory idempotency store and identity resolver.
// Production wiring passes neither dep, so these tests cannot
// run against buildApp without duplicating the routes.
async function setupIdempotent(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'v3b-05b-move-'));
  const rootReal = await realpath(dir);
  const app = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  registerAuthHooks(app, {
    verifySession,
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
    canonicalOrigin: TEST_ORIGIN,
  });
  await registerWorkspaceMoveRoutes(app, {
    workspaceRoot: dir,
    idempotency: createMemoryIdempotencyStore(),
    resolveIdentity: async (principal) => ({
      workspaceId: 'ws-1',
      userId: principal.userId,
      actorId: undefined,
    }),
  });
  await app.ready();
  fixture = { app, dir, rootReal };
  return fixture;
}

beforeEach(() => {
  fixture = undefined;
});

afterEach(async () => {
  if (fixture !== undefined) {
    await fixture.app.close();
    await rm(fixture.dir, { recursive: true, force: true });
    fixture = undefined;
  }
});

async function seed(dir: string, relPath: string, content: Buffer | string): Promise<void> {
  const absolute = join(dir, relPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function move(
  app: FastifyInstance,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string; json: () => unknown; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/workspace/move',
    headers: { ...AUTH_HEADERS, 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
  return res;
}

async function repairLinks(
  app: FastifyInstance,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string; json: () => unknown; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/workspace/move/repair-links',
    headers: { ...AUTH_HEADERS, 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
  return res;
}

function dataOf(res: { json: () => unknown }): Record<string, unknown> {
  const body = res.json() as { ok: boolean; data: Record<string, unknown> };
  expect(body.ok).toBe(true);
  return body.data;
}

function errorOf(res: { statusCode: number; json: () => unknown }, status: number, code: string): Record<string, unknown> {
  expect(res.statusCode).toBe(status);
  const body = res.json() as {
    ok: boolean;
    error: { code: string; requestId: string; details: Record<string, unknown> };
  };
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.requestId).toBe('string');
  expect(body.error.requestId).not.toBe('');
  expect(typeof body.error.details).toBe('object');
  return body.error.details;
}

function revisionOf(rootReal: string, path: string, content: Buffer | string): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return buildRevision(rootReal, path, bytes);
}

describe('POST /api/workspace/move', () => {
  it('moves a file and changes its revision', async () => {
    const { app, dir, rootReal } = await setup();
    await seed(dir, 'move/old.md', 'moved content');
    const oldRevision = revisionOf(rootReal, 'move/old.md', 'moved content');
    const res = await move(app, { source: 'move/old.md', target: 'move/new.md' });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['source']).toBe('move/old.md');
    expect(data['target']).toBe('move/new.md');
    expect(data['kind']).toBe('file');
    expect(data['rewriteLinks']).toBe(true);
    expect(data['rewriteStatus']).toBe('complete');
    expect(data['revision']).toBe(revisionOf(rootReal, 'move/new.md', 'moved content'));
    expect(data['revision']).not.toBe(oldRevision);
    expect(data['rewrittenFiles']).toEqual([]);
    expect(data['skipped']).toEqual([]);
    expect(data['pending']).toEqual([]);
    expect(data['affectedCount']).toBe(1);
    expect(data['indexHookWarning']).toBe(null);
    await expect(readFile(join(dir, 'move/old.md'))).rejects.toThrow();
    expect(await readFile(join(dir, 'move/new.md'), 'utf8')).toBe('moved content');
    // The read side agrees with the move response revision.
    const get = await app.inject({
      method: 'GET',
      url: '/api/workspace/file?path=move%2Fnew.md',
      headers: { cookie: VALID_COOKIE },
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers['x-revision']).toBe(data['revision']);
  });

  it('moves a folder with its whole subtree', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'move/srcdir/a.md', 'a');
    await seed(dir, 'move/srcdir/sub/b.md', 'b');
    const res = await move(app, { source: 'move/srcdir', target: 'move/dstdir' });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['kind']).toBe('folder');
    expect(data['revision']).toBe(null);
    expect(data['affectedCount']).toBe(4);
    expect(await readFile(join(dir, 'move/dstdir/a.md'), 'utf8')).toBe('a');
    expect(await readFile(join(dir, 'move/dstdir/sub/b.md'), 'utf8')).toBe('b');
    await expect(readFile(join(dir, 'move/srcdir/a.md'))).rejects.toThrow();
  });

  it('rejects moving a folder into its own subtree', async () => {
    const { app, dir } = await setup();
    await mkdir(join(dir, 'move/tree'), { recursive: true });
    const res = await move(app, { source: 'move/tree', target: 'move/tree/child' });
    errorOf(res, 400, 'invalid_move');
  });

  it('rejects same source and target', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'move/same.md', 's');
    const res = await move(app, { source: 'move/same.md', target: 'move/same.md' });
    errorOf(res, 400, 'invalid_move');
    expect(await readFile(join(dir, 'move/same.md'), 'utf8')).toBe('s');
  });

  it('refuses to overwrite an existing destination', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'move/clash-src.md', 'src');
    await seed(dir, 'move/clash-dst.md', 'dst');
    const res = await move(app, { source: 'move/clash-src.md', target: 'move/clash-dst.md' });
    errorOf(res, 409, 'already_exists');
    expect(await readFile(join(dir, 'move/clash-src.md'), 'utf8')).toBe('src');
    expect(await readFile(join(dir, 'move/clash-dst.md'), 'utf8')).toBe('dst');
  });

  it('refuses to move a folder onto an existing empty folder (F-05-02)', async () => {
    const { app, dir } = await setup();
    await mkdir(join(dir, 'move/fsrc'), { recursive: true });
    await seed(dir, 'move/fsrc/a.md', 'a');
    await mkdir(join(dir, 'move/fdst'), { recursive: true });
    const res = await move(app, { source: 'move/fsrc', target: 'move/fdst' });
    errorOf(res, 409, 'already_exists');
    expect(await readFile(join(dir, 'move/fsrc/a.md'), 'utf8')).toBe('a');
  });

  it('answers 412 for a stale guard and moves nothing', async () => {
    const { app, dir, rootReal } = await setup();
    await seed(dir, 'move/stale.md', 'v1');
    const staleRevision = revisionOf(rootReal, 'move/stale.md', 'v1');
    await writeFile(join(dir, 'move/stale.md'), 'v2');
    const currentRevision = revisionOf(rootReal, 'move/stale.md', 'v2');
    const res = await move(app, {
      source: 'move/stale.md',
      target: 'move/stale-new.md',
      expectedRevision: staleRevision,
    });
    const details = errorOf(res, 412, 'revision_conflict');
    expect(details['path']).toBe('move/stale.md');
    expect(details['serverRevision']).toBe(currentRevision);
    expect(await readFile(join(dir, 'move/stale.md'), 'utf8')).toBe('v2');
    await expect(readFile(join(dir, 'move/stale-new.md'))).rejects.toThrow();
  });

  it('accepts a move with the correct guard', async () => {
    const { app, dir, rootReal } = await setup();
    await seed(dir, 'move/guarded.md', 'g');
    const res = await move(app, {
      source: 'move/guarded.md',
      target: 'move/guarded-new.md',
      expectedRevision: revisionOf(rootReal, 'move/guarded.md', 'g'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('ignores expectedRevision for folders', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'move/folderguard/inside.md', 'in');
    const res = await move(app, {
      source: 'move/folderguard',
      target: 'move/folderguard-new',
      expectedRevision: 'sha256:bogus',
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['kind']).toBe('folder');
    expect(data['revision']).toBe(null);
  });

  it('rejects traversal and absolute paths on both sides', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'move/ok.md', 'ok');
    const bad = [
      { source: '../escape.md', target: 'move/x.md' },
      { source: 'move/ok.md', target: '../escape.md' },
      { source: '/etc/passwd', target: 'move/x.md' },
      { source: 'move/ok.md', target: 'move//x.md' },
      { source: 'move/../ok.md', target: 'move/x.md' },
      { source: 'move\\ok.md', target: 'move/x.md' },
    ];
    for (const body of bad) {
      const res = await move(app, body);
      errorOf(res, 400, 'invalid_path');
    }
    expect(await readFile(join(dir, 'move/ok.md'), 'utf8')).toBe('ok');
  });

  it('rejects hidden paths', async () => {
    const { app, dir } = await setup();
    await seed(dir, '.secret/h.md', 'secret');
    await seed(dir, 'move/ok.md', 'ok');
    errorOf(await move(app, { source: '.secret/h.md', target: 'move/x.md' }), 400, 'invalid_path');
    errorOf(await move(app, { source: 'move/ok.md', target: '.secret/x.md' }), 400, 'invalid_path');
  });

  it('rejects symlink components', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'move/real.md', 'real');
    await symlink(join(dir, 'move/real.md'), join(dir, 'move/link.md'));
    errorOf(await move(app, { source: 'move/link.md', target: 'move/x.md' }), 400, 'symlink_not_allowed');
    await mkdir(join(dir, 'move/realdir'), { recursive: true });
    await symlink(join(dir, 'move/realdir'), join(dir, 'move/linkdir'));
    errorOf(
      await move(app, { source: 'move/real.md', target: 'move/linkdir/x.md' }),
      400,
      'symlink_not_allowed',
    );
  });

  it('returns 404 for a missing source', async () => {
    const { app } = await setup();
    const res = await move(app, { source: 'move/ghost.md', target: 'move/ghost-new.md' });
    errorOf(res, 404, 'not_found');
  });

  it('creates target parent folders', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'move/orphan.md', 'o');
    const res = await move(app, { source: 'move/orphan.md', target: 'move/fresh/nested/orphan.md' });
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(dir, 'move/fresh/nested/orphan.md'), 'utf8')).toBe('o');
  });

  it('rejects unknown fields', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'move/fields.md', 'f');
    const res = await move(app, {
      source: 'move/fields.md',
      target: 'move/fields-new.md',
      workspaceId: 'ws-1',
    });
    errorOf(res, 400, 'validation_failed');
  });

  it('rewrites relative links in referring files', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'links/old/doc.md', '# Doc\n');
    await seed(dir, 'links/index.md', 'See [Doc](old/doc.md) and ![Diagram](old/doc.md).\n');
    const res = await move(app, { source: 'links/old/doc.md', target: 'links/new/doc.md' });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    const rewritten = data['rewrittenFiles'] as Array<Record<string, unknown>>;
    expect(rewritten.length).toBe(1);
    expect(rewritten[0]?.['path']).toBe('links/index.md');
    expect(rewritten[0]?.['replacements']).toBe(2);
    expect(await readFile(join(dir, 'links/index.md'), 'utf8')).toBe(
      'See [Doc](new/doc.md) and ![Diagram](new/doc.md).\n',
    );
  });

  it('leaves links untouched when rewriteLinks is false', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'links/old2/doc.md', '# Doc\n');
    const original = 'See [Doc](old2/doc.md).\n';
    await seed(dir, 'links/index2.md', original);
    const res = await move(app, {
      source: 'links/old2/doc.md',
      target: 'links/new2/doc.md',
      rewriteLinks: false,
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['rewriteStatus']).toBe('disabled');
    expect(data['rewrittenFiles']).toEqual([]);
    expect(await readFile(join(dir, 'links/index2.md'), 'utf8')).toBe(original);
  });

  it('does not rewrite absolute, schemed, or out-of-root references', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'links/old4/doc.md', '# Doc\n');
    const original =
      'See [Doc](old4/doc.md), [Abs](/links/old4/doc.md), [Web](https://example.invalid/links/old4/doc.md), ' +
      '[Mail](mailto:someone@example.invalid), [Frag](#old4/doc.md), [Out](../../links/old4/doc.md).\n';
    await seed(dir, 'links/index4.md', original);
    const res = await move(app, { source: 'links/old4/doc.md', target: 'links/new4/doc.md' });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    const rewritten = data['rewrittenFiles'] as Array<Record<string, unknown>>;
    expect(rewritten.length).toBe(1);
    expect(rewritten[0]?.['replacements']).toBe(1);
    expect(await readFile(join(dir, 'links/index4.md'), 'utf8')).toBe(
      'See [Doc](new4/doc.md), [Abs](/links/old4/doc.md), [Web](https://example.invalid/links/old4/doc.md), ' +
        '[Mail](mailto:someone@example.invalid), [Frag](#old4/doc.md), [Out](../../links/old4/doc.md).\n',
    );
  });

  it('does not rewrite links inside fenced code blocks', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'links/old3/doc.md', '# Doc\n');
    await seed(
      dir,
      'links/index3.md',
      'See [Doc](old3/doc.md).\n```md\n[Doc](old3/doc.md)\n```\n',
    );
    const res = await move(app, { source: 'links/old3/doc.md', target: 'links/new3/doc.md' });
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(dir, 'links/index3.md'), 'utf8')).toBe(
      'See [Doc](new3/doc.md).\n```md\n[Doc](old3/doc.md)\n```\n',
    );
  });

  it('reports an unreadable file as skipped with rewriteStatus skipped_only', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'links/plain.md', 'no links here');
    await seed(dir, 'links/broken.md', Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01]));
    const res = await move(app, { source: 'links/plain.md', target: 'links/plain-new.md' });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['rewriteStatus']).toBe('skipped_only');
    expect(data['rewrittenFiles']).toEqual([]);
    const skipped = data['skipped'] as Array<Record<string, unknown>>;
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.['path']).toBe('links/broken.md');
    expect(skipped[0]?.['reason']).toBe('read_error');
    expect(data['pending']).toEqual([]);
  });

  it('reports skipped files alongside rewritten files', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'links/old5/doc.md', '# Doc\n');
    await seed(dir, 'links/index5.md', 'See [Doc](old5/doc.md).\n');
    await seed(dir, 'links/broken5.md', Buffer.from([0xc3, 0x28, 0xff]));
    const res = await move(app, { source: 'links/old5/doc.md', target: 'links/new5/doc.md' });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['rewriteStatus']).toBe('complete');
    const rewritten = data['rewrittenFiles'] as Array<Record<string, unknown>>;
    expect(rewritten.length).toBe(1);
    expect(rewritten[0]?.['path']).toBe('links/index5.md');
    const skipped = data['skipped'] as Array<Record<string, unknown>>;
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.['path']).toBe('links/broken5.md');
    expect(skipped[0]?.['reason']).toBe('read_error');
    expect(await readFile(join(dir, 'links/index5.md'), 'utf8')).toBe('See [Doc](new5/doc.md).\n');
  });

  it('requires a session and a CSRF token', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'move/auth.md', 'a');
    const noSession = await app.inject({
      method: 'POST',
      url: '/api/workspace/move',
      headers: { origin: TEST_ORIGIN, 'x-csrf-token': 'good-csrf', 'content-type': 'application/json' },
      payload: JSON.stringify({ source: 'move/auth.md', target: 'move/auth-new.md' }),
    });
    errorOf(noSession, 401, 'unauthenticated');
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/workspace/move',
      headers: { cookie: VALID_COOKIE, origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ source: 'move/auth.md', target: 'move/auth-new.md' }),
    });
    errorOf(noCsrf, 403, 'csrf_invalid');
  });
});

describe('POST /api/workspace/move/repair-links', () => {
  it('rewrites after a move with rewriteLinks false, and a second run is empty', async () => {
    const { app, dir, rootReal } = await setup();
    await seed(dir, 'repair/old/doc.md', '# Doc\n');
    await seed(dir, 'repair/index.md', 'See [Doc](old/doc.md).\n');
    const moved = await move(app, {
      source: 'repair/old/doc.md',
      target: 'repair/new/doc.md',
      rewriteLinks: false,
    });
    expect(moved.statusCode).toBe(200);
    expect(await readFile(join(dir, 'repair/index.md'), 'utf8')).toBe('See [Doc](old/doc.md).\n');
    const res = await repairLinks(app, { source: 'repair/old/doc.md', target: 'repair/new/doc.md' });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['repaired']).toBe(true);
    expect(data['source']).toBe('repair/old/doc.md');
    expect(data['target']).toBe('repair/new/doc.md');
    expect(data['kind']).toBe('file');
    expect(data['rewriteLinks']).toBe(true);
    expect(data['rewriteStatus']).toBe('complete');
    expect(data['revision']).toBe(revisionOf(rootReal, 'repair/new/doc.md', '# Doc\n'));
    expect(data['affectedCount']).toBe(0);
    expect(data['indexHookWarning']).toBe(null);
    const rewritten = data['rewrittenFiles'] as Array<Record<string, unknown>>;
    expect(rewritten.length).toBe(1);
    expect(rewritten[0]?.['path']).toBe('repair/index.md');
    expect(rewritten[0]?.['replacements']).toBe(1);
    expect(data['skipped']).toEqual([]);
    expect(data['pending']).toEqual([]);
    expect(await readFile(join(dir, 'repair/index.md'), 'utf8')).toBe('See [Doc](new/doc.md).\n');
    // No rename happened: the source is still gone and the target
    // bytes are untouched.
    await expect(readFile(join(dir, 'repair/old/doc.md'))).rejects.toThrow();
    expect(await readFile(join(dir, 'repair/new/doc.md'), 'utf8')).toBe('# Doc\n');
    // The read side agrees with the repair response revision.
    const get = await app.inject({
      method: 'GET',
      url: '/api/workspace/file?path=repair%2Fnew%2Fdoc.md',
      headers: { cookie: VALID_COOKIE },
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers['x-revision']).toBe(data['revision']);
    // Naturally idempotent: a second run rewrites nothing.
    const again = await repairLinks(app, { source: 'repair/old/doc.md', target: 'repair/new/doc.md' });
    expect(again.statusCode).toBe(200);
    expect(dataOf(again)['rewrittenFiles']).toEqual([]);
  });

  it('rewrites folder-prefix links after a folder move', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'repair/oldfolder/a.md', 'a');
    await seed(dir, 'repair/ref.md', 'See [A](oldfolder/a.md).\n');
    const moved = await move(app, {
      source: 'repair/oldfolder',
      target: 'repair/newfolder',
      rewriteLinks: false,
    });
    expect(moved.statusCode).toBe(200);
    const res = await repairLinks(app, { source: 'repair/oldfolder', target: 'repair/newfolder' });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['repaired']).toBe(true);
    expect(data['kind']).toBe('folder');
    expect(data['revision']).toBe(null);
    expect(data['affectedCount']).toBe(0);
    expect(await readFile(join(dir, 'repair/ref.md'), 'utf8')).toBe('See [A](newfolder/a.md).\n');
  });

  it('fails the precondition when the target is missing', async () => {
    const { app } = await setup();
    const res = await repairLinks(app, {
      source: 'repair/ghost-old.md',
      target: 'repair/ghost-new.md',
    });
    errorOf(res, 409, 'repair_precondition_failed');
  });

  it('fails the precondition when the source still exists and rewrites nothing', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'repair/still.md', 's');
    await seed(dir, 'repair/still-new.md', 't');
    await seed(dir, 'repair/still-index.md', 'See [S](still.md).\n');
    const res = await repairLinks(app, { source: 'repair/still.md', target: 'repair/still-new.md' });
    errorOf(res, 409, 'repair_precondition_failed');
    expect(await readFile(join(dir, 'repair/still-index.md'), 'utf8')).toBe('See [S](still.md).\n');
    expect(await readFile(join(dir, 'repair/still.md'), 'utf8')).toBe('s');
    expect(await readFile(join(dir, 'repair/still-new.md'), 'utf8')).toBe('t');
  });

  it('rejects unknown fields, including move-only fields', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'repair/fields-new.md', 'f');
    errorOf(
      await repairLinks(app, {
        source: 'repair/fields-old.md',
        target: 'repair/fields-new.md',
        rewriteLinks: true,
      }),
      400,
      'validation_failed',
    );
    errorOf(
      await repairLinks(app, {
        source: 'repair/fields-old.md',
        target: 'repair/fields-new.md',
        expectedRevision: 'sha256:bogus',
      }),
      400,
      'validation_failed',
    );
  });

  it('rejects traversal paths on both sides', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'repair/ok.md', 'ok');
    errorOf(
      await repairLinks(app, { source: '../escape.md', target: 'repair/ok.md' }),
      400,
      'invalid_path',
    );
    errorOf(
      await repairLinks(app, { source: 'repair/ok.md', target: '../escape.md' }),
      400,
      'invalid_path',
    );
    expect(await readFile(join(dir, 'repair/ok.md'), 'utf8')).toBe('ok');
  });

  it('requires a session and a CSRF token', async () => {
    const { app, dir } = await setup();
    await seed(dir, 'repair/auth-new.md', 'a');
    const noSession = await app.inject({
      method: 'POST',
      url: '/api/workspace/move/repair-links',
      headers: { origin: TEST_ORIGIN, 'x-csrf-token': 'good-csrf', 'content-type': 'application/json' },
      payload: JSON.stringify({ source: 'repair/auth-old.md', target: 'repair/auth-new.md' }),
    });
    errorOf(noSession, 401, 'unauthenticated');
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/workspace/move/repair-links',
      headers: { cookie: VALID_COOKIE, origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ source: 'repair/auth-old.md', target: 'repair/auth-new.md' }),
    });
    errorOf(noCsrf, 403, 'csrf_invalid');
  });
});

function createMemoryIdempotencyStore(): IdempotencyPort {
  const rows = new Map<string, { requestHash: string; response: StoredIdempotentResponse; expiresAt: number }>();
  return {
    async lookup(input: IdempotencyLookupInput): Promise<IdempotencyLookupResult> {
      const row = rows.get(`${input.userId}\n${input.scope}\n${input.key}`);
      if (row === undefined || row.expiresAt <= Date.now()) {
        return { outcome: 'miss' };
      }
      if (row.requestHash !== input.requestHash) {
        return { outcome: 'reused' };
      }
      return { outcome: 'hit', response: row.response };
    },
    async store(input: IdempotencyLookupInput & { response: StoredIdempotentResponse }): Promise<void> {
      rows.set(`${input.userId}\n${input.scope}\n${input.key}`, {
        requestHash: input.requestHash,
        response: input.response,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
    },
  };
}

describe('POST /api/workspace/move idempotency', () => {
  it('replays the stored response without moving twice', async () => {
    const { app, dir } = await setupIdempotent();
    await seed(dir, 'move/idem-old.md', 'once');
    const key = `idem-move-${Date.now()}-replay`;
    const body = { source: 'move/idem-old.md', target: 'move/idem-new.md', rewriteLinks: false };
    const first = await move(app, body, { 'idempotency-key': key });
    expect(first.statusCode).toBe(200);
    const firstData = dataOf(first);
    const second = await move(app, body, { 'idempotency-key': key });
    expect(second.statusCode).toBe(200);
    expect(dataOf(second)).toEqual(firstData);
    expect(await readFile(join(dir, 'move/idem-new.md'), 'utf8')).toBe('once');
    await expect(readFile(join(dir, 'move/idem-old.md'))).rejects.toThrow();
  });

  it('rejects a reused key with a different request', async () => {
    const { app, dir } = await setupIdempotent();
    await seed(dir, 'move/reuse-old.md', 'once');
    await seed(dir, 'move/other.md', 'other');
    const key = `idem-move-${Date.now()}-reuse`;
    const first = await move(
      app,
      { source: 'move/reuse-old.md', target: 'move/reuse-new.md', rewriteLinks: false },
      { 'idempotency-key': key },
    );
    expect(first.statusCode).toBe(200);
    const second = await move(
      app,
      { source: 'move/other.md', target: 'move/other-new.md', rewriteLinks: false },
      { 'idempotency-key': key },
    );
    errorOf(second, 409, 'idempotency_key_reused');
    expect(await readFile(join(dir, 'move/other.md'), 'utf8')).toBe('other');
  });
});
