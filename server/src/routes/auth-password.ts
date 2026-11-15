// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Password change route (kontrak-api-kanonis.md section 3.12; V3-02
// part 2): POST /api/auth/password/change. One route, registered by
// the integrator in the auth block of buildApp (AD-57: overlap
// workers never edit server/src/app.ts); the registration call is
// `registerAuthPasswordRoutes(app, { auth })`, next to
// registerAuthCoreRoutes.
//
// Enforcement layers, in order:
// - The frozen global hook enforces the session (401), then Origin
//   (403 origin_rejected), then CSRF (403 csrf_invalid). This route
//   declares requiresAuth: true and adds no preHandler, exactly
//   like the session routes in auth-core.ts.
// - The body must be a JSON object with exactly currentPassword and
//   newPassword (unknown fields rejected with details.fields,
//   kontrak section 1.5). Presence and type are validated here;
//   length and sameness are validated in the service AFTER the
//   current password is verified, matching the L2 harness
//   precedence: a wrong current password answers 401 even when the
//   new password is also malformed.
// - The per-account failure bucket (5 failures per 15 minutes,
//   desain-auth.md section 6.4) is checked after the session is
//   loaded and before verification; only a wrong current password
//   counts as a failure. Failures here never touch the login
//   lockout (desain-auth.md section 3.5 step 2).
// - No step_up_required gate: the current password IS the step-up
//   for this action (desain-auth.md section 3.5). A session fresh
//   from login may change its password.
//
// Success: 200 with { csrfToken } for the fresh session, plus a new
// session cookie. All other sessions of the account are dead (rows
// deleted and epoch bumped, so even a surviving row would fail the
// epoch check). The password_changed audit event is written
// best-effort after the replace, through recordAudit like the other
// auth handlers: the frozen store interface gives
// replaceUserPassword no audit slot (unlike
// bumpEpochAndRevokeAllSessions), so the event cannot ride inside
// the replace transaction without a store change owned elsewhere.
// The password_change_failed event on a wrong current password
// carries a categorical reason in metadata (desain-auth.md section
// 12.1), server-side only, never on the wire.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import { getPrincipal } from '../middleware/auth-hook.js';
import {
  checkAccountFailureBucket,
  PASSWORD_CHANGE_ACCOUNT_SCOPE,
  recordAccountFailureBucket,
  sendRateLimited,
} from '../middleware/rate-limit.js';
import { loadSessionAndUser } from '../middleware/session.js';
import { requireStore, type AuthContext } from '../auth/context.js';
import { buildSessionCookie, clientIp, truncateUserAgent } from '../auth/crypto.js';
import { recordAudit, sessionCookieMaxAgeSeconds } from '../auth/service.js';
import {
  requireBodyObject,
  requiredString,
  throwIfIssues,
  unknownFieldIssues,
  validationFailed,
  type FieldIssue,
} from '../auth/validation.js';
import { PASSWORD_CHANGE_FAILURE_LIMIT, PASSWORD_CHANGE_FAILURE_WINDOW_MS } from '../auth/values.js';
import { changePassword } from '../services/auth/password-change.js';

export interface AuthPasswordRouteDeps {
  auth: AuthContext;
}

export async function registerAuthPasswordRoutes(app: FastifyInstance, deps: AuthPasswordRouteDeps): Promise<void> {
  const auth = deps.auth;

  // POST /api/auth/password/change: verify the current password,
  // validate the new one, rehash, bump the epoch, kill every
  // session, and mint a fresh session for the requester.
  app.post(
    '/api/auth/password/change',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = requireBodyObject(request.body);
      const issues: FieldIssue[] = [...unknownFieldIssues(body, ['currentPassword', 'newPassword'])];
      const currentPassword = requiredString(body, 'currentPassword', issues);
      const newPassword = requiredString(body, 'newPassword', issues);
      throwIfIssues(issues);

      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.unauthenticated();
      }
      const loaded = await loadSessionAndUser(auth, request, principal);
      if (loaded === null) {
        throw ApiError.unauthenticated();
      }
      const store = requireStore(auth);
      const nowMs = auth.clock();
      const ip = clientIp(request, auth.trustProxy) ?? null;
      const userAgent = truncateUserAgent(
        typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
      );

      const rate = await checkAccountFailureBucket({
        store,
        scope: PASSWORD_CHANGE_ACCOUNT_SCOPE,
        userId: loaded.user.id,
        authSecret: auth.authSecret,
        limit: PASSWORD_CHANGE_FAILURE_LIMIT,
        windowMs: PASSWORD_CHANGE_FAILURE_WINDOW_MS,
        nowMs,
      });
      if (!rate.allowed) {
        sendRateLimited(reply, request.id, rate.retryAfterSeconds);
        return reply;
      }

      const result = await changePassword(auth, store, {
        user: loaded.user,
        currentPassword: currentPassword as string,
        newPassword: newPassword as string,
        request,
        now: new Date(nowMs),
      });

      if (result.outcome === 'invalid_current') {
        await recordAccountFailureBucket({
          store,
          scope: PASSWORD_CHANGE_ACCOUNT_SCOPE,
          userId: loaded.user.id,
          authSecret: auth.authSecret,
          windowMs: PASSWORD_CHANGE_FAILURE_WINDOW_MS,
          nowMs,
        });
        await recordAudit(
          store,
          {
            userId: loaded.user.id,
            actorUserId: loaded.user.id,
            eventType: 'password_change_failed',
            ip,
            userAgent,
            metadata: { reason: 'invalid_current_password' },
          },
          () => {
            request.log.warn({ event: 'password_change_failed' }, 'audit write failed');
          },
        );
        throw ApiError.invalidCredentials();
      }
      if (result.outcome === 'invalid_new') {
        throw validationFailed([{ field: 'newPassword', issue: result.issue }]);
      }

      await recordAudit(
        store,
        {
          userId: loaded.user.id,
          actorUserId: loaded.user.id,
          eventType: 'password_changed',
          ip,
          userAgent,
          metadata: {},
        },
        () => {
          request.log.warn({ event: 'password_changed' }, 'audit write failed');
        },
      );
      reply.header(
        'Set-Cookie',
        buildSessionCookie(
          result.created.sessionId,
          sessionCookieMaxAgeSeconds(result.created.row.absoluteExpiresAt, nowMs),
          { cookieSecure: auth.cookieSecure },
        ),
      );
      return reply.code(200).send(successEnvelope({ csrfToken: result.created.csrfToken }));
    },
  );
}
