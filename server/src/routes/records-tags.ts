// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// REST tags routes (W4-WIRE, kontrak 3.6, V1-14 section 5 as
// amended by A-12 and AD-32): GET/POST /api/tags,
// GET/PATCH/DELETE /api/tags/:tagId.
//
// Auth and workspace resolution follow the marks routes
// (records-marks.ts): requiresAuth on every route, the
// workspace resolved server-side from the session principal,
// a null resolution answering the generic 404 (AD-08). Tag
// counts in list responses are direct membership over active
// records (V1-14 5.1), computed by the repository.
//
// No reorder route exists in the contract: tag order in the
// list is pinned-first then name ascending, and the kind
// tags.reorder gap stays with W4-CODEMOD F4.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import { toApiTag } from '../services/records/represent.js';
import {
  parseReassignTo,
  parseTagCreateBody,
  parseTagIdParam,
  parseTagPatchBody,
} from '../services/records/validation.js';
import {
  RECORDS_BODY_LIMIT_BYTES,
  type RecordsRouteDeps,
  type RecordsWorkspaceResolver,
} from './records-marks.js';

export const TAGS_PATH = '/api/tags';
export const TAG_PATH = '/api/tags/:tagId';

async function workspaceIdOf(
  request: FastifyRequest,
  resolveWorkspaceId: RecordsWorkspaceResolver,
): Promise<string> {
  const principal = getPrincipal(request);
  if (principal === undefined) {
    throw ApiError.unauthenticated();
  }
  const workspaceId = await resolveWorkspaceId(principal);
  if (workspaceId === null) {
    throw ApiError.notFound();
  }
  return workspaceId;
}

export async function registerTagsRoutes(app: FastifyInstance, deps: RecordsRouteDeps): Promise<void> {
  app.get(
    TAGS_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const rows = await deps.repository.listTags(workspaceId);
      return successEnvelope({ tags: rows.map((row) => toApiTag(row)) });
    },
  );

  app.post(
    TAGS_PATH,
    { config: { requiresAuth: true }, bodyLimit: RECORDS_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const input = parseTagCreateBody(request.body);
      const row = await deps.repository.createTag(workspaceId, input.name);
      reply.code(201);
      return successEnvelope(toApiTag(row));
    },
  );

  app.get(
    TAG_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const tagId = parseTagIdParam((request.params as { tagId?: unknown }).tagId);
      const rows = await deps.repository.listTags(workspaceId);
      const found = rows.find((row) => row.id === tagId);
      if (found === undefined) {
        throw ApiError.notFound();
      }
      return successEnvelope(toApiTag(found));
    },
  );

  app.patch(
    TAG_PATH,
    { config: { requiresAuth: true }, bodyLimit: RECORDS_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const tagId = parseTagIdParam((request.params as { tagId?: unknown }).tagId);
      const input = parseTagPatchBody(request.body);
      const row = await deps.repository.patchTag(workspaceId, tagId, input);
      return successEnvelope(toApiTag(row));
    },
  );

  app.delete(
    TAG_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const tagId = parseTagIdParam((request.params as { tagId?: unknown }).tagId);
      const reassignTo = parseReassignTo(request.query);
      const result = await deps.repository.deleteTag(workspaceId, tagId, reassignTo);
      return successEnvelope({ id: tagId, deleted: result.deleted, reassignedTo: result.reassignedTo });
    },
  );
}
