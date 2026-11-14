// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Negative auth lifecycle tests (worker V3-01cR, wave 3A).
//
// LAYER: L2 contract reference harness. Read this before citing any
// result from this file.
//
// What is REAL here: buildApp, the real auth hook (session then Origin
// then CSRF, deny by default), and the real envelope. Every request
// below passes through the real hook with injected verifiers, so the
// 401/403 wiring, the check order, and the denial shapes are proven
// against production code.
//
// What is FAKE here: the account store, the password comparison, the
// lockout store, the session store, the TOTP check, and every handler
// under /api/test-*. They implement the wire behavior desain-auth.md
// requires, so the ASSERTIONS pin what the real routes (V3-01b/V3-02)
// must satisfy. A green run here does NOT prove the real routes
// behave this way; the live probes in auth-negative-live.spec.ts are
// the honest check against real routes, and they skip while the real
// routes are absent. Password comparison in this file is plain fixture
// string equality, an explicit stand-in for the Argon2id verify in
// V3-01b passwords.ts; no hash, salt, or real credential appears here.
//
// The fake clock makes time-dependent rules deterministic: lockout
// ladder durations, challenge expiry, step-up freshness, idle and
// absolute session expiry. No test waits on wall time.
//
// Sources: desain-auth.md sections 1.3, 1.4, 1.6, 3.1-3.7, 5.2, 6.3-6.5;
// kontrak-api-kanonis.md sections 1.2, 3.12, 3.13, 6.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import {
  createOriginPreHandler,
  getPrincipal,
  readCsrfTokenHeader,
} from '../src/middleware/auth-hook.js';
import { ApiError, errorEnvelope, successEnvelope } from '../src/plugins/envelope.js';

const CANONICAL_ORIGIN = 'https://app.example.invalid';
const VERSION = '0.39.2-fork.1';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ABSOLUTE_SESSION_MS = 30 * DAY_MS;
const IDLE_MS = 24 * HOUR_MS;
const STEP_UP_MS = 15 * MINUTE_MS;
const CHALLENGE_MS = 5 * MINUTE_MS;
const LOGIN_WINDOW_MS = 15 * MINUTE_MS;

// Lockout ladder, desain-auth.md section 6.3 mechanism C: 15 minutes,
// 1 hour, 4 hours, then 24 hours capped.
const LOCKOUT_LADDER_MS = [15 * MINUTE_MS, HOUR_MS, 4 * HOUR_MS, DAY_MS];

function lockoutDurationMs(level: number): number {
  return LOCKOUT_LADDER_MS[Math.min(Math.max(level, 1) - 1, LOCKOUT_LADDER_MS.length - 1)] ?? DAY_MS;
}

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3001,
    databaseUrl: 'postgres://placeholder/placeholder',
    workspaceRoot: '/tmp',
    nodeEnv: 'development',
    logLevel: 'silent',
    checkTimeoutMs: 2000,
    overallTimeoutMs: 5000,
    warnings: [],
    registrationMode: 'closed',
    publicBaseUrl: CANONICAL_ORIGIN,
    trustProxy: false,
    cookieSecure: true,
    cfAccessEnabled: false,
    cfAccessTeamDomain: undefined,
    cfAccessAud: undefined,
    cfAccessJwksCacheTtlSeconds: 3600,
    cfAccessServiceAud: undefined,
    jwtAudience: undefined,
    authSecretConfigured: false,
    authSecretLengthOk: false,
    encryptionKeyConfigured: false,
    setupTokenConfigured: false,
    setupTokenLengthOk: false,
    maxBodyBytes: 1048576,
    ...overrides,
  };
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

function errorOf(res: InjectResponse): ErrorEnvelopeBody['error'] {
  return (res.json() as ErrorEnvelopeBody).error;
}

function normalizedDenial(res: InjectResponse): string {
  const parsed = JSON.parse(res.body) as ErrorEnvelopeBody;
  parsed.error.requestId = 'redacted';
  return JSON.stringify(parsed);
}

// --- Fake clock -------------------------------------------------------

class FakeClock {
  nowMs: number;

  constructor(startMs: number) {
    this.nowMs = startMs;
  }

  now(): number {
    return this.nowMs;
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }
}

// --- Fake state -------------------------------------------------------

interface FakeAccount {
  id: string;
  email: string;
  // Fixture password in clear text inside the test process only. The
  // real service stores an Argon2id hash and never sees this value.
  password: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  credentialEpoch: number;
  totpEnabled: boolean;
  totpStep: number;
  lastUsedStep: number | null;
  totpSecret: string | null;
  recoveryCodes: Set<string>;
}

interface FakeSession {
  rowId: string;
  sessionId: string;
  csrfToken: string;
  userId: string;
  sessionEpoch: number;
  createdAt: number;
  absoluteExpiresAt: number;
  lastSeenAt: number;
  stepUpAt: number | null;
}

interface FakeLockout {
  consecutiveFailures: number;
  lockoutLevel: number;
  lockedUntil: number | null;
}

interface FakeChallenge {
  token: string;
  userId: string;
  userAgent: string;
  expiresAt: number;
  attempts: number;
}

interface FakeBucket {
  windowStart: number;
  failures: number;
}

interface FakeState {
  clock: FakeClock;
  accountsById: Map<string, FakeAccount>;
  accountsByEmail: Map<string, FakeAccount>;
  sessions: Map<string, FakeSession>;
  lockouts: Map<string, FakeLockout>;
  challenges: Map<string, FakeChallenge>;
  accountIpBuckets: Map<string, FakeBucket>;
  ipBuckets: Map<string, FakeBucket>;
  stepUpFailures: Map<string, FakeBucket>;
  passwordChangeFailures: Map<string, FakeBucket>;
  records: Map<string, { id: string; ownerId: string }>;
  nextId: number;
}

const USER_EMAIL = 'user@example.invalid';
const USER_PASSWORD = 'fixture-user-password-1';
const ADMIN_EMAIL = 'admin@example.invalid';
const ADMIN_PASSWORD = 'fixture-admin-password-1';
const DISABLED_EMAIL = 'disabled@example.invalid';
const TOTP_EMAIL = 'totp@example.invalid';
const TOTP_PASSWORD = 'fixture-totp-password-1';
const TOTP_SECRET_FIXTURE = 'FIXTURE-TOTP-SECRET-ONLY-NOT-REAL';

function expectedTotpCode(step: number): string {
  return String(100_000 + step);
}

function makeAccount(
  id: string,
  email: string,
  password: string,
  role: 'user' | 'admin',
  extra: Partial<FakeAccount> = {},
): FakeAccount {
  return {
    id,
    email,
    password,
    role,
    status: 'active',
    credentialEpoch: 0,
    totpEnabled: false,
    totpStep: 100,
    lastUsedStep: null,
    totpSecret: null,
    recoveryCodes: new Set(),
    ...extra,
  };
}

