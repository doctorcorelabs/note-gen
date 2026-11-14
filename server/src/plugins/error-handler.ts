// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Global error handling: the not-found handler and the error handler.
//
// - Unknown paths and wrong methods answer 404 with the generic error
//   envelope (code not_found). The body never contains ok true, so a
//   wrong path can never be mistaken for a healthy response.
// - Errors on the three real health paths keep the Fase 0 safety net:
//   HTTP 503 with the emergency health envelope and Cache-Control
//   no-store, never a default 500 body and never the generic envelope
//   (health clients parse the health shape). The match is exact on the
//   path without the query string: an unknown path under /api/health/*
//   is not a health route and gets the generic envelope, so an auth
//   rejection on an unknown health-like path is never masked as a 503.
// - All other errors go through toErrorEnvelope: typed ApiError values
//   keep their status and code, Fastify validation failures become
//   validation_failed, malformed JSON becomes invalid_json, oversized
//   bodies become payload_too_large, and anything unexpected becomes a
//   generic internal_error. Raw error messages, stack traces, and
//   config values never enter a body.
// - Logs carry only the machine error code and the status code. The
//   request id is attached by the logger itself. Error messages are not
//   logged: a driver or library message can carry host, path, or
//   credential fragments.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildEmergencyEnvelope, HEALTH_PATHS } from '../routes/health.js';
import { errorEnvelope, toErrorEnvelope } from './envelope.js';

export interface ErrorHandlingDeps {
  version: string;
}

function requestPath(request: FastifyRequest): string {
  const url = request.url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function registerErrorHandling(app: FastifyInstance, deps: ErrorHandlingDeps): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send(errorEnvelope('not_found', 'Resource not found.', request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    if (HEALTH_PATHS.includes(requestPath(request))) {
      // Second safety net behind the ready handler's own try/catch:
      // an unexpected error on a real health route still answers 503
      // with a valid health envelope, never a default 500 body.
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
