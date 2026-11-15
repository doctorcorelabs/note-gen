// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace mkdir route (owner V3-05, wave 3B overlap AD-57).
// Kontrak 3.1, desain-workspace-api.md section 2.6:
//
//   POST /api/workspace/mkdir
//
// Creates a folder and its parents. Idempotent: a folder that
// already exists answers 200 with created false and no change; a
// newly created folder answers 201 with created true. The response
// data is { path, created, entry } where entry is the DirEntry shape
// of desain section 1.4 (size, revision, and version null for a
// folder, as on the read side).
//
// Authentication comes from the frozen global auth hook
// (middleware/auth-hook.ts): this route sets requiresAuth true and
// relies on the hook for the 401 session check plus the Origin and
// CSRF checks for mutations. JSON responses use the canonical
// envelope (plugins/envelope.ts); errors are ApiError values handled
// by the global error handler.
//
// Path handling uses the single authority, lib/paths.ts (owner
// V3-04a): validateWorkspacePath for syntax, then
// assertNoSymlinkComponents for the symlink and containment checks.
// No path logic is duplicated here. Hidden (dot-segment) paths
// answer 400 invalid_path because mkdir is a write (desain section
// 8.6); the read-side 404 mapping for hidden paths does not apply.
// A path that exists as a file, or a file anywhere on the path,
// answers 409 already_exists, matching the R1 client conformance
// mock (tests/workspace-client/mock-server.mjs handleMkdir).
//
// Body rules follow the conformance mock and kontrak 1.5: a missing
// body answers invalid_json (an unparseable or empty JSON body is
// mapped to invalid_json by the global error handler, AD-46); a
// parsed body that is not a plain object, an unknown field, or a
// non-string path answers 400 validation_failed. This deliberately
// does not use requireJsonObject from write-guards.ts: that helper
// answers invalid_json for a parsed non-object body, which
// contradicts the conformance suite (an array body must answer
// validation_failed). The divergence is noted for V3-41; append and
// patch share it and are not this route's to fix.
//
// The JSON body limit is exactly 64 KiB (desain section 1.7): a body
// of exactly 64 KiB parses, one byte more answers 413
// payload_too_large through the global error handler.
//
// No index write and no event publication happen here: the index
// and event ports (WorkspaceIndexPort.recordWrite and
// WorkspaceEventPort.publish in services/workspace/write-ports.ts)
// are UNWIRED for this route. That is deliberate, not an omission:
// IndexWriteInput is file-shaped (contentHash, sizeBytes, mimeType)
// and WorkspaceWriteEvent requires a revision string, while folders
// carry revision null on the read side, so firing either port would
// require inventing folder-shaped values the contract does not
// define. The route therefore succeeds without them, degrading
// honestly like the optional ports in WorkspaceWritePorts, until
// the index worker (V3-15) and the realtime worker (V3-08) define
// folder-shaped inputs. The created/rescan event rule of desain
// section 2.6 is owned by that later wiring; the integrator must
// not add direct index or event calls here. The route takes only
// the workspace root, like the read routes, so the integrator wires
// it with one commented block in app.ts and no AppDeps change.

import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  InvalidWorkspacePathError,
  WorkspaceRootUnavailableError,
  WorkspaceSymlinkError,
  assertNoSymlinkComponents,
  validateWorkspacePath,
} from '../lib/paths.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import type { WorkspaceEntry } from '../services/workspace/read.js';
import { fieldError, rejectUnknownFields } from '../services/workspace/write-guards.js';

export interface WorkspaceMkdirRouteDeps {
  workspaceRoot: string | undefined;
}

// Desain section 1.7: JSON bodies for mkdir, move, restore, and
// patch are limited to 64 KiB.
export const MKDIR_BODY_LIMIT_BYTES = 64 * 1024;

function symlinkNotAllowed(): ApiError {
  return new ApiError(400, 'symlink_not_allowed', 'Symlinks are not allowed.');
}

function isoOrNull(date: Date): string | null {
  const ms = date.getTime();
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  return date.toISOString();
}

function fsErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

// Asserts that the parsed body is a plain JSON object. A missing
// body (no body sent at all) answers invalid_json, matching the
// conformance mock's empty-body rule; a parsed value that is not a
// plain object (array, null, scalar, or a non-JSON Buffer body)
// answers validation_failed, matching the mock's parseJsonBody rule
// and kontrak 1.5.3 (wrong shape, not unparseable JSON).
function requireMkdirBody(body: unknown): Record<string, unknown> {
  if (body === undefined) {
    throw ApiError.invalidJson();
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Buffer.isBuffer(body)) {
    throw ApiError.validation('Request validation failed.');
  }
  return body as Record<string, unknown>;
}

