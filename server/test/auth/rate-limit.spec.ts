// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the database-backed rate limits and the progressive
// lockout (desain-auth.md section 6): fixed windows, failure-only
// counting, the setup scope, and the lockout ladder.

import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  checkAndCountSetupAttempt,
  checkFailureBucket,
  checkGeneralApiLimit,
  checkLockout,
  checkLoginBuckets,
  lockoutDurationMs,
  recordFailureBucket,
  recordLoginFailureBuckets,
  recordLoginFailureLockout,
  secondsUntilWindowEnd,
  sendRateLimited,
  windowStartMs,
} from '../../src/middleware/rate-limit.js';
import { FakeAuthStore } from './fake-store.js';
import { TEST_AUTH_SECRET, TEST_NOW_MS } from './helpers.js';

describe('window math', () => {
  it('floors the window start and rounds Retry-After up', () => {
    expect(windowStartMs(TEST_NOW_MS, 15 * 60 * 1000)).toBe(Math.floor(TEST_NOW_MS / 900_000) * 900_000);
    expect(secondsUntilWindowEnd(TEST_NOW_MS, 15 * 60 * 1000)).toBeGreaterThan(0);
    expect(secondsUntilWindowEnd(TEST_NOW_MS, 15 * 60 * 1000)).toBeLessThanOrEqual(900);
  });
});

