// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Password reset routes (kontrak-api-kanonis.md section 3.12;
// desain-auth.md section 3.6; V3-02 part 3). Two public pre-session
// routes, registered by the integrator (this task must not edit
// server/src/app.ts; see AD-57). Wiring the integrator must supply:
// the AuthContext, a PasswordResetStore (DrizzlePasswordResetStore
// from the database handle), and smtpConfigured, which defaults to
// false (the no-SMTP branch) and must stay false until a mailer
// exists, because no email sending exists in the MVP.
//
// Enforcement layers, in order, for both routes:
// - requiresAuth: false plus the frozen Origin preHandler, exactly
//   like the other public auth routes in auth-core.ts: no session
//   exists yet, so CSRF cannot apply, but Origin must still match.
//   The global hook skips these routes by route config (the F1-57
//   D3 pin); they are not hook-exempt.
// - Rate limits (desain-auth.md section 6.4) run before any token
//   work, through the database buckets shared with login/setup:
//   reset-request 3 per hour per IP and 3 per hour per account,
//   reset-confirm 5 per 15 minutes per IP. A tripped IP bucket
//   answers 429 with Retry-After. A tripped account bucket on
//   reset-request still answers the generic 200 with no token
//   created, so account existence cannot be probed through the
//   status code. Database or AUTH_SECRET failures fail closed
//   with 503, never with a misleading 200.
// - Bodies are read leniently on purpose, following the L2
//   reference harness: reset-request answers the same byte-identical
//   200 for known, unknown, disabled, malformed, and empty emails,
//   and reset-confirm treats a missing or mistyped token as an
//   invalid token and a missing new password as a shape failure
//   after the token check. Strict unknown-field rejection would
//   break the pinned genericity, so unknown fields are ignored
//   here. This leniency is an anti-enumeration exception for
//   these two routes only; it does not change validation anywhere
//   else in the auth group.
// - No route in this file reads the Authorization header, sets a
//   session cookie, or returns a token. A reset is not a login.
//
// No-SMTP branch (the default): reset-request creates no token and
// writes no audit event; recovery is the operator CLI procedure in
// desain-auth.md section 2.5, not an HTTP flow. The confirm route
// does not consult the SMTP flag: a token minted while SMTP was
// configured stays confirmable afterwards.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { successEnvelope } from '../plugins/envelope.js';
import { createOriginPreHandler } from '../middleware/auth-hook.js';
import {
  recordFailureBucket,
  secondsUntilWindowEnd,
  sendRateLimited,
  type RateLimitDecision,
} from '../middleware/rate-limit.js';
import { requireStore, type AuthContext } from '../auth/context.js';
import { clientIp, normalizeEmail, truncateUserAgent } from '../auth/crypto.js';
import { recordAudit } from '../auth/service.js';
import type { AuthStore } from '../auth/store.js';
import type { AuditEventType } from '../auth/values.js';
import {
  completePasswordReset,
  PASSWORD_RESET_COMPLETED_EVENT,
  PASSWORD_RESET_REQUESTED_EVENT,
  requestPasswordReset,
  RESET_ACCOUNT_SCOPE,
  RESET_CONFIRM_IP_LIMIT,
  RESET_CONFIRM_IP_SCOPE,
  RESET_CONFIRM_MESSAGE,
  RESET_CONFIRM_WINDOW_MS,
  RESET_IP_SCOPE,
  RESET_REQUEST_ACCOUNT_LIMIT,
  RESET_REQUEST_IP_LIMIT,
  RESET_REQUEST_MESSAGE,
  RESET_REQUEST_WINDOW_MS,
  validateResetToken,
  type PasswordResetStore,
} from '../services/auth/password-reset.js';

