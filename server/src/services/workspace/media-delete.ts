// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Media-specific delete behavior (V3-07 part 2, wave 3B overlap,
// AD-57). There is NO separate DELETE media route: media files are
// deleted through DELETE /api/workspace/file and DELETE
// /api/workspace/folder, which move the entry to trash
// (kontrak-api-kanonis.md section 3.1; desain-workspace-api.md
// (V1-09) section 2.8). V1-09 section 7 defines no delete endpoint
// at all: it covers media read (7.2), upload (7.3), revision and
// guards for upload (7.4), relative references (7.5), and the file
// tree and scan (7.6). This module therefore implements no route,
// performs no disk mutation, moves nothing to trash, and publishes
// no event. It supplies the media-specific facts and consequence
// payloads that the trash routes (V3-05c) must apply when the
// deleted entry is, or contains, media.
//
// What is media-specific about a delete, per V1-09 section 7 plus
// the trash and event sections:
//
// 1. Revision. A media file has a revision computed over its binary
//    bytes with the same section 3.1 formula as text (7.4). The
//    trash metadata row carries that last revision for the file
//    (5.1 metadata field; 7.4 applies the same section 3.1 formula
//    to binary bytes, so a media file carries a revision and only
//    folders carry null). This module computes
//    it before the move, because the revision binds the path and
//    must never be reused across a move or restore (lib/revision.ts
//    header; 5.2 restore recomputes when the path changes).
// 2. Deleted event. The server publishes a `deleted` event for the
//    deleted path (2.8), with revision and modifiedAt null and
//    isDirectory set (9.3). Events for non-.md files are still
//    published (7.6); the .md-only filter in 9.5 applies to the
//    client note-change emission, never to server publication. A
//    media delete must therefore publish exactly like a text delete.
// 3. Index soft delete. The files row for the deleted path is
//    marked deleted_at and linked to the trash entry, and stays
//    until purge or restore (5.1). Listing and scan exclude marked
//    rows. The purge path removes or tombstones the row and
//    publishes NO workspace event (5.2).
// 4. No media serving from trash. A trash blob is never served
//    through the media endpoint and never appears in list, scan, or
//    events (5.1). After the move, GET /api/workspace/media/<path>
//    for the old path answers 404, including for previously cached
//    versioned (?v=) URLs: the path no longer resolves under the
//    workspace root.
// 5. No reference rewrite. The server never rewrites media
//    references inside Markdown outside rename (7.1, section 6).
//    Deleting media leaves dangling relative references; the editor
//    keeps its per-image load-failed status (7.2). No link repair
//    runs on delete.
// 6. No kind gate. Upload validates magic numbers and may answer
//    415 (7.3), but the delete error list in 2.8 contains no 415,
//    no 412, and no 428: delete carries no revision guard and no
//    media-kind rejection. A file with mismatched extension and
//    magic, an unknown extension, or a text extension is still
//    deletable through this seam. Classification here is
//    informational (index mimeType, trash metadata); it never
//    blocks the delete.
//
// How the trash route (V3-05c) consumes this module. The integrator
// wires it; the route owns the queue, the trash move, the response
// envelope, and auth/CSRF through the frozen global hook (AD-40):
//
//   1. Reject `permanent=true` with rejectPermanentDeleteQuery
//      (2.8: purge only through the trash endpoints).
//   2. Run inspection plus the trash move inside the shared
//      per-path queue (3.6), so a write cannot land between the
//      inspection read and the move. This module owns no queue
//      instance and must never be called outside the queue by a
//      route that shares writers for the same path.
//   3. Call inspectMediaDeleteTarget with the frozen path and
//      revision ports. It resolves the path with write semantics
//      (hidden 400, symlink 400, traversal 400, missing 404,
//      wrong kind 409) and returns a plan. For a folder, the plan
//      carries no revision and no size: the trash route enumerates
//      the subtree (one trash entry, 2.8) and calls
//      classifyMediaPath per descendant for index soft-delete.
//   4. Move the entry to trash (V3-05c), then mark the index row
//      deleted with buildIndexSoftDelete and publish the event
//      from buildDeletedEvent, in the disk-then-index order of
//      3.7. Purge follows MEDIA_PURGE_CONSEQUENCES: no event.
//
// Open question for V3-05c and the integrator, not decided here:
// 3.7 step 8 defines the 500 index_update_failed shape when the
// index transaction fails after a disk write. No equivalent rule is
// stated for a failure after a trash move, so this module invents
// no error code for it; the trash route must record the decision.
//
// This module supersedes the provisional guarded DELETE media route
// from the predecessor commit on this branch (21aed4a8), which
// implemented permanent removal with a revision guard. That route
// is not in the canonical contract, contradicts 2.8 (no one-step
// permanent delete), and is removed on this branch; its validation
// approach (port resolution, lstat checks, no double decode) is
// carried over into inspectMediaDeleteTarget. The predecessor
// commit remains in branch history.
//
// Ports: frozen interfaces only, imported, never redefined. Path
// and revision behavior comes from server/src/lib/paths.ts and
// server/src/lib/revision.ts through the WorkspacePathPort and
// RevisionPort interfaces (write-ports.ts). The existing index and
// event ports have no delete shape (recordWrite eventType and
// WorkspaceWriteEvent kind are created|changed only), so this
// module defines the narrow delete payload types the trash and
// event workers consume, without widening the frozen interfaces.

