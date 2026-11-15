// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Revision guard parsing, conflict payloads, body validation helpers,
// and line-range patch application for workspace writes (V3-04b).
//
// Status rule (amended K-03, fase1/amandemen-kontrak-d1-d3.md section
// 1, ratified by AD-29): ONE code, revision_conflict, with the HTTP
// status fixed PER ENDPOINT in kontrak-api-kanonis.md section 3, NOT
// by where the guard arrived. PUT file and POST/PUT media answer 412;
// append, patch, PATCH settings, transactions, and PATCH record
// answer 409. The old wording ("412 for header guards, 409 for body
// guards") is superseded: move answers 412 for a body guard and PATCH
// record answers 409 for a header guard. Callers pass the endpoint
// status explicitly to revisionConflictError; this module never
// infers a status from the guard location. (The ApiError
// revisionConflict helper in plugins/envelope.ts keeps the
// headerGuard flag only as a status selector; write code passes
// the endpoint status explicitly so the amended rule is the one
// that runs.)
//
// Guard parsing follows desain-workspace-api.md section 3.2: trim,
// strip a W/ prefix, strip one pair of double quotes, compare the
// result exactly. A comma-separated list is not supported (400
// invalid_precondition). If-None-Match on a write endpoint supports
// only the bare "*" form.

import { ApiError } from '../../plugins/envelope.js';

// The parsed form of a header-style guard (If-Match /
// If-None-Match), shared by PUT file, PUT media, and the merged
// header/body guard of POST media.
export type HeaderGuard =
  | { kind: 'match'; revision: string }
  | { kind: 'force' }
  | { kind: 'create-only' }
  | { kind: 'none' };

export const CONFLICT_ACTIONS: readonly string[] = ['reload', 'saveAsCopy', 'forceOverwrite'];

// Parses one If-Match value into its bare revision, or null when the
// value is malformed. The "*" force form is handled by the caller:
// this function returns "*" unchanged for a bare star so the caller
// can distinguish force from a match.
function parseMatchValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.includes(',')) {
    return null;
  }
  let value = trimmed;
  if (value.startsWith('W/') || value.startsWith('w/')) {
    value = value.slice(2);
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  if (value === '' || value.includes('"') || value.includes(',')) {
    return null;
  }
  return value;
}

function invalidPrecondition(): ApiError {
  return new ApiError(400, 'invalid_precondition', 'The guard headers are not valid.');
}

// Parses the If-Match / If-None-Match pair from request headers.
// Throws 400 invalid_precondition when both headers are present,
// when either header repeats, when If-Match holds a list, or when
// If-None-Match holds anything but "*".
export function parseHeaderGuard(headers: {
  ifMatch: string | string[] | undefined;
  ifNoneMatch: string | string[] | undefined;
}): HeaderGuard {
  const { ifMatch, ifNoneMatch } = headers;
  if (Array.isArray(ifMatch) || Array.isArray(ifNoneMatch)) {
    throw invalidPrecondition();
  }
  if (ifMatch !== undefined && ifNoneMatch !== undefined) {
    throw invalidPrecondition();
  }
  if (ifMatch !== undefined) {
    if (ifMatch.trim() === '*') {
      return { kind: 'force' };
    }
    const revision = parseMatchValue(ifMatch);
    if (revision === null || revision === '*') {
      throw invalidPrecondition();
    }
    return { kind: 'match', revision };
  }
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() !== '*') {
      throw invalidPrecondition();
    }
    return { kind: 'create-only' };
  }
  return { kind: 'none' };
}

