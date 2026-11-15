// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Step-up route (kontrak-api-kanonis.md section 3.12; desain-auth.md
// section 3.5; V3-02 part 1).
//
// POST /api/auth/step-up re-authenticates the current session: the
// password, plus the current TOTP code when TOTP is enabled on the
// account. On success the session is rotated (new session id, new
// CSRF token, absolute expiry and createdAt preserved) and the new
// row carries stepUpAt = now, which unlocks sensitive actions for 15
// minutes. The response body is { csrfToken } and the rotated
// session id travels in the Set-Cookie header, exactly like the
// login success shape minus the account fields.
//
// Enforcement layers, in order: the frozen global hook enforces
// session (401), then Origin (403 origin_rejected), then CSRF (403
// csrf_invalid). This route declares requiresAuth: true and adds no
// preHandler of its own.
//
// Anti-enumeration: every authentication failure answers one generic
// 401 invalid_credentials with one message, whether the password was
// wrong, the TOTP code was missing, wrong, or replayed, or the
// account holds no TOTP credential at all. The step-up endpoint
// never answers step_up_required (contract section 3.12): that code
// belongs to the actions step-up unlocks, not to step-up itself.
// Failures are counted only in the step-up bucket (5 failures per
// 15 minutes per account, desain-auth.md section 6.4); they never
// touch the login lockout.
//
// Registration: the integrator wires registerAuthStepUpRoutes in
// buildApp next to registerAuthCoreRoutes (AD-57: overlap workers
// never edit server/src/app.ts). This module does not self-register.
//
// No route in this file reads the Authorization header.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import { getPrincipal } from '../middleware/auth-hook.js';
import {
  STEP_UP_ACCOUNT_SCOPE,
  checkAccountFailureBucket,
  recordAccountFailureBucket,
  sendRateLimited,
} from '../middleware/rate-limit.js';
import { loadSessionAndUser } from '../middleware/session.js';
import { requireStore, type AuthContext } from '../auth/context.js';
import { buildSessionCookie, clientIp, truncateUserAgent } from '../auth/crypto.js';
import {
  recordAudit,
  rotateSessionForRow,
  sessionCookieMaxAgeSeconds,
  unavailableOnDbError,
} from '../auth/service.js';
import { deriveSealKey, unsealTotpSecret } from '../auth/totp-seal.js';
import { verifyTotpCode } from '../auth/totp-verify.js';
import {
  optionalString,
  requireBodyObject,
  requiredString,
  throwIfIssues,
  unknownFieldIssues,
  type FieldIssue,
} from '../auth/validation.js';
import { PASSWORD_MAX_LENGTH, STEP_UP_FAILURE_LIMIT, STEP_UP_FAILURE_WINDOW_MS } from '../auth/values.js';

export interface AuthStepUpRouteDeps {
  auth: AuthContext;
}

export async function registerAuthStepUpRoutes(app: FastifyInstance, deps: AuthStepUpRouteDeps): Promise<void> {
  const auth = deps.auth;

  // POST /api/auth/step-up: password re-verification (plus the
  // current TOTP code when TOTP is enabled), session rotation, and
  // a fresh step-up stamp. See the module header for the failure
  // semantics: one generic 401 for every verification failure.
  app.post(
    '/api/auth/step-up',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.unauthenticated();
      }
      const body = requireBodyObject(request.body);
      const issues: FieldIssue[] = [...unknownFieldIssues(body, ['password', 'code'])];
      const password = requiredString(body, 'password', issues, { maxCodePoints: PASSWORD_MAX_LENGTH });
      const code = optionalString(body, 'code', issues, { maxCodePoints: 64 });
      throwIfIssues(issues);

      const loaded = await loadSessionAndUser(auth, request, principal);
      if (loaded === null) {
        throw ApiError.unauthenticated();
      }
      const store = requireStore(auth);
      const nowMs = auth.clock();
      const now = new Date(nowMs);
      const ip = clientIp(request, auth.trustProxy) ?? null;
      const userAgent = truncateUserAgent(
        typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
      );

      const bucket = await checkAccountFailureBucket({
        store,
        scope: STEP_UP_ACCOUNT_SCOPE,
        userId: loaded.user.id,
        authSecret: auth.authSecret,
        limit: STEP_UP_FAILURE_LIMIT,
        windowMs: STEP_UP_FAILURE_WINDOW_MS,
        nowMs,
      });
      if (!bucket.allowed) {
        sendRateLimited(reply, request.id, bucket.retryAfterSeconds);
        return reply;
      }

      // The single failure path: count the failure, audit it, and
      // answer the generic 401. Every verification outcome below
      // funnels through here so no failure mode is distinguishable.
      const failStepUp = async (): Promise<never> => {
        await recordAccountFailureBucket({
          store,
          scope: STEP_UP_ACCOUNT_SCOPE,
          userId: loaded.user.id,
          authSecret: auth.authSecret,
          windowMs: STEP_UP_FAILURE_WINDOW_MS,
          nowMs,
        });
        await recordAudit(
          store,
          {
            userId: loaded.user.id,
            actorUserId: loaded.user.id,
            eventType: 'step_up_failed',
            ip,
            userAgent,
            metadata: {},
          },
          () => {
            request.log.warn({ event: 'step_up_failed' }, 'audit write failed');
          },
        );
        throw ApiError.invalidCredentials();
      };

      const passwordOk = await auth.hasher.verify(loaded.user.passwordHash, password as string);
      let totpStep: number | null = null;
      if (loaded.user.totpEnabled) {
        // TOTP accounts must also present the current code. A missing
        // credential, an unsealable secret, a wrong code, and a
        // replayed code all fail identically to a wrong password.
        // Verification alone never consumes the code: the step is
        // claimed only after the password has also verified.
        if (code !== undefined) {
          const credential = await unavailableOnDbError(() => store.findTotpCredential(loaded.user.id));
          const key = deriveSealKey(auth.encryptionKey);
          const secret =
            credential !== null && key !== null
              ? unsealTotpSecret(credential.secretSealed, key, credential.keyVersion)
              : null;
          if (secret !== null && credential !== null) {
            const result = verifyTotpCode({
              secretBase32: secret,
              code,
              nowMs,
              lastUsedStep: credential.lastUsedStep,
            });
            if (result.valid) {
              totpStep = result.step;
            }
          }
        }
        if (!passwordOk || totpStep === null) {
          await failStepUp();
        }
        const claimed = await unavailableOnDbError(() => store.claimTotpStep(loaded.user.id, totpStep as number, now));
        if (!claimed) {
          await failStepUp();
        }
      } else if (!passwordOk) {
        await failStepUp();
      }

      const created = await rotateSessionForRow(auth, store, loaded.row, request, now, now);
      await recordAudit(
        store,
        {
          userId: loaded.user.id,
          actorUserId: loaded.user.id,
          eventType: 'step_up_succeeded',
          ip,
          userAgent,
          metadata: {},
        },
        () => {
          request.log.warn({ event: 'step_up_succeeded' }, 'audit write failed');
        },
      );
      reply.header(
        'Set-Cookie',
        buildSessionCookie(
          created.sessionId,
          sessionCookieMaxAgeSeconds(created.row.absoluteExpiresAt, nowMs),
          { cookieSecure: auth.cookieSecure },
        ),
      );
      return reply.code(200).send(successEnvelope({ csrfToken: created.csrfToken }));
    },
  );
}