import { lstat, readFile } from 'node:fs/promises';
import { isTextFilePath } from '../../lib/paths.js';
import { contentHash } from '../../lib/revision.js';
import { ApiError } from '../../plugins/envelope.js';
import type { RevisionPort, WorkspacePathPort } from './write-ports.js';
import { detectMediaType, extensionOf, mediaUrlFor } from './write-media.js';

// The only collaborators this module needs: the frozen path and
// revision ports. A WorkspaceWritePorts value is assignable here;
// the index, event, and idempotency ports are not consumed.
export interface MediaDeletePorts {
  paths: WorkspacePathPort;
  revisions: RevisionPort;
}

export type DeleteEntryKind = 'file' | 'folder';

// Classification of one path for delete consequences. Informational
// only: no kind is ever rejected by this module (see header, point
// 6). `media` means the path is a section 7.3 media type by
// extension or by detected magic; `text` means a .md/.txt path;
// `other` is everything else. All three are deletable.
export type MediaDeleteKind = 'media' | 'text' | 'other';

export interface MediaClassification {
  kind: MediaDeleteKind;
  // Lowercase extension including the dot, or '' when the name has
  // no extension (extensionOf from write-media.ts).
  extension: string;
  // Section 7.3 detected type from magic bytes, or 'unknown' when
  // no signature matched. Null when no bytes were supplied and the
  // classification is extension-only.
  detectedType: string | null;
  // Serving mime type for the stored bytes: from the detected type
  // when known, else from the claimed extension, else
  // application/octet-stream. SVG is always octet-stream (7.3 step
  // 5). Null only for extension-only classification of an unknown
  // extension, where no serving fact can be stated.
  mimeType: string | null;
  disposition: 'inline' | 'attachment' | null;
}

// Fixed consequences of every media delete, pinned so the trash
// route and specs share one statement of them. See header points
// 2, 3, and 5, and 5.2 for purge.
export interface MediaDeleteConsequences {
  publishesDeletedEvent: boolean;
  indexSoftDelete: boolean;
  markdownRefsRewritten: boolean;
  trashBlobServedViaMedia: boolean;
  purgePublishesEvent: boolean;
}

export const MEDIA_DELETE_CONSEQUENCES: MediaDeleteConsequences = {
  publishesDeletedEvent: true,
  indexSoftDelete: true,
  markdownRefsRewritten: false,
  trashBlobServedViaMedia: false,
  purgePublishesEvent: false,
};

export interface MediaDeletePlan {
  path: string;
  kind: DeleteEntryKind;
  // Files only: byte size and mtime from lstat. Folders carry null;
  // the trash route computes subtree entryCount and total size (2.8).
  size: number | null;
  modifiedAt: string | null;
  // Files only: section 3.1 revision over the binary bytes (7.4),
  // for trash metadata (5.1). Folders carry null.
  revision: string | null;
  // Files only: hex SHA-256 over the content bytes alone
  // (files.content_hash). Never a revision, never a guard.
  contentHash: string | null;
  // Files only: media classification from extension plus bytes.
  media: MediaClassification | null;
  // Files only: the media read URL that must answer 404 once the
  // entry has moved to trash (5.1).
  mediaUrl: string | null;
  consequences: MediaDeleteConsequences;
}

// Section 7.3 table, extension form. This mirrors the upload table
// in write-media.ts (which this module must not edit and which does
// not export the map); the two must not diverge without a recorded
// amendment. ZIP and SVG are media here because 7.3 lists them;
// both are served as attachment.
const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.pdf',
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.oga',
  '.zip',
  '.svg',
]);

const EXPECTED_TYPE_BY_EXT: Record<string, string> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.gif': 'gif',
  '.webp': 'webp',
  '.avif': 'avif',
  '.pdf': 'pdf',
  '.mp4': 'mp4',
  '.mov': 'mp4',
  '.m4v': 'mp4',
  '.webm': 'webm',
  '.mp3': 'mp3',
  '.wav': 'wav',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.zip': 'zip',
};

const MIME_BY_TYPE: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  zip: 'application/zip',
};

