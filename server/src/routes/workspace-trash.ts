// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace trash routes (owner V3-05, part 3; AD-57 overlap).
// Kontrak 3.1, trash side, all seven routes:
//
//   DELETE /api/workspace/file              move one file to trash
//   DELETE /api/workspace/folder            move one folder to trash
//   POST   /api/workspace/trash             batch move to trash
//   GET    /api/workspace/trash             list trash entries
//   POST   /api/workspace/trash/{id}/restore restore one entry
//   DELETE /api/workspace/trash/{id}        purge one entry
//   DELETE /api/workspace/trash             empty all trash
//
// All seven share the one trash engine in
// services/workspace/trash.ts, so there is exactly one trash
// implementation. This is workspace FILE trash, not marks trash:
// DELETE /api/marks/trash belongs to the records worker (AD-32).
//
// Authentication comes from the frozen global auth hook
// (middleware/auth-hook.ts): these routes set requiresAuth true and
// rely on the hook for the 401 session check plus the Origin and
// CSRF checks on mutations. GET needs the session only. JSON
// responses use the canonical envelope (plugins/envelope.ts).
// Unknown JSON body fields are rejected (kontrak K-09); unknown
// query parameters are ignored (kontrak 1.5).
//
// Registration is the integrator's job (AD-57): this module only
// exports registerWorkspaceTrashRoutes, following the workspace-read
// pattern. No AppDeps field is added: the workspace root comes from
// config at registration time, like the read routes.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import {
  fieldError,
  rejectUnknownFields,
  requireJsonObject,
} from '../services/workspace/write-guards.js';
import {
  createWorkspaceTrash,
  type WorkspaceTrashDeps,
} from '../services/workspace/trash.js';

export type WorkspaceTrashRouteDeps = WorkspaceTrashDeps;

function queryRecord(request: FastifyRequest): Record<string, unknown> {
  const query = request.query as unknown;
  if (typeof query === 'object' && query !== null) {
    return query as Record<string, unknown>;
  }
  return {};
}

function actorIdOf(request: FastifyRequest): string | undefined {
  return getPrincipal(request)?.userId;
}

// DELETE file/folder (desain 2.8): there is no one-step permanent
// delete from the workspace. A request with permanent=true answers
// 400 invalid_query; purge happens only through the trash
// endpoints. The check runs before path validation, so the
// rejection is deterministic. Any other permanent value (for
// example permanent=false) is not a permanent-delete request and
// is ignored like any other unknown query value (kontrak 1.5).
function rejectPermanentDelete(query: Record<string, unknown>): void {
  const permanent = query['permanent'];
  const requested =
    permanent === 'true' ||
    (Array.isArray(permanent) && permanent.includes('true'));
  if (requested) {
    throw new ApiError(400, 'invalid_query', 'The query string is not valid.');
  }
}

export async function registerWorkspaceTrashRoutes(
  app: FastifyInstance,
  deps: WorkspaceTrashRouteDeps,
): Promise<void> {
  const trash = createWorkspaceTrash(deps);

  // DELETE /api/workspace/file?path=<relatif>: move one file to
  // trash. A folder at the path answers 409 wrong_kind; a repeat
  // after the move answers 404 not_found.
  app.delete(
    '/api/workspace/file',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const query = queryRecord(request);
      rejectPermanentDelete(query);
      const result = await trash.moveToTrash(query['path'], {
        expectedKind: 'file',
        actorId: actorIdOf(request),
      });
      return successEnvelope(result);
    },
  );

  // DELETE /api/workspace/folder?path=<relatif>: move one folder
  // subtree to trash as a single entry. A file at the path
  // answers 409 wrong_kind.
  app.delete(
    '/api/workspace/folder',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const query = queryRecord(request);
      rejectPermanentDelete(query);
      const result = await trash.moveToTrash(query['path'], {
        expectedKind: 'folder',
        actorId: actorIdOf(request),
      });
      return successEnvelope(result);
    },
  );

  // GET /api/workspace/trash: paginated list, deletedAt descending.
  app.get(
    '/api/workspace/trash',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const query = queryRecord(request);
      const result = await trash.list({ cursor: query['cursor'], limit: query['limit'] });
      return successEnvelope(result);
    },
  );

  // POST /api/workspace/trash: batch move to trash, per-item
  // results. Body { paths[] }, 1 to maxBatchPaths paths; an empty
  // array or an over-limit array answers 400 validation_failed.
  app.post(
    '/api/workspace/trash',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const body = requireJsonObject(request.body);
      rejectUnknownFields(body, ['paths']);
      const paths = body['paths'];
      if (!Array.isArray(paths)) {
        throw fieldError('paths', 'expected an array');
      }
      if (paths.length < 1 || paths.length > trash.maxBatchPaths) {
        throw fieldError('paths', `expected 1 to ${trash.maxBatchPaths} paths`);
      }
      const result = await trash.moveBatch(paths, { actorId: actorIdOf(request) });
      return successEnvelope(result);
    },
  );

  // POST /api/workspace/trash/{id}/restore: restore to the original
  // path, or to body.target. Never overwrites an occupied target.
  app.post(
    '/api/workspace/trash/:id/restore',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const params = request.params as { id?: unknown };
      const body = request.body === undefined ? {} : requireJsonObject(request.body);
      rejectUnknownFields(body, ['target']);
      const target = body['target'];
      if (target !== undefined && typeof target !== 'string') {
        throw fieldError('target', 'expected a string');
      }
      const result = await trash.restore(params.id, {
        target: typeof target === 'string' ? target : undefined,
        actorId: actorIdOf(request),
      });
      return successEnvelope(result);
    },
  );

  // DELETE /api/workspace/trash/{id}: purge one entry permanently.
  app.delete(
    '/api/workspace/trash/:id',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const params = request.params as { id?: unknown };
      const result = await trash.purge(params.id);
      return successEnvelope(result);
    },
  );

  // DELETE /api/workspace/trash: empty all trash. Body JSON
  // { confirm: true } is mandatory; anything else answers 400
  // confirm_required.
  app.delete(
    '/api/workspace/trash',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      if (request.body === undefined) {
        throw new ApiError(400, 'confirm_required', 'Confirmation is required to empty the trash.');
      }
      const body = requireJsonObject(request.body);
      rejectUnknownFields(body, ['confirm']);
      if (body['confirm'] !== true) {
        throw new ApiError(400, 'confirm_required', 'Confirmation is required to empty the trash.');
      }
      const result = await trash.purgeAll();
      return successEnvelope(result);
    },
  );
}
