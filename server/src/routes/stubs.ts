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
// Fastify context when no multipart parser is present yet, so the
// buffer parser applies to these two routes only and cannot leak
// into other route groups. When the workspace-write group already
// registered its own Buffer-returning multipart parser, the stubs
// reuse it (Fastify rejects a duplicate registration); the stub
// body limit is then enforced in the handlers below, so the 413
// wire behavior does not depend on which parser produced the body.

import type { FastifyInstance } from 'fastify';
import { ApiError } from '../plugins/envelope.js';
import { validateParseRequest, validateRestoreRequest } from '../services/stubs/stub-shapes.js';

export const RESTORE_PATH = '/api/backups/restore';
export const DOCUMENT_PARSE_PATH = '/api/documents/parse';

export interface StubRouteDeps {
  maxBodyBytes: number;
}

// Reject an oversized raw body with 413 payload_too_large. The
// parser-level bodyLimit only applies when the stubs register their
// own parser; on the full app the workspace-write parser runs
// instead (with its own larger cap), so the stub limit is enforced
// here, deterministically, for every Buffer body. JSON bodies are
// objects, not Buffers, and are unaffected.
function assertBodyWithinLimit(body: unknown, maxBodyBytes: number): void {
  if (Buffer.isBuffer(body) && body.length > maxBodyBytes) {
    throw ApiError.payloadTooLarge();
  }
}

export async function registerStubRoutes(app: FastifyInstance, deps: StubRouteDeps): Promise<void> {
  await app.register(async (scoped) => {
    // The workspace-write group already registers a multipart
    // parser that returns a Buffer (see routes/workspace-write.ts),
    // and Fastify rejects a second registration of the same content
    // type on the same instance. The stub validators only need a
    // Buffer body (requireBufferBody), so when a parser is already
    // present the stubs reuse it; the standalone parser below is
    // only for apps that register the stubs without the workspace
    // routes (for example the stub spec harness).
    if (!scoped.hasContentTypeParser('multipart/form-data')) {
      scoped.addContentTypeParser(
        'multipart/form-data',
        { parseAs: 'buffer', bodyLimit: deps.maxBodyBytes },
        (_request, payload, done) => {
          done(null, payload);
        },
      );
    }

    scoped.post(
      RESTORE_PATH,
      { config: { requiresAuth: true } },
      async (request) => {
        assertBodyWithinLimit(request.body, deps.maxBodyBytes);
        validateRestoreRequest(request.body, request.headers['content-type']);
        throw ApiError.restoreUnavailable();
      },
    );

    scoped.post(
      DOCUMENT_PARSE_PATH,
      { config: { requiresAuth: true } },
      async (request) => {
        assertBodyWithinLimit(request.body, deps.maxBodyBytes);
        validateParseRequest(request.body, request.headers['content-type']);
        throw ApiError.documentParseUnavailable();
      },
    );
  });
}
