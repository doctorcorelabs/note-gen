// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Record asset type validation (V3-31).
//
// Contract: kontrak-api-kanonis.md section 3.7 and desain-record-search.md
// section 4 (V1-14). The type of an uploaded asset is decided ONLY by its
// magic bytes, never by the file extension, the part filename, or the
// client-supplied Content-Type. An asset key carries no extension at all,
// so extension logic from the workspace media path must never be applied
// here: media (relative path, kontrak 3.1) and record assets (opaque key,
// kontrak 3.7) are separate address spaces and separate typing rules.
//
// Accepted types and the size limit are server configuration decisions
// under V1-14 assumption A-5: the design sets no list and no number, and
// requires the implementation to document what it uses. This module is
// that documentation for types; the size limit lives in service.ts.
//
// Accepted, by magic bytes: PNG, JPEG, GIF, WebP, AVIF, PDF, MP4, WebM,
// MP3, WAV, Ogg, and ZIP. ZIP covers the ZIP-based document formats a
// record file may carry (docx, xlsx, pptx, epub), all served as
// application/zip attachments. Bytes with no recognized signature are
// accepted as text/plain ONLY when they decode as strict UTF-8 and do
// not start with an HTML or SVG tag; anything else unknown is rejected,
// because an asset served with a guessed type would break the
// nosniff contract of the read path.
//
// Rejected with 415 unsupported_media_type: HTML and SVG content (both
// can carry script, and no SVG allowlist decision exists), and binary
// content with no recognized signature. SVG is rejected outright rather
// than served as an attachment, unlike workspace media: a record asset
// is referenced by key from record content, and a script-bearing asset
// must not enter that store in any serving form.
//
// Disposition (V1-14 4.2): images, PDF, video, and audio are inline
// (safe to display); ZIP and plain text are attachment. The disposition
// is derived from the validated MIME type, in exactly one place
// (dispositionForMimeType), so the upload path and the serve path can
// never disagree about it.
//
// The byte signatures below deliberately duplicate the signature facts
// in services/workspace/write-media.ts instead of importing its
// detector. The media detector answers a different question (it
// consults the extension and stores unknown bytes as octet-stream),
// and asset typing must stay independent of media path logic.

import { ApiError } from '../../plugins/envelope.js';

export type AssetDisposition = 'inline' | 'attachment';

export type AssetDetectedType =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'avif'
  | 'pdf'
  | 'mp4'
  | 'webm'
  | 'mp3'
  | 'wav'
  | 'ogg'
  | 'zip'
  | 'text';

export const ASSET_MIME_TYPES: Record<AssetDetectedType, string> = {
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
  text: 'text/plain',
};

const INLINE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
]);

export function dispositionForMimeType(mimeType: string): AssetDisposition {
  return INLINE_MIME_TYPES.has(mimeType) ? 'inline' : 'attachment';
}

function startsWithBytes(bytes: Buffer, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

function bytesEqualAt(bytes: Buffer, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) {
    return false;
  }
  return bytes.subarray(offset, offset + text.length).toString('ascii') === text;
}

function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// Detects the asset type from magic bytes. Returns 'unknown' when no
// signature matches and the bytes are not plain UTF-8 text, 'html' or
// 'svg' when the content starts with such a tag (after BOM and leading
// whitespace), and the detected type otherwise. Empty input returns
// 'unknown'; the service rejects empty uploads before calling this
// module, with validation_failed rather than 415.
export function detectAssetType(bytes: Buffer): AssetDetectedType | 'unknown' | 'html' | 'svg' {
  if (bytes.length === 0) {
    return 'unknown';
  }
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'png';
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    return 'jpeg';
  }
  if (
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'gif';
  }
  if (startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12) {
    if (bytesEqualAt(bytes, 8, 'WEBP')) {
      return 'webp';
    }
    if (bytesEqualAt(bytes, 8, 'WAVE')) {
      return 'wav';
    }
  }
  if (bytes.length >= 12 && bytesEqualAt(bytes, 4, 'ftyp')) {
    const brand = bytes.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') {
      return 'avif';
    }
    return 'mp4';
  }
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return 'pdf';
  }
  if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return 'webm';
  }
  if (startsWithBytes(bytes, [0x49, 0x44, 0x33])) {
    return 'mp3';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] as number) & 0xe0) === 0xe0) {
    return 'mp3';
  }
  if (startsWithBytes(bytes, [0x4f, 0x67, 0x67, 0x53])) {
    return 'ogg';
  }
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return 'zip';
  }
  const textStart = bytes
    .subarray(0, Math.min(bytes.length, 512))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  if (textStart.startsWith('<svg')) {
    return 'svg';
  }
  if (
    textStart.startsWith('<!doctype html') ||
    textStart.startsWith('<html') ||
    textStart.startsWith('<script')
  ) {
    return 'html';
  }
  if (isValidUtf8(bytes)) {
    return 'text';
  }
  return 'unknown';
}

export interface AssetValidation {
  detectedType: AssetDetectedType;
  mimeType: string;
  disposition: AssetDisposition;
}

// Validates one upload by its bytes. Throws 415 unsupported_media_type
// for HTML, SVG, and unrecognized binary content. The error carries no
// details: the detected type is not echoed, because the upload response
// must not become a content-sniffing oracle for rejected bytes.
export function validateAssetBytes(bytes: Buffer): AssetValidation {
  const detected = detectAssetType(bytes);
  if (detected === 'unknown' || detected === 'html' || detected === 'svg') {
    throw new ApiError(415, 'unsupported_media_type', 'The media type is not supported.');
  }
  const mimeType = ASSET_MIME_TYPES[detected];
  return { detectedType: detected, mimeType, disposition: dispositionForMimeType(mimeType) };
}
