// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Shared fixtures for the auth specs: a fast fake hasher, a
// controllable clock, test-only secret values, and app builders.
// The secret-looking strings below are fixtures, not credentials:
// they exist only inside these tests and never leave the process.

import { createHash } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createAuthContext, type AuthContext } from '../../src/auth/context.js';
import { safeEqual } from '../../src/auth/crypto.js';
import type { PasswordHasher } from '../../src/auth/passwords.js';
import type { ServerConfig } from '../../src/config.js';
import { FakeAuthStore } from './fake-store.js';

export const TEST_AUTH_SECRET = 'test-only-auth-secret-value-0123456789abcdef';
export const TEST_SETUP_TOKEN = 'test-only-setup-token-value-0123456789abcdef';
export const TEST_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);
export const CANONICAL_ORIGIN = 'https://app.example.invalid';
export const TEST_NOW_MS = Date.UTC(2026, 10, 15, 4, 0, 0);
export const USER_AGENT = 'test-agent/1.0 (TestOS)';

// Fast deterministic hasher: SHA-256 with a prefix, so route tests
// never pay Argon2 cost. Argon2 correctness is covered separately
// in foundations.spec.ts with the real hasher.
export class FakePasswordHasher implements PasswordHasher {
  rehash = false;

  async hash(password: string): Promise<string> {
    return `fake$${createHash('sha256').update(password, 'utf8').digest('hex')}`;
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    return safeEqual(storedHash, await this.hash(password));
  }

  needsRehash(_storedHash: string): boolean {
    void _storedHash;
    return this.rehash;
  }
}

export class TestClock {
  nowMs: number;

  constructor(nowMs: number = TEST_NOW_MS) {
    this.nowMs = nowMs;
  }

  clock = (): number => this.nowMs;

  now(): Date {
    return new Date(this.nowMs);
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }
}

export interface TestAuth {
  auth: AuthContext;
  store: FakeAuthStore;
  clock: TestClock;
  hasher: FakePasswordHasher;
}

export function makeTestAuth(overrides: Partial<Parameters<typeof createAuthContext>[0]> = {}): TestAuth {
  const store = new FakeAuthStore();
  const clock = new TestClock();
  const hasher = new FakePasswordHasher();
  const auth = createAuthContext({
    store,
    hasher,
    authSecret: TEST_AUTH_SECRET,
    setupToken: TEST_SETUP_TOKEN,
    encryptionKey: TEST_ENCRYPTION_KEY,
    canonicalOrigin: CANONICAL_ORIGIN,
    trustProxy: false,
    cookieSecure: false,
    registrationMode: 'closed',
    clock: clock.clock,
    ...overrides,
  });
  return { auth, store, clock, hasher };
}

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3001,
    databaseUrl: undefined,
    workspaceRoot: '/tmp',
    nodeEnv: 'development',
    logLevel: 'silent',
    checkTimeoutMs: 2000,
    overallTimeoutMs: 5000,
    warnings: [],
    registrationMode: 'closed',
    publicBaseUrl: CANONICAL_ORIGIN,
    trustProxy: false,
    cookieSecure: false,
    cfAccessEnabled: false,
    cfAccessTeamDomain: undefined,
    cfAccessAud: undefined,
    cfAccessServiceAud: undefined,
    cfAccessJwksCacheTtlSeconds: 3600,
    jwtAudience: undefined,
    authSecretConfigured: true,
    authSecretLengthOk: true,
    encryptionKeyConfigured: true,
    setupTokenConfigured: true,
    setupTokenLengthOk: true,
    maxBodyBytes: 1048576,
    ...overrides,
  };
}

export async function buildTestApp(auth: AuthContext, configOverrides: Partial<ServerConfig> = {}): Promise<FastifyInstance> {
  return buildApp({ config: testConfig(configOverrides), pool: null, version: 'test', auth });
}

export function publicHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: CANONICAL_ORIGIN, 'user-agent': USER_AGENT, ...extra };
}

export function sessionHeaders(cookie: string, csrfToken: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ...publicHeaders(), cookie, 'x-csrf-token': csrfToken, ...extra };
}

// First segment of the first Set-Cookie header: "name=value".
export function cookieFromResponse(res: LightMyRequestResponse): string | undefined {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') {
    return undefined;
  }
  return first.split(';')[0] as string;
}

export function setCookieHeader(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === 'string' ? first : '';
}

export interface EnvelopeBody {
  ok: boolean;
  data?: Record<string, unknown> & { [key: string]: unknown };
  error?: { code?: unknown; message?: unknown; requestId?: unknown; retryable?: unknown; details?: unknown };
}

export function bodyOf(res: LightMyRequestResponse): EnvelopeBody {
  return res.json() as EnvelopeBody;
}

// Logs in through the real routes and returns the cookie plus the
// CSRF token from the login body. Fails the test when login does
// not succeed with 200 (use the raw inject calls for TOTP flows).
export async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<{ cookie: string; csrfToken: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: publicHeaders({ 'content-type': 'application/json' }),
    payload: { email, password },
  } satisfies InjectOptions);
  if (res.statusCode !== 200) {
    throw new Error(`loginAs expected 200, got ${res.statusCode}: ${res.body}`);
  }
  const body = bodyOf(res);
  const data = body.data as { csrfToken: string; id: string };
  const cookie = cookieFromResponse(res);
  if (cookie === undefined) {
    throw new Error('loginAs found no Set-Cookie header');
  }
  return { cookie, csrfToken: data.csrfToken, userId: data.id };
}

export async function seedLoggedInUser(
  fixture: TestAuth,
  app: FastifyInstance,
  input: { email: string; password: string },
): Promise<{ cookie: string; csrfToken: string; userId: string }> {
  const hash = await fixture.hasher.hash(input.password);
  fixture.store.seedUser({ email: input.email, passwordHash: hash });
  return loginAs(app, input.email, input.password);
}