// Parses the multipart body guard fields of POST /api/workspace/media
// (desain-workspace-api.md section 7.3): ifMatch / ifNoneMatch are
// the body counterparts of the headers. Throws
// invalid_precondition on the same malformed shapes as the header
// parser, and when both body fields are present.
export function parseBodyGuardFields(fields: {
  ifMatch: string | undefined;
  ifNoneMatch: string | undefined;
}): HeaderGuard {
  const { ifMatch, ifNoneMatch } = fields;
  if (ifMatch !== undefined && ifNoneMatch !== undefined) {
    throw invalidPrecondition();
  }
  if (ifMatch !== undefined) {
    if (ifMatch.trim() === '*') {
      return { kind: 'force' };
    }
    const revision = parseMatchValue(ifMatch);
    if (revision === null || revision === '*') {
      throw invalidPrecondition();
    }
    return { kind: 'match', revision };
  }
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() !== '*') {
      throw invalidPrecondition();
    }
    return { kind: 'create-only' };
  }
  return { kind: 'none' };
}

function sameGuard(a: HeaderGuard, b: HeaderGuard): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'match' && b.kind === 'match') {
    return a.revision === b.revision;
  }
  return true;
}

// Merges the header guard and the body guard fields of POST media:
// when both are present they must agree exactly, else 400
// invalid_precondition; when only one is present it wins; when
// neither is present the result is 'none' and the caller answers
// 428 precondition_required.
export function mergeMediaGuards(header: HeaderGuard, body: HeaderGuard): HeaderGuard {
  if (header.kind !== 'none' && body.kind !== 'none' && !sameGuard(header, body)) {
    throw invalidPrecondition();
  }
  return header.kind !== 'none' ? header : body;
}

// The parsed form of a JSON body guard (append/patch): either an
// expected revision that must match, or an explicit force.
export type BodyGuard = { kind: 'match'; revision: string } | { kind: 'force' };

// Parses expectedRevision/force from an append or patch body.
// expectedRevision is required unless force is exactly true. Wrong
// types and missing guards answer 400 validation_failed with
// details.fields, matching the workspace client conformance suite
// (tests/workspace-client/mock-server.mjs); only an unparseable or
// non-object JSON body answers invalid_json, via the global error
// handler. The optional expectedModifiedAt field (desain section
// 3.8) is accepted by the unknown-field check and ignored here: it
// is never a guard on its own.
export function parseBodyGuard(body: Record<string, unknown>): BodyGuard {
  const force = body['force'];
  if (force !== undefined && typeof force !== 'boolean') {
    throw fieldError('force', 'expected a boolean');
  }
  const forced = force === true;
  const expected = body['expectedRevision'];
  if (!forced && expected === undefined) {
    throw fieldError('expectedRevision', 'required unless force is true');
  }
  if (expected !== undefined && typeof expected !== 'string') {
    throw fieldError('expectedRevision', 'expected a string');
  }
  if (forced) {
    return { kind: 'force' };
  }
  return { kind: 'match', revision: expected as string };
}

// Builds a 400 validation_failed error naming one field, in the
// contract shape: details.fields is [{ field, issue }].
export function fieldError(field: string, issue: string): ApiError {
  return ApiError.validation('Request validation failed.', {
    fields: [{ field, issue }],
  });
}

// Rejects unknown JSON body fields (kontrak K-09): every endpoint
// with a JSON body answers 400 validation_failed naming the rejected
// fields, instead of silently ignoring a misspelled field.
export function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const rejected = Object.keys(body).filter((key) => !allowedSet.has(key));
  if (rejected.length > 0) {
    throw ApiError.validation('Request validation failed.', {
      fields: rejected.map((field) => ({ field, issue: 'unknown field' })),
    });
  }
}

// Asserts that a parsed JSON body is a plain object. Arrays, null,
// and scalars answer 400 invalid_json: the body parsed, but it is
// not the object the endpoint consumes.
export function requireJsonObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiError.invalidJson();
  }
  return body as Record<string, unknown>;
}

// Current server state for a conflict payload (desain section 3.4,
// moved under error.details by kontrak section 10.1 item 5).
export interface ConflictState {
  path: string;
  serverRevision: string;
  serverVersion: number | null;
  serverModifiedAt: string;
  serverSize: number;
  currentPreview: string | null;
  previewTruncated: boolean;
  suggestedCopyPath: string | null;
}

