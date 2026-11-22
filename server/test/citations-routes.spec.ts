// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Citations routes over the in-memory fake repository (F2-1 wave
// G-F2-1b). Standalone app with the frozen plugins, mirroring
// records-routes.spec.ts: proves the HTTP surface, envelope
// shapes, duplicate semantics, and the mapping flow without a
// database. Service semantics themselves are pinned by
// citations-service.spec.ts.

import Fastify, { LogController, type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
  type VerifySessionFn,
} from '../src/middleware/auth-hook.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import { registerRequestId, requestIdFromHeaders } from '../src/plugins/request-id.js';
import { registerCitationsRoutes } from '../src/routes/citations.js';
import {
  createFakeCitationsRepository,
  type FakeCitationsRepository,
} from '../src/services/citations/fake-repository.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TEST_PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'sess-1' };

interface Fixture {
  app: FastifyInstance;
  repository: FakeCitationsRepository;
}

let fixture: Fixture | undefined;

const verifySession: VerifySessionFn = async ({ sessionId }) =>
  sessionId === 'good-session' ? TEST_PRINCIPAL : null;

async function setup(): Promise<Fixture> {
  const repository = createFakeCitationsRepository(WORKSPACE_ID);
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
  await registerCitationsRoutes(app, {
    citations: repository,
    resolveWorkspaceId: async () => WORKSPACE_ID,
  });
  await app.ready();
  fixture = { app, repository };
  return fixture;
}

beforeEach(() => {
  fixture = undefined;
});

afterEach(async () => {
  if (fixture !== undefined) {
    await fixture.app.close();
    fixture = undefined;
  }
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: 'notegen_session=good-session',
    origin: TEST_ORIGIN,
    'x-csrf-token': 'good-csrf',
    'content-type': 'application/json',
    ...extra,
  };
}

function dataOf<T>(response: LightMyRequestResponse): T {
  const body = response.json() as { ok: boolean; data: T };
  expect(body.ok).toBe(true);
  return body.data;
}

interface ApiReferenceShape {
  id: string;
  projectKey: string;
  number: number | null;
  doi: string | null;
  duplicate?: boolean;
}

interface ApiFactShape {
  id: string;
  status: string;
  score: number;
}

describe('citations routes', () => {
  it('creates a reference (201), dedupes by DOI (200 duplicate), lists by project', async () => {
    const { app } = await setup();
    const first = await app.inject({
      method: 'POST',
      url: '/api/citations/references',
      headers: authHeaders(),
      payload: { projectKey: 'deck-hipospadia', title: 'Studi A', doi: '10.1000/ABC' },
    });
    expect(first.statusCode).toBe(201);
    const created = dataOf<ApiReferenceShape>(first);
    expect(created.doi).toBe('10.1000/abc');
    expect(created.number).toBeNull();

    const second = await app.inject({
      method: 'POST',
      url: '/api/citations/references',
      headers: authHeaders(),
      payload: { projectKey: 'deck-hipospadia', title: 'Studi A lagi', doi: 'https://doi.org/10.1000/abc' },
    });
    expect(second.statusCode).toBe(200);
    const dup = dataOf<ApiReferenceShape>(second);
    expect(dup.id).toBe(created.id);
    expect(dup.duplicate).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: '/api/citations/projects/deck-hipospadia/references',
      headers: authHeaders(),
    });
    expect(list.statusCode).toBe(200);
    const items = dataOf<{ items: ApiReferenceShape[] }>(list).items;
    expect(items).toHaveLength(1);
  });

  it('maps a fact, assigns the number, and serves bibliography + citation map', async () => {
    const { app } = await setup();
    const refRes = await app.inject({
      method: 'POST',
      url: '/api/citations/references',
      headers: authHeaders(),
      payload: {
        projectKey: 'deck-hipospadia',
        title: 'Studi A',
        authors: 'Doe J',
        journal: 'J Urol',
        year: 2024,
        doi: '10.1000/abc',
      },
    });
    const reference = dataOf<ApiReferenceShape>(refRes);
    const factRes = await app.inject({
      method: 'POST',
      url: '/api/citations/facts',
      headers: authHeaders(),
      payload: { projectKey: 'deck-hipospadia', text: 'Fakta satu', score: 90, status: 'mapped' },
    });
    expect(factRes.statusCode).toBe(201);
    const fact = dataOf<ApiFactShape>(factRes);

    const mapRes = await app.inject({
      method: 'POST',
      url: `/api/citations/facts/${fact.id}/map`,
      headers: authHeaders(),
      payload: { referenceId: reference.id },
    });
    expect(mapRes.statusCode).toBe(200);
    const mapped = dataOf<{ reference: ApiReferenceShape }>(mapRes);
    expect(mapped.reference.number).toBe(1);

    const bibRes = await app.inject({
      method: 'GET',
      url: '/api/citations/projects/deck-hipospadia/bibliography',
      headers: authHeaders(),
    });
    const bib = dataOf<{ text: string }>(bibRes);
    expect(bib.text).toContain('1. Doe J. Studi A. J Urol. 2024. doi:10.1000/abc');

    const mapListRes = await app.inject({
      method: 'GET',
      url: '/api/citations/projects/deck-hipospadia/map',
      headers: authHeaders(),
    });
    const mapList = dataOf<{ entries: Array<{ factId: string; numbers: number[] }> }>(mapListRes);
    expect(mapList.entries).toEqual([{ factId: fact.id, numbers: [1] }]);
  });

  it('rejects mapping an unmapped fact with 409 and keeps it out of the map', async () => {
    const { app } = await setup();
    const refRes = await app.inject({
      method: 'POST',
      url: '/api/citations/references',
      headers: authHeaders(),
      payload: { projectKey: 'deck-x', doi: '10.1000/xyz' },
    });
    const reference = dataOf<ApiReferenceShape>(refRes);
    const factRes = await app.inject({
      method: 'POST',
      url: '/api/citations/facts',
      headers: authHeaders(),
      payload: { projectKey: 'deck-x', text: 'Fakta lemah', score: 40 },
    });
    const fact = dataOf<ApiFactShape>(factRes);
    expect(fact.status).toBe('unmapped');

    const mapRes = await app.inject({
      method: 'POST',
      url: `/api/citations/facts/${fact.id}/map`,
      headers: authHeaders(),
      payload: { referenceId: reference.id },
    });
    expect(mapRes.statusCode).toBe(409);
  });

  it('answers 404 for unknown ids and 401 without a session', async () => {
    const { app } = await setup();
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/citations/references/00000000-0000-4000-8000-000000000099',
      headers: authHeaders(),
    });
    expect(unknown.statusCode).toBe(404);
    const badShape = await app.inject({
      method: 'GET',
      url: '/api/citations/references/not-a-uuid',
      headers: authHeaders(),
    });
    expect(badShape.statusCode).toBe(404);
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/citations/projects/deck-x/references',
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('rejects unknown body fields (K-09)', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/citations/references',
      headers: authHeaders(),
      payload: { projectKey: 'deck-x', doi: '10.1000/abc', surprise: true },
    });
    expect(res.statusCode).toBe(400);
  });
});