export interface AuthResetRouteDeps {
  auth: AuthContext;
  resetStore: PasswordResetStore;
  smtpConfigured?: boolean;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

// Atomic increment-and-check for one bucket, in the setup-scope
// style: every attempt counts, and concurrent attempts cannot
// overshoot the limit. Throws 503 when AUTH_SECRET is missing or
// the database fails (fail closed, via recordFailureBucket).
async function countBucket(input: {
  store: AuthStore;
  scope: string;
  rawKey: string;
  authSecret: string | undefined;
  limit: number;
  windowMs: number;
  nowMs: number;
}): Promise<RateLimitDecision> {
  const hits = await recordFailureBucket({
    store: input.store,
    scope: input.scope,
    rawKey: input.rawKey,
    authSecret: input.authSecret,
    windowMs: input.windowMs,
    nowMs: input.nowMs,
  });
  return {
    allowed: hits <= input.limit,
    retryAfterSeconds: secondsUntilWindowEnd(input.nowMs, input.windowMs),
  };
}

export async function registerAuthResetRoutes(app: FastifyInstance, deps: AuthResetRouteDeps): Promise<void> {
  const auth = deps.auth;
  const resetStore = deps.resetStore;
  const smtpConfigured = deps.smtpConfigured ?? false;
  const originCheck = createOriginPreHandler(auth.canonicalOrigin);
  const publicRoute = () => ({ config: { requiresAuth: false }, preHandler: [originCheck] });

  const auditFailed = (request: FastifyRequest, eventType: string) => (): void => {
    request.log.warn({ event: eventType }, 'audit write failed');
  };

  function requestIp(request: FastifyRequest): string | undefined {
    return clientIp(request, auth.trustProxy);
  }

  function requestUserAgent(request: FastifyRequest): string | undefined {
    const value = request.headers['user-agent'];
    return typeof value === 'string' ? value : undefined;
  }

  // POST /api/auth/password/reset-request: always the same generic
  // 200 (see the module header). The only non-200 outcomes are 403
  // origin_rejected from the preHandler, 429 when the IP bucket is
  // tripped, and 503 when the database or AUTH_SECRET is unavailable.
  // It never answers 401 or 404.
  app.post('/api/auth/password/reset-request', publicRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    const email = normalizeEmail(stringField(bodyRecord(request.body), 'email'));
    const store = requireStore(auth);
    const nowMs = auth.clock();
    const ip = requestIp(request);
    const ipKey = ip ?? 'unknown';

    const ipDecision = await countBucket({
      store,
      scope: RESET_IP_SCOPE,
      rawKey: ipKey,
      authSecret: auth.authSecret,
      limit: RESET_REQUEST_IP_LIMIT,
      windowMs: RESET_REQUEST_WINDOW_MS,
      nowMs,
    });
    if (!ipDecision.allowed) {
      sendRateLimited(reply, request.id, ipDecision.retryAfterSeconds);
      return reply;
    }
    const accountDecision = await countBucket({
      store,
      scope: RESET_ACCOUNT_SCOPE,
      rawKey: email,
      authSecret: auth.authSecret,
      limit: RESET_REQUEST_ACCOUNT_LIMIT,
      windowMs: RESET_REQUEST_WINDOW_MS,
      nowMs,
    });
    if (!accountDecision.allowed) {
      // Tripped account bucket: the generic 200, with no token and
      // no audit event, so the bucket state reveals nothing.
      return reply.code(200).send(successEnvelope({ message: RESET_REQUEST_MESSAGE }));
    }

    const outcome = await requestPasswordReset({ store, resetStore, email, smtpConfigured, nowMs });
    if (outcome.tokenCreated && outcome.userId !== null) {
      // The event name is asserted past the frozen AuditEventType
      // union; see password-reset.ts for why the assertion exists
      // and when the V3-02 values amendment removes it.
      await recordAudit(
        store,
        {
          userId: outcome.userId,
          actorUserId: outcome.userId,
          eventType: PASSWORD_RESET_REQUESTED_EVENT as AuditEventType,
          ip: ip ?? null,
          userAgent: truncateUserAgent(requestUserAgent(request)),
          metadata: {},
        },
        auditFailed(request, PASSWORD_RESET_REQUESTED_EVENT),
      );
    }
    return reply.code(200).send(successEnvelope({ message: RESET_REQUEST_MESSAGE }));
  });

  // POST /api/auth/password/reset-confirm: token plus new password
  // in the body (never a GET action). Token failures share one 400
  // invalid_action_token; a malformed new password with a valid
  // token answers 400 validation_failed and leaves the token
  // usable. Success answers 200, sets no cookie, and creates no
  // session: the user logs in again through the normal flow.
  app.post('/api/auth/password/reset-confirm', publicRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    const body = bodyRecord(request.body);
    const token = stringField(body, 'token');
    const newPassword = stringField(body, 'newPassword');
    const store = requireStore(auth);
    const nowMs = auth.clock();
    const ip = requestIp(request);

    const decision = await countBucket({
      store,
      scope: RESET_CONFIRM_IP_SCOPE,
      rawKey: ip ?? 'unknown',
      authSecret: auth.authSecret,
      limit: RESET_CONFIRM_IP_LIMIT,
      windowMs: RESET_CONFIRM_WINDOW_MS,
      nowMs,
    });
    if (!decision.allowed) {
      sendRateLimited(reply, request.id, decision.retryAfterSeconds);
      return reply;
    }

    const validated = await validateResetToken({ store, resetStore, token, nowMs });
    const user = await completePasswordReset({
      store,
      resetStore,
      hasher: auth.hasher,
      tokenRow: validated.tokenRow,
      user: validated.user,
      newPassword,
      now: new Date(nowMs),
    });
    await recordAudit(
      store,
      {
        userId: user.id,
        actorUserId: user.id,
        eventType: PASSWORD_RESET_COMPLETED_EVENT as AuditEventType,
        ip: ip ?? null,
        userAgent: truncateUserAgent(requestUserAgent(request)),
        metadata: {},
      },
      auditFailed(request, PASSWORD_RESET_COMPLETED_EVENT),
    );
    return reply.code(200).send(successEnvelope({ message: RESET_CONFIRM_MESSAGE }));
  });
}
