// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Direct tests for the agent token verifier and request guard
// (F2-1 wave G-F2-1d, desain-auth.md section 11.4): a valid token
// passes; expired, revoked, epoch-stale, inactive-owner, and
// unknown tokens all reject with the same null (the hook answers
// one generic 401); unknown scopes fail closed; the guard counts
// per-token and per-account buckets and writes the summarized
// agent_token_used audit at most once per throttle window.

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createAuthContext } from '../src/auth/context.js';
import { hashToken, newAgentToken, parseBearerToken } from '../src/auth/crypto.js';
import { ApiError } from '../src/plugins/envelope.js';
import { createAgentRequestGuard, createAgentTokenVerifier, isPathWithinPrefixes } from '../src/middleware/agent-token.js';
import { parseCreateAgentTokenBody } from '../src/services/auth/agent-tokens.js';
import { makeTestAuth, TEST_NOW_MS, USER_AGENT } from './auth/helpers.js';

function fakeRequest(headers: Record<string, string> = {}): FastifyRequest {
  return {
    headers: { 'user-agent': USER_AGENT, ...headers },
    ip: '127.0.0.1',
    method: 'GET',
    url: '/api/agent/marks',
    log: { warn: () => undefined },
  } as unknown as FastifyRequest;
}

function seedToken(
  fixture: ReturnType<typeof makeTestAuth>,
  overrides: {
    scopes?: string[];
    credentialEpoch?: number;
    expiresAt?: Date;
    revokedAt?: Date | null;
    status?: string;
  } = {},
): { raw: string; userId: string; tokenId: string } {
  const user = fixture.store.seedUser({
    email: `agent-${Math.random().toString(36).slice(2)}@example.invalid`,
    passwordHash: 'fixture-hash',
    credentialEpoch: 3,
    status: overrides.status ?? 'active',
  });
  const generated = newAgentToken();
  const row = fixture.store.seedAgentToken({
    userId: user.id,
    tokenHash: hashToken(generated.raw),
    scopes: overrides.scopes ?? ['notes.read', 'notes.write'],
    workspaceIds: [],
    credentialEpoch: overrides.credentialEpoch ?? 3,
    expiresAt: overrides.expiresAt ?? new Date(TEST_NOW_MS + 30 * 24 * 60 * 60 * 1000),
    revokedAt: overrides.revokedAt ?? null,
  });
  return { raw: generated.raw, userId: user.id, tokenId: row.id };
}

