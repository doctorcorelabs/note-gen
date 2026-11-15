// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace write routes (V3-04b, wave 3A): PUT file, append,
// patch, and media upload.
//
// Contract: kontrak-api-kanonis.md section 3.1 (workspace/files)
// with the amended K-03 status rule (see write-guards.ts) and the
// unknown-field rejection rule K-09. Auth, CSRF, and Origin are
// enforced by the frozen global hook (middleware/auth-hook.ts); these
// routes only declare requiresAuth. Rate limiting belongs to the
// auth worker's middleware and is not implemented here.
//
// Fail-closed wiring: when no ports are injected (the V3-04a
// path/revision modules have not landed yet), every handler answers
// 503 service_unavailable AFTER auth passes. The integrator wires
// the real ports by passing them to registerWorkspaceWriteRoutes;
// no other file changes. Until then, no write route can succeed on
// a guessed path or revision implementation.
//
// Body handling: Fastify ships no text, binary, or multipart
// parsers, so this module registers dependency-free Buffer parsers
// for the content types these routes accept. The parsers only bound
// memory (limit + headroom); the exact contract limits (2 MiB text,
// 20 MiB media) are enforced by the service with the correct codes
// (text_too_large / media_too_large). JSON bodies use the default
// Fastify parser; malformed JSON answers invalid_json through the
// global error handler. A request without a Content-Type reaches
// the handler as a Buffer body on the write routes (G8-D1), so the
// handler validates it: invalid UTF-8 answers 422 and media bytes
// are sniffed. A present-but-unknown Content-Type still answers
// 415 before the handler, exactly as Fastify answered without a
// catch-all parser.

import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrincipal, type SessionPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import {
  fieldError,
  mergeMediaGuards,
  parseBodyGuard,
  parseBodyGuardFields,
  parseHeaderGuard,
  rejectUnknownFields,
  requireJsonObject,
} from '../services/workspace/write-guards.js';
import { IDEMPOTENCY_KEY_MAX_LENGTH } from '../services/workspace/write-idempotency.js';
import {
  MEDIA_LIMIT_BYTES,
  TEXT_LIMIT_BYTES,
  WorkspaceWriteService,
  type WriteOutcome,
} from '../services/workspace/write-file.js';
import { multipartBoundary, parseMultipart } from '../services/workspace/write-media.js';
import type { WorkspaceIdentityResolver, WorkspaceWritePorts } from '../services/workspace/write-ports.js';
import type { CoalescingSinkOptions, WriteQueueOptions } from '../services/workspace/write-queue.js';
import { CoalescingEventSink, WriteQueue } from '../services/workspace/write-queue.js';

export interface WorkspaceWriteRouteDeps {
  ports?: WorkspaceWritePorts;
  resolveIdentity?: WorkspaceIdentityResolver;
  queueOptions?: WriteQueueOptions;
  sinkOptions?: CoalescingSinkOptions;
  textLimitBytes?: number;
  mediaLimitBytes?: number;
}

const TEXT_CONTENT_TYPES = ['text/plain', 'text/markdown'];
const BINARY_CONTENT_TYPES = [
  'application/octet-stream',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'application/pdf',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'application/zip',
];

