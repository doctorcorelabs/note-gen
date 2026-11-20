// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Core auth routes (kontrak-api-kanonis.md section 3.12; V3-01).
// Ten routes: first-account setup, two-step login, logout and
// logout-all, session list and revoke, CSRF token, me, and register
// (404 by design). Step-up, password change and
// reset, TOTP enrollment, and admin routes belong to V3-02 and live
// in their own route modules; this file must not grow them.
//
// Enforcement layers, in order, for every route:
// - Public routes (setup, login, login/totp, register) declare
//   requiresAuth: false so the frozen global hook skips them, and
//   attach the frozen Origin preHandler: no session exists yet, so
//   CSRF cannot apply, but Origin must still match (desain-auth.md
//   section 5.3).
// - Session routes rely on the frozen global hook for session (401),
//   Origin (403 origin_rejected), then CSRF (403 csrf_invalid), in
//   that order. Handlers re-load the session row and owner through
//   loadSessionAndUser when they need more than the principal.
// - Bodies are validated strictly: unknown fields are rejected with
//   details.fields (kontrak section 1.5). Logout, logout-all, and
//   session revoke carry no body schema and ignore any body sent.
// - Setup, login, and login/totp answers carry Cache-Control
//   no-store, set at handler entry so error answers keep it too
//   (T-28-1).
// - Anti-enumeration: login failures for unknown emails, wrong
//   passwords, and disabled accounts share one 401 code, one
//   message, and the same Argon2 cost (dummy verification for
//   unknown emails). Session revocation answers the same 404 for a
//   missing id and for an id owned by another account.
//
// Logout-all requires a fresh step-up (403 step_up_required without
// one). The step-up endpoint itself is V3-02, so until it lands a
// session can only satisfy this check when its stepUpAt was set by
// that future endpoint; the check itself is implemented here and is
// contract-correct from day one.
//
// No route in this file reads the Authorization header. A request
// carrying only a Bearer token and no valid session cookie is
// answered 401 by the hook, exactly like a request with no
// credentials (kontrak section 1.2 item 4).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import { createOriginPreHandler, getPrincipal } from '../middleware/auth-hook.js';
import { csrfTokenForSession } from '../middleware/csrf.js';
import {
  checkAndCountSetupAttempt,
  checkLockout,
  checkLoginBuckets,
  recordLoginFailureBuckets,
  recordLoginFailureLockout,
  recordLoginIpFailureBucket,
  sendRateLimited,
} from '../middleware/rate-limit.js';
import { loadSessionAndUser } from '../middleware/session.js';
import { requireStore, type AuthContext } from '../auth/context.js';
import {
  buildSessionCookie,
  clearSessionCookie,
  clientIp,
  hashToken,
  isPlausibleEmail,
  isUuid,
  newOpaqueToken,
  normalizeEmail,
  safeEqual,
  truncateUserAgent,
  userAgentHash,
} from '../auth/crypto.js';
import { passwordShapeIssue } from '../auth/passwords.js';
import {
  assertRole,
  createSessionForLogin,
  isStepUpFresh,
  recordAudit,
  sessionCookieMaxAgeSeconds,
  toSessionListEntry,
  unavailableOnDbError,
  type LoginSuccessData,
  type MeData,
} from '../auth/service.js';
import { InstallationAlreadyCompletedError, type AuthUserRow } from '../auth/store.js';
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
import { LOGIN_CHALLENGE_MAX_ATTEMPTS, LOGIN_CHALLENGE_MS, PASSWORD_MAX_LENGTH } from '../auth/values.js';

export interface AuthCoreRouteDeps {
  auth: AuthContext;
}

const DEFAULT_WORKSPACE_NAME = 'Workspace';

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

