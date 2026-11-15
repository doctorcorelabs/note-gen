// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Contract and end-to-end checks for the app surface that exists at
// the gelombang 3B base (V3-41, slot v3b-41a, R3 grup 3). Every case
// runs against the REAL buildApp through Fastify inject(): the real
// middleware, envelope, error handler, and route blocks, with the
// session/CSRF verifiers injected through the AppDeps seam that
// already exists. No live server, no open port, no Postgres: routes
// whose positive path needs a database are pinned here only for
// their fail-closed and validation behavior, and their PG-backed
// positives stay owned by the V3-10/V3-13 specs.
//
// Groups covered, in contract order: global envelope and auth-hook
// behavior (kontrak 1.2, 1.4, 1.5, 2), workspace read/write
// (kontrak 3.1), settings and secrets fail-closed (kontrak 3.2,
// 3.3), transactions and batch validation (kontrak 3.4), explicit
// 501 stubs (kontrak 7), CSP reports (kontrak 3.11), health and
// ready (kontrak 3.14), and one real auth flow end to end, from
// setup through login to a workspace write with the real session
// and CSRF token (kontrak 3.12).
//
// Deliberately NOT covered here: routes that have not landed at
// this base (records, tags, assets, search, watcher, backup CRUD,
// mkdir/move/trash/reconcile, admin, auth advanced), media
// happy-path behavior owned by V3-07, Postgres-backed positives,
// and the Playwright 6-flow suite, whose final run waits for the
// merged tree in 3E. Nothing here is skipped silently: each gap is
// named in this header and in the slot report.
//
// G8-D2 DECISION, pinned by the "G8-D2" describe block below and
// owned by this slot for integrator ratification: GET
// /api/workspace/list over a path that names an EXISTING file
// answers 400 not_a_directory. Evidence: kontrak 6.2 catalog row
// "400 not_a_directory, List atas path file"; kontrak 3.1 list row
// lists not_a_directory among its errors; desain-workspace-api.md
// section 2.1 states a file path "dijawab 400 not_a_directory".
// The implementation already answers 400; this slot changes no
// production code. The 404 seen in the V3-04c real-runner triage
// is explained as a setup cascade (the file under test was never
// created because mkdir had not landed), not as implementation
// behavior. Companion decisions pinned in the same block: scan
// over a file keeps 404 not_found (kontrak 3.1 scan row does not
// list not_a_directory; V3-04a section 4), and missing, hidden,
// and symlink paths keep the generic 404 not_found on reads.
//
// Observed app behavior pinned as-is, not as contract text: a
// wrong method on a known path and an unknown path both answer
// 404 not_found through the global not-found handler (see
// plugins/error-handler.ts); the catalog code method_not_allowed
// is not emitted by the app today. Changing that is out of scope
// for this slot and is flagged in the slot report.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import {
  readCsrfTokenHeader,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';
import {
  buildTestApp,
  bodyOf,
  cookieFromResponse,
  makeTestAuth,
  publicHeaders,
  sessionHeaders,
  TEST_SETUP_TOKEN,
  type TestAuth,
} from './auth/helpers.js';

const ORIGIN = 'https://app.example.invalid';
const PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'good-session' };
const SESSION_HEADERS = { cookie: 'notegen_session=good-session' };
const AUTH_HEADERS = {
  ...SESSION_HEADERS,
  origin: ORIGIN,
  'x-csrf-token': 'good-csrf',
};
const JSON_HEADERS = { ...AUTH_HEADERS, 'content-type': 'application/json' };

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
    publicBaseUrl: ORIGIN,
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

async function stubVerifierApp(workspaceRoot: string): Promise<FastifyInstance> {
  return buildApp({
    config: testConfig({ workspaceRoot }),
    pool: null,
    version: '0.39.2-fork.1',
    verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? PRINCIPAL : null),
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
  });
}

interface ErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

