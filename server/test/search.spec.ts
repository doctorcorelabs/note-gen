// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the search routes (V3-27 skeleton, Fase 1 wave 3B
// overlap): GET /api/search keyword search through the fake index
// port, and the POST /api/search/fuzzy explicit 501 stub.
//
// What is pinned here:
// - The fuzzy stub answers 501 fuzzy_search_unavailable only after
//   session, Origin, and CSRF checks pass; malformed bodies answer
//   400 validation_failed before the rejection; the stub never
//   calls the search port and has no side effects.
// - Keyword search answers the kontrak 3.9 shape (query, scope,
//   results, nextCursor, hasMore, fuzzy block, degraded false)
//   through the port interface; q is required and 1-200 chars,
//   scope defaults to all, mode is rejected, tagId and type
//   cannot combine with scope=files, limit defaults to 50 and
//   clamps to 200, and cursors are opaque and bound to their
//   query. Matching is all-term case-insensitive over name and
//   content, trash is never returned, and snippets stay within
//   200 characters with offsets inside the snippet.
// - POST /api/search does not exist (Fase 2 reservation, kontrak
//   section 8) and answers 405 method_not_allowed, because the path
//   exists under GET; a trailing-slash variant still answers 404.
//
// The harness composes the SAME frozen plugins as buildApp
// (request ids, error handling, auth hooks) and registers the
// search routes with the fake port, because the app.ts search
// block belongs to the integrator (V3-06/V3-25 wiring) and this
// skeleton must not edit app.ts. The pattern follows
// test/helpers/workspace-test-app.ts.

import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';
import { ApiError } from '../src/plugins/envelope.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import { registerRequestId, requestIdFromHeaders } from '../src/plugins/request-id.js';
import {
  FUZZY_SEARCH_PATH,
  parseKeywordSearchQuery,
  registerSearchRoutes,
  SEARCH_PATH,
  validateFuzzyRequestBody,
} from '../src/routes/search.js';
import {
  createFakeKeywordSearchPort,
  type FakeSearchItem,
  type KeywordSearchInput,
  type KeywordSearchPort,
  type SearchPage,
  type SearchResultItem,
} from '../src/services/search/port.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'good-session' };

const SESSION_HEADERS = {
  cookie: 'notegen_session=good-session',
};

const MUTATION_HEADERS = {
  ...SESSION_HEADERS,
  origin: TEST_ORIGIN,
  'x-csrf-token': 'good-csrf',
};

function fixtureItems(): FakeSearchItem[] {
  return [
    {
      kind: 'record',
      id: 42,
      title: 'Catatan gagal jantung',
      content: 'tanda gagal jantung kanan meliputi edema tungkai',
      fileName: '',
      type: 'text',
      tagIds: [3],
      url: '',
      updatedAt: 1794660000000,
      createdAt: 1794650000000,
    },
    {
      kind: 'record',
      id: 43,
      title: 'Daftar obat',
      content: 'furosemid untuk gagal jantung',
      fileName: '',
      type: 'text',
      tagIds: [7],
      url: '',
      updatedAt: 1794660001000,
      createdAt: 1794650001000,
    },
    {
      kind: 'record',
      id: 44,
      title: 'gagal jantung saja',
      content: '',
      fileName: '',
      type: 'image',
      tagIds: [3],
      url: 'asset-key-1',
      updatedAt: 1794660002000,
      createdAt: 1794650002000,
    },
    {
      kind: 'record',
      id: 45,
      title: 'Arsip gagal jantung',
      content: 'gagal jantung lama',
      fileName: '',
      type: 'text',
      tagIds: [],
      url: '',
      updatedAt: 1794660003000,
      createdAt: 1794650003000,
      trashed: true,
    },
    {
      kind: 'file',
      path: 'kardiologi/gagal-jantung.md',
      content: 'tatalaksana gagal jantung akut',
      contentHash: 'sha256:7be1c2',
      version: 4,
      updatedAt: 1794660000500,
    },
    {
      kind: 'file',
      path: 'sampah/gagal-jantung.md',
      content: 'gagal jantung sampah',
      contentHash: 'sha256:dead',
      version: 1,
      updatedAt: 1794660004000,
      trashed: true,
    },
  ];
}

interface CountingPort {
  port: KeywordSearchPort;
  calls: KeywordSearchInput[];
}

