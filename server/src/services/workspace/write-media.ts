// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Media upload validation and multipart parsing (V3-04b, wave 3A).
//
// Magic-number validation follows desain-workspace-api.md section
// 7.3 exactly, including the conformance mock's detection decisions
// (tests/workspace-client/mock-server.mjs): the detected type comes
// from bytes, never from the extension or the request Content-Type.
// An extension that claims an inline type whose magic does not match
// is rejected 415; an unknown extension with unknown magic is stored
// as attachment/octet-stream with detectedType "unknown"; HTML and
// script extensions are always rejected; SVG is always served as
// attachment/octet-stream, never inline.
//
// Multipart parsing is dependency-free on purpose: the server
// package has no multipart library, and adding one would need a
// lockfile regeneration by the integrator for a single-file form.
// The parser below handles exactly the POST /api/workspace/media
// shape (one text field "path", one file field "file", optional
// guard fields) over a Buffer, with binary-safe boundary splitting.

import { ApiError } from '../../plugins/envelope.js';
import { isValidUtf8 } from './write-guards.js';

export type MediaDisposition = 'inline' | 'attachment';

export interface MediaValidation {
  mimeType: string;
  detectedType: string;
  disposition: MediaDisposition;
}

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

const REJECTED_MEDIA_EXTS = new Set(['.html', '.htm', '.js', '.mjs', '.xhtml']);

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

// Detects the media type from magic bytes. Returns "unknown" when no
// signature matches, "svg" for XML starting with <svg after BOM and
// whitespace, and "html" for content starting with an HTML tag.
export function detectMediaType(bytes: Buffer): string {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'png';
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    return 'jpeg';
  }
  if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) {
    return 'gif';
  }
  if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return 'gif';
  }
  if (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytesEqualAt(bytes, 8, 'WEBP')
  ) {
    return 'webp';
  }
  if (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytesEqualAt(bytes, 8, 'WAVE')
  ) {
    return 'wav';
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
  return 'unknown';
}

export function extensionOf(normalizedPath: string): string {
  const slash = normalizedPath.lastIndexOf('/');
  const name = slash === -1 ? normalizedPath : normalizedPath.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return '';
  }
  return name.slice(dot).toLowerCase();
}

function unsupportedMediaType(): ApiError {
  return new ApiError(415, 'unsupported_media_type', 'The media type is not supported.');
}

// Validates one upload against the section 7.3 table. Throws 415
// unsupported_media_type with details naming the extension and the
// detected type when an inline-claiming extension mismatches its
// magic, when a rejected extension is used, or when HTML is
// detected. Returns the serving facts for a storable upload.
export function validateMedia(normalizedPath: string, bytes: Buffer): MediaValidation {
  const ext = extensionOf(normalizedPath);
  if (REJECTED_MEDIA_EXTS.has(ext)) {
    throw new ApiError(415, 'unsupported_media_type', 'The media type is not supported.', {
      details: { extension: ext, detectedType: 'rejected' },
    });
  }
  const detected = detectMediaType(bytes);
  if (detected === 'html') {
    throw unsupportedMediaType();
  }
  if (ext === '.svg') {
    if (detected !== 'svg') {
      throw unsupportedMediaType();
    }
    return { mimeType: 'application/octet-stream', detectedType: 'svg', disposition: 'attachment' };
  }
  if (ext === '.md' || ext === '.txt') {
    if (!isValidUtf8(bytes)) {
      throw unsupportedMediaType();
    }
    return {
      mimeType: ext === '.md' ? 'text/markdown' : 'text/plain',
      detectedType: 'text',
      disposition: 'attachment',
    };
  }
  const expected = EXPECTED_TYPE_BY_EXT[ext];
  if (expected !== undefined) {
    if (detected !== expected) {
      throw new ApiError(415, 'unsupported_media_type', 'The media type is not supported.', {
        details: { extension: ext, detectedType: detected },
      });
    }
    return {
      mimeType: MIME_BY_TYPE[detected] as string,
      detectedType: detected,
      disposition: INLINE_TYPES.has(detected) ? 'inline' : 'attachment',
    };
  }
  if (detected === 'unknown') {
    return { mimeType: 'application/octet-stream', detectedType: 'unknown', disposition: 'attachment' };
  }
  if (detected === 'svg') {
    return { mimeType: 'application/octet-stream', detectedType: 'svg', disposition: 'attachment' };
  }
  return {
    mimeType: MIME_BY_TYPE[detected] ?? 'application/octet-stream',
    detectedType: detected,
    disposition: INLINE_TYPES.has(detected) ? 'inline' : 'attachment',
  };
}

