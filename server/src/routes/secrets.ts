// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Secrets routes (V3-10a): GET /api/settings/secrets/status,
// PUT /api/settings/secrets/ai-providers,
// DELETE /api/settings/secrets/ai-providers/:providerKey
// (kontrak-api-kanonis.md section 3.3, AD-16).
//
// No route in this file ever returns a secret value, a fragment of
// one, or an error message containing one. Status answers carry
// metadata only (kind, ref, label, times). The general secrets forms
// PUT /api/settings/secrets/:kind and DELETE
// /api/settings/secrets/:kind/:ref are Fase 2 reserves (kontrak
// section 8.6) and are deliberately NOT registered here; requests to
// them answer 404 from the not-found handler.
//
// Auth, CSRF, and Origin are enforced by the frozen global hook
// (middleware/auth-hook.ts, AD-40). Handlers never log request
// bodies. The cipher seam (V3-10b) does the sealing; until it is
// wired, PUT fails closed with 503 and nothing is stored.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { successEnvelope } from '../plugins/envelope.js';
import {
  deleteAiProvider,
  getSecretsStatus,
  putAiProviders,
  type SettingsServiceDeps,
} from '../services/settings/settings-service.js';
import { parseIdempotencyKey, parsePutAiProvidersBody } from '../services/settings/validation.js';
import { requestIpHash, requirePrincipal } from './settings.js';

export async function registerSecretsRoutes(app: FastifyInstance, deps: SettingsServiceDeps): Promise<void> {
  app.get(
    '/api/settings/secrets/status',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = requirePrincipal(request);
      const data = await getSecretsStatus(deps, userId);
      return reply.send(successEnvelope(data));
    },
  );

  app.put(
    '/api/settings/secrets/ai-providers',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = requirePrincipal(request);
      const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key']);
      const entries = parsePutAiProvidersBody(request.body);
      const data = await putAiProviders(deps, userId, entries, request.body, idempotencyKey, requestIpHash(request));
      return reply.send(successEnvelope(data));
    },
  );

  app.delete(
    '/api/settings/secrets/ai-providers/:providerKey',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = requirePrincipal(request);
      const { providerKey } = request.params as { providerKey: string };
      const data = await deleteAiProvider(deps, userId, providerKey, requestIpHash(request));
      return reply.send(successEnvelope(data));
    },
  );
}
