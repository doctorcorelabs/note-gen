// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// TEST DOUBLES for the workspace write ports (V3-04b).
//
// These implementations exist ONLY under server/test/ so the write
// path can be exercised before V3-04a lands server/src/lib/paths.ts
// and server/src/lib/revision.ts. They implement the spec-faithful
// subset of desain-workspace-api.md needed by the write tests (path
// validation order, symlink containment, the section 3.1 revision
// formula) and MUST be replaced by the thin V3-04a adapter at
// integration time. Nothing in server/src/ imports this file, and
// no production behavior depends on it.
//
// The doubles are deliberately strict: any path or revision behavior
// the real V3-04a modules define differently must be caught by the
// V3-04a conformance tests, not papered over here.

import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionPrincipal } from '../../src/middleware/auth-hook.js';
import { ApiError } from '../../src/plugins/envelope.js';
import type {
  IdempotencyLookupInput,
  IdempotencyLookupResult,
  IdempotencyPort,
  IndexWriteInput,
  ResolvedWorkspacePath,
  RevisionPort,
  StoredIdempotentResponse,
  WorkspaceEventPort,
  WorkspaceIdentity,
  WorkspaceIdentityResolver,
  WorkspaceIndexPort,
  WorkspacePathPort,
  WorkspaceWriteEvent,
  WorkspaceWritePorts,
} from '../../src/services/workspace/write-ports.js';

export const TEST_WORKSPACE_KEY = 'test-workspace-key';
export const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
export const TEST_USER_ID = '00000000-0000-4000-8000-000000000002';

const MAX_PATH_BYTES = 1024;
const MAX_SEGMENTS = 50;

function invalidPath(message: string): ApiError {
  return new ApiError(400, 'invalid_path', message);
}

// Spec-faithful subset of the path validation order in
// desain-workspace-api.md section 8: reject non-strings, empty
// input, NUL/control characters, backslashes, absolute paths, and
// drive letters; collapse repeated slashes; reject dot segments,
// dot-leading segments, and empty segments; enforce the byte and
// segment limits; then walk every existing path prefix and reject
// any symlink component.
export function createTestPathPort(root: string): WorkspacePathPort {
  return {
    async resolveWritePath(input: unknown): Promise<ResolvedWorkspacePath> {
      if (typeof input !== 'string' || input === '') {
        throw invalidPath('The workspace path is not valid.');
      }
      if (input.includes('\0') || [...input].some((ch) => ch.codePointAt(0)! < 0x20 || ch === '\u007f')) {
        throw invalidPath('The workspace path is not valid.');
      }
      if (input.includes('\\')) {
        throw invalidPath('The workspace path is not valid.');
      }
      if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
        throw invalidPath('The workspace path is not valid.');
      }
      const normalized = input.replace(/\/+/g, '/');
      if (normalized === '' || normalized.endsWith('/')) {
        throw invalidPath('The workspace path is not valid.');
      }
      if (Buffer.byteLength(normalized, 'utf8') > MAX_PATH_BYTES) {
        throw invalidPath('The workspace path is not valid.');
      }
      const segments = normalized.split('/');
      if (segments.length > MAX_SEGMENTS) {
        throw invalidPath('The workspace path is not valid.');
      }
      for (const segment of segments) {
        if (segment === '' || segment === '.' || segment === '..' || segment.startsWith('.')) {
          throw invalidPath('The workspace path is not valid.');
        }
      }
      const base = await realpath(root);
      for (let i = 1; i <= segments.length; i += 1) {
        const prefix = join(base, ...segments.slice(0, i));
        let stat;
        try {
          stat = await lstat(prefix);
        } catch (error) {
          if ((error as { code?: unknown }).code === 'ENOENT') {
            break;
          }
          throw error;
        }
        if (stat.isSymbolicLink()) {
          throw new ApiError(400, 'symlink_not_allowed', 'The workspace path crosses a symbolic link.');
        }
      }
      return { normalized, absolute: join(base, ...segments) };
    },
  };
}

// The desain-workspace-api.md section 3.1 formula: sha256 over
// workspaceKey, NUL, normalized path, NUL, raw content bytes.
export function createTestRevisionPort(workspaceKey: string): RevisionPort {
  return {
    compute(normalizedPath: string, content: Buffer): string {
      const digest = createHash('sha256')
        .update(workspaceKey, 'utf8')
        .update('\0', 'utf8')
        .update(normalizedPath, 'utf8')
        .update('\0', 'utf8')
        .update(content)
        .digest('hex');
      return `sha256:${digest}`;
    },
  };
}

export class FakeIndexPort implements WorkspaceIndexPort {
  readonly rows = new Map<string, { version: number; input: IndexWriteInput }>();
  failNext = false;

  async recordWrite(input: IndexWriteInput): Promise<{ version: number }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated index failure');
    }
    const key = `${input.workspaceId}\0${input.path}`;
    const existing = this.rows.get(key);
    const version = existing === undefined ? 1 : existing.version + 1;
    this.rows.set(key, { version, input });
    return { version };
  }

  async currentVersion(workspaceId: string, path: string): Promise<number | null> {
    return this.rows.get(`${workspaceId}\0${path}`)?.version ?? null;
  }
}

export class FakeEventPort implements WorkspaceEventPort {
  readonly batches: WorkspaceWriteEvent[][] = [];
  readonly all: WorkspaceWriteEvent[] = [];

  publish(events: readonly WorkspaceWriteEvent[]): void {
    const copy = [...events];
    this.batches.push(copy);
    this.all.push(...copy);
  }
}

export class FakeIdempotencyPort implements IdempotencyPort {
  private readonly entries = new Map<string, { requestHash: string; response: StoredIdempotentResponse }>();

  async lookup(input: IdempotencyLookupInput): Promise<IdempotencyLookupResult> {
    const entry = this.entries.get(`${input.userId}\0${input.scope}\0${input.key}`);
    if (entry === undefined) {
      return { outcome: 'miss' };
    }
    if (entry.requestHash !== input.requestHash) {
      return { outcome: 'reused' };
    }
    return { outcome: 'hit', response: entry.response };
  }

  async store(input: IdempotencyLookupInput & { response: StoredIdempotentResponse }): Promise<void> {
    this.entries.set(`${input.userId}\0${input.scope}\0${input.key}`, {
      requestHash: input.requestHash,
      response: input.response,
    });
  }
}

export interface TestPortsBundle {
  ports: WorkspaceWritePorts;
  index: FakeIndexPort;
  events: FakeEventPort;
  idempotency: FakeIdempotencyPort;
  resolveIdentity: WorkspaceIdentityResolver;
}

export function createTestPorts(
  root: string,
  options: { workspaceId?: string; userId?: string; workspaceKey?: string } = {},
): TestPortsBundle {
  const index = new FakeIndexPort();
  const events = new FakeEventPort();
  const idempotency = new FakeIdempotencyPort();
  const workspaceId = options.workspaceId ?? TEST_WORKSPACE_ID;
  const userId = options.userId ?? TEST_USER_ID;
  const ports: WorkspaceWritePorts = {
    paths: createTestPathPort(root),
    revisions: createTestRevisionPort(options.workspaceKey ?? TEST_WORKSPACE_KEY),
    index,
    events,
    idempotency,
  };
  const resolveIdentity: WorkspaceIdentityResolver = async (
    _principal: SessionPrincipal,
  ): Promise<WorkspaceIdentity> => ({ workspaceId, userId, actorId: userId });
  return { ports, index, events, idempotency, resolveIdentity };
}
