// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Global error handling: the not-found handler and the error handler.
//
// - Unknown paths and wrong methods answer 404 with the generic error
//   envelope (code NOT_FOUND). The body never contains ok true, so a
//   wrong path can never be mistaken for a healthy response.
// - Errors on health paths keep the Fase 0 safety net: HTTP 503 with
//   the emergency health envelope and Cache-Control no-store, never a
//   default 500 body and never the generic envelope (health clients
//   parse the health shape).
// - All other errors go through toErrorEnvelope: typed ApiError values
//   keep their status and code, Fastify validation failures become
//   VALIDATION_ERROR, oversized bodies become PAYLOAD_TOO_LARGE, and
//   anything unexpected becomes a generic SERVER_ERROR. Raw error
//   messages, stack traces, and config values never enter a body.
// - Logs carry only the machine error code and the status code. The
//   request id is attached by the logger itself. Error messages are not
//   logged: a driver or library message can carry host, path, or
//   credential fragments.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildEmergencyEnvelope } from '../routes/health.js';
import { errorEnvelope, toErrorEnvelope } from './envelope.js';

export interface ErrorHandlingDeps {
  version: string;
}

export function registerErrorHandling(app: FastifyInstance, deps: ErrorHandlingDeps): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send(errorEnvelope('NOT_FOUND', 'Resource not found.', request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    if (request.url.startsWith('/api/health')) {
      // Second safety net behind the ready handler's own try/catch:
      // an unexpected error on a health route still answers 503 with
      // a valid health envelope, never a default 500 body.
      if (!reply.sent) {
        reply.header('Cache-Control', 'no-store');
        reply.code(503).send(buildEmergencyEnvelope(deps.version));
      }
      return;
    }
    const { statusCode, envelope } = toErrorEnvelope(error, request.id);
    if (statusCode >= 500) {
      request.log.error({ code: envelope.error.code, statusCode }, 'unhandled error');
    } else {
      request.log.warn({ code: envelope.error.code, statusCode }, 'request failed');
    }
    if (!reply.sent) {
      reply.code(statusCode).send(envelope);
    }
  });
}