function newState(): FakeState {
  const clock = new FakeClock(Date.UTC(2026, 10, 15, 0, 0, 0));
  const user = makeAccount('user-1', USER_EMAIL, USER_PASSWORD, 'user');
  const admin = makeAccount('admin-1', ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');
  const disabled = makeAccount('user-disabled', DISABLED_EMAIL, USER_PASSWORD, 'user', {
    status: 'disabled',
  });
  const totp = makeAccount('user-totp', TOTP_EMAIL, TOTP_PASSWORD, 'user', {
    totpEnabled: true,
    totpSecret: TOTP_SECRET_FIXTURE,
    recoveryCodes: new Set(['rc-test-code-0001', 'rc-test-code-0002', 'rc-test-code-0003']),
  });
  return {
    clock,
    accountsById: new Map([
      [user.id, user],
      [admin.id, admin],
      [disabled.id, disabled],
      [totp.id, totp],
    ]),
    accountsByEmail: new Map([
      [user.email, user],
      [admin.email, admin],
      [disabled.email, disabled],
      [totp.email, totp],
    ]),
    sessions: new Map(),
    lockouts: new Map(),
    challenges: new Map(),
    accountIpBuckets: new Map(),
    ipBuckets: new Map(),
    stepUpFailures: new Map(),
    passwordChangeFailures: new Map(),
    records: new Map([['rec-user-1', { id: 'rec-user-1', ownerId: 'user-1' }]]),
    nextId: 0,
  };
}

function mintSession(
  state: FakeState,
  account: FakeAccount,
  opts: { preserveAbsoluteExpiresAt?: number; preserveCreatedAt?: number; stepUpAt?: number | null } = {},
): FakeSession {
  state.nextId += 1;
  const now = state.clock.now();
  const session: FakeSession = {
    rowId: `row-${state.nextId}`,
    sessionId: `sess-${state.nextId}`,
    csrfToken: `csrf-${state.nextId}`,
    userId: account.id,
    sessionEpoch: account.credentialEpoch,
    createdAt: opts.preserveCreatedAt ?? now,
    absoluteExpiresAt: opts.preserveAbsoluteExpiresAt ?? now + ABSOLUTE_SESSION_MS,
    lastSeenAt: now,
    stepUpAt: opts.stepUpAt ?? null,
  };
  state.sessions.set(session.sessionId, session);
  return session;
}

function rotateSession(state: FakeState, old: FakeSession, stepUpAt: number | null): FakeSession {
  const account = state.accountsById.get(old.userId);
  if (account === undefined) {
    throw new Error('rotation without an account');
  }
  state.sessions.delete(old.sessionId);
  return mintSession(state, account, {
    preserveAbsoluteExpiresAt: old.absoluteExpiresAt,
    preserveCreatedAt: old.createdAt,
    stepUpAt,
  });
}

// --- Cookie helpers (development cookie name; the hook accepts both
// names, and production uses the __Host- name) ------------------------

function buildSessionCookie(value: string, maxAgeSeconds: number): string {
  return `notegen_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function setSessionCookie(reply: FastifyReply, session: FakeSession, clock: FakeClock): void {
  const maxAge = Math.max(0, Math.ceil((session.absoluteExpiresAt - clock.now()) / 1000));
  reply.header('Set-Cookie', buildSessionCookie(session.sessionId, maxAge));
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', buildSessionCookie('', 0));
}

function sessionIdFromSetCookie(res: InjectResponse): string | null {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') {
    return null;
  }
  const match = /^notegen_session=([^;]*)/.exec(first);
  return match === null ? null : (match[1] ?? null);
}

function sessionCookieHeader(sessionId: string): Record<string, string> {
  return { cookie: `notegen_session=${sessionId}` };
}

function mutationHeaders(sessionId: string, csrfToken: string): Record<string, string> {
  return { ...sessionCookieHeader(sessionId), origin: CANONICAL_ORIGIN, 'x-csrf-token': csrfToken };
}

// --- Lockout and bucket mechanics (reference implementation of
// desain-auth.md section 6.3) ------------------------------------------

function testIp(request: FastifyRequest): string {
  const header = request.headers['x-test-ip'];
  if (typeof header === 'string' && header !== '') {
    return header;
  }
  return request.ip;
}

function bucketBlocked(bucket: FakeBucket | undefined, now: number, limit: number): boolean {
  if (bucket === undefined) {
    return false;
  }
  const windowStart = Math.floor(now / LOGIN_WINDOW_MS) * LOGIN_WINDOW_MS;
  return bucket.windowStart === windowStart && bucket.failures >= limit;
}

function recordBucketFailure(buckets: Map<string, FakeBucket>, key: string, now: number): void {
  const windowStart = Math.floor(now / LOGIN_WINDOW_MS) * LOGIN_WINDOW_MS;
  const existing = buckets.get(key);
  if (existing === undefined || existing.windowStart !== windowStart) {
    buckets.set(key, { windowStart, failures: 1 });
    return;
  }
  existing.failures += 1;
}

function lockoutRemainingMs(state: FakeState, accountId: string, now: number): number | null {
  const row = state.lockouts.get(accountId);
  if (row === undefined || row.lockedUntil === null) {
    return null;
  }
  if (now >= row.lockedUntil) {
    // Lockout expired: failures reset, level kept (desain 6.3 C).
    row.consecutiveFailures = 0;
    row.lockedUntil = null;
    return null;
  }
  return row.lockedUntil - now;
}

function recordLoginFailure(state: FakeState, account: FakeAccount | undefined, email: string, ip: string): void {
  const now = state.clock.now();
  recordBucketFailure(state.accountIpBuckets, `${email}|${ip}`, now);
  recordBucketFailure(state.ipBuckets, ip, now);
  if (account === undefined) {
    return;
  }
  const row = state.lockouts.get(account.id) ?? { consecutiveFailures: 0, lockoutLevel: 0, lockedUntil: null };
  // Attempts during lockout never reach this function (the handler
  // returns 429 before verifying), so a failure here cannot extend a
  // live lockout.
  row.consecutiveFailures += 1;
  if (row.consecutiveFailures >= 5 && row.lockedUntil === null) {
    row.lockoutLevel += 1;
    row.lockedUntil = now + lockoutDurationMs(row.lockoutLevel);
  }
  state.lockouts.set(account.id, row);
}

function sendRateLimited(reply: FastifyReply, request: FastifyRequest, retryAfterSeconds: number): void {
  reply
    .code(429)
    .header('Retry-After', String(retryAfterSeconds))
    .send(errorEnvelope('rate_limited', 'Too many requests.', request.id, { retryable: true }));
}

// --- Harness ----------------------------------------------------------

interface Harness {
  app: FastifyInstance;
  state: FakeState;
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  return (request.body ?? {}) as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

async function buildHarness(): Promise<Harness> {
  const state = newState();
  const app = await buildApp({
    config: testConfig(),
    pool: null,
    version: VERSION,
    verifySession: async ({ sessionId }) => {
      if (sessionId === undefined) {
        return null;
      }
      const row = state.sessions.get(sessionId);
      if (row === undefined) {
        return null;
      }
      const account = state.accountsById.get(row.userId);
      if (account === undefined || account.status !== 'active') {
        return null;
      }
      if (row.sessionEpoch !== account.credentialEpoch) {
        return null;
      }
      const now = state.clock.now();
      if (now > row.absoluteExpiresAt || now - row.lastSeenAt > IDLE_MS) {
        state.sessions.delete(sessionId);
        return null;
      }
      row.lastSeenAt = now;
      return { userId: account.id, role: account.role, sessionId, credentialEpoch: row.sessionEpoch };
    },
    verifyCsrf: async (request, principal) => {
      const row = state.sessions.get(principal.sessionId);
      if (row === undefined) {
        return false;
      }
      return readCsrfTokenHeader(request) === row.csrfToken;
    },
  });

  const originOnly = {
    config: { requiresAuth: false },
    preHandler: createOriginPreHandler(CANONICAL_ORIGIN),
  };

  function sessionRowOf(request: FastifyRequest): FakeSession | undefined {
    const principal = getPrincipal(request);
    if (principal === undefined) {
      return undefined;
    }
    return state.sessions.get(principal.sessionId);
  }

  function stepUpFresh(request: FastifyRequest): boolean {
    const row = sessionRowOf(request);
    if (row === undefined || row.stepUpAt === null) {
      return false;
    }
    return state.clock.now() - row.stepUpAt <= STEP_UP_MS;
  }

  // POST /api/test-login: password step. Reference reading: missing or
  // empty email/password is 400 validation_failed, decided before any
  // auth verdict; every other failure is the identical 401.
  app.post('/api/test-login', originOnly, async (request, reply) => {
    const body = bodyOf(request);
    const email = stringField(body, 'email').trim().toLowerCase();
    const password = stringField(body, 'password');
    if (email === '' || password === '') {
      throw ApiError.validation();
    }
    const now = state.clock.now();
    const ip = testIp(request);
    const account = state.accountsByEmail.get(email);
    if (account !== undefined) {
      const remaining = lockoutRemainingMs(state, account.id, now);
      if (remaining !== null) {
        // Lockout Retry-After is rounded up to whole minutes (3.7).
        sendRateLimited(reply, request, Math.ceil(remaining / MINUTE_MS) * 60);
        return;
      }
    }
    if (bucketBlocked(state.accountIpBuckets.get(`${email}|${ip}`), now, 5) || bucketBlocked(state.ipBuckets.get(ip), now, 20)) {
      const windowEnd = (Math.floor(now / LOGIN_WINDOW_MS) + 1) * LOGIN_WINDOW_MS;
      sendRateLimited(reply, request, Math.ceil((windowEnd - now) / 1000));
      return;
    }
    // Fixture equality stands in for Argon2id verify (V3-01b).
    if (account === undefined || account.status !== 'active' || account.password !== password) {
      recordLoginFailure(state, account, email, ip);
      throw ApiError.invalidCredentials();
    }
    state.lockouts.delete(account.id);
    if (account.totpEnabled) {
      state.nextId += 1;
      const token = `challenge-${state.nextId}`;
      state.challenges.set(token, {
        token,
        userId: account.id,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : '',
        expiresAt: now + CHALLENGE_MS,
        attempts: 0,
      });
      reply.code(202);
      return successEnvelope({ challengeToken: token, step: 'totp' });
    }
    const session = mintSession(state, account);
    setSessionCookie(reply, session, state.clock);
    return successEnvelope({
      id: account.id,
      email: account.email,
      role: account.role,
      totpEnabled: false,
      csrfToken: session.csrfToken,
      sessionExpiresAt: session.absoluteExpiresAt,
    });
  });

  // POST /api/test-login-totp: second step. Every failure is the same
  // 401 invalid_verification_code, including expiry, exhaustion,
  // binding mismatch, replay, and a spent recovery code.
  app.post('/api/test-login-totp', originOnly, async (request, reply) => {
    const body = bodyOf(request);
    const token = stringField(body, 'challengeToken');
    const code = stringField(body, 'code');
    const recoveryCode = stringField(body, 'recoveryCode');
    const now = state.clock.now();
    const challenge = state.challenges.get(token);
    const fail = (challengeRow: FakeChallenge | undefined): never => {
      if (challengeRow !== undefined) {
        challengeRow.attempts += 1;
        const owner = state.accountsById.get(challengeRow.userId);
        if (owner !== undefined) {
          recordLoginFailure(state, owner, owner.email, testIp(request));
        }
        if (challengeRow.attempts >= 5) {
          state.challenges.delete(challengeRow.token);
        }
      }
      throw ApiError.invalidVerificationCode();
    };
    if (challenge === undefined || now > challenge.expiresAt || challenge.attempts >= 5) {
      if (challenge !== undefined) {
        state.challenges.delete(challenge.token);
      }
      throw ApiError.invalidVerificationCode();
    }
    const agent = typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : '';
    if (agent !== challenge.userAgent) {
      state.challenges.delete(challenge.token);
      throw ApiError.invalidVerificationCode();
    }
    const account = state.accountsById.get(challenge.userId);
    if (account === undefined) {
      state.challenges.delete(challenge.token);
      throw ApiError.invalidVerificationCode();
    }
    if (recoveryCode !== '') {
      if (!account.recoveryCodes.has(recoveryCode)) {
        fail(challenge);
      }
      account.recoveryCodes.delete(recoveryCode);
    } else {
      if (code !== expectedTotpCode(account.totpStep) || account.lastUsedStep === account.totpStep) {
        fail(challenge);
      }
      account.lastUsedStep = account.totpStep;
    }
    state.challenges.delete(challenge.token);
    state.lockouts.delete(account.id);
    const session = mintSession(state, account);
    setSessionCookie(reply, session, state.clock);
    return successEnvelope({
      id: account.id,
      email: account.email,
      role: account.role,
      totpEnabled: true,
      csrfToken: session.csrfToken,
      sessionExpiresAt: session.absoluteExpiresAt,
    });
  });

  app.post('/api/test-logout', async (request, reply) => {
    const row = sessionRowOf(request);
    if (row !== undefined) {
      state.sessions.delete(row.sessionId);
    }
    clearSessionCookie(reply);
    return successEnvelope(null);
  });

  app.post('/api/test-logout-all', async (request, reply) => {
    if (!stepUpFresh(request)) {
      throw ApiError.stepUpRequired();
    }
    const row = sessionRowOf(request);
    if (row === undefined) {
      throw ApiError.unauthenticated();
    }
    const account = state.accountsById.get(row.userId);
    if (account === undefined) {
      throw ApiError.unauthenticated();
    }
    for (const [id, candidate] of state.sessions) {
      if (candidate.userId === account.id) {
        state.sessions.delete(id);
      }
    }
    account.credentialEpoch += 1;
    clearSessionCookie(reply);
    return successEnvelope(null);
  });

  app.post('/api/test-step-up', async (request, reply) => {
    const row = sessionRowOf(request);
    if (row === undefined) {
      throw ApiError.unauthenticated();
    }
    const account = state.accountsById.get(row.userId);
    if (account === undefined) {
      throw ApiError.unauthenticated();
    }
    const now = state.clock.now();
    if (bucketBlocked(state.stepUpFailures.get(account.id), now, 5)) {
      const windowEnd = (Math.floor(now / LOGIN_WINDOW_MS) + 1) * LOGIN_WINDOW_MS;
      sendRateLimited(reply, request, Math.ceil((windowEnd - now) / 1000));
      return;
    }
    const body = bodyOf(request);
    const password = stringField(body, 'password');
    const code = stringField(body, 'code');
    const passwordOk = password === account.password;
    const codeOk =
      !account.totpEnabled || (code === expectedTotpCode(account.totpStep) && account.lastUsedStep !== account.totpStep);
    if (!passwordOk || !codeOk) {
      recordBucketFailure(state.stepUpFailures, account.id, now);
      throw ApiError.invalidCredentials();
    }
    if (account.totpEnabled) {
      account.lastUsedStep = account.totpStep;
    }
    const rotated = rotateSession(state, row, now);
    setSessionCookie(reply, rotated, state.clock);
    return successEnvelope({ csrfToken: rotated.csrfToken });
  });

  app.post('/api/test-password-change', async (request, reply) => {
    const row = sessionRowOf(request);
    if (row === undefined) {
      throw ApiError.unauthenticated();
    }
    const account = state.accountsById.get(row.userId);
    if (account === undefined) {
      throw ApiError.unauthenticated();
    }
    const now = state.clock.now();
    if (bucketBlocked(state.passwordChangeFailures.get(account.id), now, 5)) {
      const windowEnd = (Math.floor(now / LOGIN_WINDOW_MS) + 1) * LOGIN_WINDOW_MS;
      sendRateLimited(reply, request, Math.ceil((windowEnd - now) / 1000));
      return;
    }
    const body = bodyOf(request);
    const current = stringField(body, 'currentPassword');
    const next = stringField(body, 'newPassword');
    if (current !== account.password) {
      recordBucketFailure(state.passwordChangeFailures, account.id, now);
      throw ApiError.invalidCredentials();
    }
    if (next.length < 12 || next.length > 128 || next === account.password) {
      throw ApiError.validation();
    }
    account.password = next;
    account.credentialEpoch += 1;
    for (const [id, candidate] of state.sessions) {
      if (candidate.userId === account.id) {
        state.sessions.delete(id);
      }
    }
    const session = mintSession(state, account);
    setSessionCookie(reply, session, state.clock);
    return successEnvelope({ csrfToken: session.csrfToken });
  });

  app.get('/api/test-sessions', async (request) => {
    const row = sessionRowOf(request);
    if (row === undefined) {
      throw ApiError.unauthenticated();
    }
    const list = [...state.sessions.values()]
      .filter((candidate) => candidate.userId === row.userId)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((candidate) => ({
        id: candidate.rowId,
        deviceLabel: 'Test device',
        userAgent: 'test-agent',
        createdIp: null,
        lastSeenIp: null,
        createdAt: candidate.createdAt,
        lastSeenAt: candidate.lastSeenAt,
        absoluteExpiresAt: candidate.absoluteExpiresAt,
        isCurrent: candidate.rowId === row.rowId,
      }));
    return successEnvelope(list);
  });

  app.delete('/api/test-sessions/:id', async (request, reply) => {
    const row = sessionRowOf(request);
    if (row === undefined) {
      throw ApiError.unauthenticated();
    }
    const params = request.params as { id: string };
    const target = [...state.sessions.values()].find(
      (candidate) => candidate.rowId === params.id && candidate.userId === row.userId,
    );
    if (target === undefined) {
      throw ApiError.notFound();
    }
    state.sessions.delete(target.sessionId);
    if (target.sessionId === row.sessionId) {
      clearSessionCookie(reply);
    }
    return successEnvelope(null);
  });

  app.get('/api/test-me', async (request) => {
    const row = sessionRowOf(request);
    if (row === undefined) {
      throw ApiError.unauthenticated();
    }
    const account = state.accountsById.get(row.userId);
    if (account === undefined) {
      throw ApiError.unauthenticated();
    }
    return successEnvelope({
      id: account.id,
      email: account.email,
      role: account.role,
      totpEnabled: account.totpEnabled,
      sessionExpiresAt: row.absoluteExpiresAt,
    });
  });

  app.get('/api/test-csrf', async (request, reply) => {
    const row = sessionRowOf(request);
    if (row === undefined) {
      throw ApiError.unauthenticated();
    }
    reply.header('Cache-Control', 'no-store');
    return successEnvelope({ csrfToken: row.csrfToken });
  });

  app.post('/api/test-totp-enroll-start', async (request) => {
    if (!stepUpFresh(request)) {
      throw ApiError.stepUpRequired();
    }
    const row = sessionRowOf(request);
    if (row === undefined) {
      throw ApiError.unauthenticated();
    }
    const account = state.accountsById.get(row.userId);
    if (account === undefined) {
      throw ApiError.unauthenticated();
    }
    account.totpSecret = TOTP_SECRET_FIXTURE;
    return successEnvelope({
      otpauthUrl: `otpauth://totp/NoteGen:${account.email}?secret=${TOTP_SECRET_FIXTURE}&issuer=NoteGen`,
      secret: TOTP_SECRET_FIXTURE,
    });
  });

  function rotateCurrentKeepStepUp(request: FastifyRequest): FakeSession {
    const row = sessionRowOf(request);
    if (row === undefined) {
      throw ApiError.unauthenticated();
    }
    return rotateSession(state, row, row.stepUpAt);
  }

  function deleteOtherSessions(userId: string, keepSessionId: string): void {
    for (const [id, candidate] of state.sessions) {
      if (candidate.userId === userId && id !== keepSessionId) {
        state.sessions.delete(id);
      }
    }
  }

  app.post('/api/test-totp-enroll-confirm', async (request, reply) => {
    if (!stepUpFresh(request)) {
      throw ApiError.stepUpRequired();
    }
    const row = sessionRowOf(request);
    if (row === undefined) {
      throw ApiError.unauthenticated();
    }
    const account = state.accountsById.get(row.userId);
    if (account === undefined) {
      throw ApiError.unauthenticated();
    }
    const code = stringField(bodyOf(request), 'code');
    if (account.totpSecret === null || code !== expectedTotpCode(account.totpStep) || account.lastUsedStep === account.totpStep) {
      throw ApiError.invalidVerificationCode();
    }
    account.lastUsedStep = account.totpStep;
    account.totpEnabled = true;
    const rotated = rotateCurrentKeepStepUp(request);
    deleteOtherSessions(account.id, rotated.sessionId);
    setSessionCookie(reply, rotated, state.clock);
    return successEnvelope({ totpEnabled: true, csrfToken: rotated.csrfToken });
  });

  app.post('/api/test-totp-disable', async (request, reply) => {
    if (!stepUpFresh(request)) {
      throw ApiError.stepUpRequired();
    }
    const row = sessionRowOf(request);
    if (row === undefined) {
      throw ApiError.unauthenticated();
    }
    const account = state.accountsById.get(row.userId);
    if (account === undefined) {
      throw ApiError.unauthenticated();
    }
    const body = bodyOf(request);
    const code = stringField(body, 'code');
    const recoveryCode = stringField(body, 'recoveryCode');
    const codeOk = code !== '' && code === expectedTotpCode(account.totpStep) && account.lastUsedStep !== account.totpStep;
    const recoveryOk = recoveryCode !== '' && account.recoveryCodes.has(recoveryCode);
    if (!codeOk && !recoveryOk) {
      throw ApiError.invalidVerificationCode();
    }
    if (recoveryOk) {
      account.recoveryCodes.delete(recoveryCode);
    } else {
      account.lastUsedStep = account.totpStep;
    }
    account.totpEnabled = false;
    account.totpSecret = null;
    account.recoveryCodes.clear();
    const rotated = rotateCurrentKeepStepUp(request);
    deleteOtherSessions(account.id, rotated.sessionId);
    setSessionCookie(reply, rotated, state.clock);
    return successEnvelope({ totpEnabled: false, csrfToken: rotated.csrfToken });
  });

  app.post('/api/test-recovery-regenerate', async (request) => {
    if (!stepUpFresh(request)) {
      throw ApiError.stepUpRequired();
    }
    const row = sessionRowOf(request);
    if (row === undefined) {
      throw ApiError.unauthenticated();
    }
    const account = state.accountsById.get(row.userId);
    if (account === undefined) {
      throw ApiError.unauthenticated();
    }
    const code = stringField(bodyOf(request), 'code');
    if (!account.totpEnabled || code !== expectedTotpCode(account.totpStep) || account.lastUsedStep === account.totpStep) {
      throw ApiError.invalidVerificationCode();
    }
    account.lastUsedStep = account.totpStep;
    state.nextId += 1;
    const batch = state.nextId;
    account.recoveryCodes = new Set(Array.from({ length: 10 }, (_v, i) => `rc-batch-${batch}-code-${i + 1}`));
    return successEnvelope({ codes: [...account.recoveryCodes] });
  });

  app.get('/api/test-admin-users', async (request) => {
    const principal = getPrincipal(request);
    if (principal === undefined || principal.role !== 'admin') {
      throw ApiError.forbidden();
    }
    return successEnvelope(
      [...state.accountsById.values()].map((account) => ({
        id: account.id,
        email: account.email,
        role: account.role,
        status: account.status,
      })),
    );
  });

  function adminTarget(request: FastifyRequest): FakeAccount {
    const principal = getPrincipal(request);
    if (principal === undefined || principal.role !== 'admin') {
      throw ApiError.forbidden();
    }
    const params = request.params as { id: string };
    const target = state.accountsById.get(params.id);
    if (target === undefined) {
      throw ApiError.notFound();
    }
    return target;
  }

  // Disable bumps the epoch WITHOUT deleting session rows, so the
  // epoch check alone must kill the sessions (desain 3.5).
  app.post('/api/test-admin-users/:id/disable', async (request) => {
    const target = adminTarget(request);
    target.status = 'disabled';
    target.credentialEpoch += 1;
    return successEnvelope(null);
  });

  app.post('/api/test-admin-users/:id/restore', async (request) => {
    const target = adminTarget(request);
    target.status = 'active';
    target.credentialEpoch += 1;
    return successEnvelope(null);
  });

  // Admins never read another account's content (desain 2.3/9.4).
  app.get('/api/test-records/:id', async (request) => {
    const principal = getPrincipal(request);
    if (principal === undefined) {
      throw ApiError.unauthenticated();
    }
    const params = request.params as { id: string };
    const record = state.records.get(params.id);
    if (record === undefined || record.ownerId !== principal.userId) {
      throw ApiError.notFound();
    }
    return successEnvelope({ id: record.id, ownerId: record.ownerId });
  });

  return { app, state };
}

