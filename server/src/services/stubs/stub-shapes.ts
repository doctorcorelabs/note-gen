// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Transport-shape validation for the explicit 501 stubs (canonical
// contract section 7): backup restore and document parse.
//
// This module validates the SHAPE of a request only. It never inspects
// the content of an uploaded archive or document: no hash, no magic
// number check, no format detection, no text recognition, and no
// business validation of any kind. Part contents are located by
// framing bytes and discarded; only part names, file names, and sizes
// are recorded. The real restore and parse implementations belong to
// Fase 2 and must not reuse the 501 answers as success paths.
//
// Restore accepts two shapes (contract section 3.10): a multipart
// upload with one file part named "archive", or a JSON body carrying
// exactly one field, "backupId". There is no disk-path mode: a path
// sent by a client is never read, and an unknown JSON field is a
// validation failure (contract section 1.5). Whether a backup exists
// is never checked here; every well-formed request is answered 501.
//
// Document parse accepts one shape only (contract section 3.16,
// decision K-06): a multipart upload carrying the document bytes.
// A JSON body, including one that names a file path, is rejected as
// an invalid upload, because the input is upload bytes, never a
// server-side file path.

import { ApiError } from '../../plugins/envelope.js';

// A parsed part, without its content. The content bytes are measured
// and discarded by the parser; no field here can leak them.
export interface MultipartPartDescriptor {
  name: string;
  filename: string | null;
  contentType: string | undefined;
  sizeBytes: number;
}

const MAX_MULTIPART_PARTS = 100;
const MAX_PART_HEADER_BYTES = 8192;
const MAX_BOUNDARY_LENGTH = 70;

const CRLF = Buffer.from('\r\n');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n');

const PARSE_UPLOAD_MESSAGE =
  'Document parsing requires a multipart upload with one file part. File paths are not accepted.';
const RESTORE_UPLOAD_MESSAGE =
  'Backup restore requires a multipart upload with one archive file part, or a JSON body with backupId.';
const VALIDATION_MESSAGE = 'Request validation failed.';

// Text-part names that would smuggle a server-side path into a parse
// request. The parse input is bytes, so any of these names is a shape
// failure even when a file part is also present.
const PATH_FIELD_NAMES = new Set(['path', 'filepath', 'file_path', 'file-path', 'archivepath', 'archive_path']);

function invalidUpload(message: string): ApiError {
  return new ApiError(400, 'invalid_upload', message);
}

function contentTypeValue(contentType: string | string[] | undefined): string | undefined {
  return typeof contentType === 'string' ? contentType : undefined;
}

function mediaTypeOf(contentType: string | string[] | undefined): string | undefined {
  const value = contentTypeValue(contentType);
  if (value === undefined) {
    return undefined;
  }
  return value.split(';', 1)[0]?.trim().toLowerCase();
}

function isMultipartContentType(contentType: string | string[] | undefined): boolean {
  return mediaTypeOf(contentType) === 'multipart/form-data';
}

function isJsonContentType(contentType: string | string[] | undefined): boolean {
  const mediaType = mediaTypeOf(contentType);
  return mediaType === 'application/json' || (mediaType !== undefined && mediaType.endsWith('+json'));
}

// Extract the multipart boundary from a Content-Type header. Returns
// null when the header is not multipart, has no boundary, or carries
// a boundary that cannot appear on the wire. A null result is always
// a shape failure in the validators below, never a fallback.
export function extractMultipartBoundary(contentType: string | string[] | undefined): string | null {
  if (!isMultipartContentType(contentType)) {
    return null;
  }
  const value = contentTypeValue(contentType) ?? '';
  for (const param of value.split(';').slice(1)) {
    const eq = param.indexOf('=');
    if (eq === -1) {
      continue;
    }
    if (param.slice(0, eq).trim().toLowerCase() !== 'boundary') {
      continue;
    }
    let raw = param.slice(eq + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      raw = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (raw === '' || raw.length > MAX_BOUNDARY_LENGTH) {
      return null;
    }
    for (const ch of raw) {
      const code = ch.charCodeAt(0);
      if (code <= 0x20 || code >= 0x7f) {
        return null;
      }
    }
    return raw;
  }
  return null;
}

// Split a Content-Disposition value on semicolons that sit outside
// quoted strings, so a file name containing a semicolon survives.
function splitDisposition(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inQuotes) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === ';' && !inQuotes) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function parseDispositionParams(value: string): Map<string, string> | null {
  const segments = splitDisposition(value);
  if (segments[0]?.trim().toLowerCase() !== 'form-data') {
    return null;
  }
  const params = new Map<string, string>();
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=');
    if (eq === -1) {
      return null;
    }
    const key = segment.slice(0, eq).trim().toLowerCase();
    let raw = segment.slice(eq + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      raw = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (params.has(key)) {
      return null;
    }
    params.set(key, raw);
  }
  return params;
}

interface PartHeaders {
  disposition: Map<string, string>;
  contentType: string | undefined;
}

function parsePartHeaders(headerBlock: Buffer): PartHeaders | null {
  const text = headerBlock.toString('latin1');
  const lines = text.split('\r\n');
  let disposition: Map<string, string> | null = null;
  let contentType: string | undefined;
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      return null;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    if (name === 'content-disposition') {
      if (disposition !== null) {
        return null;
      }
      disposition = parseDispositionParams(val);
      if (disposition === null) {
        return null;
      }
    } else if (name === 'content-type') {
      if (contentType !== undefined) {
        return null;
      }
      contentType = val;
    }
    // Other headers carry no shape meaning for the stubs and are ignored.
  }
  if (disposition === null) {
    return null;
  }
  return { disposition, contentType };
}

