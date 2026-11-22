// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// End-to-end agent token routes (F2-1 wave G-F2-1d, desain-auth.md
// sections 11.4 and 11.5): cookie-authenticated creation with a
// fresh step-up returns the raw value exactly once; lists expose
// metadata only; Bearer requests reach agent data routes while
// cookies do not, and Bearer never reaches browser routes; a
// missing scope answers the generic 404; no delete route exists
// on the agent path; revocation takes effect immediately; the
// agent_token_* audit events are recorded.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bodyOf, buildTestApp, makeTestAuth, seedLoggedInUser, sessionHeaders, type TestAuth } from './auth/helpers.js';

interface Harness {
  fixture: TestAuth;
  app: FastifyInstance;
  cookie: string;
  csrfToken: string;
  userId: string;
  workspaceId: string;
}

let harness: Harness | undefined;

async function stepUp(fixture: TestAuth, userId: string): Promise<void> {
  for (const row of fixture.store.sessions.values()) {
    if (row.userId === userId) {
      row.stepUpAt = new Date(fixture.clock.nowMs);
    }
  }
}

async function createToken(
  h: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; raw?: string; tokenId?: string }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/agent/tokens',
    headers: sessionHeaders(h.cookie, h.csrfToken),
    payload: body,
  });
  const parsed = bodyOf(res);
  const data = parsed.data ?? {};
  return {
    status: res.statusCode,
    raw: typeof data['token'] === 'string' ? (data['token'] as string) : undefined,
    tokenId:
      typeof data['agentToken'] === 'object' && data['agentToken'] !== null
        ? ((data['agentToken'] as Record<string, unknown>)['id'] as string)
        : undefined,
  };
}

beforeEach(async () => {
  const fixture = makeTestAuth();
  const dir = await mkdtemp(join(tmpdir(), 'notegen-agent-'));
  const app = await buildTestApp(fixture.auth, { workspaceRoot: dir });
  const session = await seedLoggedInUser(fixture, app, {
    email: 'owner@example.invalid',
    password: 'fixture-password',
  });
  const workspace = fixture.store.seedWorkspace(session.userId);
  harness = {
    fixture,
    app,
    cookie: session.cookie,
    csrfToken: session.csrfToken,
    userId: session.userId,
    workspaceId: workspace.id,
  };
});

afterEach(async () => {
  await harness?.app.close();
  harness = undefined;
});

