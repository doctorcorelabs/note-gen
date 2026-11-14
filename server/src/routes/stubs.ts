// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Explicit 501 stubs (canonical contract section 7): backup restore
// and document parse. Both capabilities belong to Fase 2; in Fase 1
// the routes exist so callers get an explicit, testable rejection
// instead of a routing 404 or a fake success.
//
// - Auth comes first: the global auth hook runs before these handlers,
//   so a request without a valid session answers 401 and a mutation
//   with a bad Origin or CSRF token answers 403. The 501 answer is
//   given only after auth passes, and the stubs never become an oracle
//   for callers without a session.
// - Each stub answers 501 with its own stable code from the contract
//   catalog: restore_unavailable for restore, document_parse_unavailable
//   for parse. The answers are retryable false and carry a request id
//   through the shared error envelope.
// - No side effects: the handlers write nothing to the database, disk,
//   index, trash, or queue, and they never read an archive or a
//   document for business validation. An upload in an old desktop
//   format is answered 501 here, not rejected as a bad format; format
//   rejection is Fase 2 work. Scanned-document text recognition is not
//   supported and is never attempted.
// - Shape before rejection: the request shape is validated first, so a
//   malformed multipart upload answers 400 invalid_upload instead of
//   501 (see services/stubs/stub-shapes.ts). Shape validation looks at
//   framing only; it never inspects uploaded bytes.
//
// The multipart body parser is registered inside an encapsulated
// Fastify context, so the buffer parser applies to these two routes
// only and cannot leak into other route groups or block a later
// upload implementation from registering its own parser. Like every
// Fastify plugin, the context loads when the app becomes ready, which
// listen() and inject() both trigger.

import type { FastifyInstance } from 'fastify';
import { ApiError } from '../plugins/envelope.js';
import { validateParseRequest, validateRestoreRequest } from '../services/stubs/stub-shapes.js';

export const RESTORE_PATH = '/api/backups/restore';
export const DOCUMENT_PARSE_PATH = '/api/documents/parse';

export interface StubRouteDeps {
  maxBodyBytes: number;
}

export async function registerStubRoutes(app: FastifyInstance, deps: StubRouteDeps): Promise<void> {
  await app.register(async (scoped) => {
    scoped.addContentTypeParser(
      'multipart/form-data',
      { parseAs: 'buffer', bodyLimit: deps.maxBodyBytes },
      (_request, payload, done) => {
        done(null, payload);
      },
    );

    scoped.post(
      RESTORE_PATH,
      { config: { requiresAuth: true } },
      async (request) => {
        validateRestoreRequest(request.body, request.headers['content-type']);
        throw ApiError.restoreUnavailable();
      },
    );

    scoped.post(
      DOCUMENT_PARSE_PATH,
      { config: { requiresAuth: true } },
      async (request) => {
        validateParseRequest(request.body, request.headers['content-type']);
        throw ApiError.documentParseUnavailable();
      },
    );
  });
}