// Walks the path prefixes under the resolved root with lstat (never
// following symlinks) and reports whether the target directory
// already exists. A file anywhere on the path answers 409
// already_exists; a symlink component answers 400
// symlink_not_allowed. A missing component ends the walk: everything
// below it is missing too. ENOTDIR means a file blocks the walk;
// ELOOP means a symlink loop blocks it.
async function targetAlreadyExists(rootReal: string, segments: readonly string[]): Promise<boolean> {
  let current = rootReal;
  for (let i = 0; i < segments.length; i += 1) {
    current = join(current, segments[i] as string);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      const code = fsErrorCode(error);
      if (code === 'ENOENT') {
        return false;
      }
      if (code === 'ENOTDIR') {
        throw ApiError.alreadyExists('The path already exists as a file.');
      }
      if (code === 'ELOOP') {
        throw symlinkNotAllowed();
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw symlinkNotAllowed();
    }
    if (!stats.isDirectory()) {
      throw ApiError.alreadyExists('The path already exists as a file.');
    }
    if (i === segments.length - 1) {
      return true;
    }
  }
  return false;
}

export async function registerWorkspaceMkdirRoutes(
  app: FastifyInstance,
  deps: WorkspaceMkdirRouteDeps,
): Promise<void> {
  app.post(
    '/api/workspace/mkdir',
    { config: { requiresAuth: true }, bodyLimit: MKDIR_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = requireMkdirBody(request.body);
      rejectUnknownFields(body, ['path']);
      const rawPath = body['path'];
      if (typeof rawPath !== 'string') {
        throw fieldError('path', 'expected a string');
      }

      let validated;
      try {
        validated = validateWorkspacePath(rawPath);
      } catch (error) {
        if (error instanceof InvalidWorkspacePathError) {
          throw ApiError.invalidPath();
        }
        throw error;
      }
      // Writes reject hidden paths with 400 (desain section 8.6).
      // The root itself is never a mkdir target: the empty string is
      // already rejected by the validator, and the isRoot guard
      // below keeps that true if the validator ever changes.
      if (validated.hidden || validated.isRoot) {
        throw ApiError.invalidPath();
      }

      if (deps.workspaceRoot === undefined || deps.workspaceRoot === '') {
        throw ApiError.serviceUnavailable();
      }
      let fsPath: string;
      try {
        fsPath = await assertNoSymlinkComponents(deps.workspaceRoot, validated);
      } catch (error) {
        if (error instanceof WorkspaceSymlinkError) {
          throw symlinkNotAllowed();
        }
        if (error instanceof WorkspaceRootUnavailableError) {
          throw ApiError.serviceUnavailable();
        }
        if (error instanceof InvalidWorkspacePathError) {
          throw ApiError.invalidPath();
        }
        // assertNoSymlinkComponents only swallows ENOENT: a file
        // blocking an intermediate segment surfaces as a raw ENOTDIR
        // from its lstat walk, and a symlink loop as ELOOP. Map both
        // here (paths.ts is frozen); anything else stays a 500.
        const code = fsErrorCode(error);
        if (code === 'ENOTDIR') {
          throw ApiError.alreadyExists('The path already exists as a file.');
        }
        if (code === 'ELOOP') {
          throw symlinkNotAllowed();
        }
        throw error;
      }
      // The resolved root is the fsPath prefix: recover it from the
      // checked path so the prefix walk below starts inside the
      // resolved root, never through a symlinked root spelling.
      const rootReal = validated.segments.length === 0 ? fsPath : fsPath.slice(0, fsPath.length - validated.path.length - 1);

      let existed = await targetAlreadyExists(rootReal, validated.segments);
      if (!existed) {
        try {
          await mkdir(fsPath, { recursive: true });
        } catch (error) {
          const code = fsErrorCode(error);
          if (code === 'EEXIST' || code === 'ENOTDIR' || code === 'ELOOP') {
            // A concurrent creator or a file that appeared between
            // the prefix walk and the mkdir: reclassify from the
            // current on-disk state instead of guessing from the
            // error code alone.
            existed = await targetAlreadyExists(rootReal, validated.segments);
            if (!existed) {
              throw error;
            }
          } else {
            throw error;
          }
        }
      }

      let stats;
      try {
        stats = await lstat(fsPath);
      } catch (error) {
        if (fsErrorCode(error) === 'ENOENT') {
          throw ApiError.serviceUnavailable();
        }
        throw error;
      }
      if (stats.isSymbolicLink()) {
        throw symlinkNotAllowed();
      }
      if (!stats.isDirectory()) {
        throw ApiError.alreadyExists('The path already exists as a file.');
      }

      const entry: WorkspaceEntry = {
        name: validated.segments[validated.segments.length - 1] as string,
        path: validated.path,
        isDirectory: true,
        isFile: false,
        size: null,
        modifiedAt: isoOrNull(stats.mtime),
        createdAt: isoOrNull(stats.birthtime),
        revision: null,
        version: null,
        isLocale: true,
      };
      return reply.code(existed ? 200 : 201).send(
        successEnvelope({
          path: validated.path,
          created: !existed,
          entry,
        }),
      );
    },
  );
}