const INLINE_TYPES = new Set(['png', 'jpeg', 'gif', 'webp', 'avif', 'pdf', 'mp4', 'webm', 'mp3', 'wav', 'ogg']);

const KNOWN_DETECTED_TYPES = new Set([...Object.keys(MIME_BY_TYPE), 'svg']);

function servingFacts(
  detectedType: string | null,
  extension: string,
): { mimeType: string | null; disposition: 'inline' | 'attachment' | null } {
  // Extension-first rules that bytes never override: SVG is always
  // attachment + octet-stream, never inline (7.3 step 5), and text
  // extensions have no magic, so their text mime type stands even
  // though detection reports 'unknown' for prose bytes.
  if (extension === '.svg') {
    return { mimeType: 'application/octet-stream', disposition: 'attachment' };
  }
  if (extension === '.md') {
    return { mimeType: 'text/markdown', disposition: 'attachment' };
  }
  if (extension === '.txt') {
    return { mimeType: 'text/plain', disposition: 'attachment' };
  }
  if (detectedType === 'svg') {
    return { mimeType: 'application/octet-stream', disposition: 'attachment' };
  }
  if (detectedType === 'html') {
    // HTML bytes must never inherit an inline image mime type from
    // the extension: serving them inline from the same origin is
    // exactly what 7.3 step 4 forbids for uploads.
    return { mimeType: 'application/octet-stream', disposition: 'attachment' };
  }
  if (detectedType !== null && KNOWN_DETECTED_TYPES.has(detectedType)) {
    return {
      mimeType: MIME_BY_TYPE[detectedType] as string,
      disposition: INLINE_TYPES.has(detectedType) ? 'inline' : 'attachment',
    };
  }
  if (detectedType !== null) {
    // Bytes were read but matched no signature: the upload rule
    // (7.3 step 4) serves such files as attachment + octet-stream.
    // The extension alone is not trusted once the bytes contradict
    // it; a .png name over random bytes is not an image.
    return { mimeType: 'application/octet-stream', disposition: 'attachment' };
  }
  // No bytes were supplied (extension-only classification): the
  // extension is the only fact available.
  const expected = EXPECTED_TYPE_BY_EXT[extension];
  if (expected !== undefined) {
    return {
      mimeType: MIME_BY_TYPE[expected] as string,
      disposition: INLINE_TYPES.has(expected) ? 'inline' : 'attachment',
    };
  }
  return { mimeType: null, disposition: null };
}

// Classifies one normalized path. When bytes are supplied, the
// detected magic type wins over the extension (7.3: type comes
// from bytes, never from the extension alone), and a mismatch is
// recorded in detectedType, never rejected. Without bytes the
// classification is extension-only and detectedType is null; the
// trash route uses that form when enumerating a folder subtree
// without reading every descendant. This function never throws for
// a kind: HTML, script, and unknown extensions classify as media,
// text, or other and stay deletable.
export function classifyMediaPath(normalizedPath: string, bytes?: Buffer): MediaClassification {
  const extension = extensionOf(normalizedPath);
  const detectedType = bytes === undefined ? null : detectMediaType(bytes);
  const detectedIsMedia = detectedType !== null && KNOWN_DETECTED_TYPES.has(detectedType);
  const kind: MediaDeleteKind = MEDIA_EXTENSIONS.has(extension) || detectedIsMedia
    ? 'media'
    : isTextFilePath(normalizedPath)
      ? 'text'
      : 'other';
  const facts = servingFacts(detectedType, extension);
  return { kind, extension, detectedType, mimeType: facts.mimeType, disposition: facts.disposition };
}

