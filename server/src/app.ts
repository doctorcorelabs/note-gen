// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fastify application factory. buildApp creates the instance and
// registers routes, but never listens: only server.ts calls listen(),
// so tests can exercise the app with inject() without opening a port.
//
// Request logging is disabled: health probes arrive every few seconds
// from watchdogs and container healthchecks, and successful probes must
// not flood the log. Failed checks are logged by the ready handler
// itself, with error codes only. The global error handler never leaks
// error messages, stack traces, or config values into a response body.

import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import type { HealthDbPool } from './db/pool.js';
import { buildEmergencyEnvelope, registerHealthRoutes } from './routes/health.js';

export interface AppDeps {
  config: ServerConfig;
  pool: HealthDbPool | null;
  version: string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.config.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not Found', statusCode: 404 });
  });

  app.setErrorHandler((error, request, reply) => {
    if (request.url.startsWith('/api/health')) {
      // Second safety net behind the ready handler's own try/catch:
      // an unexpected error on a health route still answers 503 with
      // a valid envelope, never a default 500 body.
      reply.header('Cache-Control', 'no-store');
      reply.code(503).send(buildEmergencyEnvelope(deps.version));
      return;
    }
    request.log.error({ code: 'UNHANDLED_ERROR' }, 'unhandled error');
    reply.code(500).send({ error: 'Internal Server Error', statusCode: 500 });
  });

  await registerHealthRoutes(app, {
    pool: deps.pool,
    workspaceRoot: deps.config.workspaceRoot,
    version: deps.version,
    checkTimeoutMs: deps.config.checkTimeoutMs,
    overallTimeoutMs: deps.config.overallTimeoutMs,
  });

  return app;
}