export async function registerAuthCoreRoutes(app: FastifyInstance, deps: AuthCoreRouteDeps): Promise<void> {
  const auth = deps.auth;
  // Single-account enforcement (DA-22-07, S-P0-13/S-P0-14/S-P0-15):
  // the register handler below answers 404 in every mode, but a
  // non-closed mode must never reach route registration silently.
  // loadConfig already refuses non-closed values at boot; this guard
  // covers programmatically built contexts (tests, embeds) so a
  // misconfigured context fails fast here instead of booting an
  // installation that advertises a registration flow it does not
  // have. The message names the variable only, never its value.
  if (auth.registrationMode !== 'closed') {
    throw new Error(
      'REGISTRATION_MODE must be closed: invitation and open registration are not implemented.',
    );
  }
  const originCheck = createOriginPreHandler(auth.canonicalOrigin);
  // Factories, not shared objects: Fastify keeps route options, so
  // each registration gets a fresh options object.
  const publicRoute = () => ({ config: { requiresAuth: false }, preHandler: [originCheck] });
  const sessionRoute = () => ({ config: { requiresAuth: true } });

  const auditFailed = (request: FastifyRequest, eventType: string) => (): void => {
    request.log.warn({ event: eventType }, 'audit write failed');
  };

  // Shared finish for both login paths: create the session, stamp the
  // login time, audit, set the cookie, and return the login success
  // shape. Called only after the caller has fully authenticated the
  // user (password alone, or password plus TOTP/recovery code).
  const issueSessionAndRespond = async (
    request: FastifyRequest,
    reply: FastifyReply,
    user: AuthUserRow,
    options: { recoveryCodeUsed: boolean },
  ): Promise<FastifyReply> => {
    const store = requireStore(auth);
    const now = new Date(auth.clock());
    const created = await createSessionForLogin(auth, store, user, request, now);
    await unavailableOnDbError(() => store.updateUserLastLogin(user.id, now));
    const ip = requestIp(request, auth) ?? null;
    const userAgent = truncateUserAgent(requestUserAgent(request));
    await recordAudit(
      store,
      {
        userId: user.id,
        actorUserId: user.id,
        eventType: 'login_succeeded',
        ip,
        userAgent,
        metadata: { recoveryCodeUsed: options.recoveryCodeUsed },
      },
      auditFailed(request, 'login_succeeded'),
    );
    if (options.recoveryCodeUsed) {
      await recordAudit(
        store,
        {
          userId: user.id,
          actorUserId: user.id,
          eventType: 'recovery_code_used',
          ip,
          userAgent,
          metadata: {},
        },
        auditFailed(request, 'recovery_code_used'),
      );
    }
    const body: LoginSuccessData = {
      id: user.id,
      email: user.email,
      role: assertRole(user.role),
      totpEnabled: user.totpEnabled,
      csrfToken: created.csrfToken,
      sessionExpiresAt: created.row.absoluteExpiresAt.toISOString(),
    };
    reply.header(
      'Set-Cookie',
      buildSessionCookie(
        created.sessionId,
        sessionCookieMaxAgeSeconds(created.row.absoluteExpiresAt, now.getTime()),
        { cookieSecure: auth.cookieSecure },
      ),
    );
    return reply.code(200).send(successEnvelope(body));
  };

  // POST /api/auth/setup: first account, only while installation is
  // open. 201 with account id, email, and workspace id. No session
  // is created: the operator logs in through the normal flow.
  app.post('/api/auth/setup', publicRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const body = requireBodyObject(request.body);
    const issues: FieldIssue[] = [...unknownFieldIssues(body, ['setupToken', 'email', 'password', 'workspaceName'])];
    const setupToken = requiredString(body, 'setupToken', issues, { maxCodePoints: 1024 });
    const emailRaw = requiredString(body, 'email', issues, { maxCodePoints: 254 });
    const password = requiredString(body, 'password', issues, { maxCodePoints: PASSWORD_MAX_LENGTH });
    const workspaceNameRaw = optionalString(body, 'workspaceName', issues, {
      maxCodePoints: 128,
      minTrimmedLength: 1,
    });
    if (emailRaw !== undefined && !isPlausibleEmail(emailRaw)) {
      issues.push({ field: 'email', issue: 'email must be a valid email address' });
    }
    if (password !== undefined) {
      const shapeIssue = passwordShapeIssue(password);
      if (shapeIssue !== null) {
        issues.push({ field: 'password', issue: shapeIssue });
      }
    }
    throwIfIssues(issues);
    const email = normalizeEmail(emailRaw as string);
    const workspaceName = workspaceNameRaw === undefined ? DEFAULT_WORKSPACE_NAME : workspaceNameRaw.trim();

    const store = requireStore(auth);
    const nowMs = auth.clock();
    const completed = await unavailableOnDbError(() => store.isInstallationCompleted());
    if (completed) {
      throw ApiError.notFound();
    }
    const ip = requestIp(request, auth);
    const rate = await checkAndCountSetupAttempt({ store, ip, authSecret: auth.authSecret, nowMs });
    if (!rate.allowed) {
      sendRateLimited(reply, request.id, rate.retryAfterSeconds);
      return reply;
    }
    const configured = auth.setupToken;
    const tokenOk =
      configured !== undefined && configured !== '' && safeEqual(hashToken(setupToken as string), hashToken(configured));
    if (!tokenOk) {
      await recordAudit(
        store,
        {
          userId: null,
          actorUserId: null,
          eventType: 'installation_failed',
          ip: ip ?? null,
          userAgent: truncateUserAgent(requestUserAgent(request)),
          metadata: {},
        },
        auditFailed(request, 'installation_failed'),
      );
      throw ApiError.invalidSetupToken();
    }
    const passwordHash = await auth.hasher.hash(password as string);
    try {
      const created = await store.createFirstAccount({
        email,
        passwordHash,
        workspaceName,
        now: new Date(nowMs),
        ip: ip ?? null,
        userAgent: truncateUserAgent(requestUserAgent(request)),
      });
      return reply.code(201).send(successEnvelope({ id: created.userId, email, workspaceId: created.workspaceId }));
    } catch (error) {
      if (error instanceof InstallationAlreadyCompletedError) {
        // Race loser: another setup won the advisory lock. Same
        // generic 404 as a completed installation.
        throw ApiError.notFound();
      }
      throw ApiError.serviceUnavailable('The database is not available.');
    }
  });

  // POST /api/auth/login: step 1 (password). 200 with a session when
  // TOTP is off; 202 with a challenge token and no cookie when TOTP
  // is on. Failures are generic and costed identically (see the
  // module header).
  app.post('/api/auth/login', publicRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const body = requireBodyObject(request.body);
    const issues: FieldIssue[] = [...unknownFieldIssues(body, ['email', 'password'])];
    const emailRaw = requiredString(body, 'email', issues, { maxCodePoints: 254 });
    const password = requiredString(body, 'password', issues, { maxCodePoints: PASSWORD_MAX_LENGTH });
    if (emailRaw !== undefined && !isPlausibleEmail(emailRaw)) {
      issues.push({ field: 'email', issue: 'email must be a valid email address' });
    }
    throwIfIssues(issues);
    const email = normalizeEmail(emailRaw as string);
    const passwordValue = password as string;

    const store = requireStore(auth);
    const nowMs = auth.clock();
    const ip = requestIp(request, auth);
    const buckets = await checkLoginBuckets({ store, email, ip, authSecret: auth.authSecret, nowMs });
    if (!buckets.allowed) {
      sendRateLimited(reply, request.id, buckets.retryAfterSeconds);
      return reply;
    }
    const user = await unavailableOnDbError(() => store.findUserByEmail(email));
    if (user !== null) {
      const lockout = await checkLockout(store, user.id, nowMs);
      if (lockout.locked) {
        // One login_locked event per locked attempt (katalog 12.1):
        // repeated attempts inside the lockout window each write
        // one event, so the audit trail shows every enforcement.
        // Best-effort like the sibling login events: a failed audit
        // write logs a warning and never changes the 429.
        await recordAudit(
          store,
          {
            userId: user.id,
            actorUserId: null,
            eventType: 'login_locked',
            ip: ip ?? null,
            userAgent: truncateUserAgent(requestUserAgent(request)),
            metadata: { lockoutLevel: lockout.lockoutLevel, lockoutDurationMs: lockout.lockoutDurationMs },
          },
          auditFailed(request, 'login_locked'),
        );
        sendRateLimited(reply, request.id, lockout.retryAfterSeconds);
        return reply;
      }
    }
    let passwordOk = false;
    if (user !== null) {
      passwordOk = await auth.hasher.verify(user.passwordHash, passwordValue);
      if (user.status !== 'active') {
        // Verify anyway for identical timing, then fail generically:
        // a disabled account must be indistinguishable from a wrong
        // password.
        passwordOk = false;
      }
    } else {
      const dummyHash = await auth.dummyPasswordHash();
      await auth.hasher.verify(dummyHash, passwordValue);
    }
    if (!passwordOk || user === null) {
      await recordLoginFailureBuckets({ store, email, ip, authSecret: auth.authSecret, nowMs });
      if (user !== null) {
        await recordLoginFailureLockout(store, user.id, new Date(nowMs));
      }
      await recordAudit(
        store,
        {
          userId: user?.id ?? null,
          actorUserId: null,
          eventType: 'login_failed',
          ip: ip ?? null,
          userAgent: truncateUserAgent(requestUserAgent(request)),
          metadata: {},
        },
        auditFailed(request, 'login_failed'),
      );
      throw ApiError.invalidCredentials();
    }
    await unavailableOnDbError(() => store.clearLockout(user.id));
    if (auth.hasher.needsRehash(user.passwordHash)) {
      const nextHash = await auth.hasher.hash(passwordValue);
      await unavailableOnDbError(() => store.updateUserPasswordHash(user.id, nextHash));
    }
    if (!user.totpEnabled) {
      return issueSessionAndRespond(request, reply, user, { recoveryCodeUsed: false });
    }
    const challengeToken = newOpaqueToken();
    await unavailableOnDbError(() =>
      store.createLoginChallenge({
        userId: user.id,
        challengeHash: hashToken(challengeToken),
        createdIp: ip ?? null,
        userAgentHash: userAgentHash(requestUserAgent(request)),
        expiresAt: new Date(nowMs + LOGIN_CHALLENGE_MS),
      }),
    );
    return reply.code(202).send(successEnvelope({ challengeToken, step: 'totp' }));
  });

  // POST /api/auth/login/totp: step 2 (TOTP code or recovery code).
  // 200 with the same login success shape. Every failure mode shares
  // one 401 invalid_verification_code.
  app.post('/api/auth/login/totp', publicRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const body = requireBodyObject(request.body);
    const issues: FieldIssue[] = [...unknownFieldIssues(body, ['challengeToken', 'code', 'recoveryCode'])];
    const challengeToken = requiredString(body, 'challengeToken', issues, { maxCodePoints: 1024 });
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

    const store = requireStore(auth);
    const nowMs = auth.clock();
    const now = new Date(nowMs);
    const ip = requestIp(request, auth);
    const userAgent = requestUserAgent(request);
    const challenge = await unavailableOnDbError(() => store.findChallengeByHash(hashToken(challengeToken as string)));
    if (challenge === null) {
      await recordLoginIpFailureBucket({ store, ip, authSecret: auth.authSecret, nowMs });
      throw ApiError.invalidVerificationCode();
    }
    if (challenge.expiresAt.getTime() <= nowMs || challenge.attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS) {
      await unavailableOnDbError(() => store.deleteChallengeById(challenge.id));
      throw ApiError.invalidVerificationCode();
    }
    const user = await unavailableOnDbError(() => store.findUserById(challenge.userId));
    if (user === null || user.status !== 'active' || !user.totpEnabled) {
      await unavailableOnDbError(() => store.deleteChallengeById(challenge.id));
      throw ApiError.invalidVerificationCode();
    }
    const bindingFailed = async (): Promise<never> => {
      await unavailableOnDbError(() => store.deleteChallengeById(challenge.id));
      await recordAudit(
        store,
        {
          userId: user.id,
          actorUserId: null,
          eventType: 'login_failed',
          ip: ip ?? null,
          userAgent: truncateUserAgent(userAgent),
          metadata: { challengeBinding: 'mismatch' },
        },
        auditFailed(request, 'login_failed'),
      );
      throw ApiError.invalidVerificationCode();
    };
    // IP binding applies only when an IP was recorded at both steps
    // (desain-auth.md section 1.6); the User-Agent binding is strict
    // (both absent passes, anything else must match exactly).
    if (challenge.createdIp !== null && ip !== undefined && challenge.createdIp !== ip) {
      await bindingFailed();
    }
    if (challenge.userAgentHash !== userAgentHash(userAgent)) {
      await bindingFailed();
    }
    let verified = false;
    let usedRecovery = false;
    if (code !== undefined) {
      const credential = await unavailableOnDbError(() => store.findTotpCredential(user.id));
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
          verified = await unavailableOnDbError(() => store.claimTotpStep(user.id, result.step, now));
        }
      }
    } else if (recoveryCode !== undefined) {
      const row = await unavailableOnDbError(() =>
        store.findUnusedRecoveryCode(user.id, hashToken(normalizeRecoveryCode(recoveryCode))),
      );
      if (row !== null) {
        verified = await unavailableOnDbError(() => store.markRecoveryCodeUsed(row.id, now));
        usedRecovery = verified;
      }
    }
    if (!verified) {
      const attempts = await unavailableOnDbError(() => store.incrementChallengeAttempts(challenge.id));
      if (attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS) {
        await unavailableOnDbError(() => store.deleteChallengeById(challenge.id));
      }
      await recordLoginFailureLockout(store, user.id, now);
      await recordLoginFailureBuckets({ store, email: user.email, ip, authSecret: auth.authSecret, nowMs });
      await recordAudit(
        store,
        {
          userId: user.id,
          actorUserId: null,
          eventType: 'login_failed',
          ip: ip ?? null,
          userAgent: truncateUserAgent(userAgent),
          metadata: {},
        },
        auditFailed(request, 'login_failed'),
      );
      throw ApiError.invalidVerificationCode();
    }
    await unavailableOnDbError(() => store.deleteChallengeById(challenge.id));
    await unavailableOnDbError(() => store.clearLockout(user.id));
    return issueSessionAndRespond(request, reply, user, { recoveryCodeUsed: usedRecovery });
  });

  // POST /api/auth/logout: delete the current session server-side
  // and clear the cookie. 200 with null data.
  app.post('/api/auth/logout', sessionRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = getPrincipal(request);
    if (principal === undefined) {
      throw ApiError.unauthenticated();
    }
    const store = requireStore(auth);
    await unavailableOnDbError(() => store.deleteSessionById(principal.sessionId));
    await recordAudit(
      store,
      {
        userId: principal.userId,
        actorUserId: principal.userId,
        eventType: 'logout',
        ip: requestIp(request, auth) ?? null,
        userAgent: truncateUserAgent(requestUserAgent(request)),
        metadata: {},
      },
      auditFailed(request, 'logout'),
    );
    reply.header('Set-Cookie', clearSessionCookie({ cookieSecure: auth.cookieSecure }));
    return reply.code(200).send(successEnvelope(null));
  });

  // POST /api/auth/logout-all: delete every session of the account,
  // bump the credential epoch, and clear the cookie. Requires a
  // fresh step-up (403 step_up_required otherwise).
  app.post('/api/auth/logout-all', sessionRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
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
    const store = requireStore(auth);
    await unavailableOnDbError(() =>
      store.bumpEpochAndRevokeAllSessions(loaded.user.id, {
        userId: loaded.user.id,
        actorUserId: loaded.user.id,
        eventType: 'logout_all',
        ip: requestIp(request, auth) ?? null,
        userAgent: truncateUserAgent(requestUserAgent(request)),
        metadata: {},
      }),
    );
    reply.header('Set-Cookie', clearSessionCookie({ cookieSecure: auth.cookieSecure }));
    return reply.code(200).send(successEnvelope(null));
  });

  // GET /api/auth/sessions: the requester's own sessions, newest
  // activity first. No session ids, hashes, or CSRF tokens.
  app.get('/api/auth/sessions', sessionRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = getPrincipal(request);
    if (principal === undefined) {
      throw ApiError.unauthenticated();
    }
    const store = requireStore(auth);
    const rows = await unavailableOnDbError(() => store.listSessionsByUser(principal.userId));
    noStore(reply);
    return reply.code(200).send(successEnvelope(rows.map((row) => toSessionListEntry(row, principal.sessionId))));
  });

  // DELETE /api/auth/sessions/:id: revoke one own session. A missing
  // id and an id owned by another account share one 404. Revoking
  // the current session also clears the cookie.
  app.delete('/api/auth/sessions/:id', sessionRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = getPrincipal(request);
    if (principal === undefined) {
      throw ApiError.unauthenticated();
    }
    const params = request.params as { id?: unknown };
    const id = typeof params.id === 'string' ? params.id : '';
    if (!isUuid(id)) {
      throw ApiError.notFound();
    }
    const store = requireStore(auth);
    const row = await unavailableOnDbError(() => store.findSessionById(id));
    if (row === null || row.userId !== principal.userId) {
      throw ApiError.notFound();
    }
    await unavailableOnDbError(() => store.deleteSessionById(id));
    await recordAudit(
      store,
      {
        userId: principal.userId,
        actorUserId: principal.userId,
        eventType: 'session_revoked',
        ip: requestIp(request, auth) ?? null,
        userAgent: truncateUserAgent(requestUserAgent(request)),
        metadata: { revokedSessionId: id },
      },
      auditFailed(request, 'session_revoked'),
    );
    if (id === principal.sessionId) {
      reply.header('Set-Cookie', clearSessionCookie({ cookieSecure: auth.cookieSecure }));
    }
    return reply.code(200).send(successEnvelope(null));
  });

  // GET /api/auth/csrf: the raw CSRF token for the current session,
  // derived deterministically (no state change in this GET). The
  // frontend re-fetches it after a reload, when its in-memory copy
  // is gone. Never cached.
  app.get('/api/auth/csrf', sessionRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = getPrincipal(request);
    if (principal === undefined) {
      throw ApiError.unauthenticated();
    }
    const loaded = await loadSessionAndUser(auth, request, principal);
    if (loaded === null) {
      throw ApiError.unauthenticated();
    }
    const csrfToken = csrfTokenForSession(loaded.row.sessionHash, auth.authSecret);
    if (csrfToken === null) {
      throw ApiError.serviceUnavailable('Authentication is not configured.');
    }
    noStore(reply);
    return reply.code(200).send(successEnvelope({ csrfToken }));
  });

  // GET /api/auth/me: account metadata, TOTP status, and current
  // session info. No secrets. This is the boot guard probe endpoint
  // (src/lib/web/session-check.ts): 200 with ok true means
  // authenticated, 401/403 means unauthenticated, anything else
  // blocks entry. The envelope shape here is what the guard checks;
  // the data fields beyond ok are for the UI and are intentionally
  // tolerant on the guard side.
  app.get('/api/auth/me', sessionRoute(), async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = getPrincipal(request);
    if (principal === undefined) {
      throw ApiError.unauthenticated();
    }
    const loaded = await loadSessionAndUser(auth, request, principal);
    if (loaded === null) {
      throw ApiError.unauthenticated();
    }
    const store = requireStore(auth);
    const workspace = await unavailableOnDbError(() => store.findFirstWorkspaceByOwner(loaded.user.id));
    const body: MeData = {
      id: loaded.user.id,
      email: loaded.user.email,
      role: assertRole(loaded.user.role),
      totpEnabled: loaded.user.totpEnabled,
      createdAt: loaded.user.createdAt.toISOString(),
      lastLoginAt: loaded.user.lastLoginAt === null ? null : loaded.user.lastLoginAt.toISOString(),
      workspaceId: workspace === null ? null : workspace.id,
      session: {
        id: loaded.row.id,
        deviceLabel: loaded.row.deviceLabel ?? 'Unknown device',
        createdAt: loaded.row.createdAt.toISOString(),
        lastSeenAt: loaded.row.lastSeenAt.toISOString(),
        absoluteExpiresAt: loaded.row.absoluteExpiresAt.toISOString(),
        stepUpAt: loaded.row.stepUpAt === null ? null : loaded.row.stepUpAt.toISOString(),
      },
    };
    noStore(reply);
    return reply.code(200).send(successEnvelope(body));
  });

  // POST /api/auth/register: 404 by design, in every mode. No account
  // can ever be created through this endpoint while it answers 404,
  // and the response advertises nothing about the deployment mode.
  // Registration flows (invitation, open) do not exist; adding one
  // requires the multi-account filesystem isolation of S-P0-13,
  // S-P0-14, and S-P0-15 plus a recorded decision. The Origin check
  // still applies: this is a public mutation.
  app.post('/api/auth/register', publicRoute(), async () => {
    throw ApiError.notFound();
  });
}
