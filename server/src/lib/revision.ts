// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Revision scheme (frozen shared shape, owner V3-04a).
//
// Revision formula (desain-workspace-api.md section 3.1, reusing the
// upstream buildRevision scheme from src/lib/local-mcp/tools.ts):
//
//   revision = "sha256:" + hex(SHA-256(workspaceKey + NUL + filePath
//              + NUL + content))
//
// workspaceKey is a stable server-side workspace identifier, filePath
// is the normalized workspace-relative POSIX path, and content is the
// raw bytes on disk, with no line-ending normalization and no
// re-encoding. The upstream form hashes the same three parts joined
// by NUL as one UTF-8 string; for text files the two agree exactly
// because the stored bytes are the UTF-8 encoding of the decoded
// text, and for binary files the byte form here is the one the
// design requires. A revision changes when the path changes even if
// the bytes are identical, so revisions must never be reused across
// a move or restore.
//
// Revisions are presented as HTTP ETags (quoted-string) and as the
// JSON field revision / header X-Revision (unquoted). Guard parsing
// follows desain section 3.2: a W/ prefix is tolerated, one pair of
// double quotes is stripped, comma-separated If-Match lists are
// rejected, and If-None-Match on write endpoints accepts only "*".
// For GET revalidation, If-None-Match lists are honored and "*" matches
// any existing resource.
//
// contentHash is a different value: hex SHA-256 over the content
// bytes alone, matching files.content_hash in the index. It must
// never be substituted for a revision.
//
// V3-04b, V3-05, V3-06, and V3-07 import this module; they must not
// write a competing revision helper. Changes to this shape need a
// recorded amendment.

import { createHash } from 'node:crypto';

export const REVISION_PREFIX = 'sha256:';

const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

// Thrown when a precondition header is structurally invalid (a list
// where only one value is allowed, an unbalanced quoted string, or a
// revision value where only "*" is allowed). Route handlers map this
// to 400 invalid_precondition.
export class InvalidPreconditionError extends Error {
  constructor(message = 'The precondition header is not valid.') {
    super(message);
    this.name = 'InvalidPreconditionError';
  }
}

export function isRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION_PATTERN.test(value);
}

// Build a revision from raw content bytes (or a string, encoded as
// UTF-8). workspaceKey must be the same stable server-side key for
// every call about the same workspace; it is never sent to clients.
export function buildRevision(
  workspaceKey: string,
  filePath: string,
  content: Uint8Array | string,
): string {
  const hash = createHash('sha256');
  hash.update(workspaceKey, 'utf8');
  hash.update(Buffer.from([0]));
  hash.update(filePath, 'utf8');
  hash.update(Buffer.from([0]));
  hash.update(content);
  return `${REVISION_PREFIX}${hash.digest('hex')}`;
}

// Hex SHA-256 over content bytes alone (files.content_hash). Not a
// revision and never usable as a guard.
export function contentHash(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ETag presentation: the revision wrapped in one pair of quotes.
export function quoteETag(revision: string): string {
  return `"${revision}"`;
}

// Parse one ETag-ish value: trim whitespace, strip an optional W/
// prefix, strip one pair of double quotes. Returns null for an empty
// or structurally malformed value (unbalanced quotes, embedded comma
// or quote). A returned value is not validated as a revision here:
// comparison against the current revision decides equality, and a
// non-matching value simply does not match.
export function parseETagValue(raw: string): string | null {
  let value = raw.trim();
  if (value === '') {
    return null;
  }
  if (value.startsWith('W/')) {
    value = value.slice(2).trim();
  }
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) {
      return null;
    }
    const inner = value.slice(1, -1);
    if (inner.includes('"') || inner.includes(',')) {
      return null;
    }
    return inner;
  }
  if (value.includes('"') || value.includes(',')) {
    return null;
  }
  return value;
}

function headerValues(header: string | string[] | undefined): string[] {
  if (header === undefined) {
    return [];
  }
  return Array.isArray(header) ? header : [header];
}

// GET revalidation: true when any If-None-Match value equals the
// current revision, or when "*" is present (any existing resource
// matches). Malformed values never match; they are ignored rather
// than treated as errors on the read path.
export function ifNoneMatchMatches(
  header: string | string[] | undefined,
  revision: string,
): boolean {
  for (const raw of headerValues(header)) {
    for (const part of raw.split(',')) {
      const parsed = parseETagValue(part);
      if (parsed === '*' || (parsed !== null && parsed === revision)) {
        return true;
      }
    }
  }
  return false;
}

export type IfMatchGuard =
  | { kind: 'none' }
  | { kind: 'star' }
  | { kind: 'revision'; revision: string };

// Parse If-Match for write guards. A comma-separated list, an empty
// value, or an unbalanced quoted string throws
// InvalidPreconditionError. "*" is the force form (desain 3.5); any
// other single value is a revision guard compared exactly.
export function parseIfMatch(header: string | string[] | undefined): IfMatchGuard {
  const values = headerValues(header).filter((value) => value.trim() !== '');
  if (values.length === 0) {
    return { kind: 'none' };
  }
  if (values.length > 1) {
    throw new InvalidPreconditionError();
  }
  const raw = values[0] as string;
  if (raw.includes(',')) {
    throw new InvalidPreconditionError();
  }
  const parsed = parseETagValue(raw);
  if (parsed === null || parsed === '') {
    throw new InvalidPreconditionError();
  }
  if (parsed === '*') {
    return { kind: 'star' };
  }
  return { kind: 'revision', revision: parsed };
}

// Parse If-None-Match for write guards: only "*" is accepted. A
// revision value, a list, or a malformed value throws
// InvalidPreconditionError (desain 3.2).
export function parseIfNoneMatchForWrite(header: string | string[] | undefined): boolean {
  const values = headerValues(header).filter((value) => value.trim() !== '');
  if (values.length === 0) {
    return false;
  }
  if (values.length > 1) {
    throw new InvalidPreconditionError();
  }
  const raw = values[0] as string;
  if (raw.includes(',')) {
    throw new InvalidPreconditionError();
  }
  const parsed = parseETagValue(raw);
  if (parsed !== '*') {
    throw new InvalidPreconditionError();
  }
  return true;
}

export interface WritePreconditions {
  ifMatch: IfMatchGuard;
  ifNoneMatchStar: boolean;
}

// Parse both write guards together. Sending both If-Match and
// If-None-Match is 400 invalid_precondition; sending neither is
// allowed by this parser and answered 428 precondition_required by
// the handler (desain 2.3).
export function parseWritePreconditions(
  ifMatchHeader: string | string[] | undefined,
  ifNoneMatchHeader: string | string[] | undefined,
): WritePreconditions {
  const ifMatch = parseIfMatch(ifMatchHeader);
  const ifNoneMatchStar = parseIfNoneMatchForWrite(ifNoneMatchHeader);
  if (ifMatch.kind !== 'none' && ifNoneMatchStar) {
    throw new InvalidPreconditionError();
  }
  return { ifMatch, ifNoneMatchStar };
}
