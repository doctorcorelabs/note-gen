// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace media delete route (V3-07 part 2, wave 3B overlap,
// AD-57). PROVISIONAL: this route is NOT in the canonical contract.
//
//   DELETE /api/workspace/media/<path>
//
// Status warning, read before merge. Neither
// kontrak-api-kanonis.md section 3.1 nor desain-workspace-api.md
// (V1-09) section 7 defines a DELETE media endpoint: media files
// are deleted in the design through DELETE /api/workspace/file and
// DELETE /api/workspace/folder, which move the entry to trash
// (V1-09 section 2.8: no one-step permanent delete from the
// workspace). This file implements the tasked guarded delete
// exactly as briefed (path-form URL mirroring GET media, mandatory
// revision guard, direct removal), so the behavior exists for
// review, but merging it requires two recorded decisions: (1) a
// contract amendment adding the route, its guard rule, and its
// success shape; (2) a coordinator ruling on permanent removal
// versus trash routing once V3-05 lands. Until then, do not treat
// this route as canonical and do not build client calls on it
// without that amendment.
//
// Guard semantics are borrowed from PUT media (V1-09 section 7.4,
// amended K-03), because no delete-specific guard rule exists:
// exactly one header guard is required; none answers 428
// precondition_required; a malformed pair answers 400
// invalid_precondition; a stale If-Match answers 412
// revision_conflict with the section 3.4 conflict payload
// (currentPreview null: binary content has no preview);
// If-Match: * is the logged force form; If-None-Match: * over an
// existing file answers 409 already_exists, mirroring the write
// service guard evaluation. A missing file answers 404 not_found;
// a directory answers 409 wrong_kind (DELETE folder is the right
// endpoint); a symlink answers 400 symlink_not_allowed; hidden
// paths answer 400 invalid_path (write rule, desain 8.6).
//
// Evaluation order mirrors the write routes: guard parsing and
// the 428 check run before path resolution, so a guardless request
// answers 428 even over an invalid path, exactly like PUT.
//
// Ports: paths and revisions only, taken from the frozen
// WorkspaceWritePorts the integrator already wires in app.ts
// (createV304aWritePorts). The index and event ports have no
// delete shape (recordWrite eventType is created|changed;
// WorkspaceWriteEvent kind is created|changed), so this handler
// makes no index or event call and invents no port method: the
// deletion becomes visible through the watcher and reconcile
// (V3-06/V3-08), and index soft-delete needs a port extension
// owned by those workers. Idempotency keys are not honored: the
// contract lists no key support for this route, and the revision
// guard is the retry protection.
//
// Concurrency: the delete does not share the write service queue
// (no shared queue instance exists to inject), so a write that
// lands between the guard read and the unlink can be removed with
// the old content. The integrator must route deletes through the
// shared per-path queue at merge time, or accept the race in the
// amendment. The success shape { path, kind, size, deletedAt } is
// provisional (mirrors the DELETE file shape minus trash fields)
// and is fixed by the amendment, not by this file.
//
// Auth, CSRF, and Origin are enforced by the frozen global hook
// (middleware/auth-hook.ts); this route only declares
// requiresAuth. Fail-closed wiring: without injected ports, the
// handler answers 503 service_unavailable after auth passes,
// mirroring the write routes.

import { lstat, readFile, unlink } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import {
  buildPreview,
  parseHeaderGuard,
  revisionConflictError,
} from '../services/workspace/write-guards.js';
import type { WorkspaceWritePorts } from '../services/workspace/write-ports.js';

export interface WorkspaceMediaDeleteRouteDeps {
  ports?: WorkspaceWritePorts;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  );
}

// The wildcard segment as Fastify delivers it. The framework has
// already decoded the URL once; this handler never decodes again
// (desain 8.2, no double decode), and the path port rejects dot
// segments, backslashes, and absolute forms. The bare
// /api/workspace/media URL has no wildcard value, which the path
// port rejects as invalid_path: the root is never a delete target.
function rawMediaPath(request: FastifyRequest): unknown {
  const params = request.params as { '*'?: unknown };
  return params['*'];
}

export async function registerWorkspaceMediaDeleteRoutes(
  app: FastifyInstance,
  deps: WorkspaceMediaDeleteRouteDeps,
): Promise<void> {
  const ports = deps.ports;

  async function handleDelete(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (ports === undefined) {
      throw ApiError.serviceUnavailable();
    }
    const guard = parseHeaderGuard({
      ifMatch: request.headers['if-match'],
      ifNoneMatch: request.headers['if-none-match'],
    });
    if (guard.kind === 'none') {
      throw ApiError.preconditionRequired();
    }
    const resolved = await ports.paths.resolveWritePath(rawMediaPath(request));

    let info;
    try {
      info = await lstat(resolved.absolute);
    } catch (error) {
      if (isNotFound(error)) {
        throw ApiError.notFound();
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new ApiError(400, 'symlink_not_allowed', 'Symlinks are not allowed.');
    }
    if (info.isDirectory()) {
      throw new ApiError(409, 'wrong_kind', 'The path is a folder, not a file.');
    }
    if (!info.isFile()) {
      throw ApiError.notFound();
    }

    let content: Buffer;
    try {
      content = await readFile(resolved.absolute);
    } catch (error) {
      if (isNotFound(error)) {
        throw ApiError.notFound();
      }
      throw error;
    }
    const currentRevision = ports.revisions.compute(resolved.normalized, content);

    if (guard.kind === 'create-only') {
      throw ApiError.alreadyExists();
    }
    if (guard.kind === 'match' && guard.revision !== currentRevision) {
      const preview = buildPreview(content, false);
      throw revisionConflictError(412, {
        path: resolved.normalized,
        serverRevision: currentRevision,
        serverVersion: null,
        serverModifiedAt: info.mtime.toISOString(),
        serverSize: info.size,
        currentPreview: preview.currentPreview,
        previewTruncated: preview.previewTruncated,
        suggestedCopyPath: null,
      });
    }

    try {
      await unlink(resolved.absolute);
    } catch (error) {
      if (isNotFound(error)) {
        throw ApiError.notFound();
      }
      throw error;
    }

    if (guard.kind === 'force') {
      // Structured audit for a conscious forced delete (desain
      // section 3.5): path and revision only, never content.
      request.log.info(
        { path: resolved.normalized, oldRevision: currentRevision },
        'forced workspace media delete',
      );
    }
    reply.code(200).send(
      successEnvelope({
        path: resolved.normalized,
        kind: 'file',
        size: info.size,
        deletedAt: new Date().toISOString(),
      }),
    );
  }

  app.delete('/api/workspace/media', { config: { requiresAuth: true } }, handleDelete);
  app.delete('/api/workspace/media/*', { config: { requiresAuth: true } }, handleDelete);
}
