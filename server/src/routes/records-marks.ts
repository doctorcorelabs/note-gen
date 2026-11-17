// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// REST marks routes (W4-WIRE, kontrak 3.5, V1-14 section 3 as
// amended by A-12 and AD-32): POST/GET /api/marks,
// GET/PATCH/DELETE /api/marks/:markId, PUT
// /api/marks/:markId/tags, POST /api/marks/:markId/restore,
// DELETE /api/marks/:markId/permanent, DELETE /api/marks/trash.
//
// Auth comes from the frozen global hook: every route declares
// requiresAuth; mutations additionally get Origin and CSRF
// checks from the hook. The workspace never comes from the
// request: it is resolved server-side from the session
// principal through the injected resolver, and a null
// resolution answers the generic 404 (AD-08).
//
// Bodies are parsed and validated by services/records/
// validation.ts (pure, spec-covered); this module owns HTTP
// only: status codes, the success envelope, id parsing, and
// the post-commit asset sweep. Asset keys referenced by a
// permanently deleted record are deleted after the transaction
// commits, only when no remaining record references the key,
// and sweep failures are swallowed: the record is already gone
// and a leaked asset file is recoverable, while a failed
// response after a committed delete would lie.
//
// Bodies are capped at 1 MiB: records carry content, but a
// single record body larger than that is a client bug, not a
// note.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrincipal, type SessionPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import type { RecordsRepository } from '../services/records/repository.js';
import { toApiRecord } from '../services/records/represent.js';
import {
  parseCreateBody,
  parseEmptyTrashBody,
  parseListQuery,
  parseMarkIdParam,
  parsePatchBody,
  parsePutTagsBody,
  parseRestoreBody,
} from '../services/records/validation.js';

export const MARKS_PATH = '/api/marks';
export const MARK_PATH = '/api/marks/:markId';
export const MARK_TAGS_PATH = '/api/marks/:markId/tags';
export const MARK_RESTORE_PATH = '/api/marks/:markId/restore';
export const MARK_PERMANENT_PATH = '/api/marks/:markId/permanent';
export const MARKS_TRASH_PATH = '/api/marks/trash';

export const RECORDS_BODY_LIMIT_BYTES = 1024 * 1024;

// Resolves the workspace id for an authenticated principal, or
// null when the principal has no accessible workspace.
export type RecordsWorkspaceResolver = (principal: SessionPrincipal) => Promise<string | null>;

// The asset surface the records routes need. The adapter
// supplies the real store-backed port; when no asset root is
// configured, exists answers false (an unconfigured store
// holds no keys) and remove is a no-op.
export interface RecordsAssetPort {
  exists(workspaceId: string, assetKey: string): Promise<boolean>;
  remove(workspaceId: string, assetKey: string): Promise<boolean>;
}

export interface RecordsRouteDeps {
  repository: RecordsRepository;
  resolveWorkspaceId: RecordsWorkspaceResolver;
  assets: RecordsAssetPort;
}

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

export async function registerMarksRoutes(app: FastifyInstance, deps: RecordsRouteDeps): Promise<void> {
  async function sweepAssets(workspaceId: string, assetKeys: readonly string[]): Promise<void> {
    for (const assetKey of assetKeys) {
      try {
        if (await deps.repository.hasUrlReference(workspaceId, assetKey)) {
          continue;
        }
        await deps.assets.remove(workspaceId, assetKey);
      } catch {
        // Best effort: the record is already gone. A leaked
        // asset file is recoverable; a failed response after
        // a committed delete would lie about the outcome.
      }
    }
  }

  app.post(
    MARKS_PATH,
    { config: { requiresAuth: true }, bodyLimit: RECORDS_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const input = parseCreateBody(request.body, request.headers['idempotency-key']);
      const result = await deps.repository.createMark(workspaceId, input, (assetKey) =>
        deps.assets.exists(workspaceId, assetKey),
      );
      if (!result.duplicate) {
        reply.code(201);
      }
      return successEnvelope(toApiRecord(result.row, result.duplicate));
    },
  );

  app.get(
    MARKS_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const query = parseListQuery(request.query);
      const page = await deps.repository.listMarks(workspaceId, query);
      return successEnvelope({
        items: page.items.map((row) => toApiRecord(row)),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    },
  );

  app.get(
    MARK_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const markId = parseMarkIdParam((request.params as { markId?: unknown }).markId);
      const row = await deps.repository.getMark(workspaceId, markId);
      return successEnvelope(toApiRecord(row));
    },
  );

  app.patch(
    MARK_PATH,
    { config: { requiresAuth: true }, bodyLimit: RECORDS_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const markId = parseMarkIdParam((request.params as { markId?: unknown }).markId);
      const input = parsePatchBody(request.body, request.headers['if-match']);
      const result = await deps.repository.patchMark(workspaceId, markId, input, (assetKey) =>
        deps.assets.exists(workspaceId, assetKey),
      );
      return successEnvelope(toApiRecord(result.row));
    },
  );

  app.put(
    MARK_TAGS_PATH,
    { config: { requiresAuth: true }, bodyLimit: RECORDS_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const markId = parseMarkIdParam((request.params as { markId?: unknown }).markId);
      const input = parsePutTagsBody(request.body);
      const row = await deps.repository.putMarkTags(workspaceId, markId, input);
      return successEnvelope(toApiRecord(row));
    },
  );

  app.delete(
    MARK_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const markId = parseMarkIdParam((request.params as { markId?: unknown }).markId);
      const result = await deps.repository.softDeleteMark(workspaceId, markId);
      return successEnvelope(toApiRecord(result.row));
    },
  );

  app.post(
    MARK_RESTORE_PATH,
    { config: { requiresAuth: true }, bodyLimit: RECORDS_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const markId = parseMarkIdParam((request.params as { markId?: unknown }).markId);
      parseRestoreBody(request.body);
      const result = await deps.repository.restoreMark(workspaceId, markId);
      return successEnvelope(toApiRecord(result.row));
    },
  );

  app.delete(
    MARK_PERMANENT_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const markId = parseMarkIdParam((request.params as { markId?: unknown }).markId);
      const result = await deps.repository.permanentDeleteMark(workspaceId, markId);
      await sweepAssets(workspaceId, result.assetKeys);
      return successEnvelope({ id: markId, deleted: result.deleted, permanent: true });
    },
  );

  app.delete(
    MARKS_TRASH_PATH,
    { config: { requiresAuth: true }, bodyLimit: RECORDS_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      parseEmptyTrashBody(request.body);
      const result = await deps.repository.emptyTrash(workspaceId);
      await sweepAssets(workspaceId, result.assetKeys);
      return successEnvelope({ purged: result.purged, purgedAt: result.purgedAt });
    },
  );
}