// --- Test helpers -----------------------------------------------------

interface LoginResult {
  sessionId: string;
  csrfToken: string;
  setCookie: string;
  sessionExpiresAt: number;
}

async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string,
  extraHeaders: Record<string, string> = {},
): Promise<LoginResult> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/test-login',
    headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', ...extraHeaders },
    payload: JSON.stringify({ email, password }),
  });
  expect(res.statusCode).toBe(200);
  const data = (res.json() as { data: Record<string, unknown> }).data;
  const sessionId = sessionIdFromSetCookie(res);
  expect(sessionId).not.toBeNull();
  const raw = res.headers['set-cookie'];
  expect(typeof raw).toBe('string');
  return {
    sessionId: sessionId as string,
    csrfToken: data['csrfToken'] as string,
    setCookie: raw as string,
    sessionExpiresAt: data['sessionExpiresAt'] as number,
  };
}

async function stepUpAs(app: FastifyInstance, login: LoginResult, password: string): Promise<LoginResult> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/test-step-up',
    headers: { ...mutationHeaders(login.sessionId, login.csrfToken), 'content-type': 'application/json' },
    payload: JSON.stringify({ password }),
  });
  expect(res.statusCode).toBe(200);
  const data = (res.json() as { data: Record<string, unknown> }).data;
  const sessionId = sessionIdFromSetCookie(res);
  expect(sessionId).not.toBeNull();
  const raw = res.headers['set-cookie'];
  return {
    sessionId: sessionId as string,
    csrfToken: data['csrfToken'] as string,
    setCookie: (typeof raw === 'string' ? raw : '') as string,
    sessionExpiresAt: login.sessionExpiresAt,
  };
}