describe('failure buckets', () => {
  it('allows below the limit and denies at the limit', async () => {
    const store = new FakeAuthStore();
    const input = {
      store,
      scope: 'login:ip',
      rawKey: '203.0.113.7',
      authSecret: TEST_AUTH_SECRET,
      limit: 2,
      windowMs: 15 * 60 * 1000,
      nowMs: TEST_NOW_MS,
    };
    expect((await checkFailureBucket(input)).allowed).toBe(true);
    await recordFailureBucket(input);
    expect((await checkFailureBucket(input)).allowed).toBe(true);
    await recordFailureBucket(input);
    const denied = await checkFailureBucket(input);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('scopes buckets by window: a new window starts empty', async () => {
    const store = new FakeAuthStore();
    const base = {
      store,
      scope: 'login:ip',
      rawKey: '203.0.113.7',
      authSecret: TEST_AUTH_SECRET,
      limit: 1,
      windowMs: 15 * 60 * 1000,
    };
    await recordFailureBucket({ ...base, nowMs: TEST_NOW_MS });
    expect((await checkFailureBucket({ ...base, nowMs: TEST_NOW_MS })).allowed).toBe(false);
    expect((await checkFailureBucket({ ...base, nowMs: TEST_NOW_MS + 15 * 60 * 1000 })).allowed).toBe(true);
  });

  it('counts the login bucket pair together', async () => {
    const store = new FakeAuthStore();
    const input = { store, email: 'a@example.invalid', ip: '203.0.113.7', authSecret: TEST_AUTH_SECRET, nowMs: TEST_NOW_MS };
    expect((await checkLoginBuckets(input)).allowed).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      await recordLoginFailureBuckets(input);
    }
    expect((await checkLoginBuckets(input)).allowed).toBe(false);
  });

  it('counts every setup attempt and denies the sixth in the hour', async () => {
    const store = new FakeAuthStore();
    const input = { store, ip: '203.0.113.7', authSecret: TEST_AUTH_SECRET, nowMs: TEST_NOW_MS };
    for (let i = 0; i < 5; i += 1) {
      expect((await checkAndCountSetupAttempt(input)).allowed).toBe(true);
    }
    expect((await checkAndCountSetupAttempt(input)).allowed).toBe(false);
  });

  it('fails closed without an auth secret', async () => {
    const store = new FakeAuthStore();
    await expect(
      checkFailureBucket({
        store,
        scope: 'login:ip',
        rawKey: 'x',
        authSecret: undefined,
        limit: 1,
        windowMs: 60_000,
        nowMs: TEST_NOW_MS,
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('fails closed on a short or placeholder auth secret (G11a)', async () => {
    const store = new FakeAuthStore();
    for (const authSecret of ['short', `CHANGE_ME_${'x'.repeat(32)}`]) {
      await expect(
        checkFailureBucket({
          store,
          scope: 'login:ip',
          rawKey: 'x',
          authSecret,
          limit: 1,
          windowMs: 60_000,
          nowMs: TEST_NOW_MS,
        }),
      ).rejects.toMatchObject({ code: 'service_unavailable' });
    }
  });
});

describe('progressive lockout', () => {
  it('locks after 5 consecutive failures for 15 minutes', async () => {
    const store = new FakeAuthStore();
    const now = new Date(TEST_NOW_MS);
    const fresh = await checkLockout(store, 'u-1', TEST_NOW_MS);
    expect(fresh.locked).toBe(false);
    expect(fresh.lockoutLevel).toBe(0);
    expect(fresh.lockoutDurationMs).toBe(0);
    for (let i = 0; i < 4; i += 1) {
      await recordLoginFailureLockout(store, 'u-1', now);
      expect((await checkLockout(store, 'u-1', TEST_NOW_MS)).locked).toBe(false);
    }
    await recordLoginFailureLockout(store, 'u-1', now);
    const locked = await checkLockout(store, 'u-1', TEST_NOW_MS);
    expect(locked.locked).toBe(true);
    expect(locked.retryAfterSeconds).toBe(900);
    expect(locked.lockoutLevel).toBe(1);
    expect(locked.lockoutDurationMs).toBe(15 * 60 * 1000);
  });

  it('does not extend a lockout with attempts made while locked', async () => {
    const store = new FakeAuthStore();
    const now = new Date(TEST_NOW_MS);
    for (let i = 0; i < 5; i += 1) {
      await recordLoginFailureLockout(store, 'u-1', now);
    }
    const before = await store.getLockout('u-1');
    await recordLoginFailureLockout(store, 'u-1', new Date(TEST_NOW_MS + 60_000));
    const after = await store.getLockout('u-1');
    expect(after?.lockedUntil?.getTime()).toBe(before?.lockedUntil?.getTime());
    expect(after?.consecutiveFailures).toBe(before?.consecutiveFailures);
  });

  it('climbs one rung after expiry while keeping the level', async () => {
    const store = new FakeAuthStore();
    for (let i = 0; i < 5; i += 1) {
      await recordLoginFailureLockout(store, 'u-1', new Date(TEST_NOW_MS));
    }
    const expiredAt = TEST_NOW_MS + 15 * 60 * 1000 + 1000;
    expect((await checkLockout(store, 'u-1', expiredAt)).locked).toBe(false);
    for (let i = 0; i < 5; i += 1) {
      await recordLoginFailureLockout(store, 'u-1', new Date(expiredAt));
    }
    const row = await store.getLockout('u-1');
    expect(row?.lockoutLevel).toBe(2);
    expect(row?.lockedUntil?.getTime()).toBe(expiredAt + 60 * 60 * 1000);
    await store.clearLockout('u-1');
    expect(await store.getLockout('u-1')).toBeNull();
  });

  it('caps the ladder at 24 hours', () => {
    expect(lockoutDurationMs(1)).toBe(15 * 60 * 1000);
    expect(lockoutDurationMs(2)).toBe(60 * 60 * 1000);
    expect(lockoutDurationMs(3)).toBe(4 * 60 * 60 * 1000);
    expect(lockoutDurationMs(4)).toBe(24 * 60 * 60 * 1000);
    expect(lockoutDurationMs(9)).toBe(24 * 60 * 60 * 1000);
  });
});

describe('general API limit helper', () => {
  it('checks the account scope when a principal exists and the IP scope otherwise', async () => {
    const store = new FakeAuthStore();
    expect(
      (await checkGeneralApiLimit({ store, userId: 'u-1', ip: undefined, authSecret: TEST_AUTH_SECRET, nowMs: TEST_NOW_MS }))
        .allowed,
    ).toBe(true);
    expect(
      (
        await checkGeneralApiLimit({
          store,
          userId: undefined,
          ip: '203.0.113.7',
          authSecret: TEST_AUTH_SECRET,
          nowMs: TEST_NOW_MS,
        })
      ).allowed,
    ).toBe(true);
  });
});

describe('sendRateLimited', () => {
  it('sends 429 with Retry-After and a retryable envelope', () => {
    const seen: { code?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
    const reply = {
      code: (code: number) => {
        seen.code = code;
        return reply;
      },
      header: (name: string, value: string) => {
        seen.headers[name] = value;
        return reply;
      },
      send: (body: unknown) => {
        seen.body = body;
        return reply;
      },
    } as unknown as FastifyReply;
    sendRateLimited(reply, 'req-1', 137);
    expect(seen.code).toBe(429);
    expect(seen.headers['Retry-After']).toBe('137');
    expect(seen.body).toEqual({
      ok: false,
      error: { code: 'rate_limited', message: 'Too many requests.', requestId: 'req-1', retryable: true, details: {} },
    });
  });
});
