// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// TOTP enrollment routes (kontrak-api-kanonis.md section 3.12;
// desain-auth.md section 1.4; V3-02 part 4). Four routes:
// enroll/start, enroll/confirm, disable, recovery-codes/regenerate.
// All four require a session plus a fresh step-up plus CSRF; the
// frozen global hook enforces session, Origin, and CSRF, and each
// handler enforces step-up freshness through the same seam the
// auth core uses for logout-all (loadSessionAndUser plus
// isStepUpFresh over sessions.step_up_at). The step-up endpoint
// itself belongs to a sibling worker; no step-up mechanism is
// invented here and no schema column is added.
//
// Sealing: secrets are sealed with sealTotpSecret over
// deriveSealKey(ENCRYPTION_KEY), the exact seam the login path
// unseals with (see auth/totp-seal.ts: V3-02 MUST seal with
// deriveSealKey). The settings SecretCipher parts form (separate
// ciphertext/nonce columns) cannot be stored in the single
// totp_credentials.secret_sealed text column and cannot be unsealed
// by unsealTotpSecret, so it is not used here. When no encryption
// key is configured, the routes that must seal or unseal fail
// closed with 503 and never store plaintext.
//
// Show-once: the staged secret and the recovery codes exist in
// plaintext only in the single response that creates them. The
// database holds the secret sealed and the codes hashed, no
// endpoint re-exposes them, and the show-once responses carry
// Cache-Control: no-store. A repeated enroll/start generates a
// fresh secret; it never re-serves the staged one.
//
// Wire shapes follow the auth group camelCase convention and the
// L2 reference harness: start answers { otpauthUrl, secret };
// confirm answers { totpEnabled: true, csrfToken }; disable
// answers { totpEnabled: false, csrfToken }; regenerate answers
// { codes } with exactly 10 codes. Confirm and disable rotate the
// current session (preserving its step-up and absolute expiry)
// and delete every other session of the account, without bumping
// the credential epoch (desain-auth.md section 3.5). Regenerate
// touches no session.
//
// Disable idempotency (contract section 3.12): disabling an
// account that already has TOTP off answers success with no
// rotation and no proof required, after the step-up check. The
// staged credential of an abandoned enrollment is cleaned up by
// the same path. An enabled account must prove possession with
// exactly one of a current TOTP code or an unused recovery code;
// every proof failure shares one generic 401
// invalid_verification_code.
//
// Persistence: credential and recovery-code writes go through the
// TotpEnrollmentStore port (services/auth/totp-enroll.ts) because
// AuthStore has no such write methods and this overlap batch must
// not edit existing auth files (AD-57). The integrator wires the
// Drizzle implementation into buildApp alongside the auth block;
// until then this module is registered only by tests. Rate
// limiting uses the general API bucket, whose global wiring
// belongs to the integrator (see middleware/rate-limit.ts); no
// per-route limiter is invented here.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrincipal } from '../middleware/auth-hook.js';
import { csrfTokenForSession } from '../middleware/csrf.js';
import { loadSessionAndUser, type LoadedSession } from '../middleware/session.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import { requireStore, type AuthContext } from '../auth/context.js';
import { buildSessionCookie, clientIp, hashToken, truncateUserAgent } from '../auth/crypto.js';
import {
  isStepUpFresh,
  recordAudit,
  rotateSessionForRow,
  sessionCookieMaxAgeSeconds,
  unavailableOnDbError,
} from '../auth/service.js';
import { deriveSealKey, sealTotpSecret, TOTP_SEAL_KEY_VERSION } from '../auth/totp-seal.js';
import { normalizeRecoveryCode } from '../auth/totp-verify.js';
import {
  optionalString,
  requireBodyObject,
  requiredString,
  throwIfIssues,
  unknownFieldIssues,
  type FieldIssue,
} from '../auth/validation.js';
import {
  buildOtpauthUrl,
  generateTotpSecret,
  isStageExpired,
  newRecoveryCodeBatch,
  RECOVERY_CODES_REGENERATED_EVENT,
  TOTP_DISABLED_EVENT,
  TOTP_ENROLLED_EVENT,
  verifyTotpProof,
  type TotpEnrollmentStore,
} from '../services/auth/totp-enroll.js';

