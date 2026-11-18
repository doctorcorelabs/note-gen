// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fastify application factory. buildApp creates the instance and
// registers routes, but never listens: only server.ts calls listen(),
// so tests can exercise the app with inject() without opening a port.
//
// Foundation wiring (Fase 1, V2-02), in registration order:
// 1. Request ids: genReqId honors a well-formed client X-Request-Id
//    and otherwise generates a UUID; every reply echoes the id in the
//    X-Request-Id header, and error envelopes carry the same id.
// 2. Error handling: unknown paths answer 404 with the generic error
//    envelope; health paths keep the Fase 0 emergency envelope safety
//    net; all other errors become the generic envelope without leaking
//    messages, stack traces, or config values.
// 3. Auth hooks: the Cloudflare Access preHandler (when enabled in
//    config) runs BEFORE the session hook, so a request without a
//    valid Access JWT never reaches session verification
//    (desain-auth.md section 7.3 order; AD-132; AD-133). Routes under /api/
//    are protected by default (see middleware/auth-hook.ts). Health
//    routes are explicitly public at the session layer; at the
//    Access layer only the exemption predicate in
//    middleware/cf-access-exemptions.ts skips verification.
//    Without an injected verifySession, protected routes answer 401:
//    the foundation is deny-by-default until the auth worker lands.
// 4. Route groups (AD-61): registered by the generated index
//    (routes-generated.ts), which calls one handwritten adapter
//    per group in rank order. Health routes keep their Fase 0
//    behavior; the adapters live in routes/*.registration.ts.
// 5. Auth core routes (V3-01, AD-40): registered by the auth-core
//    adapter only when an auth context is injected through
//    AppDeps. Without the injection, no auth route exists and
//    the deny-by-default behavior of point 3 is unchanged.
//
// Request logging is disabled: health probes arrive every few seconds
// from watchdogs and container healthchecks, and successful probes must
// not flood the log. Failed checks are logged by the ready handler
// itself, with error codes only. Credential-carrying headers are
// redacted at the logger level (see plugins/logging.ts).

import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { AuthContext } from './auth/context.js';
import type { ServerConfig } from './config.js';
import type { HealthDbPool } from './db/pool.js';
import {
  createCfAccessPreHandler,
  createCfAccessVerifier,
  resolveCfAccessConfig,
} from './middleware/cf-access.js';
import { isCfAccessExemptRequest } from './middleware/cf-access-exemptions.js';
import {
  registerAuthHooks,
  type VerifyCsrfTokenFn,
  type VerifyOriginFn,
  type VerifySessionFn,
} from './middleware/auth-hook.js';
import { createCsrfVerifier } from './middleware/csrf.js';
import { createSessionVerifier } from './middleware/session.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { buildLoggerOptions } from './plugins/logging.js';
import { registerRequestId, requestIdFromHeaders } from './plugins/request-id.js';
import { createCloseRegistry } from './registration/close-registry.js';
import { registerRouteGroups } from './routes-generated.js';

export interface AppDeps {
  config: ServerConfig;
  pool: HealthDbPool | null;
  version: string;
  // Injected by the auth worker. When absent, the deny-by-default
  // stubs in middleware/auth-hook.ts apply (401 for protected routes,
  // 403 for authenticated mutations). Never allow-by-default.
  verifySession?: VerifySessionFn;
  verifyCsrf?: VerifyCsrfTokenFn;
  verifyOrigin?: VerifyOriginFn;
  // Auth context injected by the auth worker (V3-01, AD-40). When
  // present, the auth-core adapter registers its routes and the
  // session/CSRF verifiers are derived from it, unless explicit
  // verifiers above are also given (explicit wins, so foundation
  // tests keep injecting stubs). When absent, no auth route exists
  // and the foundation deny-by-default behavior is unchanged.
  // server.ts injects the production context; tests inject a context
  // built with a fake store. One context feeds one app: buildApp
  // closes it on app.close().
  auth?: AuthContext;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(deps.config.logLevel),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: deps.config.maxBodyBytes,
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });

  registerRequestId(app);
  registerErrorHandling(app, { version: deps.version });
  // Cloudflare Access perimeter (desain-auth.md section 7; AD-132,
  // PREDEPLOY finding F-02; AD-133). When verification is enabled, the
  // preHandler is registered BEFORE the session hook, so the layer
  // order is Access, then session, then CSRF/Origin. Construction
  // throws on an enabled-but-incomplete config (missing audience or
  // team domain), which loadConfig already refuses at boot; a throw
  // here fails closed the same way. When verification is disabled
  // (dev local only, enforced by loadConfig), no hook is installed
  // and no verifier is built. The exemption predicate lives in
  // middleware/cf-access-exemptions.ts; session behavior is
  // unchanged by this block.
  if (deps.config.cfAccessEnabled) {
    const verifier = createCfAccessVerifier(resolveCfAccessConfig(deps.config));
    app.addHook('preHandler', createCfAccessPreHandler(verifier, { isExempt: isCfAccessExemptRequest }));
  }
  // Resolve the verifiers before the hooks: explicit injections win,
  // then verifiers derived from the injected auth context, then the
  // deny-by-default stubs inside registerAuthHooks (undefined here).
  // verifyOrigin is never derived: the hook's default Origin matcher
  // applies when no explicit verifier is given.
  const verifySession = deps.verifySession ?? (deps.auth === undefined ? undefined : createSessionVerifier(deps.auth));
  const verifyCsrf = deps.verifyCsrf ?? (deps.auth === undefined ? undefined : createCsrfVerifier(deps.auth));
  registerAuthHooks(app, {
    verifySession,
    verifyCsrf,
    verifyOrigin: deps.verifyOrigin,
    canonicalOrigin: deps.config.publicBaseUrl,
  });

  // Route groups (AD-61): one handwritten adapter per group, called
  // in rank order by the generated index (routes-generated.ts).
  // Adapters live in routes/*.registration.ts; the frozen
  // middleware shape above is unchanged. The shared close registry
  // travels in the context: the auth-core adapter appends the auth
  // close step and registers the single onClose hook, the db
  // adapter appends the db close step (FIX-05, AD-81/B-12).
  const closeRegistry = createCloseRegistry();
  await registerRouteGroups({
    app,
    config: deps.config,
    pool: deps.pool,
    version: deps.version,
    auth: deps.auth,
    close: closeRegistry,
  });

  return app;
}