describe('agent token management routes', () => {
  it('requires a fresh step-up and returns the raw value once', async () => {
    const h = harness as Harness;
    const refused = await createToken(h, { name: 'agent', scopes: ['notes.read'] });
    expect(refused.status).toBe(403);
    await stepUp(h.fixture, h.userId);
    const created = await createToken(h, {
      name: 'agent',
      scopes: ['workspace.read', 'notes.read'],
      workspaceIds: [h.workspaceId],
    });
    expect(created.status).toBe(201);
    expect(created.raw).toMatch(/^ngt_[A-Za-z0-9_-]{43}$/);
    expect(created.raw).toHaveLength(47);
    const audit = h.fixture.store.auditEvents.filter((event) => event.eventType === 'agent_token_created');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ tokenId: created.tokenId, name: 'agent' });
    const stored = h.fixture.store.agentTokens.get(created.tokenId as string);
    expect(stored?.tokenHash).not.toBe(created.raw);
    expect(stored?.tokenHash).toHaveLength(64);
  });

  it('lists metadata only, never the raw value or the hash', async () => {
    const h = harness as Harness;
    await stepUp(h.fixture, h.userId);
    const created = await createToken(h, { name: 'agent', scopes: ['notes.read'] });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/agent/tokens',
      headers: sessionHeaders(h.cookie, h.csrfToken),
    });
    expect(res.statusCode).toBe(200);
    const items = (bodyOf(res).data?.['items'] ?? []) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('token');
    expect(items[0]).not.toHaveProperty('tokenHash');
    expect(items[0]?.['tokenPrefix']).toBe((created.raw as string).slice(4, 12));
    expect(items[0]?.['last4']).toBe((created.raw as string).slice(-4));
    expect(res.payload).not.toContain(created.raw as string);
  });

  it('rejects a foreign workspace id with the generic 404', async () => {
    const h = harness as Harness;
    await stepUp(h.fixture, h.userId);
    const other = h.fixture.store.seedUser({ email: 'other@example.invalid', passwordHash: 'fixture-hash' });
    const foreign = h.fixture.store.seedWorkspace(other.id);
    const res = await createToken(h, {
      name: 'agent',
      scopes: ['notes.read'],
      workspaceIds: [foreign.id],
    });
    expect(res.status).toBe(404);
  });

  it('revokes immediately and records the audit', async () => {
    const h = harness as Harness;
    await stepUp(h.fixture, h.userId);
    const created = await createToken(h, {
      name: 'agent',
      scopes: ['workspace.read', 'notes.read'],
      workspaceIds: [h.workspaceId],
    });
    const before = await h.app.inject({
      method: 'GET',
      url: '/api/agent/workspace/list',
      headers: { authorization: `Bearer ${created.raw as string}` },
    });
    expect(before.statusCode).toBe(200);
    const revoke = await h.app.inject({
      method: 'DELETE',
      url: `/api/agent/tokens/${created.tokenId as string}`,
      headers: sessionHeaders(h.cookie, h.csrfToken),
    });
    expect(revoke.statusCode).toBe(200);
    const after = await h.app.inject({
      method: 'GET',
      url: '/api/agent/workspace/list',
      headers: { authorization: `Bearer ${created.raw as string}` },
    });
    expect(after.statusCode).toBe(401);
    const types = h.fixture.store.auditEvents.map((event) => event.eventType);
    expect(types).toContain('agent_token_revoked');
    expect(types).toContain('agent_token_used');
    const again = await h.app.inject({
      method: 'DELETE',
      url: `/api/agent/tokens/${created.tokenId as string}`,
      headers: sessionHeaders(h.cookie, h.csrfToken),
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('agent data route auth modes', () => {
  it('answers 401 for a cookie on an agent route and for Bearer on a browser route', async () => {
    const h = harness as Harness;
    await stepUp(h.fixture, h.userId);
    const created = await createToken(h, {
      name: 'agent',
      scopes: ['workspace.read', 'notes.read'],
      workspaceIds: [h.workspaceId],
    });
    const cookieOnAgent = await h.app.inject({
      method: 'GET',
      url: '/api/agent/workspace/list',
      headers: sessionHeaders(h.cookie, h.csrfToken),
    });
    expect(cookieOnAgent.statusCode).toBe(401);
    const bearerOnBrowser = await h.app.inject({
      method: 'GET',
      url: '/api/agent/tokens',
      headers: { authorization: `Bearer ${created.raw as string}` },
    });
    expect(bearerOnBrowser.statusCode).toBe(401);
    const noAuth = await h.app.inject({ method: 'GET', url: '/api/agent/workspace/list' });
    expect(noAuth.statusCode).toBe(401);
  });

  it('answers the generic 404 when the token lacks the route scope', async () => {
    const h = harness as Harness;
    await stepUp(h.fixture, h.userId);
    const created = await createToken(h, {
      name: 'agent',
      scopes: ['workspace.read', 'notes.read'],
      workspaceIds: [h.workspaceId],
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/agent/marks',
      headers: { authorization: `Bearer ${created.raw as string}` },
      payload: { content: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('has no delete route on the agent path', async () => {
    const h = harness as Harness;
    await stepUp(h.fixture, h.userId);
    const created = await createToken(h, {
      name: 'agent',
      scopes: ['workspace.read', 'notes.read', 'notes.write', 'files.write'],
      workspaceIds: [h.workspaceId],
    });
    for (const url of ['/api/agent/marks/1', '/api/agent/workspace/file', '/api/agent/assets/x']) {
      const res = await h.app.inject({
        method: 'DELETE',
        url,
        headers: { authorization: `Bearer ${created.raw as string}` },
      });
      // No DELETE handler exists on the agent path: the router
      // answers 404 for unknown paths and 405 for known paths
      // without a DELETE method. Either proves the absence.
      expect([404, 405]).toContain(res.statusCode);
      expect(bodyOf(res).ok).not.toBe(true);
    }
  });

  it('lists the token workspaces for a valid Bearer request', async () => {
    const h = harness as Harness;
    await stepUp(h.fixture, h.userId);
    const created = await createToken(h, {
      name: 'agent',
      scopes: ['workspace.read', 'notes.read'],
      workspaceIds: [h.workspaceId],
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/agent/workspace/list',
      headers: { authorization: `Bearer ${created.raw as string}` },
    });
    expect(res.statusCode).toBe(200);
    const workspaces = (bodyOf(res).data?.['workspaces'] ?? []) as Array<Record<string, unknown>>;
    expect(workspaces.map((row) => row['id'])).toEqual([h.workspaceId]);
  });
});
