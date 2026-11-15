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
// 3. Auth hooks: routes under /api/ are protected by default (see
//    middleware/auth-hook.ts). Health routes are explicitly public.
//    Without an injected verifySession, protected routes answer 401:
//    the foundation is deny-by-default until the auth worker lands.
// 4. Health routes, unchanged in behavior from Fase 0.
// 5. Route blocks (AD-58 prototype): all route groups are registered
//    by the generated module registration.generated.ts, in the same
//    contract order the hand-written blocks used. The middleware
//    above stays frozen (AD-40) and is never generated. To add a
//    group, add a manifest in server/registration/ and regenerate;
//    never edit the generated module by hand.
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
import { registerAllRoutes } from './registration.generated.js';

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
  // present, the auth route block is registered and the
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

  // Route blocks, in contract order (AD-40), from the generated
  // registration module. This call replaces the hand-written blocks;
  // it must stay after the frozen middleware above (pattern N-2).
  await registerAllRoutes(app, deps);

  return app;
}