describe('agent token verifier', () => {
  it('accepts a valid token and returns the agent principal', async () => {
    const fixture = makeTestAuth();
    const { raw, userId, tokenId } = seedToken(fixture);
    const verify = createAgentTokenVerifier(fixture.auth);
    const principal = await verify({ request: fakeRequest({ authorization: `Bearer ${raw}` }) });
    expect(principal).not.toBeNull();
    expect(principal?.userId).toBe(userId);
    expect(principal?.tokenId).toBe(tokenId);
    expect(principal?.scopes).toEqual(['notes.read', 'notes.write']);
    expect(principal?.authMode).toBe('agent');
  });

  it('rejects missing, non-Bearer, and unknown tokens with null', async () => {
    const fixture = makeTestAuth();
    seedToken(fixture);
    const verify = createAgentTokenVerifier(fixture.auth);
    expect(await verify({ request: fakeRequest() })).toBeNull();
    expect(await verify({ request: fakeRequest({ authorization: 'Basic abc' }) })).toBeNull();
    const unknown = newAgentToken().raw;
    expect(await verify({ request: fakeRequest({ authorization: `Bearer ${unknown}` }) })).toBeNull();
  });

  it('rejects expired and revoked tokens', async () => {
    const fixture = makeTestAuth();
    const verify = createAgentTokenVerifier(fixture.auth);
    const expired = seedToken(fixture, { expiresAt: new Date(TEST_NOW_MS - 1000) });
    expect(await verify({ request: fakeRequest({ authorization: `Bearer ${expired.raw}` }) })).toBeNull();
    const revoked = seedToken(fixture, { revokedAt: new Date(TEST_NOW_MS - 1000) });
    expect(await verify({ request: fakeRequest({ authorization: `Bearer ${revoked.raw}` }) })).toBeNull();
  });

  it('rejects epoch-stale tokens and inactive owners', async () => {
    const fixture = makeTestAuth();
    const verify = createAgentTokenVerifier(fixture.auth);
    const stale = seedToken(fixture, { credentialEpoch: 2 });
    expect(await verify({ request: fakeRequest({ authorization: `Bearer ${stale.raw}` }) })).toBeNull();
    const inactive = seedToken(fixture, { status: 'disabled' });
    expect(await verify({ request: fakeRequest({ authorization: `Bearer ${inactive.raw}` }) })).toBeNull();
  });

  it('fails closed on unknown scopes', async () => {
    const fixture = makeTestAuth();
    const verify = createAgentTokenVerifier(fixture.auth);
    const mixed = seedToken(fixture, { scopes: ['notes.read', 'admin.all', 'notes.delete'] });
    const principal = await verify({ request: fakeRequest({ authorization: `Bearer ${mixed.raw}` }) });
    expect(principal?.scopes).toEqual(['notes.read']);
    const allUnknown = seedToken(fixture, { scopes: ['admin.all'] });
    expect(await verify({ request: fakeRequest({ authorization: `Bearer ${allUnknown.raw}` }) })).toBeNull();
  });

  it('throws 503 when the store is missing or the database fails', async () => {
    const context = createAuthContext({ clock: () => TEST_NOW_MS });
    const verify = createAgentTokenVerifier(context);
    const raw = newAgentToken().raw;
    await expect(verify({ request: fakeRequest({ authorization: `Bearer ${raw}` }) })).rejects.toMatchObject({
      statusCode: 503,
    });
    const fixture = makeTestAuth();
    const seeded = seedToken(fixture);
    fixture.store.failFindAgentTokenByHash = true;
    const failing = createAgentTokenVerifier(fixture.auth);
    await expect(
      failing({ request: fakeRequest({ authorization: `Bearer ${seeded.raw}` }) }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('agent request guard', () => {
  it('counts buckets, rejects over the limit with 429, and audits once per window', async () => {
    const fixture = makeTestAuth();
    const { raw } = seedToken(fixture);
    const verify = createAgentTokenVerifier(fixture.auth);
    const principal = await verify({ request: fakeRequest({ authorization: `Bearer ${raw}` }) });
    if (principal === null) {
      throw new Error('seeded token did not verify');
    }
    const guard = createAgentRequestGuard(fixture.auth, { limitPerMinute: 2 });
    const request = fakeRequest({ authorization: `Bearer ${raw}` });
    await guard(request, principal);
    await guard(request, principal);
    await expect(guard(request, principal)).rejects.toMatchObject({ statusCode: 429 });
    const used = fixture.store.auditEvents.filter((event) => event.eventType === 'agent_token_used');
    expect(used).toHaveLength(1);
    expect(used[0]?.metadata).toMatchObject({ tokenId: principal.tokenId });
    const row = fixture.store.agentTokens.get(principal.tokenId);
    expect(row?.lastUsedAt?.getTime()).toBe(TEST_NOW_MS);
  });
});

describe('agent token helpers', () => {
  it('parses Bearer headers strictly', () => {
    expect(parseBearerToken('Bearer abc.def')).toBe('abc.def');
    expect(parseBearerToken('bearer abc')).toBe('abc');
    expect(parseBearerToken('Bearer a b')).toBeUndefined();
    expect(parseBearerToken('Basic abc')).toBeUndefined();
    expect(parseBearerToken(undefined)).toBeUndefined();
    expect(parseBearerToken(['Bearer a', 'Bearer b'])).toBeUndefined();
  });

  it('jails paths at segment boundaries', () => {
    expect(isPathWithinPrefixes(null, 'any/path.md')).toBe(true);
    expect(isPathWithinPrefixes([], 'any/path.md')).toBe(true);
    expect(isPathWithinPrefixes(['inbox'], 'inbox/a.md')).toBe(true);
    expect(isPathWithinPrefixes(['inbox'], 'inbox')).toBe(true);
    expect(isPathWithinPrefixes(['inbox'], 'inbox2/a.md')).toBe(false);
    expect(isPathWithinPrefixes(['inbox'], 'other/a.md')).toBe(false);
  });

  it('validates the creation body', () => {
    const parsed = parseCreateAgentTokenBody({ name: 'agent', scopes: ['notes.read'] }, TEST_NOW_MS);
    expect(parsed.expiresAt.getTime()).toBe(TEST_NOW_MS + 90 * 24 * 60 * 60 * 1000);
    expect(parsed.workspaceIds).toEqual([]);
    expect(parsed.pathPrefixes).toBeNull();
    expect(() =>
      parseCreateAgentTokenBody({ name: 'x', scopes: ['notes.read'], bogus: 1 }, TEST_NOW_MS),
    ).toThrowError(ApiError);
    expect(() => parseCreateAgentTokenBody({ name: 'x', scopes: ['notes.delete'] }, TEST_NOW_MS)).toThrowError(
      ApiError,
    );
    expect(() => parseCreateAgentTokenBody({ name: 'x', scopes: [] }, TEST_NOW_MS)).toThrowError(ApiError);
    expect(() =>
      parseCreateAgentTokenBody(
        { name: 'x', scopes: ['notes.read'], expiresAt: new Date(TEST_NOW_MS + 366 * 24 * 60 * 60 * 1000).toISOString() },
        TEST_NOW_MS,
      ),
    ).toThrowError(ApiError);
    const withPrefixes = parseCreateAgentTokenBody(
      { name: 'x', scopes: ['notes.read'], pathPrefixes: ['/inbox/', 'notes'] },
      TEST_NOW_MS,
    );
    expect(withPrefixes.pathPrefixes).toEqual(['inbox', 'notes']);
    expect(() =>
      parseCreateAgentTokenBody({ name: 'x', scopes: ['notes.read'], pathPrefixes: ['../etc'] }, TEST_NOW_MS),
    ).toThrowError(ApiError);
  });
});
