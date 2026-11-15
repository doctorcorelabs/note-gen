// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace media read routes (owner V3-07, part 1; 3B overlap AD-57).
// Kontrak 3.1, read side only:
//
//   GET  /api/workspace/media/<path>  (raw bytes, revision ETag, one Range)
//   HEAD /api/workspace/media/<path>  (same headers as GET, no body)
//
// Media upload (POST/PUT /api/workspace/media) belongs to V3-04b and
// is deliberately absent here; this module only serves bytes that are
// already on disk.
//
// Authentication comes from the frozen global auth hook
// (middleware/auth-hook.ts): this route sets requiresAuth true and
// relies on the hook for the 401 session check. GET and HEAD need the
// session only; the hook skips Origin and CSRF checks for
// non-mutations, so no per-route CSRF config is needed. There is no
// public media URL: media requires a session, like every other
// workspace read (desain-workspace-api.md section 7.2).
//
// GET and HEAD share one route registration, following the
// GET/HEAD file route in workspace-read.ts: one handler computes the
// status and headers a GET would answer (200, 206, or 304) and HEAD
// sends exactly those headers with no body.
//
// Path handling: <path> is decoded per segment from the raw request
// URL before validation (desain section 7.2), then validated by the
// frozen validateWorkspacePath (lib/paths.ts). The framework is never
// asked to decode twice, and a segment that fails to decode is
// invalid. Hidden (dot-segment) paths, symlink components, and
// directories answer 404 not_found, never 400, so hidden files cannot
// be enumerated by status code (desain sections 8.5 and 8.6);
// syntactically invalid paths answer 400 invalid_path.
//
// Content-Type and disposition reuse the upload rules exactly: the
// serving facts come from validateMedia in the frozen write-media
// service (magic bytes decide, never the request), so a read serves
// what the write stored with the same mimeType and disposition,
// including SVG always served as attachment with
// application/octet-stream. A file on disk that the upload validator
// would reject (mismatched magic, a rejected extension, or HTML
// content placed outside the upload path) is never served inline or
// as HTML: it falls back to attachment with
// application/octet-stream. Reads never answer 415.
//
// Headers on success follow desain section 7.2 and kontrak 3.1:
// Content-Type, ETag (quoted revision) plus X-Revision (unquoted
// revision, same value as the file read), X-Version when the index
// injection knows one, Last-Modified, Content-Disposition (bare
// "inline" for allowed inline types, attachment with a filename for
// everything else), X-Content-Type-Options: nosniff always,
// Content-Security-Policy: sandbox for inline responses only, and
// Accept-Ranges: bytes. Cache-Control is "private, max-age=86400"
// for versioned URLs (a "v" query parameter is present) and
// "private, max-age=0, must-revalidate" otherwise. A matching
// If-None-Match answers 304 with no body, using the same matcher as
// the file read.
//
// Range support: one bytes range answers 206 with Content-Range; an
// unsatisfiable range answers 416 range_not_satisfiable with
// "Content-Range: bytes */<size>". A syntactically invalid Range, a
// multi-range, a non-bytes unit, or a duplicated Range header is
// ignored and the full body is served with 200, per RFC 9110: an
// invalid range is not an unsatisfiable one.
//
// Wiring: the integrator registers this module from buildApp in the
// media block (AD-40 contract order), passing the same deps shape as
// the read routes. This module never edits app.ts itself.

import { constants as fsConstants, lstat, open, realpath, stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  InvalidWorkspacePathError,
  WorkspaceRootUnavailableError,
  WorkspaceSymlinkError,
  assertNoSymlinkComponents,
  validateWorkspacePath,
} from '../lib/paths.js';
import { buildRevision, ifNoneMatchMatches, quoteETag } from '../lib/revision.js';
import { ApiError } from '../plugins/envelope.js';
import type { WorkspaceReaderDeps } from '../services/workspace/read.js';
import { validateMedia, type MediaValidation } from '../services/workspace/write-media.js';

export type WorkspaceMediaReadRouteDeps = WorkspaceReaderDeps;

const MEDIA_PREFIX = '/api/workspace/media/';

// Safe serving facts for a file the upload validator would reject:
// never inline, never a sniffable type.
const REJECTED_FALLBACK: MediaValidation = {
  mimeType: 'application/octet-stream',
  detectedType: 'unknown',
  disposition: 'attachment',
};

