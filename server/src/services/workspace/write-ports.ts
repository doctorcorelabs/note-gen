// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Ports for the workspace write path (V3-04b, wave 3A).
//
// This file defines INTERFACES ONLY. It contains no path validation
// logic and no revision computation: those belong to V3-04a
// (server/src/lib/paths.ts and server/src/lib/revision.ts). The write
// service receives implementations of these ports through dependency
// injection, so this branch stays green and testable before the V3-04a
// branch lands, and the integrator wires the real modules with one
// thin adapter in the app.ts registration block. No rival paths.ts or
// revision.ts is created here, and no path/revision logic is
// duplicated in the write services.
//
// Port contracts (from fase1/desain-workspace-api.md):
// - Path port: section 8 order of validation (normalize, reject
//   traversal/absolute/control characters, length and segment limits,
//   dot-segment filter, symlink containment). A write over a path
//   with a symlink component answers 400 symlink_not_allowed; other
//   rejections answer 400 invalid_path. The port throws ApiError
//   values with those codes; the service does not reinterpret them.
// - Revision port: section 3.1 formula, sha256 over workspaceKey,
//   normalized path, and raw content bytes. The workspaceKey never
//   leaves the revision implementation; callers only see the opaque
//   revision string.
// - Index port: section 3.7 step 8. The files index row and the
//   file_events row are written in ONE Postgres transaction. When
//   absent, writes still succeed on disk and version fields are
//   null (desain-workspace-api.md section 1.4: version is null when
//   no index row exists); wiring the Postgres implementation is an
//   integrator step, not a silent fallback inside this service.
// - Event port: section 3.7 step 9. Publication is best effort and
//   never fails a write. Events are coalesced by the write queue
//   sink (see write-queue.ts) before reaching this port; the
//   WebSocket fan-out itself belongs to V3-08.
// - Idempotency port: kontrak-api-kanonis.md sections 1.6 and 4.
//   When absent, Idempotency-Key headers are ignored safely and the
//   revision guard remains the retry protection, as the contract
//   allows while key storage is unavailable.

import type { SessionPrincipal } from '../../middleware/auth-hook.js';

// A workspace path after validation: the normalized POSIX relative
// path plus the absolute filesystem path inside the workspace root.
// The absolute path is only ever used server-side; it never enters a
// response body, an error detail, or a log line.
export interface ResolvedWorkspacePath {
  normalized: string;
  absolute: string;
}

// Validates a client-supplied path for a WRITE operation and resolves
// it inside the workspace root. Throws ApiError (invalid_path or
// symlink_not_allowed) on rejection. The input is unknown because it
// arrives from a query string or a JSON body; non-string input is a
// rejection, never a coercion.
export interface WorkspacePathPort {
  resolveWritePath(input: unknown): Promise<ResolvedWorkspacePath>;
}

// Computes the opaque revision string for file content at a
// normalized path. Pure and synchronous: the same path and bytes
// always yield the same revision.
export interface RevisionPort {
  compute(normalizedPath: string, content: Buffer): string;
}

// Server-side identity for one authenticated request, resolved from
// the session principal. The workspace id is the workspaces.id UUID
// that also keys the revision formula inside the revision port; the
// user id keys idempotency storage. Neither value comes from the
// client: a request that carries workspaceId is rejected by the
// unknown-field rule before it reaches this layer.
export interface WorkspaceIdentity {
  workspaceId: string;
  userId: string;
  actorId: string | undefined;
}

// Resolves the workspace identity for a verified principal. Returns
// null when no workspace can be attributed (for example before the
// auth worker lands the session-to-workspace mapping); callers fail
// closed in that case whenever a Postgres-backed port is in use.
export type WorkspaceIdentityResolver = (
  principal: SessionPrincipal,
) => Promise<WorkspaceIdentity | null>;

export interface IndexWriteInput {
  workspaceId: string;
  actorId: string | undefined;
  path: string;
  // Hex SHA-256 of the content bytes only (files.content_hash). This
  // is NOT the revision: the revision also binds workspaceKey and
  // path (desain-workspace-api.md section 3.1).
  contentHash: string;
  sizeBytes: number;
  mimeType: string | null;
  eventType: 'created' | 'changed';
  created: boolean;
}

// Writes the files index row and the file_events row for one
// successful disk write, in a single transaction, and reads the
// current index version for conflict payloads and no-op appends.
export interface WorkspaceIndexPort {
  recordWrite(input: IndexWriteInput): Promise<{ version: number }>;
  currentVersion(workspaceId: string, path: string): Promise<number | null>;
}

// One coalesced workspace change, for the realtime layer. The shape
// is deliberately narrow: the WebSocket message contract (sequence
// numbers, actor labels, resync) belongs to V3-08, which maps from
// these fields.
export interface WorkspaceWriteEvent {
  kind: 'created' | 'changed';
  path: string;
  revision: string;
  version: number | null;
  actorId: string | undefined;
}

export interface WorkspaceEventPort {
  publish(events: readonly WorkspaceWriteEvent[]): Promise<void> | void;
}

// A stored idempotent response: everything needed to replay the
// original success without re-running the mutation.
export interface StoredIdempotentResponse {
  status: number;
  data: Record<string, unknown>;
  headers: {
    etag: string;
    revision: string;
    lastModified: string;
    version: string | undefined;
  };
}

export interface IdempotencyLookupInput {
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
}

export type IdempotencyLookupResult =
  | { outcome: 'miss' }
  | { outcome: 'hit'; response: StoredIdempotentResponse }
  | { outcome: 'reused' };

export interface IdempotencyPort {
  lookup(input: IdempotencyLookupInput): Promise<IdempotencyLookupResult>;
  store(input: IdempotencyLookupInput & { response: StoredIdempotentResponse }): Promise<void>;
}

// The full set of collaborators for the write service. Only paths
// and revisions are mandatory; the rest are optional so the service
// degrades honestly (null versions, no events, no key replay) until
// the owning workers land their pieces.
export interface WorkspaceWritePorts {
  paths: WorkspacePathPort;
  revisions: RevisionPort;
  index?: WorkspaceIndexPort;
  events?: WorkspaceEventPort;
  idempotency?: IdempotencyPort;
}
