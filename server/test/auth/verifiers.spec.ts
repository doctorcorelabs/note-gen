// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Direct tests for the session and CSRF verifiers injected into the
// frozen auth hook. Every rejection path of desain-auth.md section
// 3.2 is pinned here; the hook-level ordering (session before
// Origin before CSRF) is pinned by the foundation auth-hook.spec.ts
// and the end-to-end ordering by auth-routes.spec.ts.

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createAuthContext } from '../../src/auth/context.js';
import { deriveCsrfToken, hashToken, newOpaqueToken } from '../../src/auth/crypto.js';
import { createSessionForLogin } from '../../src/auth/service.js';
import type { AuthSessionRow, AuthUserRow } from '../../src/auth/store.js';
import { createCsrfVerifier } from '../../src/middleware/csrf.js';
import { createSessionVerifier, loadSessionAndUser } from '../../src/middleware/session.js';
import { FakeAuthStore } from './fake-store.js';
import { FakePasswordHasher, makeTestAuth, TEST_AUTH_SECRET, TEST_NOW_MS, USER_AGENT } from './helpers.js';

function fakeRequest(headers: Record<string, string> = {}): FastifyRequest {
  return { headers: { 'user-agent': USER_AGENT, ...headers }, ip: '127.0.0.1' } as unknown as FastifyRequest;
}

async function seedSession(
  store: FakeAuthStore,
  user: AuthUserRow,
  overrides: Partial<AuthSessionRow> = {},
): Promise<{ row: AuthSessionRow; sessionId: string; csrfToken: string }> {
  const sessionId = newOpaqueToken();
  const sessionHash = hashToken(sessionId);
  const csrfToken = deriveCsrfToken(sessionHash, TEST_AUTH_SECRET);
  const row = await store.createSession({
    userId: user.id,
    sessionHash,
    csrfTokenHash: hashToken(csrfToken),
    credentialEpoch: user.credentialEpoch,
    deviceLabel: 'Test device',
    userAgent: USER_AGENT,
    createdIp: '127.0.0.1',
    lastSeenIp: '127.0.0.1',
    createdAt: new Date(TEST_NOW_MS),
    lastSeenAt: new Date(TEST_NOW_MS),
    absoluteExpiresAt: new Date(TEST_NOW_MS + 30 * 24 * 60 * 60 * 1000),
    stepUpAt: null,
    ...overrides,
  });
  return { row, sessionId, csrfToken };
}