type ExtractedMediaPath =
  | { kind: 'path'; path: string }
  | { kind: 'invalid' }
  | { kind: 'absent' };

// Decode the media path per segment from the raw request URL
// (desain 7.2). The query string is stripped first; each segment is
// decoded once, so a double-encoded traversal stays a literal file
// name and a malformed percent sequence is invalid, not repaired.
function extractMediaPath(request: FastifyRequest): ExtractedMediaPath {
  const rawUrl = request.url;
  const queryAt = rawUrl.indexOf('?');
  const pathOnly = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  if (!pathOnly.startsWith(MEDIA_PREFIX)) {
    return { kind: 'absent' };
  }
  const rest = pathOnly.slice(MEDIA_PREFIX.length);
  if (rest === '') {
    return { kind: 'invalid' };
  }
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return { kind: 'invalid' };
    }
  }
  return { kind: 'path', path: segments.join('/') };
}

function hasVersionQuery(request: FastifyRequest): boolean {
  const query = request.query as unknown;
  return (
    typeof query === 'object' &&
    query !== null &&
    'v' in (query as Record<string, unknown>)
  );
}

// Map path-layer errors to read-side HTTP errors, exactly as the
// file read service does: hidden and symlink paths are 404 here,
// while the write side answers 400 for the same paths.
function mapPathError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof InvalidWorkspacePathError) {
    return ApiError.invalidPath();
  }
  if (error instanceof WorkspaceSymlinkError) {
    return ApiError.notFound();
  }
  if (error instanceof WorkspaceRootUnavailableError) {
    return ApiError.serviceUnavailable();
  }
  throw error;
}

async function requireRoot(workspaceRoot: string | undefined): Promise<string> {
  if (workspaceRoot === undefined || workspaceRoot === '') {
    throw ApiError.serviceUnavailable();
  }
  let rootReal: string;
  try {
    rootReal = await realpath(workspaceRoot);
  } catch {
    throw ApiError.serviceUnavailable();
  }
  let rootStats;
  try {
    rootStats = await stat(rootReal);
  } catch {
    throw ApiError.serviceUnavailable();
  }
  if (!rootStats.isDirectory()) {
    throw ApiError.serviceUnavailable();
  }
  return rootReal;
}

async function readFileNoFollow(fsPath: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(fsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
        return null;
      }
    }
    throw error;
  }
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// Serving facts from the upload validator, so reads match writes.
// Only the 415 rejection degrades to the safe fallback; any other
// error propagates.
function servingFacts(normalizedPath: string, bytes: Buffer): MediaValidation {
  try {
    return validateMedia(normalizedPath, bytes);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'unsupported_media_type') {
      return REJECTED_FALLBACK;
    }
    throw error;
  }
}

