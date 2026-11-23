// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Agent Deep Search routes over the in-memory fake repository
// (F2-2 wave G-F2-2f). Standalone app with the frozen plugins,
// mirroring deep-search-routes.spec.ts, but with a stub agent
// token verifier that maps bearer values to principals with
// different scope sets. Proves the scope matrix of F2-2 decision
// 4: search.read reads job results, deepsearch.write creates
// jobs, neither scope implies the other, a cookie never works on
// the agent path, a foreign workspace answers the generic 404,
// jobs created here carry the token id, and no cancel, retry,
// approve-writing, or delete route exists on the agent surface.

import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthStore, AuthWorkspaceRow } from '../src/auth/store.js';
import {
  registerAuthHooks,
  type AgentPrincipal,
  type VerifyAgentTokenFn,
} from '../src/middleware/auth-hook.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import { registerRequestId, requestIdFromHeaders } from '../src/plugins/request-id.js';
import { registerAgentDeepSearchRoutes } from '../src/routes/agent-deep-search.js';
import {
  createFakeDeepSearchRepository,
  type FakeDeepSearchRepository,
} from '../src/services/deep-search/fake-repository.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN_ID = '44444444-4444-4444-8444-444444444444';

const READ_TOKEN = 'test-read-token';
const WRITE_TOKEN = 'test-write-token';
const BOTH_TOKEN = 'test-both-token';

function principal(scopes: string[], workspaceIds: string[]): AgentPrincipal {
  return {
    userId: USER_ID,
    tokenId: TOKEN_ID,
    scopes,
    workspaceIds,
    pathPrefixes: null,
    authMode: 'agent',
  };
}

const verifyAgentToken: VerifyAgentTokenFn = async ({ request }) => {
  const header = request.headers.authorization;
  if (header === `Bearer ${READ_TOKEN}`) {
    return principal(['search.read'], [WORKSPACE_ID]);
  }
  if (header === `Bearer ${WRITE_TOKEN}`) {
    return principal(['deepsearch.write'], [WORKSPACE_ID]);
  }
  if (header === `Bearer ${BOTH_TOKEN}`) {
    return principal(['search.read', 'deepsearch.write'], [WORKSPACE_ID]);
  }
  return null;
};

function workspaceRow(id: string, ownerUserId: string): AuthWorkspaceRow {
  return { id, ownerUserId } as AuthWorkspaceRow;
}

const fakeStore = {
  async findWorkspaceById(id: string): Promise<AuthWorkspaceRow | null> {
    if (id === WORKSPACE_ID) {
      return workspaceRow(id, USER_ID);
    }
    if (id === FOREIGN_WORKSPACE_ID) {
      return workspaceRow(id, '99999999-9999-4999-8999-999999999999');
    }
    return null;
  },
  async findFirstWorkspaceByOwner(userId: string): Promise<AuthWorkspaceRow | null> {
    return userId === USER_ID ? workspaceRow(WORKSPACE_ID, USER_ID) : null;
  },
} as unknown as AuthStore;

interface Fixture {
  app: FastifyInstance;
  repository: FakeDeepSearchRepository;
}

let fixture: Fixture | undefined;

