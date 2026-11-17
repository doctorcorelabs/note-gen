// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Global error handling: the not-found handler and the error handler.
//
// - Unknown paths answer 404 with the generic error envelope (code
//   not_found). A wrong method on a known path answers 405
//   method_not_allowed (kontrak-api-kanonis.md section 6.2: 405,
//   retryable false, all paths). The not-found handler tells the two
//   apart with the route registry below, built from the onRoute hook:
//   when the path matches a registered pattern under another method,
//   the method is wrong; otherwise the path is unknown. The body never
//   contains ok true, so a wrong path can never be mistaken for a
//   healthy response.
// - Errors on the three real health paths keep the Fase 0 safety net:
//   HTTP 503 with the emergency health envelope and Cache-Control
//   no-store, never a default 500 body and never the generic envelope
//   (health clients parse the health shape). The match is exact on the
//   path without the query string: an unknown path under /api/health/*
//   is not a health route and gets the generic envelope, so an auth
//   rejection on an unknown health-like path is never masked as a 503.
//   One carve-out: deliberate 401/403 rejections (Cloudflare Access
//   verification on ready/alias, desain-auth.md sections 7.5-7.6)
//   pass through with the generic envelope and their own status, so
//   the watchdog can tell an edge credential problem (401/403) apart
//   from an origin failure (503). The safety net stays for unexpected
//   errors only.
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

// One decoded path segment. A malformed escape keeps its raw form so
// matching never throws on hostile input.
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function splitPath(path: string): string[] {
  return path.split('/').map(decodeSegment);
}

// True when a concrete request path matches a Fastify route pattern:
// literal segments must be equal, a `:param` segment matches exactly
// one non-empty segment, and a trailing `*` matches one or more
// remaining segments (the path must carry at least the segment the
// star stands on, so the bare prefix without the trailing slash does
// not match). Matching is exact and case-sensitive, like the router:
// a trailing slash or a different segment count does not match.
// Only the shapes used by this server's route table are supported
// (plain literals, `:param`, trailing `*`); no route uses an inline
// param regex, and a `:param` segment here matches any non-empty
// segment.
export function pathMatchesRoutePattern(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/');
  const pathSegments = splitPath(path);
  for (let i = 0; i < patternSegments.length; i += 1) {
    const patternSegment = patternSegments[i] as string;
    if (patternSegment === '*') {
      return pathSegments[i] !== undefined;
    }
    const pathSegment = pathSegments[i];
    if (pathSegment === undefined) {
      return false;
    }
    if (patternSegment.startsWith(':')) {
      if (pathSegment === '') {
        return false;
      }
      continue;
    }
    if (patternSegment !== pathSegment) {
      return false;
    }
  }
  return patternSegments.length === pathSegments.length;
}

export function registerErrorHandling(app: FastifyInstance, deps: ErrorHandlingDeps): void {
  // Route registry for the 404/405 split, populated by the onRoute
  // hook for every route registered after this function runs. All
  // callers register error handling before their routes (buildApp
  // and the bare-Fastify test harnesses), so every route lands here,
  // including routes added after buildApp returns and the HEAD
  // routes Fastify generates from GET routes. Methods merge per
  // pattern: one pattern registered under several methods keeps
  // them all.
  const routes: Array<{ pattern: string; methods: Set<string> }> = [];
  app.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    const existing = routes.find((entry) => entry.pattern === routeOptions.url);
    if (existing !== undefined) {
      for (const method of methods) {
        existing.methods.add(method);
      }
      return;
    }
    routes.push({ pattern: routeOptions.url, methods: new Set<string>(methods) });
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const path = requestPath(request);
    const matches = routes.filter((entry) => pathMatchesRoutePattern(entry.pattern, path));
    const methodKnown = matches.some((entry) => entry.methods.has(request.method));
    // A match whose methods exclude the request method means the
    // path exists and the method is wrong: 405. When no pattern
    // matches, or a matching pattern does serve the method (a state
    // the router should never produce here), the answer stays 404.
    if (matches.length > 0 && !methodKnown) {
      reply.code(405).send(errorEnvelope('method_not_allowed', 'Method not allowed.', request.id));
      return;
    }
    reply.code(404).send(errorEnvelope('not_found', 'Resource not found.', request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    if (HEALTH_PATHS.includes(requestPath(request))) {
      const { statusCode, envelope } = toErrorEnvelope(error, request.id);
      if (statusCode === 401 || statusCode === 403) {
        // Deliberate auth rejections pass through: masking an Access
        // rejection as 503 would read as "origin not ready" and
        // could trigger a tunnel restart for what is actually an
        // edge credential problem (desain-auth.md section 7.6).
        request.log.warn({ code: envelope.error.code, statusCode }, 'request failed');
        if (!reply.sent) {
          reply.header('Cache-Control', 'no-store');
          reply.code(statusCode).send(envelope);
        }
        return;
      }
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