async function readStreamCapped(
  payload: AsyncIterable<Buffer | string>,
  capBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of payload) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    total += buf.length;
    if (total > capBytes) {
      throw ApiError.payloadTooLarge();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// Discards a request body without retaining it, for unmatched
// routes whose 404/405 answer must not depend on body size.
async function drainStream(payload: AsyncIterable<Buffer | string>): Promise<void> {
  for await (const chunk of payload) {
    void chunk;
  }
}

// Same shape as Fastify's own FST_ERR_CTP_INVALID_MEDIA_TYPE
// (fastify 5.12.8, lib/errors.js): the global error handler maps
// statusCode 415 onto unsupported_media_type, so a request with a
// present-but-unknown Content-Type answers exactly as it did
// before the catch-all parser existed.
function unsupportedMediaTypeError(): Error & { code: string; statusCode: number } {
  const error = new Error('Unsupported Media Type') as Error & { code: string; statusCode: number };
  error.code = 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
  error.statusCode = 415;
  return error;
}

// Memory cap for a write route when the request carries no
// Content-Type, mirroring the caps of the explicit parsers above:
// text routes use the text cap, media routes the media cap. Any
// other matched route answers null and keeps the Fastify default.
function writeRouteCap(request: FastifyRequest, textCap: number, mediaCap: number): number | null {
  const url = request.raw.url;
  if (url === undefined) {
    return null;
  }
  const pathname = url.split('?', 1)[0];
  const method = request.method;
  if (method === 'PUT' && pathname === '/api/workspace/file') {
    return textCap;
  }
  if (
    method === 'POST' &&
    (pathname === '/api/workspace/file/append' || pathname === '/api/workspace/file/patch')
  ) {
    return textCap;
  }
  if (pathname === '/api/workspace/media' && (method === 'PUT' || method === 'POST')) {
    return mediaCap;
  }
  return null;
}

function registerBufferParsers(app: FastifyInstance, textLimitBytes: number, mediaLimitBytes: number): void {
  const textCap = textLimitBytes + 1024 * 1024;
  const mediaCap = mediaLimitBytes + 1024 * 1024;
  // Fastify's built-in text/plain parser decodes to a string, which
  // would silently replace invalid UTF-8 bytes before the handler
  // can reject them with invalid_utf8. Replace it with the Buffer
  // parser; the other types have no built-in parser, so the guard
  // only prevents a duplicate registration on the same instance.
  if (app.hasContentTypeParser('text/plain')) {
    app.removeContentTypeParser('text/plain');
  }
  app.addContentTypeParser('text/plain', async (_request: FastifyRequest, payload: IncomingMessage) =>
    readStreamCapped(payload, textCap),
  );
  for (const type of TEXT_CONTENT_TYPES.slice(1)) {
    if (!app.hasContentTypeParser(type)) {
      app.addContentTypeParser(type, async (_request: FastifyRequest, payload: IncomingMessage) =>
        readStreamCapped(payload, textCap),
      );
    }
  }
  for (const type of BINARY_CONTENT_TYPES) {
    if (!app.hasContentTypeParser(type)) {
      app.addContentTypeParser(type, async (_request: FastifyRequest, payload: IncomingMessage) =>
        readStreamCapped(payload, mediaCap),
      );
    }
  }
  if (!app.hasContentTypeParser('multipart/form-data')) {
    app.addContentTypeParser('multipart/form-data', async (_request: FastifyRequest, payload: IncomingMessage) =>
      readStreamCapped(payload, mediaLimitBytes + 64 * 1024),
    );
  }
  // Catch-all parser (G8-D1): Fastify runs the '*' parser both for
  // a missing Content-Type with a body and for a present-but-unknown
  // Content-Type (fastify 5.12.8: lib/handle-request.js runs the
  // parser with '' when the header is absent, and
  // lib/content-type-parser.js falls back to the '' entry, where
  // '*' parsers are stored). Without it, both cases answer 415
  // before any handler runs. The parser keeps that 415 for every
  // present Content-Type and for a missing Content-Type outside
  // the write routes, and only turns a missing Content-Type on a
  // write route into a Buffer body so the handler validates it.
  // Unmatched routes (request.is404, including 405) drain the body
  // and keep their 404/405 answer: Fastify skips parsing for them
  // when no parser matches, and throwing here would mask the
  // 404/405 with a 415. No hasContentTypeParser('*') guard:
  // Fastify stores '*' under '' while hasContentTypeParser('*')
  // looks up '/', so the guard can never see an existing '*'
  // parser; re-registering '*' overwrites the '' entry instead of
  // throwing.
  app.addContentTypeParser('*', async (request: FastifyRequest, payload: IncomingMessage) => {
    if (request.is404) {
      await drainStream(payload);
      return Buffer.alloc(0);
    }
    const rawContentType = request.headers['content-type'];
    const contentType = Array.isArray(rawContentType) ? rawContentType.join(',') : rawContentType;
    if (contentType !== undefined && contentType.trim() !== '') {
      throw unsupportedMediaTypeError();
    }
    const cap = writeRouteCap(request, textCap, mediaCap);
    if (cap === null) {
      throw unsupportedMediaTypeError();
    }
    return readStreamCapped(payload, cap);
  });
}

function queryPath(request: FastifyRequest): unknown {
  const query = request.query as { path?: unknown };
  return query.path;
}

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers['idempotency-key'];
  if (raw === undefined) {
    return undefined;
  }
  if (Array.isArray(raw)) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'Idempotency-Key', issue: 'must appear once' }],
    });
  }
  if (raw === '' || raw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'Idempotency-Key', issue: 'must be 1 to 128 characters' }],
    });
  }
  return raw;
}

