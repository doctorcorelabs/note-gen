// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Unit tests for the auth service mechanics: session creation and
// rotation, step-up freshness, role assertion, cookie lifetime, and
// the audit/database error mapping shared by the handlers.

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/plugins/envelope.js';
import { deriveCsrfToken, hashToken } from '../../src/auth/crypto.js';
import {
  assertRole,
  createSessionForLogin,
  isStepUpFresh,
  recordAudit,
  rotateSessionForRow,
  sessionCookieMaxAgeSeconds,
  unavailableOnDbError,
} from '../../src/auth/service.js';
import type { AuthStore } from '../../src/auth/store.js';
import { FakeAuthStore } from './fake-store.js';
import { makeTestAuth, TEST_AUTH_SECRET, TEST_NOW_MS, USER_AGENT } from './helpers.js';

function fakeRequest(): FastifyRequest {
  return { headers: { 'user-agent': USER_AGENT }, ip: '127.0.0.1' } as unknown as FastifyRequest;
}

describe('step-up freshness', () => {
  it('requires a step-up within the last 15 minutes', () => {
    expect(isStepUpFresh(null, TEST_NOW_MS)).toBe(false);
    expect(isStepUpFresh(new Date(TEST_NOW_MS), TEST_NOW_MS)).toBe(true);
    expect(isStepUpFresh(new Date(TEST_NOW_MS - 15 * 60 * 1000), TEST_NOW_MS)).toBe(true);
    expect(isStepUpFresh(new Date(TEST_NOW_MS - 15 * 60 * 1000 - 1), TEST_NOW_MS)).toBe(false);
  });
});

describe('cookie lifetime', () => {
  it('returns remaining seconds and never a negative value', () => {
    expect(sessionCookieMaxAgeSeconds(new Date(TEST_NOW_MS + 90_000), TEST_NOW_MS)).toBe(90);
    expect(sessionCookieMaxAgeSeconds(new Date(TEST_NOW_MS - 1000), TEST_NOW_MS)).toBe(0);
  });
});

describe('role assertion', () => {
  it('passes user and admin and fails closed on anything else', () => {
    expect(assertRole('user')).toBe('user');
    expect(assertRole('admin')).toBe('admin');
    expect(() => assertRole('superuser')).toThrow(ApiError);
  });
});

describe('session creation', () => {
  it('creates a fresh session with derived CSRF material and a 30-day absolute expiry', async () => {
    const fixture = makeTestAuth();
    const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: 'hash' });
    const now = new Date(TEST_NOW_MS);
    const created = await createSessionForLogin(fixture.auth, fixture.store, user, fakeRequest(), now);
    expect(created.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.row.sessionHash).toBe(hashToken(created.sessionId));
    expect(created.csrfToken).toBe(deriveCsrfToken(created.row.sessionHash, TEST_AUTH_SECRET));
    expect(created.row.csrfTokenHash).toBe(hashToken(created.csrfToken));
    expect(created.row.credentialEpoch).toBe(user.credentialEpoch);
    expect(created.row.absoluteExpiresAt.getTime()).toBe(TEST_NOW_MS + 30 * 24 * 60 * 60 * 1000);
    expect(created.row.stepUpAt).toBeNull();
    expect(created.row.deviceLabel).toBe('Unknown device');
  });

  it('fails closed without an auth secret', async () => {
    const fixture = makeTestAuth({ authSecret: undefined });
    const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: 'hash' });
    await expect(createSessionForLogin(fixture.auth, fixture.store, user, fakeRequest(), new Date(TEST_NOW_MS))).rejects.toMatchObject({
      code: 'service_unavailable',
      statusCode: 503,
    });
  });
});

describe('session rotation', () => {
  it('kills the old row and preserves creation time and absolute expiry', async () => {
    const fixture = makeTestAuth();
    const user = fixture.store.seedUser({ email: 'a@example.invalid', passwordHash: 'hash' });
    const created = await createSessionForLogin(fixture.auth, fixture.store, user, fakeRequest(), new Date(TEST_NOW_MS));
    const stepUpAt = new Date(TEST_NOW_MS + 60_000);
    const rotated = await rotateSessionForRow(
      fixture.auth,
      fixture.store,
      created.row,
      fakeRequest(),
      new Date(TEST_NOW_MS + 60_000),
      stepUpAt,
    );
    expect(await fixture.store.findSessionById(created.row.id)).toBeNull();
    expect(rotated.sessionId).not.toBe(created.sessionId);
    expect(rotated.csrfToken).not.toBe(created.csrfToken);
    expect(rotated.row.createdAt.getTime()).toBe(created.row.createdAt.getTime());
    expect(rotated.row.absoluteExpiresAt.getTime()).toBe(created.row.absoluteExpiresAt.getTime());
    expect(rotated.row.stepUpAt?.getTime()).toBe(stepUpAt.getTime());
    expect(rotated.row.credentialEpoch).toBe(created.row.credentialEpoch);
  });
});

describe('audit and database error mapping', () => {
  it('passes ApiError through and maps other failures to 503', async () => {
    await expect(unavailableOnDbError(async () => 'ok')).resolves.toBe('ok');
    const api = ApiError.notFound();
    await expect(unavailableOnDbError(async () => { throw api; })).rejects.toBe(api);
    await expect(unavailableOnDbError(async () => { throw new Error('boom'); })).rejects.toMatchObject({
      code: 'service_unavailable',
      statusCode: 503,
    });
  });

  it('records audit events and swallows audit failures with a callback', async () => {
    const store = new FakeAuthStore();
    await recordAudit(store, {
      userId: 'u-1',
      actorUserId: 'u-1',
      eventType: 'logout',
      ip: null,
      userAgent: null,
      metadata: {},
    });
    expect(store.auditEvents).toHaveLength(1);
    const failing = new FakeAuthStore();
    failing.insertAuditEvent = async () => {
      throw new Error('audit down');
    };
    let called = false;
    await recordAudit(
      failing as unknown as AuthStore,
      { userId: null, actorUserId: null, eventType: 'logout', ip: null, userAgent: null, metadata: {} },
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
  });
});
