// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the admin account routes (kontrak-api-kanonis.md section
// 3.13; V1-08 section 12.2): GET /api/admin/users, POST disable,
// POST restore, DELETE one session of another account. The routes
// under test live in routes/auth-admin.ts with the service in
// services/auth/admin.ts; this spec file keeps the task-brief name
// admin.spec.ts.
//
// The app here is a bare Fastify instance, not buildApp: this overlap
// task (AD-57) must not edit server/src/app.ts, so the admin routes
// are registered directly with the FROZEN global hook
// (registerAuthHooks) and a fake AdminAccountStore that implements
// the documented adapter contract (one-transaction status change:
// status + disabled_at + epoch bump + session deletion + audit
// write; no change on a repeat of the current status).
//
// What is pinned: metadata-only list shape (exactly id, email, role,
// status) with Cache-Control: no-store; 403 forbidden for a non-admin
// on every route with the session intact; 401 without a session;
// 404 not_found for unknown and malformed ids; natural idempotence
// of disable/restore (repeat answers 200 with no epoch bump and no
// audit write); revoke repeat answers 404; a session owned by a
// different account answers the same 404; mutations still pass
// through the frozen Origin then CSRF layers; a database failure
// answers 503 service_unavailable; corrupted role/status values fail
// closed with 500.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/plugins/envelope.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import { registerRequestId } from '../src/plugins/request-id.js';
import {
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';
import { registerAuthAdminRoutes } from '../src/routes/auth-admin.js';
import {
  toAccountMetadata,
  type AccountMetadata,
  type AccountSessionRow,
  type AccountStatusRow,
  type AdminAccountStore,
  type AdminAuditEventInput,
  type SetUserStatusInput,
  type SetUserStatusResult,
} from '../src/services/auth/admin.js';

const ORIGIN = 'https://app.example.invalid';
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const UNKNOWN_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_SESSION_ID = '66666666-6666-4666-8666-666666666666';

const ADMIN_PRINCIPAL: SessionPrincipal = { userId: ADMIN_ID, role: 'admin', sessionId: 'admin-session' };
const USER_PRINCIPAL: SessionPrincipal = { userId: USER_ID, role: 'user', sessionId: 'user-session' };

interface FakeUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  credentialEpoch: number;
  disabledAt: Date | null;
}

class FakeAdminStore implements AdminAccountStore {
  users = new Map<string, FakeUser>();
  sessions = new Map<string, AccountSessionRow>();
  audits: AdminAuditEventInput[] = [];
  failNext = false;

  constructor() {
    this.users.set(ADMIN_ID, {
      id: ADMIN_ID,
      email: 'admin@example.invalid',
      role: 'admin',
      status: 'active',
      credentialEpoch: 0,
      disabledAt: null,
    });
    this.users.set(USER_ID, {
      id: USER_ID,
      email: 'user@example.invalid',
      role: 'user',
      status: 'active',
      credentialEpoch: 0,
      disabledAt: null,
    });
    this.users.set(OTHER_ID, {
      id: OTHER_ID,
      email: 'other@example.invalid',
      role: 'user',
      status: 'active',
      credentialEpoch: 3,
      disabledAt: null,
    });
    this.sessions.set(SESSION_ID, { id: SESSION_ID, userId: USER_ID });
    this.sessions.set(OTHER_SESSION_ID, { id: OTHER_SESSION_ID, userId: OTHER_ID });
  }

  private maybeFail(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated database failure');
    }
  }

  async listUsers(): Promise<AccountMetadata[]> {
    this.maybeFail();
    return [...this.users.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((user) => toAccountMetadata({ id: user.id, email: user.email, role: user.role, status: user.status }));
  }

  async findUserStatus(id: string): Promise<AccountStatusRow | null> {
    this.maybeFail();
    const user = this.users.get(id);
    if (user === undefined) {
      return null;
    }
    return { id: user.id, status: user.status, credentialEpoch: user.credentialEpoch };
  }

  async setUserStatus(input: SetUserStatusInput): Promise<SetUserStatusResult | null> {
    this.maybeFail();
    const user = this.users.get(input.userId);
    if (user === undefined) {
      return null;
    }
    if (user.status === input.status) {
      return { status: user.status, credentialEpoch: user.credentialEpoch, changed: false };
    }
    user.status = input.status;
    user.credentialEpoch += 1;
    user.disabledAt = input.status === 'disabled' ? input.now : null;
    for (const [sessionId, session] of [...this.sessions]) {
      if (session.userId === input.userId) {
        this.sessions.delete(sessionId);
      }
    }
    this.audits.push(input.audit);
    return { status: user.status, credentialEpoch: user.credentialEpoch, changed: true };
  }

  async findSessionById(id: string): Promise<AccountSessionRow | null> {
    this.maybeFail();
    return this.sessions.get(id) ?? null;
  }

  async deleteSessionById(id: string): Promise<boolean> {
    this.maybeFail();
    return this.sessions.delete(id);
  }

  async insertAdminAuditEvent(event: AdminAuditEventInput): Promise<void> {
    this.maybeFail();
    this.audits.push(event);
  }
}