// Builds the details object for a revision conflict. For append and
// patch the failed operation is named in details.failedOperation.
export function conflictDetails(
  state: ConflictState,
  failedOperation?: 'append' | 'patch',
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    path: state.path,
    serverRevision: state.serverRevision,
    serverVersion: state.serverVersion,
    serverModifiedAt: state.serverModifiedAt,
    serverSize: state.serverSize,
    currentPreview: state.currentPreview,
    previewTruncated: state.previewTruncated,
    suggestedCopyPath: state.suggestedCopyPath,
    actions: [...CONFLICT_ACTIONS],
  };
  if (failedOperation !== undefined) {
    details['failedOperation'] = failedOperation;
  }
  return details;
}

// Builds the revision_conflict error with the EXPLICIT per-endpoint
// status (amended K-03): 412 for PUT file/media, 409 for
// append/patch. The caller owns the status; this function never
// derives it from the guard location.
export function revisionConflictError(
  status: 409 | 412,
  state: ConflictState,
  failedOperation?: 'append' | 'patch',
): ApiError {
  return new ApiError(status, 'revision_conflict', 'The file has changed since it was last read.', {
    details: conflictDetails(state, failedOperation),
  });
}

export const CONFLICT_PREVIEW_MAX_CHARS = 1000;

// Builds the conflict preview: at most the first 1000 characters of
// the current text content. Binary content has no preview (null,
// not truncated). Content that is not valid UTF-8 has no preview
// either: the preview must never carry replacement-character soup
// mistaken for file content.
export function buildPreview(
  content: Buffer,
  isText: boolean,
): { currentPreview: string | null; previewTruncated: boolean } {
  if (!isText) {
    return { currentPreview: null, previewTruncated: false };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return { currentPreview: null, previewTruncated: false };
  }
  if (text.length <= CONFLICT_PREVIEW_MAX_CHARS) {
    return { currentPreview: text, previewTruncated: false };
  }
  return {
    currentPreview: text.slice(0, CONFLICT_PREVIEW_MAX_CHARS),
    previewTruncated: true,
  };
}

// Strict UTF-8 check: true only when every byte decodes. The server
// never applies lossy decoding on the read/write path (desain
// section 2.2).
export function isValidUtf8(content: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

export function decodeUtf8Strict(content: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(content);
}

// Line-start offsets for patch range handling: line i (1-based)
// starts at lineStarts[i - 1]. The line count is lineStarts.length,
// which counts a trailing empty segment after a final newline as a
// line, matching the conformance mock and desain section 2.5.
export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

// Validates a patch range against the actual file text (desain
// section 2.5): startLine in [1, lineCount + 1], endLine in
// [startLine, lineCount + 1]. Anything else answers 400
// invalid_patch_range. Callers validate integer-ness of the inputs
// before calling this function.
export function validatePatchRange(text: string, startLine: number, endLine: number): void {
  const lineCount = lineStartsOf(text).length;
  if (startLine < 1 || startLine > lineCount + 1 || endLine < startLine || endLine > lineCount + 1) {
    throw new ApiError(400, 'invalid_patch_range', 'The patch line range is outside the file.');
  }
}

// Applies a validated range patch: the byte range from the start of
// startLine to the start of endLine (or end of file) is replaced
// verbatim by replacement. No newline is added or removed by the
// server; CRLF files keep their \r bytes because splitting happens
// on \n only (desain section 2.5).
export function applyLinePatch(text: string, startLine: number, endLine: number, replacement: string): string {
  const starts = lineStartsOf(text);
  const lineCount = starts.length;
  const startOffset = startLine <= lineCount ? (starts[startLine - 1] as number) : text.length;
  const endOffset = endLine <= lineCount ? (starts[endLine - 1] as number) : text.length;
  return text.slice(0, startOffset) + replacement + text.slice(endOffset);
}
