// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Settings routes (V3-10a): GET /api/settings, PATCH /api/settings,
// GET /api/settings/revision (kontrak-api-kanonis.md section 3.2).
//
// Auth, CSRF, and Origin are enforced by the frozen global hook
// (middleware/auth-hook.ts, AD-40); these handlers only read the
// verified principal. Every route declares requiresAuth explicitly.
// Handlers never log request bodies or settings values, and error
// responses carry field names only, never values.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import {
  getSettings,
  getSettingsRevision,
  patchSettings,
  type SettingsServiceDeps,
} from '../services/settings/settings-service.js';
import {
  parseIdempotencyKey,
  parsePatchSettingsBody,
  parseSettingsKeysQuery,
  sha256Hex,
} from '../services/settings/validation.js';

// Read the verified principal attached by the auth hook. A missing
// principal means the hook did not run or did not verify; fail closed
// with 401 rather than serving data to an unknown caller.
export function requirePrincipal(request: FastifyRequest): { userId: string } {
  const principal = getPrincipal(request);
  if (principal === undefined) {
    throw ApiError.unauthenticated();
  }
  return { userId: principal.userId };
}

// Hash of the request IP for audit rows. The raw IP is never stored
// in an audit row and never logged by these handlers.
export function requestIpHash(request: FastifyRequest): string {
  return sha256Hex(request.ip ?? 'unknown');
}

export async function registerSettingsRoutes(app: FastifyInstance, deps: SettingsServiceDeps): Promise<void> {
  app.get(
    '/api/settings',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = requirePrincipal(request);
      const keys = parseSettingsKeysQuery(request.query);
      const data = await getSettings(deps, userId, keys);
      return reply.send(successEnvelope(data));
    },
  );

  app.patch(
    '/api/settings',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = requirePrincipal(request);
      const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key']);
      const body = parsePatchSettingsBody(request.body);
      const data = await patchSettings(deps, userId, body, idempotencyKey, requestIpHash(request));
      return reply.send(successEnvelope(data));
    },
  );

  app.get(
    '/api/settings/revision',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = requirePrincipal(request);
      const data = await getSettingsRevision(deps, userId);
      return reply.send(successEnvelope(data));
    },
  );
}