function rawBodyBuffer(request: FastifyRequest): Buffer {
  const body = request.body;
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  throw ApiError.invalidJson();
}

function sendOutcome<TData>(
  reply: FastifyReply,
  outcome: WriteOutcome<TData>,
): void {
  reply.code(outcome.status);
  reply.header('ETag', outcome.headers.etag);
  reply.header('X-Revision', outcome.headers.revision);
  reply.header('Last-Modified', outcome.headers.lastModified);
  if (outcome.headers.version !== undefined) {
    reply.header('X-Version', outcome.headers.version);
  }
  reply.send(successEnvelope(outcome.data));
}

function logForcedWrite(
  request: FastifyRequest,
  outcome: WriteOutcome<{ path: string; revision: string }>,
): void {
  if (!outcome.forced || outcome.replayed) {
    return;
  }
  // Structured audit for a conscious overwrite (desain section 3.5):
  // path and revisions only, never content.
  request.log.info(
    { path: outcome.data.path, oldRevision: outcome.oldRevision, newRevision: outcome.data.revision },
    'forced workspace write',
  );
}

export async function registerWorkspaceWriteRoutes(
  app: FastifyInstance,
  deps: WorkspaceWriteRouteDeps,
): Promise<void> {
  const textLimitBytes = deps.textLimitBytes ?? TEXT_LIMIT_BYTES;
  const mediaLimitBytes = deps.mediaLimitBytes ?? MEDIA_LIMIT_BYTES;
  registerBufferParsers(app, textLimitBytes, mediaLimitBytes);

  const service =
    deps.ports === undefined
      ? null
      : new WorkspaceWriteService({
          ports: deps.ports,
          resolveIdentity: deps.resolveIdentity,
          queue: new WriteQueue(deps.queueOptions),
          eventSink: new CoalescingEventSink(deps.ports.events, deps.sinkOptions),
          textLimitBytes,
          mediaLimitBytes,
        });

  function requireService(): WorkspaceWriteService {
    if (service === null) {
      throw ApiError.serviceUnavailable();
    }
    return service;
  }

  function principalOf(request: FastifyRequest): SessionPrincipal | undefined {
    return getPrincipal(request);
  }

  // PUT /api/workspace/file: create or overwrite a text file.
  // Guard header is mandatory: exactly one of If-Match /
  // If-None-Match: *. Stale If-Match answers 412 (amended K-03).
  app.put(
    '/api/workspace/file',
    { config: { requiresAuth: true }, bodyLimit: textLimitBytes + 1024 * 1024 },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const svc = requireService();
      const guard = parseHeaderGuard({
        ifMatch: request.headers['if-match'],
        ifNoneMatch: request.headers['if-none-match'],
      });
      if (guard.kind === 'none') {
        throw ApiError.preconditionRequired();
      }
      const outcome = await svc.putFile({
        rawPath: queryPath(request),
        guard,
        body: rawBodyBuffer(request),
        idempotencyKey: readIdempotencyKey(request),
        principal: principalOf(request),
      });
      logForcedWrite(request, outcome);
      sendOutcome(reply, outcome);
    },
  );

  // POST /api/workspace/file/append: append with a body guard.
  // Stale expectedRevision answers 409 (amended K-03).
  app.post(
    '/api/workspace/file/append',
    { config: { requiresAuth: true }, bodyLimit: textLimitBytes + 64 * 1024 },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const svc = requireService();
      const body = requireJsonObject(request.body);
      rejectUnknownFields(body, ['expectedRevision', 'content', 'force', 'expectedModifiedAt']);
      const guard = parseBodyGuard(body);
      const content = body['content'];
      if (typeof content !== 'string') {
        throw fieldError('content', 'expected a string');
      }
      const outcome = await svc.appendFile({
        rawPath: queryPath(request),
        guard,
        content,
        idempotencyKey: readIdempotencyKey(request),
        principal: principalOf(request),
      });
      logForcedWrite(request, outcome);
      sendOutcome(reply, outcome);
    },
  );

  // POST /api/workspace/file/patch: replace a line range [startLine,
  // endLine), 1-based. Stale expectedRevision answers 409; a range
  // outside the file answers 400 invalid_patch_range.
  app.post(
    '/api/workspace/file/patch',
    { config: { requiresAuth: true }, bodyLimit: textLimitBytes + 64 * 1024 },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const svc = requireService();
      const body = requireJsonObject(request.body);
      rejectUnknownFields(body, [
        'expectedRevision',
        'startLine',
        'endLine',
        'replacement',
        'force',
        'expectedModifiedAt',
      ]);
      const guard = parseBodyGuard(body);
      const startLine = body['startLine'];
      const endLine = body['endLine'];
      const replacement = body['replacement'];
      if (typeof startLine !== 'number' || !Number.isInteger(startLine)) {
        throw fieldError('startLine', 'expected an integer');
      }
      if (typeof endLine !== 'number' || !Number.isInteger(endLine)) {
        throw fieldError('endLine', 'expected an integer');
      }
      if (typeof replacement !== 'string') {
        throw fieldError('replacement', 'expected a string');
      }
      const outcome = await svc.patchFile({
        rawPath: queryPath(request),
        guard,
        startLine,
        endLine,
        replacement,
        idempotencyKey: readIdempotencyKey(request),
        principal: principalOf(request),
      });
      logForcedWrite(request, outcome);
      sendOutcome(reply, outcome);
    },
  );

  // POST /api/workspace/media: multipart upload. Field "path" plus
  // one file field "file"; guards via headers or body fields
  // ifMatch/ifNoneMatch (they must agree when both are present).
  // Stale guards answer 412 (amended K-03).
  app.post(
    '/api/workspace/media',
    { config: { requiresAuth: true }, bodyLimit: mediaLimitBytes + 64 * 1024 },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const svc = requireService();
      const boundary = multipartBoundary(request.headers['content-type']);
      if (boundary === null) {
        throw new ApiError(400, 'invalid_upload', 'The multipart upload is not valid.');
      }
      const body = rawBodyBuffer(request);
      const parsed = parseMultipart(body, boundary);
      const paths = parsed.fields.get('path') ?? [];
      if (paths.length !== 1) {
        throw new ApiError(400, 'invalid_upload', 'The multipart upload is not valid.');
      }
      if (parsed.files.length !== 1 || parsed.files[0]?.name !== 'file') {
        throw new ApiError(400, 'invalid_upload', 'The multipart upload is not valid.');
      }
      const ifMatchValues = parsed.fields.get('ifMatch') ?? [];
      const ifNoneMatchValues = parsed.fields.get('ifNoneMatch') ?? [];
      if (ifMatchValues.length > 1 || ifNoneMatchValues.length > 1) {
        throw new ApiError(400, 'invalid_precondition', 'The guard headers are not valid.');
      }
      const headerGuard = parseHeaderGuard({
        ifMatch: request.headers['if-match'],
        ifNoneMatch: request.headers['if-none-match'],
      });
      const bodyGuard = parseBodyGuardFields({
        ifMatch: ifMatchValues[0],
        ifNoneMatch: ifNoneMatchValues[0],
      });
      const guard = mergeMediaGuards(headerGuard, bodyGuard);
      if (guard.kind === 'none') {
        throw ApiError.preconditionRequired();
      }
      const file = parsed.files[0] as { data: Buffer };
      const outcome = await svc.writeMedia({
        rawPath: paths[0],
        guard,
        body: file.data,
        idempotencyKey: readIdempotencyKey(request),
        principal: principalOf(request),
      });
      logForcedWrite(request, outcome);
      sendOutcome(reply, outcome);
    },
  );

  // PUT /api/workspace/media: raw binary upload. The request
  // Content-Type is ignored for typing (magic bytes decide); the
  // guard uses headers exactly like PUT file. Stale guards answer
  // 412 (amended K-03).
  app.put(
    '/api/workspace/media',
    { config: { requiresAuth: true }, bodyLimit: mediaLimitBytes + 1024 * 1024 },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const svc = requireService();
      const guard = parseHeaderGuard({
        ifMatch: request.headers['if-match'],
        ifNoneMatch: request.headers['if-none-match'],
      });
      if (guard.kind === 'none') {
        throw ApiError.preconditionRequired();
      }
      const outcome = await svc.writeMedia({
        rawPath: queryPath(request),
        guard,
        body: rawBodyBuffer(request),
        idempotencyKey: readIdempotencyKey(request),
        principal: principalOf(request),
      });
      logForcedWrite(request, outcome);
      sendOutcome(reply, outcome);
    },
  );
}