function countingPort(items: readonly FakeSearchItem[]): CountingPort {
  const fake = createFakeKeywordSearchPort(items);
  const calls: KeywordSearchInput[] = [];
  return {
    port: {
      async search(input: KeywordSearchInput): Promise<SearchPage> {
        calls.push(input);
        return fake.search(input);
      },
    },
    calls,
  };
}

async function searchApp(counter: CountingPort): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  registerAuthHooks(app, {
    verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? PRINCIPAL : null),
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
    canonicalOrigin: TEST_ORIGIN,
  });
  await registerSearchRoutes(app, { search: counter.port });
  return app;
}

interface ErrorEnvelopeBody {
  ok: false;
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

interface SearchEnvelopeBody {
  ok: true;
  data: {
    query: string;
    scope: string;
    results: SearchResultItem[];
    nextCursor: string | null;
    hasMore: boolean;
    fuzzy: { available: boolean; reason: string; message: string };
    degraded: boolean;
  };
}

function assertErrorBody(body: unknown, expectedCode: string): asserts body is ErrorEnvelopeBody {
  const parsed = body as ErrorEnvelopeBody;
  expect(parsed.ok).toBe(false);
  expect(parsed.error.code).toBe(expectedCode);
  expect(parsed.error.retryable).toBe(false);
  expect(typeof parsed.error.requestId).toBe('string');
  expect(parsed.error.requestId).not.toBe('');
  expect(parsed.error.message).toBeTruthy();
  expect(parsed.error.details).toEqual(expect.any(Object));
}

function searchUrl(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `${SEARCH_PATH}?${query}`;
}

function validFuzzyBody(): Record<string, unknown> {
  return {
    query: 'ggl jnt',
    items: [
      { id: 'record:42', keys: { title: 'Catatan gagal jantung', body: 'tanda gagal jantung kanan' } },
      { id: 'record:43', keys: { title: 'Daftar obat', body: 'furosemid' } },
    ],
    keys: ['title', 'body'],
    threshold: 0,
    limit: 20,
  };
}

async function postFuzzy(
  app: FastifyInstance,
  body: unknown,
  headers: Record<string, string> = MUTATION_HEADERS,
) {
  return app.inject({
    method: 'POST',
    url: FUZZY_SEARCH_PATH,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

function thrownApiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) {
      return err;
    }
    throw err;
  }
  throw new Error('Expected the function to throw an ApiError.');
}

describe('fuzzy stub', () => {
  it('answers 501 fuzzy_search_unavailable for a well-formed body', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const res = await postFuzzy(app, validFuzzyBody());
    expect(res.statusCode).toBe(501);
    const body = res.json();
    assertErrorBody(body, 'fuzzy_search_unavailable');
    expect(body.error.details).toEqual({});
    expect(body.error.message).toMatch(/keyword search/i);
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
    expect(counter.calls).toEqual([]);
    await app.close();
  });

  it('answers the same 501 on repeat calls without touching the search port', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const first = await postFuzzy(app, validFuzzyBody());
    const second = await postFuzzy(app, validFuzzyBody());
    expect(first.statusCode).toBe(501);
    expect(second.statusCode).toBe(501);
    expect(first.json().error.code).toBe(second.json().error.code);
    expect(counter.calls).toEqual([]);
    await app.close();
  });