function errorOf(res: LightMyRequestResponse): ErrorBody['error'] {
  const body = res.json() as ErrorBody;
  expect(body.ok).toBe(false);
  return body.error;
}

function expectErrorEnvelope(res: LightMyRequestResponse, status: number, code: string): ErrorBody['error'] {
  expect(res.statusCode).toBe(status);
  const error = errorOf(res);
  expect(error.code).toBe(code);
  expect(typeof error.message).toBe('string');
  expect(error.message.length).toBeGreaterThan(0);
  expect(typeof error.requestId).toBe('string');
  expect(error.requestId.length).toBeGreaterThan(0);
  expect(typeof error.retryable).toBe('boolean');
  expect(error.details).toEqual(expect.any(Object));
  expect(res.headers['x-request-id']).toBe(error.requestId);
  return error;
}

function dataOf<T>(res: LightMyRequestResponse): T {
  const body = res.json() as { ok: boolean; data: T };
  expect(body.ok).toBe(true);
  return body.data;
}

function multipartBody(boundary: string, parts: Array<{ name: string; filename?: string; content: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let disposition = `form-data; name="${part.name}"`;
    if (part.filename !== undefined) {
      disposition += `; filename="${part.filename}"`;
    }
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n\r\n`, 'utf8'));
    chunks.push(Buffer.from(part.content, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

describe('contract e2e grup 3: stub-verifier app', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'contract-g3-'));
    await writeFile(join(root, 'a.md'), 'hello\n', 'utf8');
    await writeFile(join(root, 'b.txt'), 'plain\n', 'utf8');
    await writeFile(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, 'bad.md'), Buffer.from([0xff, 0xfe, 0xfd]));
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'c.md'), 'child\n', 'utf8');
    await writeFile(join(root, '.hidden.md'), 'hidden\n', 'utf8');
    app = await stubVerifierApp(root);
  }, 30000);

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  describe('global envelope and auth hook (kontrak 1.2, 1.4, 2)', () => {
    it('answers success with { ok: true, data } and no error field', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/workspace/list', headers: SESSION_HEADERS });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['data', 'ok']);
      expect(body['ok']).toBe(true);
    });

    it('echoes a client X-Request-Id in the header and the error body', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/workspace/list?path=nope',
        headers: { ...SESSION_HEADERS, 'x-request-id': 'req-g3-echo-1' },
      });
      const error = expectErrorEnvelope(res, 404, 'not_found');
      expect(error.requestId).toBe('req-g3-echo-1');
    });

    it('answers 401 unauthenticated without a session and for a bad session', async () => {
      const noCookie = await app.inject({ method: 'GET', url: '/api/workspace/list' });
      expectErrorEnvelope(noCookie, 401, 'unauthenticated');
      const badCookie = await app.inject({
        method: 'GET',
        url: '/api/workspace/list',
        headers: { cookie: 'notegen_session=bad-session' },
      });
      expectErrorEnvelope(badCookie, 401, 'unauthenticated');
    });

    it('answers 404 not_found for unknown paths, with or without a session', async () => {
      const authed = await app.inject({ method: 'GET', url: '/api/nope', headers: SESSION_HEADERS });
      expectErrorEnvelope(authed, 404, 'not_found');
      const anon = await app.inject({ method: 'GET', url: '/api/nope' });
      expectErrorEnvelope(anon, 404, 'not_found');
    });

    it('rejects the versioned /api/v1/ prefix with 404 not_found', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/workspace/list', headers: SESSION_HEADERS });
      expectErrorEnvelope(res, 404, 'not_found');
    });

    it('answers 404 not_found for a wrong method on a known path', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/workspace/list', headers: AUTH_HEADERS });
      expectErrorEnvelope(res, 404, 'not_found');
    });

    it('rejects a mutation without Origin with 403 origin_rejected', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/workspace/file?path=a.md',
        headers: { ...SESSION_HEADERS, 'x-csrf-token': 'good-csrf', 'content-type': 'text/plain' },
        payload: 'x',
      });
      expectErrorEnvelope(res, 403, 'origin_rejected');
    });

    it('rejects a mutation with Origin but a bad CSRF token with 403 csrf_invalid', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/workspace/file?path=a.md',
        headers: { ...SESSION_HEADERS, origin: ORIGIN, 'x-csrf-token': 'bad-csrf', 'content-type': 'text/plain' },
        payload: 'x',
      });
      expectErrorEnvelope(res, 403, 'csrf_invalid');
    });

    it('does not require Origin or CSRF for a session GET', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/workspace/list', headers: SESSION_HEADERS });
      expect(res.statusCode).toBe(200);
    });

    it('answers 400 invalid_json for a malformed JSON body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/append?path=a.md',
        headers: JSON_HEADERS,
        payload: '{not json',
      });
      expectErrorEnvelope(res, 400, 'invalid_json');
    });

    it('rejects an unknown body field with 400 validation_failed naming the field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/append?path=a.md',
        headers: JSON_HEADERS,
        payload: { expectedRevision: 'sha256:whatever', content: 'x', surprise: 1 },
      });
      const error = expectErrorEnvelope(res, 400, 'validation_failed');
      expect(JSON.stringify(error.details)).toContain('surprise');
    });
  });

  describe('workspace read and write flow (kontrak 3.1)', () => {
    it('creates, reads, and lists a file with consistent revision and headers', async () => {
      const created = await app.inject({
        method: 'PUT',
        url: '/api/workspace/file?path=flow.md',
        headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
        payload: 'line1\nline2\nline3\n',
      });
      expect(created.statusCode).toBe(201);
      const createdData = dataOf<{ path: string; revision: string; version: unknown; size: number; modifiedAt: string; created: boolean }>(created);
      expect(createdData.path).toBe('flow.md');
      expect(createdData.created).toBe(true);
      expect(createdData.size).toBe(18);
      expect(createdData.revision.startsWith('sha256:')).toBe(true);
      expect(createdData.modifiedAt.endsWith('Z')).toBe(true);
      expect(created.headers['etag']).toBe(`"${createdData.revision}"`);

      const read = await app.inject({ method: 'GET', url: '/api/workspace/file?path=flow.md', headers: SESSION_HEADERS });
      expect(read.statusCode).toBe(200);
      expect(read.body).toBe('line1\nline2\nline3\n');
      expect(read.headers['etag']).toBe(`"${createdData.revision}"`);
      expect(read.headers['x-revision']).toBe(createdData.revision);
      expect(read.headers['last-modified']).toBeDefined();

      const listed = await app.inject({ method: 'GET', url: '/api/workspace/list', headers: SESSION_HEADERS });
      const listData = dataOf<{ entries: Array<{ name: string; path: string }> }>(listed);
      expect(listData.entries.map((entry) => entry.name)).toContain('flow.md');
      expect(listData.entries[0]?.name).toBe('sub');
    });

    it('answers 304 for a matching If-None-Match and 200 headers-only for HEAD', async () => {
      const read = await app.inject({ method: 'GET', url: '/api/workspace/file?path=a.md', headers: SESSION_HEADERS });
      const etag = read.headers['etag'] as string;
      const revalidated = await app.inject({
        method: 'GET',
        url: '/api/workspace/file?path=a.md',
        headers: { ...SESSION_HEADERS, 'if-none-match': etag },
      });
      expect(revalidated.statusCode).toBe(304);
      expect(revalidated.body).toBe('');
      const head = await app.inject({ method: 'HEAD', url: '/api/workspace/file?path=a.md', headers: SESSION_HEADERS });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers['etag']).toBe(etag);
    });

    it('requires a guard on PUT, rejects a stale guard with 412, accepts a fresh guard', async () => {
      const noGuard = await app.inject({
        method: 'PUT',
        url: '/api/workspace/file?path=a.md',
        headers: { ...AUTH_HEADERS, 'content-type': 'text/plain' },
        payload: 'noguard',
      });
      expectErrorEnvelope(noGuard, 428, 'precondition_required');

      const stale = await app.inject({
        method: 'PUT',
        url: '/api/workspace/file?path=a.md',
        headers: { ...AUTH_HEADERS, 'if-match': 'sha256:stale', 'content-type': 'text/plain' },
        payload: 'stale',
      });
      const conflict = expectErrorEnvelope(stale, 412, 'revision_conflict');
      expect(conflict.retryable).toBe(false);

      const stat = await app.inject({ method: 'GET', url: '/api/workspace/stat?path=a.md', headers: SESSION_HEADERS });
      const revision = (dataOf<{ revision: string }>(stat)).revision;
      const fresh = await app.inject({
        method: 'PUT',
        url: '/api/workspace/file?path=a.md',
        headers: { ...AUTH_HEADERS, 'if-match': revision, 'content-type': 'text/plain' },
        payload: 'hello2\n',
      });
      expect(fresh.statusCode).toBe(200);
      expect(dataOf<{ created: boolean }>(fresh).created).toBe(false);
    });

    it('appends with a body guard: stale 409, fresh 200, content visible on read', async () => {
      const stale = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/append?path=b.txt',
        headers: JSON_HEADERS,
        payload: { expectedRevision: 'sha256:stale', content: 'more' },
      });
      expectErrorEnvelope(stale, 409, 'revision_conflict');

      const stat = await app.inject({ method: 'GET', url: '/api/workspace/stat?path=b.txt', headers: SESSION_HEADERS });
      const revision = dataOf<{ revision: string }>(stat).revision;
      const appended = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/append?path=b.txt',
        headers: JSON_HEADERS,
        payload: { expectedRevision: revision, content: 'more\n' },
      });
      expect(appended.statusCode).toBe(200);
      const read = await app.inject({ method: 'GET', url: '/api/workspace/file?path=b.txt', headers: SESSION_HEADERS });
      expect(read.body).toBe('plain\nmore\n');
    });

    it('patches a line range and rejects an out-of-range patch', async () => {
      const stat = await app.inject({ method: 'GET', url: '/api/workspace/stat?path=flow.md', headers: SESSION_HEADERS });
      const revision = dataOf<{ revision: string }>(stat).revision;
      const outOfRange = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/patch?path=flow.md',
        headers: JSON_HEADERS,
        payload: { expectedRevision: revision, startLine: 9, endLine: 10, replacement: 'x\n' },
      });
      expectErrorEnvelope(outOfRange, 400, 'invalid_patch_range');

      const patched = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/patch?path=flow.md',
        headers: JSON_HEADERS,
        payload: { expectedRevision: revision, startLine: 2, endLine: 3, replacement: 'LINE2\n' },
      });
      expect(patched.statusCode).toBe(200);
      const read = await app.inject({ method: 'GET', url: '/api/workspace/file?path=flow.md', headers: SESSION_HEADERS });
      expect(read.body).toBe('line1\nLINE2\nline3\n');
    });

    it('answers 415 for a non-text file and 422 for invalid UTF-8 on GET', async () => {
      const binary = await app.inject({ method: 'GET', url: '/api/workspace/file?path=pic.png', headers: SESSION_HEADERS });
      expectErrorEnvelope(binary, 415, 'not_text_file');
      const badUtf8 = await app.inject({ method: 'GET', url: '/api/workspace/file?path=bad.md', headers: SESSION_HEADERS });
      expectErrorEnvelope(badUtf8, 422, 'invalid_text_encoding');
    });

    it('answers 404 for GET file over a folder and 400 invalid_path for traversal', async () => {
      const folder = await app.inject({ method: 'GET', url: '/api/workspace/file?path=sub', headers: SESSION_HEADERS });
      expectErrorEnvelope(folder, 404, 'not_found');
      const traversal = await app.inject({ method: 'GET', url: '/api/workspace/list?path=%2E%2E%2Fetc', headers: SESSION_HEADERS });
      expectErrorEnvelope(traversal, 400, 'invalid_path');
    });

    it('answers 404 for missing media and requires a guard on media PUT', async () => {
      const missing = await app.inject({ method: 'GET', url: '/api/workspace/media/nope.png', headers: SESSION_HEADERS });
      expectErrorEnvelope(missing, 404, 'not_found');
      const noGuard = await app.inject({
        method: 'PUT',
        url: '/api/workspace/media?path=pic2.png',
        headers: { ...AUTH_HEADERS, 'content-type': 'image/png' },
        payload: Buffer.from([0x89, 0x50]),
      });
      expectErrorEnvelope(noGuard, 428, 'precondition_required');
    });
  });

  describe('G8-D2: list and scan over a file (kontrak 3.1, 6.2)', () => {
    it('answers 400 not_a_directory for list over an existing file', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/workspace/list?path=a.md', headers: SESSION_HEADERS });
      expectErrorEnvelope(res, 400, 'not_a_directory');
    });

    it('answers 404 not_found for list over a missing folder', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/workspace/list?path=ghost', headers: SESSION_HEADERS });
      expectErrorEnvelope(res, 404, 'not_found');
    });

    it('answers 404 not_found for list over a hidden path, without distinguishing it', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/workspace/list?path=.hidden.md', headers: SESSION_HEADERS });
      expectErrorEnvelope(res, 404, 'not_found');
    });

    it('answers 404 not_found for scan over an existing file', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/workspace/scan?folder=a.md', headers: SESSION_HEADERS });
      expectErrorEnvelope(res, 404, 'not_found');
    });

    it('answers 400 for an invalid cursor and an invalid limit, and clamps an over-max limit', async () => {
      const badCursor = await app.inject({ method: 'GET', url: '/api/workspace/list?cursor=!!!', headers: SESSION_HEADERS });
      expectErrorEnvelope(badCursor, 400, 'invalid_cursor');
      const badLimit = await app.inject({ method: 'GET', url: '/api/workspace/list?limit=0', headers: SESSION_HEADERS });
      expectErrorEnvelope(badLimit, 400, 'invalid_limit');
      const clamped = await app.inject({ method: 'GET', url: '/api/workspace/list?limit=999999', headers: SESSION_HEADERS });
      expect(clamped.statusCode).toBe(200);
      expect(dataOf<{ hasMore: boolean }>(clamped).hasMore).toBe(false);
    });
  });

  describe('settings, secrets, and db without a database (kontrak 3.2, 3.3, 3.4)', () => {
    it('fails closed with 503 service_unavailable and retryable true on settings reads', async () => {
      for (const url of ['/api/settings', '/api/settings/revision', '/api/settings/secrets/status']) {
        const res = await app.inject({ method: 'GET', url, headers: SESSION_HEADERS });
        const error = expectErrorEnvelope(res, 503, 'service_unavailable');
        expect(error.retryable).toBe(true);
      }
    });

    it('fails closed with 503 on PATCH settings after auth and CSRF pass', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: JSON_HEADERS,
        payload: { baseRevision: 0, settings: {} },
      });
      expectErrorEnvelope(res, 503, 'service_unavailable');
    });

    it('rejects an unknown db kind with 400 invalid_operation naming index and kind', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/db/batch',
        headers: JSON_HEADERS,
        payload: { operations: [{ kind: 'nope.kind' }] },
      });
      const error = expectErrorEnvelope(res, 400, 'invalid_operation');
      expect(error.details['operationIndex']).toBe(0);
      expect(error.details['kind']).toBe('nope.kind');
    });

    it('rejects a write kind inside the read-only batch endpoint', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/db/batch',
        headers: JSON_HEADERS,
        payload: { operations: [{ kind: 'messages.append' }] },
      });
      expectErrorEnvelope(res, 400, 'invalid_operation');
    });

    it('rejects an unknown top-level field and a SQL-carrying field in db bodies', async () => {
      const unknown = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: JSON_HEADERS,
        payload: { operations: [{ kind: 'messages.append' }], surprise: 1 },
      });
      expectErrorEnvelope(unknown, 400, 'validation_failed');
      const sql = await app.inject({
        method: 'POST',
        url: '/api/db/batch',
        headers: JSON_HEADERS,
        payload: { operations: [{ kind: 'messages.get', sql: 'SELECT 1' }] },
      });
      const error = expectErrorEnvelope(sql, 400, 'validation_failed');
      expect(JSON.stringify(error.details)).toContain('sql');
    });

    it('answers 410 capability_unavailable for the Fase 2 gated policy.put kind', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: JSON_HEADERS,
        payload: { operations: [{ kind: 'policy.put' }] },
      });
      const error = expectErrorEnvelope(res, 410, 'capability_unavailable');
      expect(error.details['capability']).toBe('policy.put');
    });

    it('protects db routes with session and CSRF', async () => {
      const anon = await app.inject({
        method: 'POST',
        url: '/api/db/batch',
        headers: { origin: ORIGIN, 'x-csrf-token': 'good-csrf', 'content-type': 'application/json' },
        payload: { operations: [{ kind: 'messages.get' }] },
      });
      expectErrorEnvelope(anon, 401, 'unauthenticated');
      const noCsrf = await app.inject({
        method: 'POST',
        url: '/api/db/batch',
        headers: { ...SESSION_HEADERS, origin: ORIGIN, 'content-type': 'application/json' },
        payload: { operations: [{ kind: 'messages.get' }] },
      });
      expectErrorEnvelope(noCsrf, 403, 'csrf_invalid');
    });
  });

  describe('stubs, CSP, and health (kontrak 7, 3.11, 3.14)', () => {
    it('answers 501 document_parse_unavailable for a valid multipart parse upload', async () => {
      const boundary = '----g3-parse-boundary';
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/parse',
        headers: { ...AUTH_HEADERS, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [{ name: 'file', filename: 'doc.pdf', content: 'pdf-bytes' }]),
      });
      expectErrorEnvelope(res, 501, 'document_parse_unavailable');
    });

    it('answers 501 restore_unavailable for a JSON backupId restore', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/backups/restore',
        headers: JSON_HEADERS,
        payload: { backupId: 'backup-1' },
      });
      expectErrorEnvelope(res, 501, 'restore_unavailable');
    });

    it('answers 403 before the stub when Origin is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/backups/restore',
        headers: { ...SESSION_HEADERS, 'x-csrf-token': 'good-csrf', 'content-type': 'application/json' },
        payload: { backupId: 'backup-1' },
      });
      expectErrorEnvelope(res, 403, 'origin_rejected');
    });

    it('answers 204 empty for a valid CSP report with no session, no CSRF, no Origin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/csp-reports',
        headers: { 'content-type': 'application/csp-report' },
        payload: {
          'csp-report': {
            'document-uri': 'https://app.example.invalid/notes/a',
            'violated-directive': 'script-src',
          },
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    });

    it('answers 200 live with the AD-19 health shape, not the JSON envelope', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health/live' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body['ok']).toBe(true);
      expect(body['status']).toBe('live');
      expect(body['data']).toBeUndefined();
      expect(body['error']).toBeUndefined();
      const checks = body['checks'] as Record<string, { status: string }>;
      expect(checks['process']?.status).toBe('ok');
    });

    it('answers 503 not_ready with the fixed check order when the database is absent', async () => {
      const ready = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(ready.statusCode).toBe(503);
      const body = ready.json() as { ok: boolean; status: string; checks: Record<string, unknown> };
      expect(body.ok).toBe(false);
      expect(body.status).toBe('not_ready');
      expect(Object.keys(body.checks)).toEqual(['db', 'workspace', 'migrations', 'pgvector', 'worker']);
      const alias = await app.inject({ method: 'GET', url: '/api/health' });
      expect(alias.statusCode).toBe(503);
      const aliasBody = alias.json() as { status: string; checks: Record<string, unknown> };
      expect(aliasBody.status).toBe('not_ready');
      expect(Object.keys(aliasBody.checks)).toEqual(['db', 'workspace', 'migrations', 'pgvector', 'worker']);
    });
  });
});

describe('contract e2e grup 3: real auth flow', () => {
  let app: FastifyInstance;
  let fixture: TestAuth;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'contract-g3-auth-'));
    fixture = makeTestAuth();
    app = await buildTestApp(fixture.auth, { workspaceRoot: root });
  }, 30000);

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('setup, login, workspace write with the real session, and logout end to end', async () => {
    const register = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { ...publicHeaders(), 'content-type': 'application/json' },
      payload: { email: 'x@example.invalid', password: 'SomePassphrase1!' },
    });
    expectErrorEnvelope(register, 404, 'not_found');

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { ...publicHeaders(), 'content-type': 'application/json' },
      payload: { setupToken: TEST_SETUP_TOKEN, email: 'admin@example.invalid', password: 'SomePassphrase1!', workspaceName: 'Main' },
    });
    expect(setup.statusCode).toBe(201);
    expect(setup.headers['set-cookie']).toBeUndefined();
    expect(typeof bodyOf(setup).data?.['workspaceId']).toBe('string');

    const setupAgain = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { ...publicHeaders(), 'content-type': 'application/json' },
      payload: { setupToken: TEST_SETUP_TOKEN, email: 'b@example.invalid', password: 'SomePassphrase1!' },
    });
    expectErrorEnvelope(setupAgain, 404, 'not_found');

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...publicHeaders(), 'content-type': 'application/json' },
      payload: { email: 'admin@example.invalid', password: 'WrongPassphrase1!' },
    });
    expectErrorEnvelope(wrongPassword, 401, 'invalid_credentials');
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...publicHeaders(), 'content-type': 'application/json' },
      payload: { email: 'ghost@example.invalid', password: 'WrongPassphrase1!' },
    });
    expectErrorEnvelope(unknownEmail, 401, 'invalid_credentials');

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...publicHeaders(), 'content-type': 'application/json' },
      payload: { email: 'admin@example.invalid', password: 'SomePassphrase1!' },
    });
    expect(login.statusCode).toBe(200);
    const loginData = bodyOf(login).data as { csrfToken: string; email: string };
    expect(loginData.email).toBe('admin@example.invalid');
    const cookie = cookieFromResponse(login);
    expect(cookie).toBeDefined();
    const authed = sessionHeaders(cookie as string, loginData.csrfToken);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookie as string } });
    expect(me.statusCode).toBe(200);
    const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: cookie as string } });
    expect(csrf.statusCode).toBe(200);
    expect(csrf.headers['cache-control']).toBe('no-store');

    const created = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=auth-flow.md',
      headers: { ...authed, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'written after login\n',
    });
    expect(created.statusCode).toBe(201);
    const read = await app.inject({ method: 'GET', url: '/api/workspace/file?path=auth-flow.md', headers: { cookie: cookie as string } });
    expect(read.statusCode).toBe(200);
    expect(read.body).toBe('written after login\n');

    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: authed });
    expect(logout.statusCode).toBe(200);
    const afterLogout = await app.inject({ method: 'GET', url: '/api/workspace/list', headers: { cookie: cookie as string } });
    expectErrorEnvelope(afterLogout, 401, 'unauthenticated');
  }, 30000);
});
