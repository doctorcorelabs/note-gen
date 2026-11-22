// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Agent token management routes (F2-1 wave G-F2-1d, desain-auth.md
// section 11.5). These three endpoints are cookie-authenticated
// like every browser route (session + Origin + CSRF through the
// global hook); creation additionally requires a fresh step-up.
// They deliberately do NOT use authMode 'agent': a token can
// never create, list, or revoke tokens. The raw token value is
// returned exactly once, in the creation response.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/context.js';
import { requireStore } from '../auth/context.js';
import { clientIp, isUuid, truncateUserAgent } from '../auth/crypto.js';
import { unavailableOnDbError } from '../auth/service.js';
import { getPrincipal } from '../middleware/auth-hook.js';
import { loadSessionAndUser } from '../middleware/session.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import {
  createAgentToken,
  parseCreateAgentTokenBody,
  revokeAgentToken,
  toApiAgentToken,
} from '../services/auth/agent-tokens.js';
import { requireFreshStepUp } from '../services/auth/step-up.js';

export const AGENT_TOKENS_PATH = '/api/agent/tokens';
export const AGENT_TOKEN_PATH = '/api/agent/tokens/:tokenId';
export const AGENT_TOKENS_BODY_LIMIT_BYTES = 64 * 1024;

export interface AgentTokenRouteDeps {
  auth: AuthContext;
}

export async function registerAgentTokenRoutes(
  app: FastifyInstance,
  deps: AgentTokenRouteDeps,
): Promise<void> {
  const auth = deps.auth;

  app.post(
    AGENT_TOKENS_PATH,
    { config: { requiresAuth: true }, bodyLimit: AGENT_TOKENS_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.unauthenticated();
      }
      const loaded = await loadSessionAndUser(auth, request, principal);
      if (loaded === null) {
        throw ApiError.unauthenticated();
      }
      requireFreshStepUp(loaded.row, auth.clock());
      const body = parseCreateAgentTokenBody(request.body, auth.clock());
      const created = await createAgentToken(auth, {
        userId: principal.userId,
        credentialEpoch: loaded.user.credentialEpoch,
        body,
        ip: clientIp(request, auth.trustProxy) ?? null,
        userAgent: truncateUserAgent(request.headers['user-agent']),
        nowMs: auth.clock(),
      });
      reply.code(201);
      return successEnvelope({
        token: created.raw,
        warning:
          'This token value is shown once and cannot be displayed again. Store it in the Secure Vault now; if it is lost, revoke this token and create a new one.',
        agentToken: toApiAgentToken(created.row),
      });
    },
  );

  app.get(
    AGENT_TOKENS_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.unauthenticated();
      }
      const store = requireStore(auth);
      const rows = await unavailableOnDbError(() => store.listAgentTokensByUser(principal.userId));
      return successEnvelope({ items: rows.map((row) => toApiAgentToken(row)) });
    },
  );

  app.delete(
    AGENT_TOKEN_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.unauthenticated();
      }
      const rawId = (request.params as { tokenId?: unknown }).tokenId;
      if (typeof rawId !== 'string' || !isUuid(rawId)) {
        throw ApiError.notFound();
      }
      await revokeAgentToken(auth, {
        userId: principal.userId,
        tokenId: rawId,
        ip: clientIp(request, auth.trustProxy) ?? null,
        userAgent: truncateUserAgent(request.headers['user-agent']),
        nowMs: auth.clock(),
      });
      return successEnvelope({ id: rawId, revoked: true });
    },
  );
}
