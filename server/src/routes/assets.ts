// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Record asset routes (V3-31): POST /api/assets and
// GET /api/assets/:assetKey.
//
// Contract: kontrak-api-kanonis.md section 3.7. Auth comes from the
// frozen global hook (middleware/auth-hook.ts): both routes declare
// requiresAuth; the POST additionally gets Origin and CSRF checks from
// the hook because it is a mutation, and the GET gets the session check
// only. A request without a session answers 401 before any handler
// logic runs. (Fastify parses the multipart body before the preHandler
// hook runs, so "auth before reading the body" in V1-14 4.1 holds at
// the handler level: no asset logic, validation, or disk write happens
// before the hook passes. The body is bounded by the parser cap below.)
//
// Upload shape: multipart/form-data with exactly one file part named
// "file" and at most one text part named "fileName". Any other part,
// a second file part, or a missing file part answers 400
// invalid_upload. The multipart framing parser is shared with the
// workspace media upload (services/workspace/write-media.ts); asset
// typing never consults it and never consults extensions. The parser
// is registered in an encapsulated context and reused when another
// group already registered a multipart parser on the same instance
// (the stubs pattern, routes/stubs.ts).
//
// Workspace resolution: the workspace never comes from the request
// (kontrak 1.1). It is resolved server-side from the session principal
// through the injected resolver. This module owns no database access:
// the production resolver is supplied at wiring time and must apply
// the same membership rule as services/db/workspace.ts (member row,
// else owned workspace, else null). A null resolution answers the
// generic 404 not_found on both routes (AD-08): no workspace and a
// denied workspace are indistinguishable to the caller.
//
// Wiring (W4-WIRE): the assets registration adapter (rank 130,
// routes/assets.registration.ts) constructs a
// FilesystemAssetStore rooted OUTSIDE the workspace file tree
// under /data from the dedicated config value assetRoot
// (ASSET_ROOT), an AssetService over it, and the database-backed
// workspace resolver. When ASSET_ROOT is unset, the adapter
// wires a fail-closed store that answers 503 per request.
//
// Serve response (V1-14 4.2): raw bytes with Content-Type from the
// type validated at upload, Content-Disposition inline for display
// types and attachment otherwise, X-Content-Type-Options: nosniff,
// Cache-Control: private, ETag from the content hash, and
// Content-Length. Errors before the body starts use the JSON error
// envelope through the global error handler. No Range handling and
// no conditional-request handling is specified for assets in kontrak
// 3.7, so none is implemented; the ETag is present for client caching.
// The key is a single path segment: asset keys contain no slash, so
// no wildcard segment is needed, and a key containing a slash can
// never match this route.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrincipal, type SessionPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import { multipartBoundary, parseMultipart } from '../services/workspace/write-media.js';
import { AssetService, resolveFileName } from '../services/assets/service.js';
import type { AssetDisposition } from '../services/assets/types.js';

export const ASSETS_PATH = '/api/assets';
export const ASSET_PATH = '/api/assets/:assetKey';

// Resolves the workspace id for an authenticated principal, or null
// when the principal has no accessible workspace.
export type AssetWorkspaceResolver = (principal: SessionPrincipal) => Promise<string | null>;

export interface AssetRouteDeps {
  service: AssetService;
  resolveWorkspaceId: AssetWorkspaceResolver;
}

function invalidUpload(): ApiError {
  return new ApiError(400, 'invalid_upload', 'The multipart upload is not valid.');
}

export function contentDispositionFor(disposition: AssetDisposition, fileName: string): string {
  return `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function registerAssetRoutes(app: FastifyInstance, deps: AssetRouteDeps): Promise<void> {
  await app.register(async (scoped) => {
    if (!scoped.hasContentTypeParser('multipart/form-data')) {
      scoped.addContentTypeParser(
        'multipart/form-data',
        { parseAs: 'buffer', bodyLimit: deps.service.limitBytes + 64 * 1024 },
        (_request, payload, done) => {
          done(null, payload);
        },
      );
    }

    async function workspaceIdOf(request: FastifyRequest): Promise<string> {
      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.unauthenticated();
      }
      const workspaceId = await deps.resolveWorkspaceId(principal);
      if (workspaceId === null) {
        throw ApiError.notFound();
      }
      return workspaceId;
    }

    scoped.post(
      ASSETS_PATH,
      { config: { requiresAuth: true }, bodyLimit: deps.service.limitBytes + 64 * 1024 },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const workspaceId = await workspaceIdOf(request);
        const boundary = multipartBoundary(request.headers['content-type']);
        if (boundary === null) {
          throw invalidUpload();
        }
        if (!Buffer.isBuffer(request.body)) {
          throw invalidUpload();
        }
        const parsed = parseMultipart(request.body, boundary);
        if (parsed.files.length !== 1 || parsed.files[0]?.name !== 'file') {
          throw invalidUpload();
        }
        for (const fieldName of parsed.fields.keys()) {
          if (fieldName !== 'fileName') {
            throw invalidUpload();
          }
        }
        const fileNameValues = parsed.fields.get('fileName') ?? [];
        if (fileNameValues.length > 1) {
          throw invalidUpload();
        }
        const file = parsed.files[0] as { data: Buffer; filename: string | undefined };
        const fileName = resolveFileName(fileNameValues[0], file.filename);
        const representation = await deps.service.upload({
          workspaceId,
          fileName,
          bytes: file.data,
        });
        reply.code(201);
        return successEnvelope(representation);
      },
    );

    scoped.get(
      ASSET_PATH,
      { config: { requiresAuth: true } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const workspaceId = await workspaceIdOf(request);
        const params = request.params as { assetKey?: unknown };
        const served = await deps.service.serve(workspaceId, params.assetKey);
        reply.header('Content-Type', served.metadata.mimeType);
        reply.header(
          'Content-Disposition',
          contentDispositionFor(served.disposition, served.metadata.fileName),
        );
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Cache-Control', 'private');
        reply.header('ETag', served.etag);
        reply.header('Content-Length', String(served.bytes.length));
        reply.code(200);
        return reply.send(served.bytes);
      },
    );
  });
}