function jsonMutation(
  app: FastifyInstance,
  method: 'POST' | 'DELETE',
  url: string,
  login: LoginResult,
  body: Record<string, unknown>,
): Promise<InjectResponse> {
  return app.inject({
    method,
    url,
    headers: { ...mutationHeaders(login.sessionId, login.csrfToken), 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

// --- Lockout ladder ---------------------------------------------------

describe('L2: progressive lockout ladder [reference harness, fake clock]', () => {
  async function failLogin(app: FastifyInstance, email: string, password: string, ip: string): Promise<InjectResponse> {
    return app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'x-test-ip': ip },
      payload: JSON.stringify({ email, password }),
    });
  }

  it('five failures answer 401; the sixth, even with the correct password, answers 429 with Retry-After 900', async () => {
    const { app } = await buildHarness();
    for (let i = 0; i < 5; i += 1) {
      const res = await failLogin(app, USER_EMAIL, 'fixture-wrong-password', '203.0.113.11');
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('invalid_credentials');
    }
    const locked = await failLogin(app, USER_EMAIL, USER_PASSWORD, '203.0.113.11');
    expect(locked.statusCode).toBe(429);
    expect(errorOf(locked).code).toBe('rate_limited');
    expect(errorOf(locked).retryable).toBe(true);
    expect(locked.headers['retry-after']).toBe('900');
    expect(locked.headers).not.toHaveProperty('x-ratelimit-limit');
    await app.close();
  });

  it('attempts during lockout do not extend it: lockedUntil and the failure count stay fixed', async () => {
    const { app, state } = await buildHarness();
    for (let i = 0; i < 5; i += 1) {
      await failLogin(app, USER_EMAIL, 'fixture-wrong-password', '203.0.113.12');
    }
    const row = state.lockouts.get('user-1');
    expect(row).toBeDefined();
    const lockedUntil = row?.lockedUntil;
    const failures = row?.consecutiveFailures;
    expect(lockedUntil).toBe(state.clock.now() + 15 * MINUTE_MS);
    for (let i = 0; i < 3; i += 1) {
      const res = await failLogin(app, USER_EMAIL, 'fixture-wrong-password', '203.0.113.12');
      expect(res.statusCode).toBe(429);
    }
    expect(state.lockouts.get('user-1')?.lockedUntil).toBe(lockedUntil);
    expect(state.lockouts.get('user-1')?.consecutiveFailures).toBe(failures);
    await app.close();
  });

  it('the ladder climbs 15m, 1h, 4h, 24h, then caps at 24h, keeping the level across expiries', async () => {
    const { app, state } = await buildHarness();
    const expected = ['900', '3600', '14400', '86400', '86400'];
    for (const retryAfter of expected) {
      for (let i = 0; i < 5; i += 1) {
        const res = await failLogin(app, USER_EMAIL, 'fixture-wrong-password', '203.0.113.13');
        expect(res.statusCode).toBe(401);
      }
      const locked = await failLogin(app, USER_EMAIL, USER_PASSWORD, '203.0.113.13');
      expect(locked.statusCode).toBe(429);
      expect(locked.headers['retry-after']).toBe(retryAfter);
      state.clock.advance(Number(retryAfter) * 1000 + 1000);
      // A probe after expiry must see failures reset but the level kept.
      expect(state.lockouts.get('user-1')?.lockoutLevel).toBeGreaterThan(0);
    }
    await app.close();
  });

  it('a successful login resets the ladder fully: the next lockout is back to 15 minutes', async () => {
    const { app, state } = await buildHarness();
    for (let i = 0; i < 5; i += 1) {
      await failLogin(app, USER_EMAIL, 'fixture-wrong-password', '203.0.113.14');
    }
    state.clock.advance(15 * MINUTE_MS + 1000);
    await loginAs(app, USER_EMAIL, USER_PASSWORD, { 'x-test-ip': '203.0.113.14' });
    expect(state.lockouts.has('user-1')).toBe(false);
    for (let i = 0; i < 5; i += 1) {
      const res = await failLogin(app, USER_EMAIL, 'fixture-wrong-password', '203.0.113.14');
      expect(res.statusCode).toBe(401);
    }
    const locked = await failLogin(app, USER_EMAIL, USER_PASSWORD, '203.0.113.14');
    expect(locked.headers['retry-after']).toBe('900');
    await app.close();
  });

  it('lockout never kills a valid session: the session keeps serving while login is blocked', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD, { 'x-test-ip': '203.0.113.15' });
    for (let i = 0; i < 5; i += 1) {
      await failLogin(app, USER_EMAIL, 'fixture-wrong-password', '203.0.113.15');
    }
    const blocked = await failLogin(app, USER_EMAIL, USER_PASSWORD, '203.0.113.15');
    expect(blocked.statusCode).toBe(429);
    const served = await app.inject({
      method: 'GET',
      url: '/api/test-me',
      headers: sessionCookieHeader(login.sessionId),
    });
    expect(served.statusCode).toBe(200);
    await app.close();
  });

  it('lockout applies from any IP: failures from one IP lock the account for another IP', async () => {
    const { app } = await buildHarness();
    for (let i = 0; i < 5; i += 1) {
      await failLogin(app, USER_EMAIL, 'fixture-wrong-password', '203.0.113.16');
    }
    const other = await failLogin(app, USER_EMAIL, USER_PASSWORD, '198.51.100.9');
    expect(other.statusCode).toBe(429);
    await app.close();
  });

  it('the per-account-IP bucket blocks unknown emails too: 5 failures, then 429 without a lockout row', async () => {
    const { app, state } = await buildHarness();
    for (let i = 0; i < 5; i += 1) {
      const res = await failLogin(app, 'ghost@example.invalid', 'fixture-wrong-password', '203.0.113.17');
      expect(res.statusCode).toBe(401);
    }
    const blocked = await failLogin(app, 'ghost@example.invalid', 'fixture-wrong-password', '203.0.113.17');
    expect(blocked.statusCode).toBe(429);
    expect(state.lockouts.size).toBe(0);
    await app.close();
  });

  it('the cross-account IP bucket blocks spraying: 20 failures across distinct emails, then 429', async () => {
    const { app } = await buildHarness();
    for (let i = 0; i < 20; i += 1) {
      const res = await failLogin(app, `spray-${i}@example.invalid`, 'fixture-wrong-password', '203.0.113.18');
      expect(res.statusCode).toBe(401);
    }
    const blocked = await failLogin(app, 'spray-20@example.invalid', 'fixture-wrong-password', '203.0.113.18');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    await app.close();
  });

  it('a success between failures does not erase the bucket count, but the 429 then comes from the bucket, not the lockout', async () => {
    const { app, state } = await buildHarness();
    const ip = '203.0.113.19';
    for (let i = 0; i < 4; i += 1) {
      await failLogin(app, USER_EMAIL, 'fixture-wrong-password', ip);
    }
    await loginAs(app, USER_EMAIL, USER_PASSWORD, { 'x-test-ip': ip });
    expect(state.lockouts.has('user-1')).toBe(false);
    const fifth = await failLogin(app, USER_EMAIL, 'fixture-wrong-password', ip);
    expect(fifth.statusCode).toBe(401);
    const blocked = await failLogin(app, USER_EMAIL, 'fixture-wrong-password', ip);
    expect(blocked.statusCode).toBe(429);
    // Only one consecutive failure since the success: no lockout row
    // with a live lock; the bucket is what blocked.
    expect(state.lockouts.get('user-1')?.lockedUntil ?? null).toBeNull();
    await app.close();
  });

  it('buckets reset in the next window: failures in a new 15 minute window answer 401 again', async () => {
    const { app, state } = await buildHarness();
    for (let i = 0; i < 5; i += 1) {
      await failLogin(app, 'ghost2@example.invalid', 'fixture-wrong-password', '203.0.113.20');
    }
    const blocked = await failLogin(app, 'ghost2@example.invalid', 'fixture-wrong-password', '203.0.113.20');
    expect(blocked.statusCode).toBe(429);
    state.clock.advance(15 * MINUTE_MS + 1000);
    const again = await failLogin(app, 'ghost2@example.invalid', 'fixture-wrong-password', '203.0.113.20');
    expect(again.statusCode).toBe(401);
    await app.close();
  });
});