  it('answers 501 without the optional threshold and limit fields', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const body = validFuzzyBody();
    delete body['threshold'];
    delete body['limit'];
    const res = await postFuzzy(app, body);
    expect(res.statusCode).toBe(501);
    assertErrorBody(res.json(), 'fuzzy_search_unavailable');
    await app.close();
  });

  it('answers 401 without a session and 401 for an unknown session', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const noCookie = await postFuzzy(app, validFuzzyBody(), {
      origin: TEST_ORIGIN,
      'x-csrf-token': 'good-csrf',
    });
    expect(noCookie.statusCode).toBe(401);
    assertErrorBody(noCookie.json(), 'unauthenticated');
    const badSession = await postFuzzy(app, validFuzzyBody(), {
      ...MUTATION_HEADERS,
      cookie: 'notegen_session=no-such-session',
    });
    expect(badSession.statusCode).toBe(401);
    assertErrorBody(badSession.json(), 'unauthenticated');
    await app.close();
  });

  it('answers 401 before shape validation when the session is missing', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const res = await postFuzzy(app, { nonsense: true }, {
      origin: TEST_ORIGIN,
      'x-csrf-token': 'good-csrf',
    });
    expect(res.statusCode).toBe(401);
    assertErrorBody(res.json(), 'unauthenticated');
    await app.close();
  });

  it('answers 403 with distinct codes and one shared message for Origin and CSRF failures', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const badOrigin = await postFuzzy(app, validFuzzyBody(), {
      ...MUTATION_HEADERS,
      origin: 'https://evil.example.invalid',
    });
    expect(badOrigin.statusCode).toBe(403);
    const badOriginBody = badOrigin.json();
    assertErrorBody(badOriginBody, 'origin_rejected');
    const badCsrf = await postFuzzy(app, validFuzzyBody(), {
      cookie: 'notegen_session=good-session',
      origin: TEST_ORIGIN,
    });
    expect(badCsrf.statusCode).toBe(403);
    const badCsrfBody = badCsrf.json();
    assertErrorBody(badCsrfBody, 'csrf_invalid');
    expect(badOriginBody.error.message).toBe(badCsrfBody.error.message);
    await app.close();
  });

  it('answers 400 validation_failed for a missing, empty, or overlong query', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const missing = validFuzzyBody();
    delete missing['query'];
    expect((await postFuzzy(app, missing)).statusCode).toBe(400);
    assertErrorBody((await postFuzzy(app, { ...validFuzzyBody(), query: '   ' })).json(), 'validation_failed');
    const overlong = await postFuzzy(app, { ...validFuzzyBody(), query: 'q'.repeat(201) });
    expect(overlong.statusCode).toBe(400);
    assertErrorBody(overlong.json(), 'validation_failed');
    const missingRes = await postFuzzy(app, missing);
    assertErrorBody(missingRes.json(), 'validation_failed');
    await app.close();
  });

  it('answers 400 validation_failed for missing, empty, or oversized items', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const missing = validFuzzyBody();
    delete missing['items'];
    assertErrorBody((await postFuzzy(app, missing)).json(), 'validation_failed');
    assertErrorBody((await postFuzzy(app, { ...validFuzzyBody(), items: [] })).json(), 'validation_failed');
    const oversized = Array.from({ length: 2001 }, (_, i) => ({ id: `item:${i}`, keys: {} }));
    assertErrorBody((await postFuzzy(app, { ...validFuzzyBody(), items: oversized })).json(), 'validation_failed');
    await app.close();
  });

  it('answers 400 validation_failed for malformed items and keys', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const cases: unknown[] = [
      { ...validFuzzyBody(), items: [{ keys: { title: 'x' } }] },
      { ...validFuzzyBody(), items: [{ id: '  ', keys: { title: 'x' } }] },
      { ...validFuzzyBody(), items: [{ id: 'a' }] },
      { ...validFuzzyBody(), items: [{ id: 'a', keys: { title: 42 } }] },
      { ...validFuzzyBody(), items: [{ id: 'a', keys: {}, extra: 1 }] },
      { ...validFuzzyBody(), items: ['not-an-object'] },
      { ...validFuzzyBody(), keys: [] },
      { ...validFuzzyBody(), keys: Array.from({ length: 11 }, (_, i) => `k${i}`) },
      { ...validFuzzyBody(), keys: ['title', ''] },
      { ...validFuzzyBody(), keys: 'title' },
    ];
    const missingKeys = validFuzzyBody();
    delete missingKeys['keys'];
    cases.push(missingKeys);
    for (const body of cases) {
      const res = await postFuzzy(app, body);
      expect(res.statusCode).toBe(400);
      assertErrorBody(res.json(), 'validation_failed');
    }
    await app.close();
  });

  it('answers 400 validation_failed for a bad threshold or limit', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const cases: unknown[] = [
      { ...validFuzzyBody(), threshold: 'high' },
      { ...validFuzzyBody(), limit: 0 },
      { ...validFuzzyBody(), limit: 201 },
      { ...validFuzzyBody(), limit: 1.5 },
      { ...validFuzzyBody(), limit: '20' },
    ];
    for (const body of cases) {
      const res = await postFuzzy(app, body);
      expect(res.statusCode).toBe(400);
      assertErrorBody(res.json(), 'validation_failed');
    }
    await app.close();
  });

  it('answers 400 validation_failed naming unknown fields', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const res = await postFuzzy(app, { ...validFuzzyBody(), workspaceId: 'nope' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    assertErrorBody(body, 'validation_failed');
    expect(body.error.details).toEqual({ fields: [{ field: 'workspaceId', issue: 'unknown_field' }] });
    await app.close();
  });

  it('answers 400 validation_failed for a non-object body', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const array = await postFuzzy(app, ['query']);
    expect(array.statusCode).toBe(400);
    assertErrorBody(array.json(), 'validation_failed');
    const noBody = await app.inject({
      method: 'POST',
      url: FUZZY_SEARCH_PATH,
      headers: MUTATION_HEADERS,
    });
    expect(noBody.statusCode).toBe(400);
    assertErrorBody(noBody.json(), 'validation_failed');
    await app.close();
  });

  it('answers 400 invalid_json for a malformed JSON body through the shared error handler', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const res = await app.inject({
      method: 'POST',
      url: FUZZY_SEARCH_PATH,
      headers: { ...MUTATION_HEADERS, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    assertErrorBody(res.json(), 'invalid_json');
    await app.close();
  });

  it('answers 405 for a wrong method and 404 for a trailing slash', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const get = await app.inject({ method: 'GET', url: FUZZY_SEARCH_PATH, headers: SESSION_HEADERS });
    expect(get.statusCode).toBe(405);
    assertErrorBody(get.json(), 'method_not_allowed');
    const trailing = await app.inject({
      method: 'POST',
      url: `${FUZZY_SEARCH_PATH}/`,
      headers: { ...MUTATION_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify(validFuzzyBody()),
    });
    expect(trailing.statusCode).toBe(404);
    assertErrorBody(trailing.json(), 'not_found');
    await app.close();
  });
});

