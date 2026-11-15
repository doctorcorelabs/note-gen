// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Db routes: POST /api/transactions and POST /api/db/batch
// (kontrak-api-kanonis.md section 3.4).
//
// - No version prefix, no workspace id in the path, query, or body:
//   the workspace comes from the authenticated session.
// - Both routes are session + CSRF protected by the global auth
//   hook (bentuk-middleware-beku.md, AD-40). The batch endpoint is
//   read-pure but still uses POST with a body, so CSRF still
//   applies (kontrak 3.4 note). The routes declare requiresAuth
//   explicitly; the hook also protects every /api/ route by
//   default, so a forgotten config could never make them public.
// - Bodies are validated in code (services/db/validation.ts),
//   not by a Fastify JSON schema, because the per-kind validation
//   is dynamic: the contract error codes and details (invalid
//   operation with operationIndex, validation_failed with
//   details.fields) cannot be produced by a static schema. The
//   per-route body limit enforces the 1 MB contract bound even when
//   the global body limit is configured larger (CT-X5).
// - Success uses the canonical envelope { ok: true, data }.
//   Errors are thrown as ApiError and rendered by the global error
//   handler. No operation content is ever logged: only the global
//   handler's code-only log lines apply.
// - There is no endpoint here that accepts SQL, a table name, a
//   column name, or a generic invoke payload, ever (AD-26).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import type { DbRouteDeps } from '../services/db/deps.js';
import { runBatchRequest, runTransactionRequest } from '../services/db/dispatch.js';
import { DB_MAX_BODY_BYTES } from '../services/db/kinds.js';
import {
  hashDbRequestBody,
  validateDbOperations,
  validateIdempotencyKey,
} from '../services/db/validation.js';

export const TRANSACTIONS_PATH = '/api/transactions';
export const DB_BATCH_PATH = '/api/db/batch';

export async function registerDbRoutes(app: FastifyInstance, deps: DbRouteDeps): Promise<void> {
  app.post(
    TRANSACTIONS_PATH,
    { config: { requiresAuth: true }, bodyLimit: DB_MAX_BODY_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.unauthenticated();
      }
      const operations = validateDbOperations(request.body, 'write');
      const idempotencyKey = validateIdempotencyKey(request.headers['idempotency-key']);
      const data = await runTransactionRequest(deps, {
        userId: principal.userId,
        requestId: request.id,
        operations,
        idempotencyKey,
        requestHash: idempotencyKey === null ? '' : hashDbRequestBody(operations),
      });
      reply.code(200).send(successEnvelope(data));
    },
  );

  app.post(
    DB_BATCH_PATH,
    { config: { requiresAuth: true }, bodyLimit: DB_MAX_BODY_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.unauthenticated();
      }
      const operations = validateDbOperations(request.body, 'read');
      const data = await runBatchRequest(deps, {
        userId: principal.userId,
        requestId: request.id,
        operations,
      });
      reply.code(200).send(successEnvelope(data));
    },
  );
}