// --- Fixation and rotation --------------------------------------------

describe('L2: session fixation and rotation [reference harness, real hook]', () => {
  it('a pre-login cookie never becomes the authenticated session: login always mints a fresh id', async () => {
    const { app } = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: {
        origin: CANONICAL_ORIGIN,
        'content-type': 'application/json',
        cookie: 'notegen_session=attacker-planted-id',
      },
      payload: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
    });
    expect(res.statusCode).toBe(200);
    const issued = sessionIdFromSetCookie(res);
    expect(issued).not.toBeNull();
    expect(issued).not.toBe('attacker-planted-id');
    const planted = await app.inject({
      method: 'GET',
      url: '/api/test-me',
      headers: sessionCookieHeader('attacker-planted-id'),
    });
    expect(planted.statusCode).toBe(401);
    await app.close();
  });

  it('two logins mint two different session ids and two different CSRF tokens, both valid', async () => {
    const { app } = await buildHarness();
    const first = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const second = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.csrfToken).not.toBe(first.csrfToken);
    for (const login of [first, second]) {
      const res = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(login.sessionId) });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it('step-up rotation kills the old session id at once and rotates the CSRF token with it', async () => {
    const { app } = await buildHarness();
    const before = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const after = await stepUpAs(app, before, USER_PASSWORD);
    expect(after.sessionId).not.toBe(before.sessionId);
    expect(after.csrfToken).not.toBe(before.csrfToken);
    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/test-me',
      headers: sessionCookieHeader(before.sessionId),
    });
    expect(oldSession.statusCode).toBe(401);
    const oldCsrf = await app.inject({
      method: 'POST',
      url: '/api/test-logout',
      headers: mutationHeaders(after.sessionId, before.csrfToken),
    });
    expect(oldCsrf.statusCode).toBe(403);
    expect(errorOf(oldCsrf).code).toBe('csrf_invalid');
    const fresh = await app.inject({
      method: 'POST',
      url: '/api/test-logout',
      headers: mutationHeaders(after.sessionId, after.csrfToken),
    });
    expect(fresh.statusCode).toBe(200);
    await app.close();
  });

  it('step-up rotation preserves the absolute expiry and createdAt: rotation is not lifetime extension', async () => {
    const { app, state } = await buildHarness();
    const before = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const oldRow = state.sessions.get(before.sessionId);
    expect(oldRow).toBeDefined();
    state.clock.advance(HOUR_MS);
    const after = await stepUpAs(app, before, USER_PASSWORD);
    const newRow = state.sessions.get(after.sessionId);
    expect(newRow).toBeDefined();
    expect(newRow?.absoluteExpiresAt).toBe(oldRow?.absoluteExpiresAt);
    expect(newRow?.createdAt).toBe(oldRow?.createdAt);
    expect(newRow?.stepUpAt).toBe(state.clock.now());
    expect(after.sessionExpiresAt).toBe(before.sessionExpiresAt);
    await app.close();
  });

  it('a CSRF token from another session never works, even for the same account', async () => {
    const { app } = await buildHarness();
    const first = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const second = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-logout',
      headers: mutationHeaders(first.sessionId, second.csrfToken),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('csrf_invalid');
    await app.close();
  });

  it('an idle session dies after 24 hours without activity, and the row is removed', async () => {
    const { app, state } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    state.clock.advance(24 * HOUR_MS + 1000);
    const res = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(login.sessionId) });
    expect(res.statusCode).toBe(401);
    expect(state.sessions.has(login.sessionId)).toBe(false);
    await app.close();
  });

  it('activity refreshes idle time but never extends the 30 day absolute expiry', async () => {
    const { app, state } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    for (let day = 0; day < 29; day += 1) {
      state.clock.advance(DAY_MS);
      const res = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(login.sessionId) });
      expect(res.statusCode).toBe(200);
    }
    state.clock.advance(DAY_MS + 1000);
    const expired = await app.inject({
      method: 'GET',
      url: '/api/test-me',
      headers: sessionCookieHeader(login.sessionId),
    });
    expect(expired.statusCode).toBe(401);
    expect(state.sessions.has(login.sessionId)).toBe(false);
    await app.close();
  });
});

// --- Epoch ------------------------------------------------------------

describe('L2: credential epoch revokes old sessions [reference harness, real hook]', () => {
  it('an epoch bump alone kills every old session even when the rows still exist', async () => {
    const { app, state } = await buildHarness();
    const first = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const second = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const account = state.accountsById.get('user-1');
    expect(account).toBeDefined();
    if (account !== undefined) {
      account.credentialEpoch += 1;
    }
    expect(state.sessions.size).toBe(2);
    for (const login of [first, second]) {
      const res = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(login.sessionId) });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('unauthenticated');
    }
    await app.close();
  });

  it('a session minted after the bump passes: the new epoch matches', async () => {
    const { app, state } = await buildHarness();
    const before = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const account = state.accountsById.get('user-1');
    if (account !== undefined) {
      account.credentialEpoch += 1;
    }
    const denied = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(before.sessionId) });
    expect(denied.statusCode).toBe(401);
    const after = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const served = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(after.sessionId) });
    expect(served.statusCode).toBe(200);
    expect(state.sessions.get(after.sessionId)?.sessionEpoch).toBe(account?.credentialEpoch);
    await app.close();
  });

  it('the epoch only ever increases across password change and logout-all', async () => {
    const { app, state } = await buildHarness();
    const account = state.accountsById.get('user-1');
    expect(account?.credentialEpoch).toBe(0);
    const first = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const changed = await jsonMutation(app, 'POST', '/api/test-password-change', first, {
      currentPassword: USER_PASSWORD,
      newPassword: 'fixture-user-password-2',
    });
    expect(changed.statusCode).toBe(200);
    expect(account?.credentialEpoch).toBe(1);
    const second = await loginAs(app, USER_EMAIL, 'fixture-user-password-2');
    const stepped = await stepUpAs(app, second, 'fixture-user-password-2');
    const all = await app.inject({
      method: 'POST',
      url: '/api/test-logout-all',
      headers: mutationHeaders(stepped.sessionId, stepped.csrfToken),
    });
    expect(all.statusCode).toBe(200);
    expect(account?.credentialEpoch).toBe(2);
    await app.close();
  });

  it('ordinary login and single logout never bump the epoch', async () => {
    const { app, state } = await buildHarness();
    const account = state.accountsById.get('user-1');
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    expect(account?.credentialEpoch).toBe(0);
    const out = await app.inject({
      method: 'POST',
      url: '/api/test-logout',
      headers: mutationHeaders(login.sessionId, login.csrfToken),
    });
    expect(out.statusCode).toBe(200);
    expect(account?.credentialEpoch).toBe(0);
    await app.close();
  });
});

// --- Logout -----------------------------------------------------------

describe('L2: logout and logout-all [reference harness, real hook]', () => {
  it('logout kills only the current session; other devices keep working', async () => {
    const { app } = await buildHarness();
    const first = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const second = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const out = await app.inject({
      method: 'POST',
      url: '/api/test-logout',
      headers: mutationHeaders(first.sessionId, first.csrfToken),
    });
    expect(out.statusCode).toBe(200);
    const dead = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(first.sessionId) });
    expect(dead.statusCode).toBe(401);
    const alive = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(second.sessionId) });
    expect(alive.statusCode).toBe(200);
    await app.close();
  });

  it('logout clears the cookie with Max-Age=0 and the same attributes used when setting it', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    expect(login.setCookie).toContain('Path=/');
    expect(login.setCookie).toContain('HttpOnly');
    expect(login.setCookie).toContain('SameSite=Lax');
    const out = await app.inject({
      method: 'POST',
      url: '/api/test-logout',
      headers: mutationHeaders(login.sessionId, login.csrfToken),
    });
    expect(out.statusCode).toBe(200);
    const cleared = out.headers['set-cookie'];
    expect(typeof cleared).toBe('string');
    expect(cleared as string).toBe('notegen_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    await app.close();
  });

  it('a second logout with the same dead session answers 401: there is nothing left to revoke', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const first = await app.inject({
      method: 'POST',
      url: '/api/test-logout',
      headers: mutationHeaders(login.sessionId, login.csrfToken),
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/test-logout',
      headers: mutationHeaders(login.sessionId, login.csrfToken),
    });
    expect(second.statusCode).toBe(401);
    expect(errorOf(second).code).toBe('unauthenticated');
    await app.close();
  });

  it('logout-all kills every session of the account, including the current one, and bumps the epoch', async () => {
    const { app, state } = await buildHarness();
    const first = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const second = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const stepped = await stepUpAs(app, first, USER_PASSWORD);
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-logout-all',
      headers: mutationHeaders(stepped.sessionId, stepped.csrfToken),
    });
    expect(res.statusCode).toBe(200);
    expect(state.accountsById.get('user-1')?.credentialEpoch).toBe(1);
    for (const id of [first.sessionId, second.sessionId, stepped.sessionId]) {
      const denied = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(id) });
      expect(denied.statusCode).toBe(401);
    }
    const cleared = res.headers['set-cookie'];
    expect(cleared as string).toContain('Max-Age=0');
    await app.close();
  });

  it('logout-all leaves other accounts sessions untouched', async () => {
    const { app } = await buildHarness();
    const mine = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const theirs = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const stepped = await stepUpAs(app, mine, USER_PASSWORD);
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-logout-all',
      headers: mutationHeaders(stepped.sessionId, stepped.csrfToken),
    });
    expect(res.statusCode).toBe(200);
    const alive = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(theirs.sessionId) });
    expect(alive.statusCode).toBe(200);
    await app.close();
  });

  it('logout-all without a session answers 401, never 403', async () => {
    const { app } = await buildHarness();
    const res = await app.inject({ method: 'POST', url: '/api/test-logout-all' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthenticated');
    await app.close();
  });

  it('logout-all with a valid session but no CSRF token answers 403 csrf_invalid', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-logout-all',
      headers: { ...sessionCookieHeader(login.sessionId), origin: CANONICAL_ORIGIN },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('csrf_invalid');
    await app.close();
  });
});