// Rejects `permanent=true` on the DELETE file/folder surface (2.8:
// no one-step permanent delete; purge only through the trash
// endpoints). Only the literal query value 'true' is rejected, as
// the design words it; absence and other values pass, and the
// trash route owns any further query validation.
export function rejectPermanentDeleteQuery(permanent: unknown): void {
  if (permanent === 'true') {
    throw new ApiError(
      400,
      'invalid_query',
      'Permanent delete is not allowed on this endpoint.',
    );
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function wrongKindError(expectedKind: DeleteEntryKind): ApiError {
  return new ApiError(
    409,
    'wrong_kind',
    expectedKind === 'file'
      ? 'The path is a folder, not a file.'
      : 'The path is a file, not a folder.',
  );
}

// Validates and inspects one delete target. No mutation: the caller
// (trash route, inside the per-path queue) performs the trash move
// after this returns. Resolution uses the frozen path port with
// write semantics, so traversal, absolute, hidden, overlong, and
// malformed paths answer 400 invalid_path, symlink components
// answer 400 symlink_not_allowed, and an unavailable root answers
// 503 (desain 8.5, 8.6; the port throws those ApiErrors). A missing
// target answers 404 not_found; a target of the wrong kind answers
// 409 wrong_kind (2.8). A path that crosses a non-directory
// component answers 400 invalid_path. Non-regular entries (fifo,
// socket, device) answer 404: they are not workspace entries. No
// guard is evaluated: delete has no If-Match rule in 2.8 or in
// kontrak 3.1, and no 428/412 code applies here.
export async function inspectMediaDeleteTarget(
  ports: MediaDeletePorts,
  rawPath: unknown,
  expectedKind: DeleteEntryKind,
): Promise<MediaDeletePlan> {
  const resolved = await ports.paths.resolveWritePath(rawPath);

  let info;
  try {
    info = await lstat(resolved.absolute);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') {
      throw ApiError.notFound();
    }
    if (code === 'ENOTDIR') {
      throw ApiError.invalidPath();
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    // Defense in depth: the path port walk already rejects symlink
    // components, but the lstat check covers a symlink swapped in
    // after resolution and keeps the mapping explicit.
    throw new ApiError(400, 'symlink_not_allowed', 'Symlinks are not allowed.');
  }
  if (info.isDirectory()) {
    if (expectedKind !== 'folder') {
      throw wrongKindError(expectedKind);
    }
    return {
      path: resolved.normalized,
      kind: 'folder',
      size: null,
      modifiedAt: null,
      revision: null,
      contentHash: null,
      media: null,
      mediaUrl: null,
      consequences: MEDIA_DELETE_CONSEQUENCES,
    };
  }
  if (!info.isFile()) {
    throw ApiError.notFound();
  }
  if (expectedKind !== 'file') {
    throw wrongKindError(expectedKind);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(resolved.absolute);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw ApiError.notFound();
    }
    throw error;
  }
  return {
    path: resolved.normalized,
    kind: 'file',
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    revision: ports.revisions.compute(resolved.normalized, bytes),
    contentHash: contentHash(bytes),
    media: classifyMediaPath(resolved.normalized, bytes),
    mediaUrl: mediaUrlFor(resolved.normalized),
    consequences: MEDIA_DELETE_CONSEQUENCES,
  };
}

// The delete event payload for the realtime layer. This is a NEW
// narrow shape: the frozen WorkspaceWriteEvent kind is
// created|changed only and must not be widened here. V3-08 maps
// this to the wire message (9.3): type workspace-file-changed, a
// sequence number, actor, workspaceRoot, and originConnectionId.
// For `deleted`, revision and modifiedAt are null (9.3); the
// folder flag distinguishes file and folder deletes.
export interface WorkspaceDeleteEvent {
  kind: 'deleted';
  path: string;
  previousPath: null;
  revision: null;
  modifiedAt: null;
  isDirectory: boolean;
}

export function buildDeletedEvent(plan: MediaDeletePlan): WorkspaceDeleteEvent {
  return {
    kind: 'deleted',
    path: plan.path,
    previousPath: null,
    revision: null,
    modifiedAt: null,
    isDirectory: plan.kind === 'folder',
  };
}

// The index soft-delete facts for one deleted entry (5.1): the
// files row is marked deleted_at and linked to the trash entry.
// This is a NEW narrow shape: the frozen WorkspaceIndexPort
// recordWrite covers created|changed only, so the storage worker
// owns the port method that consumes this input. For a folder, the
// trash route builds one input per subtree row; revision, size,
// and mimeType are null for the folder row itself.
export interface IndexSoftDeleteInput {
  workspaceId: string;
  path: string;
  kind: DeleteEntryKind;
  trashId: string;
  deletedAt: string;
  revision: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
}

export function buildIndexSoftDelete(
  plan: MediaDeletePlan,
  input: { workspaceId: string; trashId: string; deletedAt: string },
): IndexSoftDeleteInput {
  return {
    workspaceId: input.workspaceId,
    path: plan.path,
    kind: plan.kind,
    trashId: input.trashId,
    deletedAt: input.deletedAt,
    revision: plan.revision,
    sizeBytes: plan.size,
    mimeType: plan.media === null ? null : plan.media.mimeType,
  };
}

// Purge consequences (5.2), constant across media and text: purge
// publishes no workspace event (the path has been absent since the
// trash move), the soft-deleted index row is removed or kept as a
// tombstone per the storage worker, and the blob is never served
// through the media endpoint. The trash route asserts its purge
// path against this record.
export interface MediaPurgeConsequences {
  workspaceEvent: null;
  indexAction: 'remove-or-tombstone';
  trashBlobServedViaMedia: boolean;
}

export const MEDIA_PURGE_CONSEQUENCES: MediaPurgeConsequences = {
  workspaceEvent: null,
  indexAction: 'remove-or-tombstone',
  trashBlobServedViaMedia: false,
};