interface EnvelopeBody {
  ok: boolean;
  data?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function bodyOf(res: { json(): unknown }): EnvelopeBody {
  return res.json() as EnvelopeBody;
}

async function buildAdminApp(store: AdminAccountStore): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  registerAuthHooks(app, {
    verifySession: async ({ sessionId }) => {
      if (sessionId === 'admin-session') {
        return ADMIN_PRINCIPAL;
      }
      if (sessionId === 'user-session') {
        return USER_PRINCIPAL;
      }
      return null;
    },
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    canonicalOrigin: ORIGIN,
  });
  await registerAuthAdminRoutes(app, { store, clock: () => Date.UTC(2026, 10, 15, 4, 0, 0) });
  await app.ready();
  return app;
}

const ADMIN_COOKIE = { cookie: 'notegen_session=admin-session' };
const USER_COOKIE = { cookie: 'notegen_session=user-session' };

function mutationHeaders(cookie: Record<string, string>) {
  return { ...cookie, origin: ORIGIN, 'x-csrf-token': 'good-csrf' };
}

describe('admin routes', () => {
  let store: FakeAdminStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = new FakeAdminStore();
    app = await buildAdminApp(store);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/admin/users', () => {
    it('lists account metadata with exactly the four pinned fields', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: ADMIN_COOKIE });
      expect(res.statusCode).toBe(200);
      const body = bodyOf(res);
      expect(body.ok).toBe(true);
      const data = body.data as AccountMetadata[];
      expect(data).toHaveLength(3);
      for (const entry of data) {
        expect(Object.keys(entry).sort()).toEqual(['email', 'id', 'role', 'status']);
      }
      expect(data.map((entry) => entry.email)).toContain('admin@example.invalid');
      expect(data.find((entry) => entry.id === OTHER_ID)).toEqual({
        id: OTHER_ID,
        email: 'other@example.invalid',
        role: 'user',
        status: 'active',
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('answers 403 forbidden for a non-admin, with the session intact', async () => {
      const first = await app.inject({ method: 'GET', url: '/api/admin/users', headers: USER_COOKIE });
      expect(first.statusCode).toBe(403);
      expect(bodyOf(first).error?.code).toBe('forbidden');
      const again = await app.inject({ method: 'GET', url: '/api/admin/users', headers: USER_COOKIE });
      expect(again.statusCode).toBe(403);
      expect(bodyOf(again).error?.code).toBe('forbidden');
    });

    it('answers 401 without a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/users' });
      expect(res.statusCode).toBe(401);
      expect(bodyOf(res).error?.code).toBe('unauthenticated');
    });

    it('answers 503 when the database fails', async () => {
      store.failNext = true;
      const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: ADMIN_COOKIE });
      expect(res.statusCode).toBe(503);
      expect(bodyOf(res).error?.code).toBe('service_unavailable');
    });
  });

  describe('POST /api/admin/users/:id/disable', () => {
    it('disables the account, bumps the epoch, deletes sessions, and audits', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${USER_ID}/disable`,
        headers: mutationHeaders(ADMIN_COOKIE),
      });
      expect(res.statusCode).toBe(200);
      expect(bodyOf(res).ok).toBe(true);
      const user = store.users.get(USER_ID);
      expect(user?.status).toBe('disabled');
      expect(user?.credentialEpoch).toBe(1);
      expect(user?.disabledAt).not.toBeNull();
      expect(store.sessions.has(SESSION_ID)).toBe(false);
      expect(store.audits).toHaveLength(1);
      expect(store.audits[0]?.eventType).toBe('account_disabled');
      expect(store.audits[0]?.userId).toBe(USER_ID);
      expect(store.audits[0]?.actorUserId).toBe(ADMIN_ID);
    });

    it('is idempotent: re-disabling answers 200 with no change', async () => {
      const first = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${USER_ID}/disable`,
        headers: mutationHeaders(ADMIN_COOKIE),
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${USER_ID}/disable`,
        headers: mutationHeaders(ADMIN_COOKIE),
      });
      expect(second.statusCode).toBe(200);
      expect(store.users.get(USER_ID)?.credentialEpoch).toBe(1);
      expect(store.audits).toHaveLength(1);
    });

    it('answers 404 for an unknown id and for a malformed id', async () => {
      for (const id of [UNKNOWN_ID, 'not-a-uuid']) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/admin/users/${id}/disable`,
          headers: mutationHeaders(ADMIN_COOKIE),
        });
        expect(res.statusCode).toBe(404);
        expect(bodyOf(res).error?.code).toBe('not_found');
      }
      expect(store.audits).toHaveLength(0);
    });

    it('answers 403 for a non-admin and changes nothing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${USER_ID}/disable`,
        headers: mutationHeaders(USER_COOKIE),
      });
      expect(res.statusCode).toBe(403);
      expect(bodyOf(res).error?.code).toBe('forbidden');
      expect(store.users.get(USER_ID)?.status).toBe('active');
      expect(store.audits).toHaveLength(0);
    });

    it('still enforces Origin then CSRF through the frozen hook', async () => {
      const noOrigin = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${USER_ID}/disable`,
        headers: { ...ADMIN_COOKIE, 'x-csrf-token': 'good-csrf' },
      });
      expect(noOrigin.statusCode).toBe(403);
      expect(bodyOf(noOrigin).error?.code).toBe('origin_rejected');
      const noCsrf = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${USER_ID}/disable`,
        headers: { ...ADMIN_COOKIE, origin: ORIGIN },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(bodyOf(noCsrf).error?.code).toBe('csrf_invalid');
      expect(store.users.get(USER_ID)?.status).toBe('active');
    });
  });

  describe('POST /api/admin/users/:id/restore', () => {
    it('restores a disabled account and bumps the epoch again', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/admin/users/${USER_ID}/disable`,
        headers: mutationHeaders(ADMIN_COOKIE),
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${USER_ID}/restore`,
        headers: mutationHeaders(ADMIN_COOKIE),
      });
      expect(res.statusCode).toBe(200);
      const user = store.users.get(USER_ID);
      expect(user?.status).toBe('active');
      expect(user?.credentialEpoch).toBe(2);
      expect(user?.disabledAt).toBeNull();
      expect(store.audits.map((event) => event.eventType)).toEqual(['account_disabled', 'account_restored']);
    });

    it('is idempotent: restoring an active account answers 200 with no change', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${USER_ID}/restore`,
        headers: mutationHeaders(ADMIN_COOKIE),
      });
      expect(res.statusCode).toBe(200);
      expect(store.users.get(USER_ID)?.credentialEpoch).toBe(0);
      expect(store.audits).toHaveLength(0);
    });

    it('answers 404 for an unknown id and 403 for a non-admin', async () => {
      const unknown = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${UNKNOWN_ID}/restore`,
        headers: mutationHeaders(ADMIN_COOKIE),
      });
      expect(unknown.statusCode).toBe(404);
      expect(bodyOf(unknown).error?.code).toBe('not_found');
      const nonAdmin = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${USER_ID}/restore`,
        headers: mutationHeaders(USER_COOKIE),
      });
      expect(nonAdmin.statusCode).toBe(403);
      expect(bodyOf(nonAdmin).error?.code).toBe('forbidden');
    });
  });

  describe('DELETE /api/admin/users/:id/sessions/:sessionId', () => {
    it('revokes one session of another account and audits', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${USER_ID}/sessions/${SESSION_ID}`,
        headers: mutationHeaders(ADMIN_COOKIE),
      });
      expect(res.statusCode).toBe(200);
      expect(store.sessions.has(SESSION_ID)).toBe(false);
      expect(store.sessions.has(OTHER_SESSION_ID)).toBe(true);
      expect(store.audits).toHaveLength(1);
      expect(store.audits[0]?.eventType).toBe('session_revoked');
      expect(store.audits[0]?.metadata).toEqual({ revokedSessionId: SESSION_ID });
    });

    it('answers 404 when the revocation is repeated', async () => {
      const first = await app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${USER_ID}/sessions/${SESSION_ID}`,
        headers: mutationHeaders(ADMIN_COOKIE),
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${USER_ID}/sessions/${SESSION_ID}`,
        headers: mutationHeaders(ADMIN_COOKIE),
      });
      expect(second.statusCode).toBe(404);
      expect(bodyOf(second).error?.code).toBe('not_found');
    });

    it('answers the same 404 for an unknown account, an unknown session, and a session owned by another account', async () => {
      const cases = [
        `/api/admin/users/${UNKNOWN_ID}/sessions/${SESSION_ID}`,
        `/api/admin/users/${USER_ID}/sessions/${UNKNOWN_ID}`,
        `/api/admin/users/${USER_ID}/sessions/${OTHER_SESSION_ID}`,
        `/api/admin/users/${USER_ID}/sessions/not-a-uuid`,
      ];
      for (const url of cases) {
        const res = await app.inject({ method: 'DELETE', url, headers: mutationHeaders(ADMIN_COOKIE) });
        expect(res.statusCode).toBe(404);
        expect(bodyOf(res).error?.code).toBe('not_found');
      }
      expect(store.sessions.size).toBe(2);
      expect(store.audits).toHaveLength(0);
    });

    it('answers 403 for a non-admin and revokes nothing', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${USER_ID}/sessions/${SESSION_ID}`,
        headers: mutationHeaders(USER_COOKIE),
      });
      expect(res.statusCode).toBe(403);
      expect(bodyOf(res).error?.code).toBe('forbidden');
      expect(store.sessions.has(SESSION_ID)).toBe(true);
    });
  });

  describe('toAccountMetadata', () => {
    it('fails closed on corrupted role and status values', () => {
      for (const row of [
        { id: USER_ID, email: 'u@example.invalid', role: 'superuser', status: 'active' },
        { id: USER_ID, email: 'u@example.invalid', role: 'user', status: 'suspended' },
      ]) {
        let code: string | undefined;
        try {
          toAccountMetadata(row);
        } catch (error) {
          if (error instanceof ApiError) {
            code = error.code;
          }
        }
        expect(code).toBe('internal_error');
      }
    });
  });
});