export interface AuthTotpRouteDeps {
  auth: AuthContext;
  enrollment: TotpEnrollmentStore;
}

function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
}

function requestIp(request: FastifyRequest, auth: AuthContext): string | undefined {
  return clientIp(request, auth.trustProxy);
}

function requestUserAgent(request: FastifyRequest): string | undefined {
  const value = request.headers['user-agent'];
  return typeof value === 'string' ? value : undefined;
}

export async function registerAuthTotpRoutes(app: FastifyInstance, deps: AuthTotpRouteDeps): Promise<void> {
  const auth = deps.auth;
  const enrollment = deps.enrollment;
  const sessionRoute = () => ({ config: { requiresAuth: true } });

  const auditFailed = (request: FastifyRequest, eventType: string) => (): void => {
    request.log.warn({ event: eventType }, 'audit write failed');
  };

  // Loads the session row and owner, then enforces a fresh step-up.
  // The global hook already validated the session; a null load here
  // means only a race (revocation between hook and handler).
  const loadSteppedUp = async (request: FastifyRequest): Promise<LoadedSession> => {
    const principal = getPrincipal(request);
    if (principal === undefined) {
      throw ApiError.unauthenticated();
    }
    const loaded = await loadSessionAndUser(auth, request, principal);
    if (loaded === null) {
      throw ApiError.unauthenticated();
    }
    if (!isStepUpFresh(loaded.row.stepUpAt, auth.clock())) {
      throw ApiError.stepUpRequired();
    }
    return loaded;
  };

  // The seal key, or a fail-closed 503 when no encryption key is
  // configured. Callers that must seal or unseal use this; the
  // recovery-code proof path in disable does not need it.
  const sealKeyOr503 = (): Buffer => {
    const key = deriveSealKey(auth.encryptionKey);
    if (key === null) {
      throw ApiError.serviceUnavailable('Encryption is not configured.');
    }
    return key;
  };

  // Rotates the current session (step-up and absolute expiry
  // preserved), deletes every other session of the account, sets
  // the new session cookie, and returns the new CSRF token.
  const rotateAndRevokeOthers = async (
    request: FastifyRequest,
    reply: FastifyReply,
    loaded: LoadedSession,
    now: Date,
  ): Promise<string> => {
    const store = requireStore(auth);
    const rotated = await rotateSessionForRow(auth, store, loaded.row, request, now, loaded.row.stepUpAt);
    await unavailableOnDbError(() => enrollment.deleteOtherSessions(loaded.user.id, rotated.row.id));
    reply.header(
      'Set-Cookie',
      buildSessionCookie(
        rotated.sessionId,
        sessionCookieMaxAgeSeconds(rotated.row.absoluteExpiresAt, now.getTime()),
        { cookieSecure: auth.cookieSecure },
      ),
    );
    return rotated.csrfToken;
  };

  const auditTotpEvent = async (
    request: FastifyRequest,
    userId: string,
    eventType: typeof TOTP_ENROLLED_EVENT,
  ): Promise<void> => {
    const store = requireStore(auth);
    await recordAudit(
      store,
      {
        userId,
        actorUserId: userId,
        eventType,
        ip: requestIp(request, auth) ?? null,
        userAgent: truncateUserAgent(requestUserAgent(request)),
        metadata: {},
      },
      auditFailed(request, eventType as string),
    );
  };

  // POST /api/auth/totp/enroll/start: stage a fresh sealed secret
  // and show it once as an otpauth URL plus its Base32 string. The
  // body, if any, is ignored, like logout. The stage lives in
  // totp_enrollment_stages, apart from the live credential row, so
  // a re-enrollment never disturbs TOTP login until confirm
  // promotes the stage; a user who abandons a re-enrollment keeps
  // logging in with the old secret, and an expired stage simply
  // requires a fresh start.
  app.post('/api/auth/totp/enroll/start', sessionRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    const loaded = await loadSteppedUp(request);
    const key = sealKeyOr503();
    const secret = generateTotpSecret();
    const sealed = sealTotpSecret(secret, key);
    const now = new Date(auth.clock());
    await unavailableOnDbError(() =>
      enrollment.stageCredential({
        userId: loaded.user.id,
        secretSealed: sealed,
        keyVersion: TOTP_SEAL_KEY_VERSION,
        stagedAt: now,
      }),
    );
    noStore(reply);
    return reply.code(200).send(
      successEnvelope({
        otpauthUrl: buildOtpauthUrl(loaded.user.email, secret),
        secret,
      }),
    );
  });

  // POST /api/auth/totp/enroll/confirm: verify a code from the
  // staged secret, promote the stage into the live credential in
  // one transaction, and issue the initial recovery set. The
  // initial set is stored (hashed) but not displayed; the user
  // obtains visible codes through regenerate. An expired stage
  // (15 minutes, for a first enrollment or a re-enrollment alike)
  // is deleted and answers the generic code error, like every
  // other proof failure, leaving any live credential untouched.
  // The confirmation step is recorded by activation itself, so no
  // separate step claim runs here.
  app.post('/api/auth/totp/enroll/confirm', sessionRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    const body = requireBodyObject(request.body);
    const issues: FieldIssue[] = [...unknownFieldIssues(body, ['code'])];
    const code = requiredString(body, 'code', issues, { maxCodePoints: 64 });
    throwIfIssues(issues);
    const loaded = await loadSteppedUp(request);
    const key = sealKeyOr503();
    const nowMs = auth.clock();
    const now = new Date(nowMs);
    const stage = await unavailableOnDbError(() => enrollment.findStage(loaded.user.id));
    if (stage === null) {
      throw ApiError.invalidVerificationCode();
    }
    if (isStageExpired(stage, nowMs)) {
      await unavailableOnDbError(() => enrollment.deleteStage(loaded.user.id));
      throw ApiError.invalidVerificationCode();
    }
    const proof = verifyTotpProof({
      credential: { secretSealed: stage.secretSealed, keyVersion: stage.keyVersion, lastUsedStep: null },
      sealKey: key,
      code: code as string,
      nowMs,
    });
    if (!proof.valid) {
      throw ApiError.invalidVerificationCode();
    }
    const batch = newRecoveryCodeBatch(now);
    const activated = await unavailableOnDbError(() =>
      enrollment.activateEnrollment({
        userId: loaded.user.id,
        enrolledAt: now,
        verifiedAt: now,
        totpStep: proof.step,
        batch,
      }),
    );
    if (!activated) {
      throw ApiError.invalidVerificationCode();
    }
    await auditTotpEvent(request, loaded.user.id, TOTP_ENROLLED_EVENT);
    const csrfToken = await rotateAndRevokeOthers(request, reply, loaded, now);
    return reply.code(200).send(successEnvelope({ totpEnabled: true, csrfToken }));
  });

  // POST /api/auth/totp/disable: remove the credential and the
  // whole recovery set in one transaction. An account with TOTP
  // already off answers success without proof and without
  // rotation (contract idempotency); an enabled account must
  // prove possession with exactly one of a TOTP code or a
  // recovery code.
  app.post('/api/auth/totp/disable', sessionRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    const loaded = await loadSteppedUp(request);
    const store = requireStore(auth);
    const nowMs = auth.clock();
    const now = new Date(nowMs);
    if (!loaded.user.totpEnabled) {
      await unavailableOnDbError(() => enrollment.disableTotp(loaded.user.id, now));
      const csrfToken = csrfTokenForSession(loaded.row.sessionHash, auth.authSecret);
      if (csrfToken === null) {
        throw ApiError.serviceUnavailable('Authentication is not configured.');
      }
      return reply.code(200).send(successEnvelope({ totpEnabled: false, csrfToken }));
    }
    const body = requireBodyObject(request.body);
    const issues: FieldIssue[] = [...unknownFieldIssues(body, ['code', 'recoveryCode'])];
    const code = optionalString(body, 'code', issues, { maxCodePoints: 64 });
    const recoveryCode = optionalString(body, 'recoveryCode', issues, { maxCodePoints: 64 });
    const hasCode = 'code' in body;
    const hasRecoveryCode = 'recoveryCode' in body;
    if (hasCode && hasRecoveryCode) {
      issues.push({ field: 'recoveryCode', issue: 'provide exactly one of code and recoveryCode' });
    } else if (!hasCode && !hasRecoveryCode) {
      issues.push({ field: 'code', issue: 'code or recoveryCode is required' });
    }
    throwIfIssues(issues);
    let proven = false;
    if (code !== undefined) {
      const key = sealKeyOr503();
      const credential = await unavailableOnDbError(() => store.findTotpCredential(loaded.user.id));
      if (credential !== null) {
        const proof = verifyTotpProof({ credential, sealKey: key, code, nowMs });
        if (proof.valid) {
          proven = await unavailableOnDbError(() => store.claimTotpStep(loaded.user.id, proof.step, now));
        }
      }
    } else if (recoveryCode !== undefined) {
      const row = await unavailableOnDbError(() =>
        store.findUnusedRecoveryCode(loaded.user.id, hashToken(normalizeRecoveryCode(recoveryCode))),
      );
      // No separate mark-used: disable deletes the whole set in
      // the same transaction below, which consumes the code.
      proven = row !== null;
    }
    if (!proven) {
      throw ApiError.invalidVerificationCode();
    }
    await unavailableOnDbError(() => enrollment.disableTotp(loaded.user.id, now));
    await auditTotpEvent(request, loaded.user.id, TOTP_DISABLED_EVENT);
    const csrfToken = await rotateAndRevokeOthers(request, reply, loaded, now);
    return reply.code(200).send(successEnvelope({ totpEnabled: false, csrfToken }));
  });

  // POST /api/auth/totp/recovery-codes/regenerate: replace the
  // whole recovery set (used and unused) with 10 fresh codes,
  // shown once. Requires a valid TOTP code; a recovery code is
  // not accepted as proof here, and a disabled account answers
  // the generic code error.
  app.post(
    '/api/auth/totp/recovery-codes/regenerate',
    sessionRoute(),
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = requireBodyObject(request.body);
      const issues: FieldIssue[] = [...unknownFieldIssues(body, ['code'])];
      const code = requiredString(body, 'code', issues, { maxCodePoints: 64 });
      throwIfIssues(issues);
      const loaded = await loadSteppedUp(request);
      const key = sealKeyOr503();
      const store = requireStore(auth);
      const nowMs = auth.clock();
      const now = new Date(nowMs);
      const credential = await unavailableOnDbError(() => store.findTotpCredential(loaded.user.id));
      const proof =
        loaded.user.totpEnabled && credential !== null
          ? verifyTotpProof({ credential, sealKey: key, code: code as string, nowMs })
          : { valid: false as const };
      if (!proof.valid) {
        throw ApiError.invalidVerificationCode();
      }
      const claimed = await unavailableOnDbError(() => store.claimTotpStep(loaded.user.id, proof.step, now));
      if (!claimed) {
        throw ApiError.invalidVerificationCode();
      }
      const batch = newRecoveryCodeBatch(now);
      await unavailableOnDbError(() => enrollment.replaceRecoveryCodes(loaded.user.id, batch));
      await auditTotpEvent(request, loaded.user.id, RECOVERY_CODES_REGENERATED_EVENT);
      noStore(reply);
      return reply.code(200).send(successEnvelope({ codes: batch.codes }));
    },
  );
}
