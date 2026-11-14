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
//
// Request logging is disabled: health probes arrive every few seconds
// from watchdogs and container healthchecks, and successful probes must
// not flood the log. Failed checks are logged by the ready handler
// itself, with error codes only. Credential-carrying headers are
// redacted at the logger level (see plugins/logging.ts).

import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import type { HealthDbPool } from './db/pool.js';
import {
  registerAuthHooks,
  type VerifyCsrfTokenFn,
  type VerifyOriginFn,
  type VerifySessionFn,
} from './middleware/auth-hook.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { buildLoggerOptions } from './plugins/logging.js';
import { registerRequestId, requestIdFromHeaders } from './plugins/request-id.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWorkspaceWriteRoutes } from './routes/workspace-write.js';

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
  registerAuthHooks(app, {
    verifySession: deps.verifySession,
    verifyCsrf: deps.verifyCsrf,
    verifyOrigin: deps.verifyOrigin,
    canonicalOrigin: deps.config.publicBaseUrl,
  });

  await registerHealthRoutes(app, {
    pool: deps.pool,
    workspaceRoot: deps.config.workspaceRoot,
    version: deps.version,
    checkTimeoutMs: deps.config.checkTimeoutMs,
    overallTimeoutMs: deps.config.overallTimeoutMs,
  });

  // Workspace write routes (V3-04b, wave 3A). Registered with no
  // ports until the V3-04a path/revision modules land: every write
  // route answers 503 service_unavailable after auth passes, so no
  // write can succeed on a guessed path or revision implementation.
  // The integrator wires the real ports here in this one block:
  // registerWorkspaceWriteRoutes(app, { ports, resolveIdentity }).
  await registerWorkspaceWriteRoutes(app, {});

  return app;
}
