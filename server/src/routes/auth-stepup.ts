// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Step-up route (kontrak-api-kanonis.md section 3.12; desain-auth.md
// section 3.5; V3-02 part 1).
//
// POST /api/auth/step-up re-authenticates the current session: the
// password, plus exactly one second factor when TOTP is enabled on
// the account: the current TOTP code or one unused recovery code
// (desain-auth.md section 1.4; DA-02-F04). The recovery-code
// alternative is the way back into TOTP management for a user who
// lost the authenticator; without it, a recovery-code login could
// never step up and the account counted down to lockout. A recovery
// code used here is consumed once and audited prominently, exactly
// as a recovery-code login is. On success the session is rotated
// (new session id, new CSRF token, absolute expiry and createdAt
// preserved) and the new row carries stepUpAt = now, which unlocks
// sensitive actions for 15 minutes. The response body is
// { csrfToken } and the rotated session id travels in the
// Set-Cookie header, exactly like the login success shape minus the
// account fields.
//
// Enforcement layers, in order: the frozen global hook enforces
// session (401), then Origin (403 origin_rejected), then CSRF (403
// csrf_invalid). This route declares requiresAuth: true and adds no
// preHandler of its own.
//
// Anti-enumeration: every authentication failure answers one generic
// 401 invalid_credentials with one message, whether the password was
// wrong, the TOTP code was missing, wrong, or replayed, the account
// holds no TOTP credential at all, the recovery code was missing,
// used, or wrong, or both or neither second factor was presented.
// The step-up endpoint never answers step_up_required (contract
// section 3.12): that code belongs to the actions step-up unlocks,
// not to step-up itself. Failures are counted only in the step-up
// bucket (5 failures per 15 minutes per account, desain-auth.md
// section 6.4); they never touch the login lockout.
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
import { buildSessionCookie, clientIp, hashToken, truncateUserAgent } from '../auth/crypto.js';
import {
  recordAudit,
  rotateSessionForRow,
  sessionCookieMaxAgeSeconds,
  unavailableOnDbError,
} from '../auth/service.js';
import { deriveSealKey, unsealTotpSecret } from '../auth/totp-seal.js';
import { normalizeRecoveryCode, verifyTotpCode } from '../auth/totp-verify.js';
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

  // POST /api/auth/step-up: password re-verification (plus exactly
  // one of the current TOTP code and an unused recovery code when
  // TOTP is enabled), session rotation, and a fresh step-up stamp.
  // See the module header for the failure semantics: one generic
  // 401 for every verification failure.
  app.post(
    '/api/auth/step-up',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.unauthenticated();
      }
      const body = requireBodyObject(request.body);
      const issues: FieldIssue[] = [...unknownFieldIssues(body, ['password', 'code', 'recoveryCode'])];
      const password = requiredString(body, 'password', issues, { maxCodePoints: PASSWORD_MAX_LENGTH });
      const code = optionalString(body, 'code', issues, { maxCodePoints: 64 });
      const recoveryCode = optionalString(body, 'recoveryCode', issues, { maxCodePoints: 64 });
      throwIfIssues(issues);
      // The exactly-one second-factor rule is enforced after the
      // account loads: it applies only when TOTP is enabled, and
      // accounts without TOTP ignore both factor fields, exactly as
      // the code field was already ignored for them.

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
      let usedRecovery = false;
      if (loaded.user.totpEnabled) {
        // TOTP accounts must also present exactly one second factor:
        // the current TOTP code or one unused recovery code. Both
        // together, or neither, fail exactly like a wrong password,
        // so no failure mode is distinguishable. Verification alone
        // never consumes anything: the TOTP step is claimed, and
        // the recovery code is marked used, only after the password
        // has also verified.
        const hasCode = code !== undefined;
        const hasRecoveryCode = recoveryCode !== undefined;
        if (hasCode === hasRecoveryCode) {
          await failStepUp();
        }
        if (hasCode) {
          let totpStep: number | null = null;
          const credential = await unavailableOnDbError(() => store.findTotpCredential(loaded.user.id));
          const key = deriveSealKey(auth.encryptionKey);
          const secret =
            credential !== null && key !== null
              ? unsealTotpSecret(credential.secretSealed, key, credential.keyVersion)
              : null;
          if (secret !== null && credential !== null) {
            const result = verifyTotpCode({
              secretBase32: secret,
              code: code as string,
              nowMs,
              lastUsedStep: credential.lastUsedStep,
            });
            if (result.valid) {
              totpStep = result.step;
            }
          }
          if (!passwordOk || totpStep === null) {
            await failStepUp();
          }
          const claimed = await unavailableOnDbError(() =>
            store.claimTotpStep(loaded.user.id, totpStep as number, now),
          );
          if (!claimed) {
            await failStepUp();
          }
        } else {
          // Recovery-code step-up (desain-auth.md section 1.4;
          // DA-02-F04): the only way back into TOTP management for
          // a user who lost the authenticator. The lookup is
          // read-only; the code is consumed by the conditional
          // mark below, after the password has verified, so a
          // wrong password never burns a code and a concurrent
          // use of the same code loses the race.
          const row = await unavailableOnDbError(() =>
            store.findUnusedRecoveryCode(loaded.user.id, hashToken(normalizeRecoveryCode(recoveryCode as string))),
          );
          if (!passwordOk || row === null) {
            await failStepUp();
          }
          const marked = await unavailableOnDbError(() => store.markRecoveryCodeUsed(row.id, now));
          if (!marked) {
            await failStepUp();
          }
          usedRecovery = true;
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
          metadata: { recoveryCodeUsed: usedRecovery },
        },
        () => {
          request.log.warn({ event: 'step_up_succeeded' }, 'audit write failed');
        },
      );
      if (usedRecovery) {
        await recordAudit(
          store,
          {
            userId: loaded.user.id,
            actorUserId: loaded.user.id,
            eventType: 'recovery_code_used',
            ip,
            userAgent,
            metadata: {},
          },
          () => {
            request.log.warn({ event: 'recovery_code_used' }, 'audit write failed');
          },
        );
      }
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