// --- Step-up ----------------------------------------------------------

describe('L2: step-up gating and freshness [reference harness, real hook]', () => {
  it('logout-all without step-up answers 403 step_up_required and revokes nothing', async () => {
    const { app, state } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-logout-all',
      headers: mutationHeaders(login.sessionId, login.csrfToken),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('step_up_required');
    expect(state.sessions.has(login.sessionId)).toBe(true);
    expect(state.accountsById.get('user-1')?.credentialEpoch).toBe(0);
    await app.close();
  });

  it('TOTP enroll, disable, and recovery regeneration all require step-up', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    for (const url of ['/api/test-totp-enroll-start', '/api/test-totp-disable', '/api/test-recovery-regenerate']) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { ...mutationHeaders(login.sessionId, login.csrfToken), 'content-type': 'application/json' },
        payload: JSON.stringify({ code: '100100' }),
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('step_up_required');
    }
    await app.close();
  });

  it('a step-up older than 15 minutes no longer authorizes logout-all', async () => {
    const { app, state } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const stepped = await stepUpAs(app, login, USER_PASSWORD);
    state.clock.advance(15 * MINUTE_MS + 1000);
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-logout-all',
      headers: mutationHeaders(stepped.sessionId, stepped.csrfToken),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('step_up_required');
    await app.close();
  });

  it('a step-up within 15 minutes authorizes logout-all', async () => {
    const { app, state } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const stepped = await stepUpAs(app, login, USER_PASSWORD);
    state.clock.advance(14 * MINUTE_MS);
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-logout-all',
      headers: mutationHeaders(stepped.sessionId, stepped.csrfToken),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('step-up failure answers the generic 401 and never touches the login lockout', async () => {
    const { app, state } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    for (let i = 0; i < 5; i += 1) {
      const res = await jsonMutation(app, 'POST', '/api/test-step-up', login, { password: 'fixture-wrong-password' });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('invalid_credentials');
    }
    expect(state.lockouts.has('user-1')).toBe(false);
    const still = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(login.sessionId) });
    expect(still.statusCode).toBe(200);
    await app.close();
  });

  it('step-up failures are rate limited on their own bucket: the sixth answers 429', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    for (let i = 0; i < 5; i += 1) {
      const res = await jsonMutation(app, 'POST', '/api/test-step-up', login, { password: 'fixture-wrong-password' });
      expect(res.statusCode).toBe(401);
    }
    const limited = await jsonMutation(app, 'POST', '/api/test-step-up', login, { password: 'fixture-wrong-password' });
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();
    await app.close();
  });

  it('step-up for a TOTP account also requires the current code', async () => {
    const { app, state } = await buildHarness();
    // Log the TOTP account in through both steps.
    const step1 = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-1' },
      payload: JSON.stringify({ email: TOTP_EMAIL, password: TOTP_PASSWORD }),
    });
    expect(step1.statusCode).toBe(202);
    const challengeToken = (step1.json() as { data: { challengeToken: string } }).data.challengeToken;
    const step2 = await app.inject({
      method: 'POST',
      url: '/api/test-login-totp',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-1' },
      payload: JSON.stringify({ challengeToken, code: expectedTotpCode(100) }),
    });
    expect(step2.statusCode).toBe(200);
    const sessionId = sessionIdFromSetCookie(step2);
    const csrfToken = (step2.json() as { data: { csrfToken: string } }).data.csrfToken;
    expect(sessionId).not.toBeNull();
    const login: LoginResult = { sessionId: sessionId as string, csrfToken, setCookie: '', sessionExpiresAt: 0 };
    const noCode = await jsonMutation(app, 'POST', '/api/test-step-up', login, { password: TOTP_PASSWORD });
    expect(noCode.statusCode).toBe(401);
    expect(errorOf(noCode).code).toBe('invalid_credentials');
    // The step 100 code was consumed by login, so step-up needs the
    // next step's code.
    const account = state.accountsById.get('user-totp');
    if (account !== undefined) {
      account.totpStep = 101;
    }
    const withCode = await jsonMutation(app, 'POST', '/api/test-step-up', login, {
      password: TOTP_PASSWORD,
      code: expectedTotpCode(101),
    });
    expect(withCode.statusCode).toBe(200);
    await app.close();
  });
});

// --- Password change --------------------------------------------------

describe('L2: password change [reference harness, real hook]', () => {
  it('a wrong current password answers the generic 401 and never touches the login lockout', async () => {
    const { app, state } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const res = await jsonMutation(app, 'POST', '/api/test-password-change', login, {
      currentPassword: 'fixture-wrong-password',
      newPassword: 'fixture-user-password-2',
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('invalid_credentials');
    expect(state.lockouts.has('user-1')).toBe(false);
    await app.close();
  });

  it('a new password equal to the old one answers 400 validation_failed', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const res = await jsonMutation(app, 'POST', '/api/test-password-change', login, {
      currentPassword: USER_PASSWORD,
      newPassword: USER_PASSWORD,
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('validation_failed');
    await app.close();
  });

  it('a new password shorter than 12 characters answers 400 validation_failed', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const res = await jsonMutation(app, 'POST', '/api/test-password-change', login, {
      currentPassword: USER_PASSWORD,
      newPassword: 'short',
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('validation_failed');
    await app.close();
  });

  it('a successful change kills other sessions, rotates the current one with a fresh absolute expiry, and bumps the epoch', async () => {
    const { app, state } = await buildHarness();
    const first = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const second = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const oldRow = state.sessions.get(first.sessionId);
    state.clock.advance(HOUR_MS);
    const res = await jsonMutation(app, 'POST', '/api/test-password-change', first, {
      currentPassword: USER_PASSWORD,
      newPassword: 'fixture-user-password-2',
    });
    expect(res.statusCode).toBe(200);
    expect(state.accountsById.get('user-1')?.credentialEpoch).toBe(1);
    const newId = sessionIdFromSetCookie(res);
    expect(newId).not.toBeNull();
    expect(newId).not.toBe(first.sessionId);
    const newRow = state.sessions.get(newId as string);
    expect(newRow?.absoluteExpiresAt).toBeGreaterThan(oldRow?.absoluteExpiresAt ?? 0);
    for (const id of [first.sessionId, second.sessionId]) {
      const denied = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(id) });
      expect(denied.statusCode).toBe(401);
    }
    const served = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(newId as string) });
    expect(served.statusCode).toBe(200);
    await app.close();
  });

  it('after a change, the old password fails and the new password works', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const res = await jsonMutation(app, 'POST', '/api/test-password-change', login, {
      currentPassword: USER_PASSWORD,
      newPassword: 'fixture-user-password-2',
    });
    expect(res.statusCode).toBe(200);
    const old = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'x-test-ip': '203.0.113.31' },
      payload: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
    });
    expect(old.statusCode).toBe(401);
    await loginAs(app, USER_EMAIL, 'fixture-user-password-2', { 'x-test-ip': '203.0.113.31' });
    await app.close();
  });
});

// --- Session listing and revocation -----------------------------------

