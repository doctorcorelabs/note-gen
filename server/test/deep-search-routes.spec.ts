// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deep Search routes over the in-memory fake repository (F2-2 wave
// G-F2-2a). Standalone app with the frozen plugins, mirroring
// citations-routes.spec.ts: proves the HTTP surface, envelope
// shapes, 202 creation, and cancel/retry status codes without a
// database. Service semantics themselves are pinned by
// deep-search-service.spec.ts.

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
import { registerDeepSearchRoutes } from '../src/routes/deep-search.js';
import {
  createFakeDeepSearchRepository,
  type FakeDeepSearchRepository,
} from '../src/services/deep-search/fake-repository.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const TEST_PRINCIPAL: SessionPrincipal = { userId: USER_ID, role: 'user', sessionId: 'sess-1' };

interface Fixture {
  app: FastifyInstance;
  repository: FakeDeepSearchRepository;
}

let fixture: Fixture | undefined;

const verifySession: VerifySessionFn = async ({ sessionId }) =>
  sessionId === 'good-session' ? TEST_PRINCIPAL : null;

async function setup(): Promise<Fixture> {
  const repository = createFakeDeepSearchRepository(WORKSPACE_ID);
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
  await registerDeepSearchRoutes(app, {
    deepSearch: repository,
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

interface ApiJobShape {
  id: string;
  projectKey: string;
  status: string;
  budgetExaUsd: string | null;
  costExaUsd: string;
  createdByUserId: string | null;
  input: { maxCandidates: number; stages: string };
}

describe('deep search routes', () => {
  it('creates a job (202 queued), lists it, and serves detail with steps + summary', async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/deep-search/jobs',
      headers: authHeaders(),
      payload: { projectKey: 'deck-x', topic: 'Hipospadia', budgetExaUsd: 0.15 },
    });
    expect(created.statusCode).toBe(202);
    const job = dataOf<ApiJobShape>(created);
    expect(job.status).toBe('queued');
    expect(job.budgetExaUsd).toBe('0.1500');
    expect(job.costExaUsd).toBe('0');
    expect(job.createdByUserId).toBe(USER_ID);
    expect(job.input.maxCandidates).toBe(100);

    const list = await app.inject({
      method: 'GET',
      url: '/api/deep-search/jobs?projectKey=deck-x',
      headers: authHeaders(),
    });
    expect(list.statusCode).toBe(200);
    const listData = dataOf<{ items: ApiJobShape[]; nextCursor: string | null }>(list);
    expect(listData.items).toHaveLength(1);
    expect(listData.nextCursor).toBeNull();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/deep-search/jobs/${job.id}`,
      headers: authHeaders(),
    });
    expect(detail.statusCode).toBe(200);
    const detailData = dataOf<{
      job: ApiJobShape;
      steps: Array<{ step: string; status: string }>;
      summary: { candidates: number; factCandidates: number };
    }>(detail);
    expect(detailData.steps.map((s) => s.step)).toEqual([
      'collector_pubmed',
      'collector_exa',
      'assessor',
      'complement',
    ]);
    expect(detailData.summary.candidates).toBe(0);
    expect(detailData.summary.factCandidates).toBe(0);

    const candidates = await app.inject({
      method: 'GET',
      url: `/api/deep-search/jobs/${job.id}/candidates`,
      headers: authHeaders(),
    });
    expect(dataOf<{ items: unknown[] }>(candidates).items).toHaveLength(0);
    const facts = await app.inject({
      method: 'GET',
      url: `/api/deep-search/jobs/${job.id}/facts`,
      headers: authHeaders(),
    });
    expect(dataOf<{ items: unknown[] }>(facts).items).toHaveLength(0);
  });

  it('cancels a queued job, then refuses retry and re-cancel with 409', async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/deep-search/jobs',
      headers: authHeaders(),
      payload: { projectKey: 'deck-x', topic: 'T' },
    });
    const job = dataOf<ApiJobShape>(created);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/deep-search/jobs/${job.id}/cancel`,
      headers: authHeaders(),
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    expect(dataOf<ApiJobShape>(cancelled).status).toBe('cancelled');
    const retry = await app.inject({
      method: 'POST',
      url: `/api/deep-search/jobs/${job.id}/retry`,
      headers: authHeaders(),
      payload: {},
    });
    expect(retry.statusCode).toBe(409);
    const recancel = await app.inject({
      method: 'POST',
      url: `/api/deep-search/jobs/${job.id}/cancel`,
      headers: authHeaders(),
      payload: {},
    });
    expect(recancel.statusCode).toBe(409);
  });

  it('retries a failed job back to queued', async () => {
    const { app, repository } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/deep-search/jobs',
      headers: authHeaders(),
      payload: { projectKey: 'deck-x', topic: 'T' },
    });
    const job = dataOf<ApiJobShape>(created);
    repository.forceJobStatus(job.id, 'failed');
    const retried = await app.inject({
      method: 'POST',
      url: `/api/deep-search/jobs/${job.id}/retry`,
      headers: authHeaders(),
      payload: {},
    });
    expect(retried.statusCode).toBe(200);
    expect(dataOf<ApiJobShape>(retried).status).toBe('queued');
  });

  it('answers 404 for unknown ids, 401 without a session, 400 for bad input', async () => {
    const { app } = await setup();
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/deep-search/jobs/00000000-0000-4000-8000-000000000099',
      headers: authHeaders(),
    });
    expect(unknown.statusCode).toBe(404);
    const badShape = await app.inject({
      method: 'GET',
      url: '/api/deep-search/jobs/not-a-uuid',
      headers: authHeaders(),
    });
    expect(badShape.statusCode).toBe(404);
    const anonymous = await app.inject({ method: 'GET', url: '/api/deep-search/jobs' });
    expect(anonymous.statusCode).toBe(401);
    const overBudget = await app.inject({
      method: 'POST',
      url: '/api/deep-search/jobs',
      headers: authHeaders(),
      payload: { projectKey: 'deck-x', topic: 'T', budgetExaUsd: 1 },
    });
    expect(overBudget.statusCode).toBe(400);
    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/deep-search/jobs',
      headers: authHeaders(),
      payload: { projectKey: 'deck-x', topic: 'T', surprise: true },
    });
    expect(unknownField.statusCode).toBe(400);
    const badStatus = await app.inject({
      method: 'GET',
      url: '/api/deep-search/jobs?status=bogus',
      headers: authHeaders(),
    });
    expect(badStatus.statusCode).toBe(400);
  });

  it('has no DELETE route for jobs (decision 9)', async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/deep-search/jobs',
      headers: authHeaders(),
      payload: { projectKey: 'deck-x', topic: 'T' },
    });
    const job = dataOf<ApiJobShape>(created);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/deep-search/jobs/${job.id}`,
      // No JSON content type: a bodyless DELETE must reach routing,
      // where the path exists for GET only and answers 405.
      headers: {
        cookie: 'notegen_session=good-session',
        origin: TEST_ORIGIN,
        'x-csrf-token': 'good-csrf',
      },
    });
    expect(del.statusCode).toBe(405);
  });
});
