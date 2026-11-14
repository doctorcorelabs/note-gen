// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Filesystem operational errors (moved from fs/interface.ts at merge
// M8, audit V2-40: the interface file stays type-only, and the error
// class plus its helpers live here. Capability failures use
// PlatformCapabilityError from ../errors instead, never this class.

/** Conflict payload from V1-09 section 3.4, carried on FsAdapterError. */
export interface FsConflictPayload {
  path: string;
  serverRevision: string;
  serverVersion: number | null;
  serverModifiedAt: string;
  serverSize: number;
  currentPreview: string | null;
  previewTruncated: boolean;
  suggestedCopyPath: string | null;
  actions: string[];
  failedOperation?: "append" | "patch";
}

/**
 * Operational filesystem error. `code` is a stable string from the V1-09
 * error catalog (section 10) when the error came from the server, or one
 * of the client-side codes below when the adapter rejected the call
 * before any request or when the response was unusable: `invalid_path`
 * (same code the server uses), `directory_not_empty`, `network_error`,
 * `invalid_response`, `not_a_file`, `invalid_state`, `invalid_argument`,
 * `unknown`. Capability failures (a feature the web mode cannot provide
 * at all) use PlatformCapabilityError instead, never this class.
 */
export class FsAdapterError extends Error {
  readonly code: string;
  readonly status: number;
  readonly path?: string;
  readonly requestId?: string;
  readonly detail?: string;
  readonly conflict?: FsConflictPayload;
  readonly retryAfterSeconds?: number;
  readonly diskWritten?: boolean;

  constructor(opts: {
    code: string;
    status: number;
    message: string;
    path?: string;
    requestId?: string;
    detail?: string;
    conflict?: FsConflictPayload;
    retryAfterSeconds?: number;
    diskWritten?: boolean;
  }) {
    super(opts.message);
    this.name = "FsAdapterError";
    this.code = opts.code;
    this.status = opts.status;
    this.path = opts.path;
    this.requestId = opts.requestId;
    this.detail = opts.detail;
    this.conflict = opts.conflict;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.diskWritten = opts.diskWritten;
  }
}

export function isFsAdapterError(err: unknown): err is FsAdapterError {
  return err instanceof FsAdapterError;
}

/**
 * True for revision conflicts from either guard location: HTTP 412
 * `revision_conflict` (If-Match) or HTTP 409 `version_conflict`
 * (expectedRevision in a JSON body). Callers must treat both the same
 * way (V1-09 section 3.3); the web implementation normalizes both to
 * code `revision_conflict`, and this helper also accepts the raw
 * `version_conflict` code for errors produced elsewhere.
 */
export function isRevisionConflictError(err: unknown): boolean {
  return (
    isFsAdapterError(err) &&
    (err.code === "revision_conflict" || err.code === "version_conflict")
  );
}

export function isNotFoundError(err: unknown): boolean {
  return isFsAdapterError(err) && err.code === "not_found";
}
