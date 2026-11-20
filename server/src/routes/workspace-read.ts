// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace read routes (owner V3-04a). Kontrak 3.1, read side only:
//
//   GET  /api/workspace/list
//   GET  /api/workspace/file   (raw text, ETag revision)
//   HEAD /api/workspace/file   (same headers, no body, no 415/422)
//   GET  /api/workspace/scan
//   GET  /api/workspace/stat
//
// Write, move, trash, media, and reconcile routes belong to V3-04b,
// V3-05, V3-06, and V3-07 and are deliberately absent here.
//
// Authentication comes from the frozen global auth hook
// (middleware/auth-hook.ts): these routes set requiresAuth true and
// rely on the hook for the 401 session check. GET and HEAD need the
// session only; the hook skips Origin and CSRF checks for
// non-mutations, so no per-route CSRF config is needed. JSON
// responses use the canonical envelope (plugins/envelope.ts); the
// file body is the raw-text exception in kontrak 2.3, and errors on
// that route still use the envelope through the global error
// handler. Unknown query parameters are ignored (kontrak behavior
// proven by the R1 client suite); known parameters are validated by
// the read service.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { quoteETag } from '../lib/revision.js';
import { successEnvelope } from '../plugins/envelope.js';
import { createWorkspaceReader, type WorkspaceReaderDeps } from '../services/workspace/read.js';

export type WorkspaceReadRouteDeps = WorkspaceReaderDeps;

function queryRecord(request: FastifyRequest): Record<string, unknown> {
  const query = request.query as unknown;
  if (typeof query === 'object' && query !== null) {
    return query as Record<string, unknown>;
  }
  return {};
}

function setFileHeaders(
  reply: FastifyReply,
  options: {
    contentType: string;
    revision: string;
    version: number | null;
    modifiedAt: Date;
  },
): void {
  reply.header('Content-Type', options.contentType);
  reply.header('ETag', quoteETag(options.revision));
  reply.header('X-Revision', options.revision);
  if (options.version !== null) {
    reply.header('X-Version', String(options.version));
  }
  reply.header('Last-Modified', options.modifiedAt.toUTCString());
  reply.header('Cache-Control', 'private, no-cache');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', 'sandbox');
}

export async function registerWorkspaceReadRoutes(
  app: FastifyInstance,
  deps: WorkspaceReadRouteDeps,
): Promise<void> {
  const reader = createWorkspaceReader(deps);

  app.get(
    '/api/workspace/list',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const query = queryRecord(request);
      const result = await reader.list(query['path'], {
        cursor: query['cursor'],
        limit: query['limit'],
        includeMetadata: query['includeMetadata'],
      });
      return successEnvelope(result);
    },
  );

  // GET and HEAD share one route so HEAD runs its own branch: HEAD
  // must answer 200 for non-text and invalid-UTF-8 files, where GET
  // answers 415 and 422 (kontrak 3.1).
  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/workspace/file',
    config: { requiresAuth: true },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = queryRecord(request);
      if (request.method === 'HEAD') {
        const head = await reader.headFile(query['path']);
        setFileHeaders(reply, head);
        reply.header('Content-Length', String(head.size));
        return reply.code(200).send();
      }
      const result = await reader.readFile(query['path'], request.headers['if-none-match']);
      setFileHeaders(reply, result);
      if (result.notModified) {
        return reply.code(304).send();
      }
      reply.header('Content-Length', String(result.size));
      return reply.code(200).send(result.text as string);
    },
  });

  app.get(
    '/api/workspace/scan',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const query = queryRecord(request);
      const result = await reader.scan(query['folder'], {
        cursor: query['cursor'],
        limit: query['limit'],
        includeMetadata: query['includeMetadata'],
      });
      return successEnvelope(result);
    },
  );

  app.get(
    '/api/workspace/stat',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = queryRecord(request);
      const result = await reader.stat(query['path']);
      if (result.entry.isFile && result.revision !== null && result.modifiedAt !== null) {
        reply.header('ETag', quoteETag(result.revision));
        reply.header('Last-Modified', result.modifiedAt.toUTCString());
      }
      return successEnvelope(result.entry);
    },
  );
}