describe('session verifier', () => {
  it('returns null without a cookie and without touching the store', async () => {
    const fixture = makeTestAuth({ store: null });
    const verify = createSessionVerifier(fixture.auth);
    await expect(verify({ request: fakeRequest(), sessionId: undefined })).resolves.toBeNull();
  });

  it('returns the principal for a valid session', async () => {
    const fixture = makeTestAuth();
    const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: 'hash', role: 'admin' });
    const { sessionId } = await seedSession(fixture.store, user);
    const principal = await createSessionVerifier(fixture.auth)({ request: fakeRequest(), sessionId });
    expect(principal).toEqual({ userId: user.id, role: 'admin', sessionId: expect.any(String), credentialEpoch: 1 });
  });

  it('returns null for an unknown session hash', async () => {
    const fixture = makeTestAuth();
    const principal = await createSessionVerifier(fixture.auth)({
      request: fakeRequest(),
      sessionId: newOpaqueToken(),
    });
    expect(principal).toBeNull();
  });

  it('rejects and deletes the session of a disabled account', async () => {
    const fixture = makeTestAuth();
    const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: 'hash', status: 'disabled' });
    const { row, sessionId } = await seedSession(fixture.store, user);
    const principal = await createSessionVerifier(fixture.auth)({ request: fakeRequest(), sessionId });
    expect(principal).toBeNull();
    expect(await fixture.store.findSessionById(row.id)).toBeNull();
  });

  it('rejects and deletes a session whose epoch no longer matches', async () => {
    const fixture = makeTestAuth();
    const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: 'hash' });
    const { row, sessionId } = await seedSession(fixture.store, user, { credentialEpoch: 99 });
    const principal = await createSessionVerifier(fixture.auth)({ request: fakeRequest(), sessionId });
    expect(principal).toBeNull();
    expect(await fixture.store.findSessionById(row.id)).toBeNull();
  });

  it('rejects and deletes an absolutely expired session', async () => {
    const fixture = makeTestAuth();
    const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: 'hash' });
    const { row, sessionId } = await seedSession(fixture.store, user, {
      absoluteExpiresAt: new Date(TEST_NOW_MS - 1000),
    });
    const principal = await createSessionVerifier(fixture.auth)({ request: fakeRequest(), sessionId });
    expect(principal).toBeNull();
    expect(await fixture.store.findSessionById(row.id)).toBeNull();
  });

  it('rejects and deletes an idle-expired session', async () => {
    const fixture = makeTestAuth();
    const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: 'hash' });
    const { row, sessionId } = await seedSession(fixture.store, user, {
      lastSeenAt: new Date(TEST_NOW_MS - 24 * 60 * 60 * 1000 - 1000),
    });
    const principal = await createSessionVerifier(fixture.auth)({ request: fakeRequest(), sessionId });
    expect(principal).toBeNull();
    expect(await fixture.store.findSessionById(row.id)).toBeNull();
  });

  it('updates last_seen_at only past the 15-minute throttle', async () => {
    const fixture = makeTestAuth();
    const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: 'hash' });
    const stale = await seedSession(fixture.store, user, { lastSeenAt: new Date(TEST_NOW_MS - 16 * 60 * 1000) });
    await createSessionVerifier(fixture.auth)({ request: fakeRequest(), sessionId: stale.sessionId });
    const updated = await fixture.store.findSessionById(stale.row.id);
    expect(updated?.lastSeenAt.getTime()).toBe(TEST_NOW_MS);
    const fresh = await seedSession(fixture.store, user, { lastSeenAt: new Date(TEST_NOW_MS - 5 * 60 * 1000) });
    await createSessionVerifier(fixture.auth)({ request: fakeRequest(), sessionId: fresh.sessionId });
    const untouched = await fixture.store.findSessionById(fresh.row.id);
    expect(untouched?.lastSeenAt.getTime()).toBe(TEST_NOW_MS - 5 * 60 * 1000);
  });

  it('throws 503 when the store is missing or the database fails', async () => {
    const noStore = makeTestAuth({ store: null });
    await expect(
      createSessionVerifier(noStore.auth)({ request: fakeRequest(), sessionId: newOpaqueToken() }),
    ).rejects.toMatchObject({ code: 'service_unavailable', statusCode: 503 });
    const fixture = makeTestAuth();
    fixture.store.failFindSessionByHash = true;
    await expect(
      createSessionVerifier(fixture.auth)({ request: fakeRequest(), sessionId: newOpaqueToken() }),
    ).rejects.toMatchObject({ code: 'service_unavailable', statusCode: 503 });
  });

  it('rejects a role outside the known set', async () => {
    const fixture = makeTestAuth();
    const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: 'hash', role: 'superuser' });
    const { sessionId } = await seedSession(fixture.store, user);
    const principal = await createSessionVerifier(fixture.auth)({ request: fakeRequest(), sessionId });
    expect(principal).toBeNull();
  });
});

describe('loadSessionAndUser', () => {
  it('loads the row and owner, and returns null on a revoked race', async () => {
    const fixture = makeTestAuth();
    const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: 'hash' });
    const created = await createSessionForLogin(fixture.auth, fixture.store, user, fakeRequest(), new Date(TEST_NOW_MS));
    const principal = { userId: user.id, role: 'user' as const, sessionId: created.row.id, credentialEpoch: 1 };
    const loaded = await loadSessionAndUser(fixture.auth, fakeRequest(), principal);
    expect(loaded?.row.id).toBe(created.row.id);
    expect(loaded?.user.id).toBe(user.id);
    await fixture.store.deleteSessionById(created.row.id);
    await expect(loadSessionAndUser(fixture.auth, fakeRequest(), principal)).resolves.toBeNull();
  });
});

describe('CSRF verifier', () => {
  it('accepts the matching token and rejects everything else', async () => {
    const fixture = makeTestAuth();
    const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: 'hash' });
    const { row, csrfToken } = await seedSession(fixture.store, user);
    const principal = { userId: user.id, role: 'user' as const, sessionId: row.id, credentialEpoch: 1 };
    const verify = createCsrfVerifier(fixture.auth);
    expect(await verify(fakeRequest({ 'x-csrf-token': csrfToken }), principal)).toBe(true);
    expect(await verify(fakeRequest({ 'x-csrf-token': 'wrong-token' }), principal)).toBe(false);
    expect(await verify(fakeRequest(), principal)).toBe(false);
    expect(await verify(fakeRequest({ 'x-csrf-token': csrfToken }), { ...principal, sessionId: 'missing' })).toBe(false);
    expect(await verify(fakeRequest({ 'x-csrf-token': csrfToken }), { ...principal, credentialEpoch: 99 })).toBe(false);
  });

  it('fails closed without a store or on a database failure', async () => {
    const noStore = createAuthContext({ store: null, hasher: new FakePasswordHasher() });
    const principal = { userId: 'u', role: 'user' as const, sessionId: 's' };
    expect(await createCsrfVerifier(noStore)(fakeRequest({ 'x-csrf-token': 'x' }), principal)).toBe(false);
    const fixture = makeTestAuth();
    fixture.store.failFindSessionById = true;
    expect(await createCsrfVerifier(fixture.auth)(fakeRequest({ 'x-csrf-token': 'x' }), principal)).toBe(false);
  });
});
