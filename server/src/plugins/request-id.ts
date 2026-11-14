// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Request id handling.
//
// Every request carries one id: Fastify assigns it through genReqId in
// app.ts, the id is echoed as the X-Request-Id response header on every
// reply (including errors), and error envelopes carry the same id so a
// client report can be matched to a server log line. Health bodies do
// not carry the id (their schemas forbid extra fields); the header is
// the only request id channel for health.
//
// A client-supplied X-Request-Id is honored only when it matches a
// strict token pattern. Anything else (including values with whitespace
// or control characters, which could smuggle log or header injection)
// is discarded and replaced with a fresh UUID. Duplicate headers are
// also discarded.

import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function requestIdFromHeaders(headers: IncomingHttpHeaders): string {
  const raw = headers[REQUEST_ID_HEADER];
  if (typeof raw === 'string' && REQUEST_ID_PATTERN.test(raw)) {
    return raw;
  }
  return randomUUID();
}

export function registerRequestId(app: FastifyInstance): void {
  // onRequest, not onSend: the header must be present on every reply
  // type (JSON, binary, stream) and on errors thrown by later hooks.
  // request.id is assigned before onRequest hooks run.
  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });
}