describe('L2: session listing and per-device revocation [reference harness, real hook]', () => {
  it('the session list never contains a session id, a hash, or a CSRF token', async () => {
    const { app } = await buildHarness();
    const first = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const second = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const res = await app.inject({ method: 'GET', url: '/api/test-sessions', headers: sessionCookieHeader(first.sessionId) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(first.sessionId);
    expect(res.body).not.toContain(second.sessionId);
    expect(res.body).not.toContain(first.csrfToken);
    expect(res.body).not.toContain(second.csrfToken);
    expect(res.body).not.toContain('csrf_token_hash');
    expect(res.body).not.toContain('session_hash');
    const list = (res.json() as { data: Array<Record<string, unknown>> }).data;
    expect(list).toHaveLength(2);
    expect(list.filter((entry) => entry['isCurrent'] === true)).toHaveLength(1);
    await app.close();
  });

  it('revoking another device session works and leaves the current session alive', async () => {
    const { app } = await buildHarness();
    const first = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const second = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const listRes = await app.inject({ method: 'GET', url: '/api/test-sessions', headers: sessionCookieHeader(first.sessionId) });
    const list = (listRes.json() as { data: Array<{ id: string; isCurrent: boolean }> }).data;
    const other = list.find((entry) => entry.isCurrent === false);
    expect(other).toBeDefined();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/test-sessions/${other?.id ?? ''}`,
      headers: mutationHeaders(first.sessionId, first.csrfToken),
    });
    expect(res.statusCode).toBe(200);
    const dead = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(second.sessionId) });
    expect(dead.statusCode).toBe(401);
    const alive = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(first.sessionId) });
    expect(alive.statusCode).toBe(200);
    await app.close();
  });

  it('revoking an unknown id and revoking another account session id yield identical 404 bodies', async () => {
    const { app } = await buildHarness();
    const mine = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const theirs = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const theirList = await app.inject({
      method: 'GET',
      url: '/api/test-sessions',
      headers: sessionCookieHeader(theirs.sessionId),
    });
    const theirId = ((theirList.json() as { data: Array<{ id: string }> }).data[0]?.id ?? 'row-missing') as string;
    const denials: string[] = [];
    for (const id of ['row-unknown', theirId]) {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/test-sessions/${id}`,
        headers: mutationHeaders(mine.sessionId, mine.csrfToken),
      });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('not_found');
      denials.push(normalizedDenial(res));
    }
    expect(denials[1]).toBe(denials[0]);
    const alive = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(theirs.sessionId) });
    expect(alive.statusCode).toBe(200);
    await app.close();
  });

  it('revoking the current session also clears the cookie', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const listRes = await app.inject({ method: 'GET', url: '/api/test-sessions', headers: sessionCookieHeader(login.sessionId) });
    const ownId = ((listRes.json() as { data: Array<{ id: string }> }).data[0]?.id ?? '') as string;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/test-sessions/${ownId}`,
      headers: mutationHeaders(login.sessionId, login.csrfToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie'] as string).toContain('Max-Age=0');
    await app.close();
  });

  it('a second revoke of the same id answers 404', async () => {
    const { app } = await buildHarness();
    const first = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const listRes = await app.inject({ method: 'GET', url: '/api/test-sessions', headers: sessionCookieHeader(first.sessionId) });
    const list = (listRes.json() as { data: Array<{ id: string; isCurrent: boolean }> }).data;
    const other = list.find((entry) => entry.isCurrent === false);
    const url = `/api/test-sessions/${other?.id ?? ''}`;
    const ok = await app.inject({ method: 'DELETE', url, headers: mutationHeaders(first.sessionId, first.csrfToken) });
    expect(ok.statusCode).toBe(200);
    const again = await app.inject({ method: 'DELETE', url, headers: mutationHeaders(first.sessionId, first.csrfToken) });
    expect(again.statusCode).toBe(404);
    await app.close();
  });
});

// --- TOTP lifecycle ---------------------------------------------------

describe('L2: TOTP enroll, disable, and recovery codes [reference harness, real hook]', () => {
  it('enroll confirm kills other sessions, rotates the current one, and does not bump the epoch', async () => {
    const { app, state } = await buildHarness();
    const first = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const second = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const stepped = await stepUpAs(app, first, USER_PASSWORD);
    const start = await app.inject({
      method: 'POST',
      url: '/api/test-totp-enroll-start',
      headers: mutationHeaders(stepped.sessionId, stepped.csrfToken),
    });
    expect(start.statusCode).toBe(200);
    const confirm = await jsonMutation(app, 'POST', '/api/test-totp-enroll-confirm', stepped, { code: expectedTotpCode(100) });
    expect(confirm.statusCode).toBe(200);
    expect(state.accountsById.get('user-1')?.totpEnabled).toBe(true);
    expect(state.accountsById.get('user-1')?.credentialEpoch).toBe(0);
    const dead = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(second.sessionId) });
    expect(dead.statusCode).toBe(401);
    const rotatedId = sessionIdFromSetCookie(confirm);
    expect(rotatedId).not.toBeNull();
    expect(rotatedId).not.toBe(stepped.sessionId);
    const alive = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(rotatedId as string) });
    expect(alive.statusCode).toBe(200);
    await app.close();
  });

  it('enroll confirm with a wrong code answers 401 and leaves TOTP disabled', async () => {
    const { app, state } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const stepped = await stepUpAs(app, login, USER_PASSWORD);
    await app.inject({
      method: 'POST',
      url: '/api/test-totp-enroll-start',
      headers: mutationHeaders(stepped.sessionId, stepped.csrfToken),
    });
    const confirm = await jsonMutation(app, 'POST', '/api/test-totp-enroll-confirm', stepped, { code: '000000' });
    expect(confirm.statusCode).toBe(401);
    expect(errorOf(confirm).code).toBe('invalid_verification_code');
    expect(state.accountsById.get('user-1')?.totpEnabled).toBe(false);
    await app.close();
  });

  it('disable with a recovery code consumes that code and clears the whole recovery set', async () => {
    const { app, state } = await buildHarness();
    const account = state.accountsById.get('user-totp');
    expect(account?.recoveryCodes.size).toBe(3);
    // Log in with a recovery code so the TOTP step is consumed first.
    const step1 = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-2' },
      payload: JSON.stringify({ email: TOTP_EMAIL, password: TOTP_PASSWORD }),
    });
    expect(step1.statusCode).toBe(202);
    const challengeToken = (step1.json() as { data: { challengeToken: string } }).data.challengeToken;
    const step2 = await app.inject({
      method: 'POST',
      url: '/api/test-login-totp',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-2' },
      payload: JSON.stringify({ challengeToken, recoveryCode: 'rc-test-code-0001' }),
    });
    expect(step2.statusCode).toBe(200);
    expect(account?.recoveryCodes.has('rc-test-code-0001')).toBe(false);
    const sessionId = sessionIdFromSetCookie(step2);
    const csrfToken = (step2.json() as { data: { csrfToken: string } }).data.csrfToken;
    const login: LoginResult = { sessionId: sessionId as string, csrfToken, setCookie: '', sessionExpiresAt: 0 };
    // Step-up for a TOTP account needs the code; advance the step so a
    // fresh code exists.
    if (account !== undefined) {
      account.totpStep = 101;
    }
    const steppedRes = await app.inject({
      method: 'POST',
      url: '/api/test-step-up',
      headers: { ...mutationHeaders(login.sessionId, login.csrfToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ password: TOTP_PASSWORD, code: expectedTotpCode(101) }),
    });
    expect(steppedRes.statusCode).toBe(200);
    const steppedId = sessionIdFromSetCookie(steppedRes);
    const steppedCsrf = (steppedRes.json() as { data: { csrfToken: string } }).data.csrfToken;
    const stepped: LoginResult = { sessionId: steppedId as string, csrfToken: steppedCsrf, setCookie: '', sessionExpiresAt: 0 };
    if (account !== undefined) {
      account.totpStep = 102;
    }
    const disable = await jsonMutation(app, 'POST', '/api/test-totp-disable', stepped, {
      recoveryCode: 'rc-test-code-0002',
    });
    expect(disable.statusCode).toBe(200);
    expect(account?.totpEnabled).toBe(false);
    expect(account?.recoveryCodes.size).toBe(0);
    expect(account?.totpSecret).toBeNull();
    await app.close();
  });

  it('recovery regeneration replaces the whole batch and returns exactly 10 codes once', async () => {
    const { app, state } = await buildHarness();
    const account = state.accountsById.get('user-totp');
    const oldCodes = new Set(account?.recoveryCodes);
    // Log in with the TOTP code, then step up on the next step.
    const step1 = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-3' },
      payload: JSON.stringify({ email: TOTP_EMAIL, password: TOTP_PASSWORD }),
    });
    const challengeToken = (step1.json() as { data: { challengeToken: string } }).data.challengeToken;
    const step2 = await app.inject({
      method: 'POST',
      url: '/api/test-login-totp',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-3' },
      payload: JSON.stringify({ challengeToken, code: expectedTotpCode(100) }),
    });
    expect(step2.statusCode).toBe(200);
    const login: LoginResult = {
      sessionId: sessionIdFromSetCookie(step2) as string,
      csrfToken: (step2.json() as { data: { csrfToken: string } }).data.csrfToken,
      setCookie: '',
      sessionExpiresAt: 0,
    };
    if (account !== undefined) {
      account.totpStep = 101;
    }
    const steppedRes = await app.inject({
      method: 'POST',
      url: '/api/test-step-up',
      headers: { ...mutationHeaders(login.sessionId, login.csrfToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ password: TOTP_PASSWORD, code: expectedTotpCode(101) }),
    });
    expect(steppedRes.statusCode).toBe(200);
    const stepped: LoginResult = {
      sessionId: sessionIdFromSetCookie(steppedRes) as string,
      csrfToken: (steppedRes.json() as { data: { csrfToken: string } }).data.csrfToken,
      setCookie: '',
      sessionExpiresAt: 0,
    };
    if (account !== undefined) {
      account.totpStep = 102;
    }
    const regen = await jsonMutation(app, 'POST', '/api/test-recovery-regenerate', stepped, {
      code: expectedTotpCode(102),
    });
    expect(regen.statusCode).toBe(200);
    const codes = (regen.json() as { data: { codes: string[] } }).data.codes;
    expect(codes).toHaveLength(10);
    for (const old of oldCodes) {
      expect(codes).not.toContain(old);
      expect(account?.recoveryCodes.has(old)).toBe(false);
    }
    await app.close();
  });

  it('a TOTP code cannot be replayed at the same step: the second use answers 401', async () => {
    const { app, state } = await buildHarness();
    const account = state.accountsById.get('user-totp');
    const attempt = async (): Promise<InjectResponse> => {
      const step1 = await app.inject({
        method: 'POST',
        url: '/api/test-login',
        headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-4' },
        payload: JSON.stringify({ email: TOTP_EMAIL, password: TOTP_PASSWORD }),
      });
      expect(step1.statusCode).toBe(202);
      const challengeToken = (step1.json() as { data: { challengeToken: string } }).data.challengeToken;
      return app.inject({
        method: 'POST',
        url: '/api/test-login-totp',
        headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-4' },
        payload: JSON.stringify({ challengeToken, code: expectedTotpCode(100) }),
      });
    };
    const first = await attempt();
    expect(first.statusCode).toBe(200);
    expect(account?.lastUsedStep).toBe(100);
    const replay = await attempt();
    expect(replay.statusCode).toBe(401);
    expect(errorOf(replay).code).toBe('invalid_verification_code');
    await app.close();
  });
});

// --- TOTP login step edges --------------------------------------------

describe('L2: TOTP login challenge edges [reference harness, fake clock]', () => {
  async function startChallenge(app: FastifyInstance, agent: string): Promise<string> {
    const step1 = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': agent },
      payload: JSON.stringify({ email: TOTP_EMAIL, password: TOTP_PASSWORD }),
    });
    expect(step1.statusCode).toBe(202);
    expect(step1.headers['set-cookie']).toBeUndefined();
    return (step1.json() as { data: { challengeToken: string } }).data.challengeToken;
  }

  it('the password step sets no session cookie: the challenge alone grants nothing', async () => {
    const { app } = await buildHarness();
    const token = await startChallenge(app, 'test-agent-5');
    expect(token.startsWith('challenge-')).toBe(true);
    const probe = await app.inject({
      method: 'GET',
      url: '/api/test-me',
      headers: { cookie: `notegen_session=${token}` },
    });
    expect(probe.statusCode).toBe(401);
    await app.close();
  });

  it('an expired challenge answers the same 401 as a wrong code, and is deleted', async () => {
    const { app, state } = await buildHarness();
    const token = await startChallenge(app, 'test-agent-6');
    state.clock.advance(CHALLENGE_MS + 1000);
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-login-totp',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-6' },
      payload: JSON.stringify({ challengeToken: token, code: expectedTotpCode(100) }),
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('invalid_verification_code');
    expect(state.challenges.has(token)).toBe(false);
    await app.close();
  });

  it('five wrong codes delete the challenge, and the failures count toward the login lockout', async () => {
    const { app, state } = await buildHarness();
    const token = await startChallenge(app, 'test-agent-7');
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/test-login-totp',
        headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-7' },
        payload: JSON.stringify({ challengeToken: token, code: '000000' }),
      });
      expect(res.statusCode).toBe(401);
    }
    expect(state.challenges.has(token)).toBe(false);
    const locked = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'x-test-ip': '203.0.113.41' },
      payload: JSON.stringify({ email: TOTP_EMAIL, password: TOTP_PASSWORD }),
    });
    expect(locked.statusCode).toBe(429);
    await app.close();
  });

  it('a challenge used from a different user agent is rejected and deleted', async () => {
    const { app, state } = await buildHarness();
    const token = await startChallenge(app, 'test-agent-8a');
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-login-totp',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-8b' },
      payload: JSON.stringify({ challengeToken: token, code: expectedTotpCode(100) }),
    });
    expect(res.statusCode).toBe(401);
    expect(state.challenges.has(token)).toBe(false);
    await app.close();
  });

  it('a challenge cannot be reused after success: the second use answers 401', async () => {
    const { app } = await buildHarness();
    const token = await startChallenge(app, 'test-agent-9');
    const ok = await app.inject({
      method: 'POST',
      url: '/api/test-login-totp',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-9' },
      payload: JSON.stringify({ challengeToken: token, code: expectedTotpCode(100) }),
    });
    expect(ok.statusCode).toBe(200);
    const again = await app.inject({
      method: 'POST',
      url: '/api/test-login-totp',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-9' },
      payload: JSON.stringify({ challengeToken: token, code: expectedTotpCode(100) }),
    });
    expect(again.statusCode).toBe(401);
    await app.close();
  });

  it('a spent recovery code answers the same 401 as an unknown code', async () => {
    const { app } = await buildHarness();
    const first = await startChallenge(app, 'test-agent-10');
    const ok = await app.inject({
      method: 'POST',
      url: '/api/test-login-totp',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-10' },
      payload: JSON.stringify({ challengeToken: first, recoveryCode: 'rc-test-code-0001' }),
    });
    expect(ok.statusCode).toBe(200);
    const second = await startChallenge(app, 'test-agent-10');
    const spent = await app.inject({
      method: 'POST',
      url: '/api/test-login-totp',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-10' },
      payload: JSON.stringify({ challengeToken: second, recoveryCode: 'rc-test-code-0001' }),
    });
    expect(spent.statusCode).toBe(401);
    const third = await startChallenge(app, 'test-agent-10');
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/test-login-totp',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'user-agent': 'test-agent-10' },
      payload: JSON.stringify({ challengeToken: third, recoveryCode: 'rc-test-code-never' }),
    });
    expect(unknown.statusCode).toBe(401);
    expect(normalizedDenial(spent)).toBe(normalizedDenial(unknown));
    await app.close();
  });
});

// --- Admin and account metadata ---------------------------------------

describe('L2: admin gating and disable/restore [reference harness, real hook]', () => {
  it('a non-admin answers 403 forbidden on every admin route, with the session intact', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const list = await app.inject({ method: 'GET', url: '/api/test-admin-users', headers: sessionCookieHeader(login.sessionId) });
    expect(list.statusCode).toBe(403);
    expect(errorOf(list).code).toBe('forbidden');
    for (const url of ['/api/test-admin-users/user-1/disable', '/api/test-admin-users/user-1/restore']) {
      const res = await app.inject({ method: 'POST', url, headers: mutationHeaders(login.sessionId, login.csrfToken) });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('forbidden');
    }
    const alive = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(login.sessionId) });
    expect(alive.statusCode).toBe(200);
    await app.close();
  });

  it('an admin lists account metadata without any secret field', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await app.inject({ method: 'GET', url: '/api/test-admin-users', headers: sessionCookieHeader(login.sessionId) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('password');
    expect(res.body).not.toContain('passwordHash');
    expect(res.body).not.toContain('FIXTURE-TOTP-SECRET');
    const list = (res.json() as { data: Array<Record<string, unknown>> }).data;
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(['email', 'id', 'role', 'status']);
    }
    await app.close();
  });

  it('disabling an account kills its sessions through the epoch bump alone, and login then answers the generic 401', async () => {
    const { app, state } = await buildHarness();
    const victim = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const admin = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-admin-users/user-1/disable',
      headers: mutationHeaders(admin.sessionId, admin.csrfToken),
    });
    expect(res.statusCode).toBe(200);
    expect(state.sessions.has(victim.sessionId)).toBe(true);
    const dead = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(victim.sessionId) });
    expect(dead.statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json', 'x-test-ip': '203.0.113.51' },
      payload: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
    });
    expect(login.statusCode).toBe(401);
    expect(errorOf(login).code).toBe('invalid_credentials');
    await app.close();
  });

  it('restoring an account does not resurrect old sessions: the epoch moved again', async () => {
    const { app, state } = await buildHarness();
    const victim = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const admin = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    await app.inject({
      method: 'POST',
      url: '/api/test-admin-users/user-1/disable',
      headers: mutationHeaders(admin.sessionId, admin.csrfToken),
    });
    const restore = await app.inject({
      method: 'POST',
      url: '/api/test-admin-users/user-1/restore',
      headers: mutationHeaders(admin.sessionId, admin.csrfToken),
    });
    expect(restore.statusCode).toBe(200);
    expect(state.accountsById.get('user-1')?.credentialEpoch).toBe(2);
    const dead = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(victim.sessionId) });
    expect(dead.statusCode).toBe(401);
    await loginAs(app, USER_EMAIL, USER_PASSWORD);
    await app.close();
  });

  it('admin disable and restore of an unknown id answer 404, identical to each other', async () => {
    const { app } = await buildHarness();
    const admin = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const denials: string[] = [];
    for (const url of ['/api/test-admin-users/user-unknown/disable', '/api/test-admin-users/user-unknown/restore']) {
      const res = await app.inject({ method: 'POST', url, headers: mutationHeaders(admin.sessionId, admin.csrfToken) });
      expect(res.statusCode).toBe(404);
      denials.push(normalizedDenial(res));
    }
    expect(denials[1]).toBe(denials[0]);
    await app.close();
  });

  it('an admin requesting another account record answers 404, identical to an unknown record', async () => {
    const { app } = await buildHarness();
    const admin = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const mine = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const owned = await app.inject({
      method: 'GET',
      url: '/api/test-records/rec-user-1',
      headers: sessionCookieHeader(mine.sessionId),
    });
    expect(owned.statusCode).toBe(200);
    const denials: string[] = [];
    for (const url of ['/api/test-records/rec-user-1', '/api/test-records/rec-unknown']) {
      const res = await app.inject({ method: 'GET', url, headers: sessionCookieHeader(admin.sessionId) });
      expect(res.statusCode).toBe(404);
      denials.push(normalizedDenial(res));
    }
    expect(denials[1]).toBe(denials[0]);
    await app.close();
  });
});

// --- Me and CSRF refresh ----------------------------------------------

describe('L2: me and CSRF refresh [reference harness, real hook]', () => {
  it('me returns account metadata without secrets and never the password', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const res = await app.inject({ method: 'GET', url: '/api/test-me', headers: sessionCookieHeader(login.sessionId) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(USER_PASSWORD);
    expect(res.body).not.toContain('passwordHash');
    const data = (res.json() as { data: Record<string, unknown> }).data;
    expect(data['email']).toBe(USER_EMAIL);
    expect(data['role']).toBe('user');
    expect(data['totpEnabled']).toBe(false);
    await app.close();
  });

  it('CSRF refresh returns the live token with no-store, and the token works for a mutation', async () => {
    const { app } = await buildHarness();
    const login = await loginAs(app, USER_EMAIL, USER_PASSWORD);
    const res = await app.inject({ method: 'GET', url: '/api/test-csrf', headers: sessionCookieHeader(login.sessionId) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const token = (res.json() as { data: { csrfToken: string } }).data.csrfToken;
    expect(token).toBe(login.csrfToken);
    const mutated = await app.inject({
      method: 'POST',
      url: '/api/test-logout',
      headers: mutationHeaders(login.sessionId, token),
    });
    expect(mutated.statusCode).toBe(200);
    await app.close();
  });

  it('login success never contains a session id, a hash, or the password', async () => {
    const { app } = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-login',
      headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('sessionId');
    expect(res.body).not.toContain('session_hash');
    expect(res.body).not.toContain('passwordHash');
    expect(res.body).not.toContain(USER_PASSWORD);
    const data = (res.json() as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(['csrfToken', 'email', 'id', 'role', 'sessionExpiresAt', 'totpEnabled']);
    await app.close();
  });

  it('email lookup is normalized: surrounding spaces and upper case still log in', async () => {
    const { app } = await buildHarness();
    await loginAs(app, '  USER@Example.Invalid  ', USER_PASSWORD);
    await app.close();
  });

  it('missing email or password answers 400 validation_failed, before any auth verdict (reference reading)', async () => {
    const { app } = await buildHarness();
    for (const body of [{ password: USER_PASSWORD }, { email: USER_EMAIL }, { email: '', password: '' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/test-login',
        headers: { origin: CANONICAL_ORIGIN, 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('validation_failed');
    }
    await app.close();
  });
});