// Parse a multipart body into part descriptors. Only CRLF framing is
// accepted, matching what browsers and command-line upload tools send.
// The body must start with the opening delimiter, every part must end
// at a delimiter, and a closing delimiter must terminate the body.
// Anything else is malformed and answered invalid_upload by the caller.
export function parseMultipartParts(body: Buffer, boundary: string): MultipartPartDescriptor[] {
  const message = 'The multipart body is not valid.';
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw invalidUpload(message);
  }
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  if (body.length < delimiter.length || !body.subarray(0, delimiter.length).equals(delimiter)) {
    throw invalidUpload(message);
  }
  const framing = Buffer.concat([CRLF, delimiter]);
  const parts: MultipartPartDescriptor[] = [];
  let pos = delimiter.length;
  for (;;) {
    if (body.subarray(pos, pos + 2).equals(Buffer.from('--'))) {
      const tail = body.subarray(pos + 2).toString('latin1');
      if (!/^[\r\n \t]*$/.test(tail)) {
        throw invalidUpload(message);
      }
      return parts;
    }
    if (!body.subarray(pos, pos + 2).equals(CRLF)) {
      throw invalidUpload(message);
    }
    pos += CRLF.length;
    if (parts.length >= MAX_MULTIPART_PARTS) {
      throw invalidUpload(message);
    }
    const headerEnd = body.indexOf(DOUBLE_CRLF, pos);
    if (headerEnd === -1 || headerEnd - pos > MAX_PART_HEADER_BYTES) {
      throw invalidUpload(message);
    }
    const headers = parsePartHeaders(body.subarray(pos, headerEnd));
    if (headers === null) {
      throw invalidUpload(message);
    }
    const name = headers.disposition.get('name');
    if (name === undefined || name === '') {
      throw invalidUpload(message);
    }
    const filename = headers.disposition.has('filename') ? (headers.disposition.get('filename') ?? '') : null;
    const contentStart = headerEnd + DOUBLE_CRLF.length;
    const next = body.indexOf(framing, contentStart);
    if (next === -1) {
      throw invalidUpload(message);
    }
    // Content bytes are measured and discarded, never inspected.
    parts.push({ name, filename, contentType: headers.contentType, sizeBytes: next - contentStart });
    pos = next + CRLF.length + delimiter.length;
  }
}

function requireBufferBody(body: unknown): Buffer {
  if (!Buffer.isBuffer(body)) {
    throw invalidUpload('The multipart body is not valid.');
  }
  return body;
}

// Validate the document parse request shape. A well-formed multipart
// upload with exactly one file part passes; everything else, including
// any JSON body, fails as an invalid upload.
export function validateParseRequest(body: unknown, contentType: string | string[] | undefined): void {
  const boundary = extractMultipartBoundary(contentType);
  if (boundary === null) {
    throw invalidUpload(PARSE_UPLOAD_MESSAGE);
  }
  const parts = parseMultipartParts(requireBufferBody(body), boundary);
  const fileParts = parts.filter((part) => part.filename !== null);
  if (fileParts.length !== 1 || fileParts[0]?.filename === '') {
    throw invalidUpload(PARSE_UPLOAD_MESSAGE);
  }
  for (const part of parts) {
    if (part.filename === null && PATH_FIELD_NAMES.has(part.name.toLowerCase())) {
      throw invalidUpload(PARSE_UPLOAD_MESSAGE);
    }
  }
}

// Validate the JSON shape of a restore request: an object carrying
// exactly "backupId" with a non-empty string value. Unknown fields are
// rejected with details.fields naming each rejected field (contract
// section 1.5). The value itself is never looked up.
export function validateRestoreJsonBody(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiError.validation(VALIDATION_MESSAGE, { fields: [{ field: 'body', issue: 'invalid' }] });
  }
  const record = body as Record<string, unknown>;
  const issues: Array<{ field: string; issue: string }> = [];
  const backupId = record.backupId;
  if (backupId === undefined) {
    issues.push({ field: 'backupId', issue: 'required' });
  } else if (typeof backupId !== 'string' || backupId.trim() === '') {
    issues.push({ field: 'backupId', issue: 'invalid' });
  }
  for (const key of Object.keys(record)) {
    if (key !== 'backupId') {
      issues.push({ field: key, issue: 'unknown field' });
    }
  }
  if (issues.length > 0) {
    throw ApiError.validation(VALIDATION_MESSAGE, { fields: issues });
  }
}

// Validate the backup restore request shape across its two accepted
// forms: one multipart file part named "archive", or a JSON body with
// backupId. A request in neither form fails validation. The archive
// bytes and the backup id are never examined beyond this shape check.
export function validateRestoreRequest(body: unknown, contentType: string | string[] | undefined): void {
  if (isMultipartContentType(contentType)) {
    const boundary = extractMultipartBoundary(contentType);
    if (boundary === null) {
      throw invalidUpload(RESTORE_UPLOAD_MESSAGE);
    }
    const parts = parseMultipartParts(requireBufferBody(body), boundary);
    if (parts.length !== 1) {
      throw invalidUpload(RESTORE_UPLOAD_MESSAGE);
    }
    const only = parts[0];
    if (only === undefined || only.filename === null || only.name !== 'archive' || only.filename === '') {
      throw invalidUpload(RESTORE_UPLOAD_MESSAGE);
    }
    return;
  }
  if (isJsonContentType(contentType)) {
    validateRestoreJsonBody(body);
    return;
  }
  // No recognized upload shape: a restore request must carry either a
  // multipart archive or a JSON backupId. This is a shape failure, not
  // a statement about any backup.
  throw ApiError.validation(VALIDATION_MESSAGE, { fields: [{ field: 'body', issue: 'required' }] });
}