describe('keyword search', () => {
  it('answers the kontrak 3.9 shape with the fuzzy block and degraded false', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const res = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung' }),
      headers: SESSION_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchEnvelopeBody;
    expect(body.ok).toBe(true);
    expect(body.data.query).toBe('gagal jantung');
    expect(body.data.scope).toBe('all');
    expect(body.data.fuzzy).toEqual({
      available: false,
      reason: 'not_in_mvp',
      message: 'Fuzzy matching is not available in this version. Results below are keyword matches only.',
    });
    expect(body.data.degraded).toBe(false);
    expect(body.data.hasMore).toBe(false);
    expect(body.data.nextCursor).toBeNull();
    expect(body.data.results.length).toBe(4);
    await app.close();
  });

  it('orders hits by score, then updatedAt, then the stable key', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const res = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung' }),
      headers: SESSION_HEADERS,
    });
    const body = res.json() as SearchEnvelopeBody;
    const order = body.data.results.map((result) =>
      result.kind === 'record' ? `record:${result.id}` : `file:${result.path}`,
    );
    expect(order).toEqual([
      'file:kardiologi/gagal-jantung.md',
      'record:42',
      'record:44',
      'record:43',
    ]);
    const scores = body.data.results.map((result) => result.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    await app.close();
  });

  it('matches a link record by a term that occurs only in its url (UTANG-UJI-03b)', async () => {
    const counter = countingPort([
      {
        kind: 'record',
        id: 46,
        title: 'Hypospadias overview article',
        content: 'captured page text without the identifier',
        fileName: '',
        type: 'link',
        tagIds: [],
        url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9995849/',
        updatedAt: 1794660005000,
        createdAt: 1794650005000,
      },
    ]);
    const app = await searchApp(counter);
    const res = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'PMC9995849' }),
      headers: SESSION_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchEnvelopeBody;
    expect(body.data.results.length).toBe(1);
    expect(body.data.results[0].kind).toBe('record');
    const control = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'kata-tidak-ada-xyz' }),
      headers: SESSION_HEADERS,
    });
    expect((control.json() as SearchEnvelopeBody).data.results.length).toBe(0);
    await app.close();
  });

  it('never returns trashed records or files', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const res = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung' }),
      headers: SESSION_HEADERS,
    });
    const body = res.json() as SearchEnvelopeBody;
    const ids = body.data.results.map((result) => (result.kind === 'record' ? result.id : result.path));
    expect(ids).not.toContain(45);
    expect(ids).not.toContain('sampah/gagal-jantung.md');
    await app.close();
  });

  it('needs a session but no CSRF token or Origin for the GET read', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const noSession = await app.inject({ method: 'GET', url: searchUrl({ q: 'gagal' }) });
    expect(noSession.statusCode).toBe(401);
    assertErrorBody(noSession.json(), 'unauthenticated');
    const badSession = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal' }),
      headers: { cookie: 'notegen_session=no-such-session' },
    });
    expect(badSession.statusCode).toBe(401);
    assertErrorBody(badSession.json(), 'unauthenticated');
    const evilOrigin = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal' }),
      headers: { ...SESSION_HEADERS, origin: 'https://evil.example.invalid' },
    });
    expect(evilOrigin.statusCode).toBe(200);
    await app.close();
  });

  it('answers 400 validation_failed for a missing, empty, or overlong q', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const missing = await app.inject({ method: 'GET', url: SEARCH_PATH, headers: SESSION_HEADERS });
    expect(missing.statusCode).toBe(400);
    assertErrorBody(missing.json(), 'validation_failed');
    for (const q of ['', '   ', 'q'.repeat(201)]) {
      const res = await app.inject({
        method: 'GET',
        url: searchUrl({ q }),
        headers: SESSION_HEADERS,
      });
      expect(res.statusCode).toBe(400);
      assertErrorBody(res.json(), 'validation_failed');
    }
    await app.close();
  });

  it('trims q and echoes the trimmed query', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const res = await app.inject({
      method: 'GET',
      url: searchUrl({ q: '  gagal jantung  ' }),
      headers: SESSION_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as SearchEnvelopeBody).data.query).toBe('gagal jantung');
    expect(counter.calls[0]?.query).toBe('gagal jantung');
    await app.close();
  });

  it('requires all terms and matches case-insensitively over name and content', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const upper = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'GAGAL JANTUNG' }),
      headers: SESSION_HEADERS,
    });
    expect((upper.json() as SearchEnvelopeBody).data.results.length).toBe(4);
    const andOnly = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal furosemid' }),
      headers: SESSION_HEADERS,
    });
    const andBody = andOnly.json() as SearchEnvelopeBody;
    expect(andBody.data.results.map((r) => (r.kind === 'record' ? r.id : r.path))).toEqual([43]);
    const noMatch = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal xyzqqq' }),
      headers: SESSION_HEADERS,
    });
    expect(noMatch.statusCode).toBe(200);
    const noMatchBody = noMatch.json() as SearchEnvelopeBody;
    expect(noMatchBody.data.results).toEqual([]);
    expect(noMatchBody.data.hasMore).toBe(false);
    expect(noMatchBody.data.nextCursor).toBeNull();
    await app.close();
  });

  it('scopes to records or files and rejects an unknown scope', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const records = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung', scope: 'records' }),
      headers: SESSION_HEADERS,
    });
    const recordsBody = records.json() as SearchEnvelopeBody;
    expect(recordsBody.data.scope).toBe('records');
    expect(recordsBody.data.results.every((r) => r.kind === 'record')).toBe(true);
    expect(recordsBody.data.results.length).toBe(3);
    const files = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung', scope: 'files' }),
      headers: SESSION_HEADERS,
    });
    const filesBody = files.json() as SearchEnvelopeBody;
    expect(filesBody.data.scope).toBe('files');
    expect(filesBody.data.results.map((r) => (r.kind === 'file' ? r.path : r.id))).toEqual([
      'kardiologi/gagal-jantung.md',
    ]);
    const bad = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal', scope: 'notes' }),
      headers: SESSION_HEADERS,
    });
    expect(bad.statusCode).toBe(400);
    assertErrorBody(bad.json(), 'validation_failed');
    await app.close();
  });

  it('rejects the mode parameter and ignores other unknown query parameters', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const mode = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal', mode: 'vector' }),
      headers: SESSION_HEADERS,
    });
    expect(mode.statusCode).toBe(400);
    const modeBody = mode.json();
    assertErrorBody(modeBody, 'validation_failed');
    expect(modeBody.error.details).toEqual({ fields: [{ field: 'mode', issue: 'unsupported' }] });
    const unknown = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal', utm_source: 'test' }),
      headers: SESSION_HEADERS,
    });
    expect(unknown.statusCode).toBe(200);
    await app.close();
  });

  it('filters record hits by tagId and type without filtering file hits', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const byTag = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung', tagId: '3' }),
      headers: SESSION_HEADERS,
    });
    const byTagBody = byTag.json() as SearchEnvelopeBody;
    expect(byTagBody.data.results.map((r) => (r.kind === 'record' ? r.id : r.path)).sort()).toEqual([
      42,
      44,
      'kardiologi/gagal-jantung.md',
    ]);
    const byType = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung', scope: 'records', type: 'text' }),
      headers: SESSION_HEADERS,
    });
    expect((byType.json() as SearchEnvelopeBody).data.results.map((r) => (r.kind === 'record' ? r.id : r.path))).toEqual([42, 43]);
    const byTypeList = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung', scope: 'records', type: 'text,image' }),
      headers: SESSION_HEADERS,
    });
    expect((byTypeList.json() as SearchEnvelopeBody).data.results.length).toBe(3);
    await app.close();
  });

  it('rejects tagId and type combined with scope=files', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const cases: Record<string, string>[] = [
      { q: 'gagal', scope: 'files', tagId: '3' },
      { q: 'gagal', scope: 'files', type: 'text' },
    ];
    for (const params of cases) {
      const res = await app.inject({ method: 'GET', url: searchUrl(params), headers: SESSION_HEADERS });
      expect(res.statusCode).toBe(400);
      assertErrorBody(res.json(), 'validation_failed');
    }
    await app.close();
  });

  it('rejects a non-integer, zero, or empty tagId and an empty type', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const cases: Record<string, string>[] = [
      { q: 'gagal', tagId: 'abc' },
      { q: 'gagal', tagId: '0' },
      { q: 'gagal', tagId: '3.5' },
      { q: 'gagal', tagId: '' },
      { q: 'gagal', type: '' },
      { q: 'gagal', type: ' , ' },
    ];
    for (const params of cases) {
      const res = await app.inject({ method: 'GET', url: searchUrl(params), headers: SESSION_HEADERS });
      expect(res.statusCode).toBe(400);
      assertErrorBody(res.json(), 'validation_failed');
    }
    await app.close();
  });

  it('keeps snippets within 200 characters with offsets inside the snippet', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const res = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung' }),
      headers: SESSION_HEADERS,
    });
    const body = res.json() as SearchEnvelopeBody;
    for (const result of body.data.results) {
      expect(result.snippet.length).toBeLessThanOrEqual(200);
      for (const match of result.snippetMatches) {
        expect(match.start).toBeGreaterThanOrEqual(0);
        expect(match.end).toBeLessThanOrEqual(result.snippet.length);
        expect(['gagal', 'jantung']).toContain(result.snippet.slice(match.start, match.end).toLowerCase());
      }
    }
    const titleOnly = body.data.results.find((r) => r.kind === 'record' && r.id === 44);
    expect(titleOnly).toBeDefined();
    expect(titleOnly?.snippet).toBe('');
    expect(titleOnly?.snippetMatches).toEqual([]);
    expect(titleOnly?.snippetField).toBe('content');
    await app.close();
  });

  it('centers long snippets on the first match', async () => {
    const longContent = `${'x'.repeat(500)} gagal jantung ${'y'.repeat(500)}`;
    const counter = countingPort([
      {
        kind: 'record',
        id: 1,
        title: 'Panjang',
        content: longContent,
        fileName: '',
        type: 'text',
        tagIds: [],
        url: '',
        updatedAt: 1000,
        createdAt: 900,
      },
    ]);
    const app = await searchApp(counter);
    const res = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung' }),
      headers: SESSION_HEADERS,
    });
    const body = res.json() as SearchEnvelopeBody;
    expect(body.data.results[0]?.snippet.length).toBe(200);
    expect(body.data.results[0]?.snippet).toContain('gagal jantung');
    await app.close();
  });

  it('defaults the limit to 50 and clamps an overlarge limit to 200', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    await app.inject({ method: 'GET', url: searchUrl({ q: 'gagal' }), headers: SESSION_HEADERS });
    expect(counter.calls[0]?.limit).toBe(50);
    const clamped = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal', limit: '500' }),
      headers: SESSION_HEADERS,
    });
    expect(clamped.statusCode).toBe(200);
    expect(counter.calls[1]?.limit).toBe(200);
    await app.close();
  });

  it('answers invalid_limit for a limit below 1 or not an integer', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    for (const limit of ['0', '-1', 'abc', '1.5', '']) {
      const res = await app.inject({
        method: 'GET',
        url: searchUrl({ q: 'gagal', limit }),
        headers: SESSION_HEADERS,
      });
      expect(res.statusCode).toBe(400);
      assertErrorBody(res.json(), 'invalid_limit');
    }
    await app.close();
  });

  it('pages through results with opaque cursors and ends with a null cursor', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const first = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung', limit: '2' }),
      headers: SESSION_HEADERS,
    });
    const firstBody = first.json() as SearchEnvelopeBody;
    expect(firstBody.data.results.length).toBe(2);
    expect(firstBody.data.hasMore).toBe(true);
    expect(typeof firstBody.data.nextCursor).toBe('string');
    const cursor = firstBody.data.nextCursor ?? '';
    const second = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung', limit: '2', cursor }),
      headers: SESSION_HEADERS,
    });
    const secondBody = second.json() as SearchEnvelopeBody;
    expect(secondBody.data.results.length).toBe(2);
    expect(secondBody.data.hasMore).toBe(false);
    expect(secondBody.data.nextCursor).toBeNull();
    const full = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung' }),
      headers: SESSION_HEADERS,
    });
    const fullBody = full.json() as SearchEnvelopeBody;
    expect([...firstBody.data.results, ...secondBody.data.results]).toEqual(fullBody.data.results);
    // The same cursor replays the same page, and the limit is not
    // part of the cursor binding.
    const replay = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung', limit: '1', cursor }),
      headers: SESSION_HEADERS,
    });
    const replayBody = replay.json() as SearchEnvelopeBody;
    expect(replayBody.data.results).toEqual([secondBody.data.results[0]]);
    expect(replayBody.data.hasMore).toBe(true);
    await app.close();
  });

  it('answers invalid_cursor for a malformed or tampered cursor', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const garbage = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal', cursor: 'not-a-cursor' }),
      headers: SESSION_HEADERS,
    });
    expect(garbage.statusCode).toBe(400);
    assertErrorBody(garbage.json(), 'invalid_cursor');
    const first = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung', limit: '1' }),
      headers: SESSION_HEADERS,
    });
    const cursor = (first.json() as SearchEnvelopeBody).data.nextCursor ?? '';
    for (const tampered of [cursor.slice(0, -4), `x${cursor.slice(1)}`, '']) {
      const res = await app.inject({
        method: 'GET',
        url: searchUrl({ q: 'gagal jantung', limit: '1', cursor: tampered }),
        headers: SESSION_HEADERS,
      });
      expect(res.statusCode).toBe(400);
      assertErrorBody(res.json(), 'invalid_cursor');
    }
    await app.close();
  });

  it('answers invalid_cursor for a cursor carried to a different query, scope, or filter', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const first = await app.inject({
      method: 'GET',
      url: searchUrl({ q: 'gagal jantung', limit: '1' }),
      headers: SESSION_HEADERS,
    });
    const cursor = (first.json() as SearchEnvelopeBody).data.nextCursor ?? '';
    const variants: Record<string, string>[] = [
      { q: 'furosemid', limit: '1', cursor },
      { q: 'gagal jantung', scope: 'records', limit: '1', cursor },
      { q: 'gagal jantung', tagId: '3', limit: '1', cursor },
      { q: 'gagal jantung', type: 'text', limit: '1', cursor },
    ];
    for (const params of variants) {
      const res = await app.inject({ method: 'GET', url: searchUrl(params), headers: SESSION_HEADERS });
      expect(res.statusCode).toBe(400);
      assertErrorBody(res.json(), 'invalid_cursor');
    }
    await app.close();
  });

  it('answers 405 for POST /api/search, the Fase 2 reservation with no MVP route', async () => {
    const counter = countingPort(fixtureItems());
    const app = await searchApp(counter);
    const authed = await app.inject({
      method: 'POST',
      url: SEARCH_PATH,
      headers: { ...MUTATION_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ q: 'gagal' }),
    });
    expect(authed.statusCode).toBe(405);
    assertErrorBody(authed.json(), 'method_not_allowed');
    const anonymous = await app.inject({
      method: 'POST',
      url: SEARCH_PATH,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ q: 'gagal' }),
    });
    expect(anonymous.statusCode).toBe(405);
    assertErrorBody(anonymous.json(), 'method_not_allowed');
    expect(counter.calls).toEqual([]);
    await app.close();
  });
});