async function setup(): Promise<Fixture> {
  const repository = createFakeDeepSearchRepository(WORKSPACE_ID);
  const app = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  registerAuthHooks(app, { verifyAgentToken });
  await registerAgentDeepSearchRoutes(app, { deepSearch: repository, store: fakeStore });
  await app.ready();
  fixture = { app, repository };
  return fixture;
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function dataOf(res: { body: string }): Record<string, unknown> {
  const parsed = JSON.parse(res.body) as { data?: Record<string, unknown> };
  return parsed.data ?? {};
}

beforeEach(() => {
  fixture = undefined;
});

afterEach(async () => {
  await fixture?.app.close();
  fixture = undefined;
});

describe('agent deep search scope matrix', () => {
  it('creates a job with deepsearch.write and stamps the token id', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/deep-search/jobs',
      headers: bearer(WRITE_TOKEN),
      payload: { projectKey: 'deck-hipospadia', topic: 'hypospadias repair' },
    });
    expect(res.statusCode).toBe(202);
    const data = dataOf(res);
    expect(data['status']).toBe('queued');
    expect(data['createdByUserId']).toBeNull();
    expect(data['createdByTokenId']).toBe(TOKEN_ID);
  });

  it('answers the generic 404 when creating with only search.read', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/deep-search/jobs',
      headers: bearer(READ_TOKEN),
      payload: { projectKey: 'deck-hipospadia', topic: 'hypospadias repair' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('answers the generic 404 when reading with only deepsearch.write', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/deep-search/jobs',
      headers: bearer(WRITE_TOKEN),
    });
    expect(res.statusCode).toBe(404);
  });

  it('reads list, detail, candidates, and facts with search.read', async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/agent/deep-search/jobs',
      headers: bearer(BOTH_TOKEN),
      payload: { projectKey: 'deck-hipospadia', topic: 'hypospadias repair' },
    });
    expect(created.statusCode).toBe(202);
    const jobId = dataOf(created)['id'] as string;

    const list = await app.inject({
      method: 'GET',
      url: '/api/agent/deep-search/jobs?projectKey=deck-hipospadia',
      headers: bearer(READ_TOKEN),
    });
    expect(list.statusCode).toBe(200);
    const items = dataOf(list)['items'] as unknown[];
    expect(items).toHaveLength(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/agent/deep-search/jobs/${jobId}`,
      headers: bearer(READ_TOKEN),
    });
    expect(detail.statusCode).toBe(200);
    const detailData = dataOf(detail);
    expect((detailData['job'] as Record<string, unknown>)['id']).toBe(jobId);
    expect(detailData['steps'] as unknown[]).toHaveLength(4);

    const candidates = await app.inject({
      method: 'GET',
      url: `/api/agent/deep-search/jobs/${jobId}/candidates`,
      headers: bearer(READ_TOKEN),
    });
    expect(candidates.statusCode).toBe(200);
    expect(dataOf(candidates)['items']).toEqual([]);

    const facts = await app.inject({
      method: 'GET',
      url: `/api/agent/deep-search/jobs/${jobId}/facts`,
      headers: bearer(READ_TOKEN),
    });
    expect(facts.statusCode).toBe(200);
    expect(dataOf(facts)['items']).toEqual([]);
  });

  it('answers 401 without a bearer token and for a session cookie', async () => {
    const { app } = await setup();
    const anonymous = await app.inject({ method: 'GET', url: '/api/agent/deep-search/jobs' });
    expect(anonymous.statusCode).toBe(401);
    const cookie = await app.inject({
      method: 'GET',
      url: '/api/agent/deep-search/jobs',
      headers: { cookie: 'session=good-session' },
    });
    expect(cookie.statusCode).toBe(401);
  });

  it('answers the generic 404 for a workspace outside the token', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent/deep-search/jobs?workspaceId=${FOREIGN_WORKSPACE_ID}`,
      headers: bearer(READ_TOKEN),
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects writingApproved in the create body like the cookie route', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/deep-search/jobs',
      headers: bearer(WRITE_TOKEN),
      payload: {
        projectKey: 'deck-hipospadia',
        topic: 'hypospadias repair',
        writingApproved: true,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('has no cancel, retry, approve-writing, or delete route on the agent path', async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/agent/deep-search/jobs',
      headers: bearer(BOTH_TOKEN),
      payload: { projectKey: 'deck-hipospadia', topic: 'hypospadias repair' },
    });
    const jobId = dataOf(created)['id'] as string;
    for (const suffix of ['cancel', 'retry', 'approve-writing']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agent/deep-search/jobs/${jobId}/${suffix}`,
        headers: bearer(BOTH_TOKEN),
      });
      expect(res.statusCode).toBe(404);
    }
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/agent/deep-search/jobs/${jobId}`,
      headers: bearer(BOTH_TOKEN),
    });
    // No DELETE handler exists; Fastify answers 405 for the known
    // GET path (404 would also prove absence).
    expect([404, 405]).toContain(del.statusCode);
  });
});