function contentDisposition(facts: MediaValidation, normalizedPath: string): string {
  if (facts.disposition === 'inline') {
    return 'inline';
  }
  const name = normalizedPath.split('/').pop() ?? '';
  const escaped = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  let value = `attachment; filename="${escaped}"`;
  if (escaped !== name || /[^\x20-\x7e]/.test(name)) {
    value += `; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  return value;
}

interface ByteRange {
  start: number;
  end: number;
}

type RangeOutcome =
  | { kind: 'ignore' }
  | { kind: 'range'; range: ByteRange }
  | { kind: 'unsatisfiable' };

// Parse a single Range header. BigInt comparison keeps huge digit
// strings correct: a start at or past the end of the file is
// unsatisfiable, not a silent wrap to a small number.
function parseRange(header: string | string[] | undefined, size: number): RangeOutcome {
  if (header === undefined || Array.isArray(header)) {
    return { kind: 'ignore' };
  }
  const value = header.trim();
  if (value.slice(0, 6).toLowerCase() !== 'bytes=') {
    return { kind: 'ignore' };
  }
  const spec = value.slice(6).trim();
  if (spec === '' || spec.includes(',')) {
    return { kind: 'ignore' };
  }
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (match === null) {
    return { kind: 'ignore' };
  }
  const startText = match[1] as string;
  const endText = match[2] as string;
  if (startText === '' && endText === '') {
    return { kind: 'ignore' };
  }
  const sizeBig = BigInt(size);
  if (startText === '') {
    const suffix = BigInt(endText);
    if (suffix === 0n || size === 0) {
      return { kind: 'unsatisfiable' };
    }
    const take = suffix > sizeBig ? sizeBig : suffix;
    return { kind: 'range', range: { start: Number(sizeBig - take), end: size - 1 } };
  }
  const startBig = BigInt(startText);
  if (startBig >= sizeBig) {
    return { kind: 'unsatisfiable' };
  }
  const start = Number(startBig);
  if (endText === '') {
    return { kind: 'range', range: { start, end: size - 1 } };
  }
  const endBig = BigInt(endText);
  if (endBig < startBig) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'range', range: { start, end: endBig >= sizeBig ? size - 1 : Number(endBig) } };
}

function setMediaHeaders(
  reply: FastifyReply,
  options: {
    facts: MediaValidation;
    revision: string;
    version: number | null;
    modifiedAt: Date;
    normalizedPath: string;
    versioned: boolean;
  },
): void {
  reply.header('Content-Type', options.facts.mimeType);
  reply.header('ETag', quoteETag(options.revision));
  reply.header('X-Revision', options.revision);
  if (options.version !== null) {
    reply.header('X-Version', String(options.version));
  }
  reply.header('Last-Modified', options.modifiedAt.toUTCString());
  reply.header(
    'Cache-Control',
    options.versioned ? 'private, max-age=86400' : 'private, max-age=0, must-revalidate',
  );
  reply.header('Content-Disposition', contentDisposition(options.facts, options.normalizedPath));
  reply.header('X-Content-Type-Options', 'nosniff');
  if (options.facts.disposition === 'inline') {
    reply.header('Content-Security-Policy', 'sandbox');
  }
  reply.header('Accept-Ranges', 'bytes');
}

export async function registerWorkspaceMediaReadRoutes(
  app: FastifyInstance,
  deps: WorkspaceMediaReadRouteDeps,
): Promise<void> {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/workspace/media/*',
    config: { requiresAuth: true },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const extracted = extractMediaPath(request);
      if (extracted.kind === 'absent') {
        throw ApiError.notFound();
      }
      if (extracted.kind === 'invalid') {
        throw ApiError.invalidPath();
      }
      let validated;
      try {
        validated = validateWorkspacePath(extracted.path, {});
      } catch (error) {
        throw mapPathError(error);
      }
      if (validated.hidden) {
        throw ApiError.notFound();
      }
      const rootReal = await requireRoot(deps.workspaceRoot);
      const workspaceKey = deps.workspaceKey ?? rootReal;
      let fsPath: string;
      try {
        fsPath = await assertNoSymlinkComponents(rootReal, validated);
      } catch (error) {
        throw mapPathError(error);
      }
      let stats;
      try {
        stats = await lstat(fsPath);
      } catch {
        throw ApiError.notFound();
      }
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw ApiError.notFound();
      }
      const bytes = await readFileNoFollow(fsPath);
      if (bytes === null) {
        throw ApiError.notFound();
      }
      const revision = buildRevision(workspaceKey, validated.path, bytes);
      const version =
        deps.resolveVersion === undefined ? null : await deps.resolveVersion(validated.path);
      const facts = servingFacts(validated.path, bytes);
      setMediaHeaders(reply, {
        facts,
        revision,
        version,
        modifiedAt: stats.mtime,
        normalizedPath: validated.path,
        versioned: hasVersionQuery(request),
      });
      if (ifNoneMatchMatches(request.headers['if-none-match'], revision)) {
        return reply.code(304).send();
      }
      const range = parseRange(request.headers['range'], bytes.length);
      if (range.kind === 'unsatisfiable') {
        reply.header('Content-Range', `bytes */${bytes.length}`);
        throw new ApiError(416, 'range_not_satisfiable', 'The requested range is not satisfiable.');
      }
      const isHead = request.method === 'HEAD';
      if (range.kind === 'range') {
        const slice = bytes.subarray(range.range.start, range.range.end + 1);
        reply.header(
          'Content-Range',
          `bytes ${range.range.start}-${range.range.end}/${bytes.length}`,
        );
        reply.header('Content-Length', String(slice.length));
        if (isHead) {
          return reply.code(206).send();
        }
        return reply.code(206).send(slice);
      }
      reply.header('Content-Length', String(bytes.length));
      if (isHead) {
        return reply.code(200).send();
      }
      return reply.code(200).send(bytes);
    },
  });
}