describe('fuzzy shape validator', () => {
  it('accepts the reserved Fase 2 body with and without optional fields', () => {
    expect(() => validateFuzzyRequestBody(validFuzzyBody())).not.toThrow();
    const minimal = validFuzzyBody();
    delete minimal['threshold'];
    delete minimal['limit'];
    expect(() => validateFuzzyRequestBody(minimal)).not.toThrow();
  });

  it('names every missing required field', () => {
    const err = thrownApiError(() => validateFuzzyRequestBody({}));
    expect(err.code).toBe('validation_failed');
    expect(err.details).toEqual({
      fields: [
        { field: 'query', issue: 'required' },
        { field: 'items', issue: 'required' },
        { field: 'keys', issue: 'required' },
      ],
    });
  });

  it('names unknown fields at the top level and inside items', () => {
    const top = thrownApiError(() => validateFuzzyRequestBody({ ...validFuzzyBody(), extra: 1 }));
    expect(top.details).toEqual({ fields: [{ field: 'extra', issue: 'unknown_field' }] });
    const nested = thrownApiError(() =>
      validateFuzzyRequestBody({
        ...validFuzzyBody(),
        items: [{ id: 'a', keys: {}, score: 9 }],
      }),
    );
    expect(nested.details).toEqual({ fields: [{ field: 'items[0].score', issue: 'unknown_field' }] });
  });

  it('rejects an undefined or non-object body', () => {
    expect(thrownApiError(() => validateFuzzyRequestBody(undefined)).details).toEqual({
      fields: [{ field: 'body', issue: 'required' }],
    });
    expect(thrownApiError(() => validateFuzzyRequestBody('query')).code).toBe('validation_failed');
    expect(thrownApiError(() => validateFuzzyRequestBody(null)).code).toBe('validation_failed');
  });
});

