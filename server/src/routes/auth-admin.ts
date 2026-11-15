// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Admin account routes (kontrak-api-kanonis.md section 3.13; V3-02
// part 5). Four routes: list account metadata, disable, restore, and
// revoke one session of another account. Registration in app.ts is
// the integrator's job (AD-57: overlap workers never edit app.ts);
// this module only defines the registration function and takes its
// store by injection, so it cannot run unwired.
//
// Enforcement layers, in order, for every route:
// - The frozen global hook (middleware/auth-hook.ts, AD-40) enforces
//   the session (401), then Origin (403 origin_rejected), then CSRF
//   (403 csrf_invalid) for mutations. Handlers never re-check those
//   layers; they only enforce the admin role, through the service.
// - A non-admin answers 403 forbidden on every route, with the
//   session intact: the role check throws before any mutation.
// - Path ids are validated as UUIDs; a malformed id answers the same
//   generic 404 as an unknown id (mirrors the own-session revoke in
//   routes/auth-core.ts).
// - Bodies are ignored: disable, restore, and session revoke carry
//   no body schema, like logout in auth-core.ts. No reason field is
//   accepted, because the contract defines none.
// - The list response carries Cache-Control: no-store, like /me and
//   /csrf: account metadata must never sit in a shared cache.
//
// No route here reads another account's content. The list returns
// metadata only (id, email, role, status); there is no per-account
// detail route, no role-change route, and no impersonation route.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import { getPrincipal } from '../middleware/auth-hook.js';
import { clientIp, isUuid, truncateUserAgent } from '../auth/crypto.js';
import {
  disableAccount,
  listAccounts,
  restoreAccount,
  revokeAccountSession,
  type AdminAccountStore,
  type AdminRequestFacts,
} from '../services/auth/admin.js';

export interface AuthAdminRouteDeps {
  store: AdminAccountStore;
  clock?: () => number;
  trustProxy?: boolean;
}

function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
}

function factsOf(request: FastifyRequest, deps: AuthAdminRouteDeps): AdminRequestFacts {
  const userAgent = request.headers['user-agent'];
  return {
    ip: clientIp(request, deps.trustProxy ?? false) ?? null,
    userAgent: truncateUserAgent(typeof userAgent === 'string' ? userAgent : undefined),
    now: new Date((deps.clock ?? Date.now)()),
  };
}

function pathId(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, unknown>;
  const value = params[name];
  if (typeof value !== 'string' || !isUuid(value)) {
    throw ApiError.notFound();
  }
  return value;
}

export async function registerAuthAdminRoutes(
  app: FastifyInstance,
  deps: AuthAdminRouteDeps,
): Promise<void> {
  const store = deps.store;
  const sessionRoute = () => ({ config: { requiresAuth: true } });

  // GET /api/admin/users: account metadata only. The service
  // enforces the admin role and shapes each entry to exactly the
  // four pinned fields.
  app.get('/api/admin/users', sessionRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = getPrincipal(request);
    if (principal === undefined) {
      throw ApiError.unauthenticated();
    }
    const accounts = await listAccounts(store, principal);
    noStore(reply);
    return reply.code(200).send(successEnvelope(accounts));
  });

  // POST /api/admin/users/:id/disable: disable plus epoch bump (on a
  // real status change). Re-disabling answers 200 with no change.
  app.post(
    '/api/admin/users/:id/disable',
    sessionRoute(),
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.unauthenticated();
      }
      const id = pathId(request, 'id');
      await disableAccount(store, principal, id, factsOf(request, deps));
      return reply.code(200).send(successEnvelope(null));
    },
  );

  // POST /api/admin/users/:id/restore: restore plus epoch bump (on a
  // real status change), so pre-disable sessions never come back.
  // Re-restoring answers 200 with no change.
  app.post(
    '/api/admin/users/:id/restore',
    sessionRoute(),
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.unauthenticated();
      }
      const id = pathId(request, 'id');
      await restoreAccount(store, principal, id, factsOf(request, deps));
      return reply.code(200).send(successEnvelope(null));
    },
  );

  // DELETE /api/admin/users/:id/sessions/:sessionId: revoke one
  // session of another account. Unknown account, unknown session,
  // and a session owned by a different account all answer the same
  // generic 404; repeating the revocation answers 404.
  app.delete(
    '/api/admin/users/:id/sessions/:sessionId',
    sessionRoute(),
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.unauthenticated();
      }
      const id = pathId(request, 'id');
      const sessionId = pathId(request, 'sessionId');
      await revokeAccountSession(store, principal, id, sessionId, factsOf(request, deps));
      return reply.code(200).send(successEnvelope(null));
    },
  );
}