// Builds the read URL for an uploaded file: per-segment encoding,
// no version query (the client adds ?v= from the revision when it
// wants cache busting).
export function mediaUrlFor(normalizedPath: string): string {
  return `/api/workspace/media/${normalizedPath.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
}

// --- Multipart parsing ---

export interface MultipartFilePart {
  name: string;
  filename: string | undefined;
  contentType: string | undefined;
  data: Buffer;
}

export interface ParsedMultipart {
  fields: Map<string, string[]>;
  files: MultipartFilePart[];
}

function invalidUpload(): ApiError {
  return new ApiError(400, 'invalid_upload', 'The multipart upload is not valid.');
}

// Extracts the boundary parameter from a multipart Content-Type
// header value. Returns null when the header is missing, is not
// multipart/form-data, or carries no usable boundary.
export function multipartBoundary(contentType: string | string[] | undefined): string | null {
  if (typeof contentType !== 'string') {
    return null;
  }
  const [mediaType, ...params] = contentType.split(';');
  if (mediaType?.trim().toLowerCase() !== 'multipart/form-data') {
    return null;
  }
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const name = param.slice(0, eq).trim().toLowerCase();
    if (name !== 'boundary') {
      continue;
    }
    let value = param.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (value === '' || value.length > 70) {
      return null;
    }
    return value;
  }
  return null;
}

function parseDispositionParams(headerValue: string): Map<string, string> {
  const params = new Map<string, string>();
  const parts = headerValue.split(';');
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const name = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (name !== '' && !params.has(name)) {
      params.set(name, value);
    }
  }
  return params;
}

// Parses a complete multipart body. Throws 400 invalid_upload on any
// structural problem: missing boundary delimiters, a part without a
// Content-Disposition name, or a body that does not end with the
// closing delimiter. Part bodies keep their exact bytes: exactly one
// trailing CRLF (the delimiter's line break) is stripped, nothing
// more.
export function parseMultipart(body: Buffer, boundary: string): ParsedMultipart {
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  const fields = new Map<string, string[]>();
  const files: MultipartFilePart[] = [];

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) {
    throw invalidUpload();
  }
  cursor += delimiter.length;

  for (;;) {
    // After a delimiter comes CRLF (part follows), "--" (closing
    // delimiter), or "--" + CRLF. Anything else is malformed.
    if (body.subarray(cursor, cursor + 2).toString('ascii') === '--') {
      return { fields, files };
    }
    if (body.subarray(cursor, cursor + 2).toString('ascii') === '\r\n') {
      cursor += 2;
    } else if (body[cursor] === 0x0a) {
      cursor += 1;
    } else {
      throw invalidUpload();
    }

    const headerEnd = body.indexOf('\r\n\r\n', cursor);
    const headerEndLf = body.indexOf('\n\n', cursor);
    let headersEnd: number;
    let bodyStart: number;
    if (headerEnd !== -1 && (headerEndLf === -1 || headerEnd <= headerEndLf)) {
      headersEnd = headerEnd;
      bodyStart = headerEnd + 4;
    } else if (headerEndLf !== -1) {
      headersEnd = headerEndLf;
      bodyStart = headerEndLf + 2;
    } else {
      throw invalidUpload();
    }
    const headerText = body.subarray(cursor, headersEnd).toString('utf8');
    const headerLines = headerText.split('\r\n').flatMap((line) => line.split('\n'));
    let disposition: string | undefined;
    let partContentType: string | undefined;
    for (const line of headerLines) {
      const colon = line.indexOf(':');
      if (colon === -1) {
        continue;
      }
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === 'content-disposition') {
        disposition = value;
      } else if (name === 'content-type') {
        partContentType = value;
      }
    }
    if (disposition === undefined) {
      throw invalidUpload();
    }
    const params = parseDispositionParams(disposition);
    const fieldName = params.get('name');
    if (fieldName === undefined || fieldName === '') {
      throw invalidUpload();
    }

    // The next delimiter is preceded by CRLF (or a lone LF), which
    // belongs to the delimiter, not to the part body.
    const next = body.indexOf(delimiter, bodyStart);
    if (next === -1) {
      throw invalidUpload();
    }
    let partEnd = next;
    if (partEnd >= 2 && body.subarray(partEnd - 2, partEnd).toString('ascii') === '\r\n') {
      partEnd -= 2;
    } else if (partEnd >= 1 && body[partEnd - 1] === 0x0a) {
      partEnd -= 1;
    }
    const data = body.subarray(bodyStart, partEnd);
    const filename = params.get('filename');
    if (filename !== undefined) {
      files.push({ name: fieldName, filename, contentType: partContentType, data: Buffer.from(data) });
    } else {
      const values = fields.get(fieldName) ?? [];
      values.push(data.toString('utf8'));
      fields.set(fieldName, values);
    }
    cursor = next + delimiter.length;
  }
}