describe('keyword query parser', () => {
  it('normalizes defaults and trims q', () => {
    const input = parseKeywordSearchQuery({ q: '  hello world  ' }, PRINCIPAL);
    expect(input.query).toBe('hello world');
    expect(input.scope).toBe('all');
    expect(input.limit).toBe(50);
    expect(input.tagId).toBeUndefined();
    expect(input.type).toBeUndefined();
    expect(input.cursor).toBeUndefined();
    expect(input.principal).toBe(PRINCIPAL);
  });

  it('parses scope, tagId, type list, limit, and cursor', () => {
    const input = parseKeywordSearchQuery(
      { q: 'x', scope: 'records', tagId: '12', type: 'text, image ', limit: '25', cursor: 'opaque' },
      PRINCIPAL,
    );
    expect(input.scope).toBe('records');
    expect(input.tagId).toBe(12);
    expect(input.type).toEqual(['text', 'image']);
    expect(input.limit).toBe(25);
    expect(input.cursor).toBe('opaque');
  });

  it('collects validation issues and names the mode field', () => {
    const err = thrownApiError(() => parseKeywordSearchQuery({ mode: 'vector' }, PRINCIPAL));
    expect(err.code).toBe('validation_failed');
    expect(err.details).toEqual({
      fields: [
        { field: 'mode', issue: 'unsupported' },
        { field: 'q', issue: 'required' },
      ],
    });
  });

  it('uses the specific codes for limit and cursor shape failures', () => {
    expect(thrownApiError(() => parseKeywordSearchQuery({ q: 'x', limit: '0' }, PRINCIPAL)).code).toBe(
      'invalid_limit',
    );
    expect(
      thrownApiError(() => parseKeywordSearchQuery({ q: 'x', cursor: ['a', 'b'] }, PRINCIPAL)).code,
    ).toBe('invalid_cursor');
  });
});

describe('fake keyword search port', () => {
  it('returns an empty page for an empty fixture', async () => {
    const fake = createFakeKeywordSearchPort([]);
    const page = await fake.search({
      principal: PRINCIPAL,
      query: 'gagal',
      scope: 'all',
      tagId: undefined,
      type: undefined,
      cursor: undefined,
      limit: 50,
    });
    expect(page).toEqual({ results: [], nextCursor: null, hasMore: false });
  });

  it('falls back to the content start when a record desc is empty', async () => {
    const fake = createFakeKeywordSearchPort([
      {
        kind: 'record',
        id: 7,
        title: '',
        content: 'gagal jantung content without a desc',
        fileName: '',
        type: 'text',
        tagIds: [],
        url: '',
        updatedAt: 1000,
        createdAt: 900,
      },
    ]);
    const page = await fake.search({
      principal: PRINCIPAL,
      query: 'gagal',
      scope: 'records',
      tagId: undefined,
      type: undefined,
      cursor: undefined,
      limit: 50,
    });
    expect(page.results[0]?.kind).toBe('record');
    if (page.results[0]?.kind === 'record') {
      expect(page.results[0].title).toBe('gagal jantung content without a desc');
    }
  });
});
