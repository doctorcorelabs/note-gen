// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// TEST-ONLY thin adapter: the real V3-04a path and revision modules
// behind the V3-04b write ports (V3-04cR, wave 3A conformance).
//
// The workspace write service (V3-04b) receives its path and revision
// behavior through injected ports, so it can be tested before the
// V3-04a modules land. The V3-04b suite runs against test doubles
// that re-implement the spec-faithful subset. The conformance specs
// in this directory run the SAME real routes, guards, queue, and
// service with the REAL modules instead: validateWorkspacePath,
// assertNoSymlinkComponents, and buildRevision from
// server/src/lib/. Any behavior the doubles define differently from
// the real modules must surface here, not at integration time.
//
// This adapter mirrors the thin adapter the integrator writes in the
// app.ts registration block. It lives under server/test/ only;
// nothing in server/src/ imports it, and no production behavior
// depends on it. The index, event, and idempotency collaborators
// stay the V3-04b fakes: the Postgres index port is integrator
// wiring, the WebSocket fan-out belongs to V3-08, and key storage
// belongs to the auth worker. The auth verifiers stay stubs behind
// the REAL frozen auth hooks (see workspace-test-app.ts).
//
// Error mapping (desain-workspace-api.md sections 8.5 and 8.6):
// hidden paths answer 400 invalid_path for writes; symlink
// components answer 400 symlink_not_allowed for writes; an
// unresolvable workspace root answers 503 service_unavailable.

import type { SessionPrincipal } from '../../src/middleware/auth-hook.js';
import {
  assertNoSymlinkComponents,
  InvalidWorkspacePathError,
  validateWorkspacePath,
  WorkspaceRootUnavailableError,
  WorkspaceSymlinkError,
} from '../../src/lib/paths.js';
import { buildRevision } from '../../src/lib/revision.js';
import { ApiError } from '../../src/plugins/envelope.js';
import type {
  ResolvedWorkspacePath,
  RevisionPort,
  WorkspaceIdentity,
  WorkspaceIdentityResolver,
  WorkspacePathPort,
  WorkspaceWritePorts,
} from '../../src/services/workspace/write-ports.js';
import {
  FakeEventPort,
  FakeIdempotencyPort,
  FakeIndexPort,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
  type TestPortsBundle,
} from '../helpers/workspace-test-ports.js';

// The stable server-side workspace key used by the real revision
// port in these tests. Conformance specs recompute revisions
// independently with this key and node:crypto, never by calling
// buildRevision, so a wrong formula cannot hide behind itself.
export const REAL_WORKSPACE_KEY = 'test-workspace-key';

export function createRealPathPort(root: string): WorkspacePathPort {
  return {
    async resolveWritePath(input: unknown): Promise<ResolvedWorkspacePath> {
      let validated;
      try {
        validated = validateWorkspacePath(input);
      } catch (error) {
        if (error instanceof InvalidWorkspacePathError) {
          throw ApiError.invalidPath();
        }
        throw error;
      }
      if (validated.hidden) {
        throw ApiError.invalidPath();
      }
      try {
        const absolute = await assertNoSymlinkComponents(root, validated);
        return { normalized: validated.path, absolute };
      } catch (error) {
        if (error instanceof WorkspaceSymlinkError) {
          throw new ApiError(400, 'symlink_not_allowed', 'The workspace path crosses a symbolic link.');
        }
        if (error instanceof WorkspaceRootUnavailableError) {
          throw ApiError.serviceUnavailable();
        }
        throw error;
      }
    },
  };
}

export function createRealRevisionPort(workspaceKey: string): RevisionPort {
  return {
    compute(normalizedPath: string, content: Buffer): string {
      return buildRevision(workspaceKey, normalizedPath, content);
    },
  };
}

export function createRealPortsBundle(
  root: string,
  options: { workspaceId?: string; userId?: string; workspaceKey?: string } = {},
): TestPortsBundle {
  const index = new FakeIndexPort();
  const events = new FakeEventPort();
  const idempotency = new FakeIdempotencyPort();
  const workspaceId = options.workspaceId ?? TEST_WORKSPACE_ID;
  const userId = options.userId ?? TEST_USER_ID;
  const ports: WorkspaceWritePorts = {
    paths: createRealPathPort(root),
    revisions: createRealRevisionPort(options.workspaceKey ?? REAL_WORKSPACE_KEY),
    index,
    events,
    idempotency,
  };
  const resolveIdentity: WorkspaceIdentityResolver = async (
    _principal: SessionPrincipal,
  ): Promise<WorkspaceIdentity> => ({ workspaceId, userId, actorId: userId });
  return { ports, index, events, idempotency, resolveIdentity };
}
