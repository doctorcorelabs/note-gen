// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Thin adapter from the frozen V3-04a path/revision modules
// (server/src/lib/paths.ts, server/src/lib/revision.ts) to the
// workspace write ports (write-ports.ts). Landed by the V3-04b
// integrator from the trial-verified code in
// laporan-v3-04b-workspace-write.md; wired in the app.ts write
// block.
//
// The adapter contains NO validation or hashing logic of its own:
// it only maps the frozen modules' error classes to ApiError codes
// and binds the workspace key the same way the read side does
// (injected UUID, else the resolved workspace root).

import { realpathSync } from 'node:fs';
import {
  InvalidWorkspacePathError,
  WorkspaceRootUnavailableError,
  WorkspaceSymlinkError,
  assertNoSymlinkComponents,
  validateWorkspacePath,
} from '../../lib/paths.js';
import { buildRevision } from '../../lib/revision.js';
import { ApiError } from '../../plugins/envelope.js';
import type {
  ResolvedWorkspacePath,
  RevisionPort,
  WorkspacePathPort,
  WorkspaceWritePorts,
} from './write-ports.js';

export function createV304aPathPort(workspaceRoot: string | undefined): WorkspacePathPort {
  return {
    async resolveWritePath(input: unknown): Promise<ResolvedWorkspacePath> {
      if (workspaceRoot === undefined || workspaceRoot === '') {
        throw ApiError.serviceUnavailable();
      }
      let validated;
      try {
        validated = validateWorkspacePath(input);
      } catch (error) {
        if (error instanceof InvalidWorkspacePathError) {
          throw ApiError.invalidPath();
        }
        throw error;
      }
      // Writes reject hidden (dot-segment) paths with 400
      // invalid_path (desain section 8.6); the root itself is
      // never a write target.
      if (validated.hidden || validated.isRoot) {
        throw ApiError.invalidPath();
      }
      try {
        const absolute = await assertNoSymlinkComponents(workspaceRoot, validated);
        return { normalized: validated.path, absolute };
      } catch (error) {
        if (error instanceof WorkspaceSymlinkError) {
          throw new ApiError(400, 'symlink_not_allowed', 'Symlinks are not allowed.');
        }
        if (error instanceof WorkspaceRootUnavailableError) {
          throw ApiError.serviceUnavailable();
        }
        if (error instanceof InvalidWorkspacePathError) {
          throw ApiError.invalidPath();
        }
        throw error;
      }
    },
  };
}

export function createV304aRevisionPort(
  workspaceRoot: string | undefined,
  workspaceKey: string | undefined,
): RevisionPort {
  let cachedKey: string | undefined;
  return {
    compute(normalizedPath: string, content: Buffer): string {
      if (workspaceKey !== undefined) {
        return buildRevision(workspaceKey, normalizedPath, content);
      }
      if (cachedKey === undefined) {
        if (workspaceRoot === undefined || workspaceRoot === '') {
          throw ApiError.serviceUnavailable();
        }
        cachedKey = realpathSync(workspaceRoot);
      }
      return buildRevision(cachedKey, normalizedPath, content);
    },
  };
}

// Paths + revisions only. The index, event, and idempotency ports
// are wired by the integrator from the PG adapters
// (write-index-pg.ts, write-idempotency.ts) and the V3-08 event
// publisher; until then writes succeed with null versions and no
// key replay, exactly as the port contract documents.
export function createV304aWritePorts(
  workspaceRoot: string | undefined,
  workspaceKey?: string,
): WorkspaceWritePorts {
  return {
    paths: createV304aPathPort(workspaceRoot),
    revisions: createV304aRevisionPort(workspaceRoot, workspaceKey),
  };
}
