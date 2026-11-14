// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the explicit 501 stubs (canonical contract section 7):
// POST /api/backups/restore and POST /api/documents/parse.
//
// What is pinned here: each stub answers 501 with its own stable code
// only after session, Origin, and CSRF checks pass; malformed
// multipart uploads answer 400 invalid_upload instead of 501; the
// parse stub accepts upload bytes only and rejects any JSON body,
// including one that names a file path; the restore stub accepts a
// multipart archive or a JSON backupId and never rejects an upload
// for its format; and neither stub touches the database or the disk.
// The multipart shape parser is also tested directly, so framing
// failures stay visible even when the HTTP layer changes.
//
// File name note: this file uses the .spec.ts suffix, matching the
// other server specs and the Vitest include pattern.

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import {
  readCsrfTokenHeader,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';
import { ApiError } from '../src/plugins/envelope.js';
import { DOCUMENT_PARSE_PATH, RESTORE_PATH } from '../src/routes/stubs.js';
import {
  extractMultipartBoundary,
  parseMultipartParts,
  validateParseRequest,
  validateRestoreJsonBody,
  validateRestoreRequest,
} from '../src/services/stubs/stub-shapes.js';

const CANONICAL_ORIGIN = 'https://app.example.invalid';
const PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'good-session' };
const BOUNDARY = '----stub-test-boundary-7';

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3001,
    databaseUrl: 'postgres://placeholder/placeholder',
    workspaceRoot: '/tmp',
    nodeEnv: 'development',
    logLevel: 'silent',
    checkTimeoutMs: 2000,
    overallTimeoutMs: 5000,
    warnings: [],
    registrationMode: 'closed',
    publicBaseUrl: undefined,
    trustProxy: false,
    cookieSecure: true,
    cfAccessEnabled: false,
    cfAccessTeamDomain: undefined,
    cfAccessAud: undefined,
    cfAccessServiceAud: undefined,
    cfAccessJwksCacheTtlSeconds: 3600,
    jwtAudience: undefined,
    authSecretConfigured: false,
    authSecretLengthOk: false,
    encryptionKeyConfigured: false,
    setupTokenConfigured: false,
    setupTokenLengthOk: false,
    maxBodyBytes: 1048576,
    ...overrides,
  };
}

async function stubApp(overrides: Partial<ServerConfig> = {}) {
  return buildApp({
    config: testConfig({ publicBaseUrl: CANONICAL_ORIGIN, ...overrides }),
    pool: null,
    version: '0.39.2-fork.1',
    verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? PRINCIPAL : null),
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
  });
}

const AUTHED_HEADERS = {
  cookie: 'notegen_session=good-session',
  origin: CANONICAL_ORIGIN,
  'x-csrf-token': 'good-csrf',
};

interface ErrorEnvelopeBody {
  ok: false;
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

function assertErrorBody(body: unknown, expectedCode: string): asserts body is ErrorEnvelopeBody {
  const parsed = body as ErrorEnvelopeBody;
  expect(parsed.ok).toBe(false);
  expect(parsed.error.code).toBe(expectedCode);
  expect(parsed.error.retryable).toBe(false);
  expect(typeof parsed.error.requestId).toBe('string');
  expect(parsed.error.requestId).not.toBe('');
  expect(parsed.error.message).toBeTruthy();
  expect(parsed.error.details).toEqual(expect.any(Object));
}

function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) {
      return err.code;
    }
    throw err;
  }
  throw new Error('Expected the function to throw an ApiError.');
}

interface TestPart {
  name: string;
  filename?: string;
  contentType?: string;
  content: string | Buffer;
}

function multipartBody(parts: TestPart[], boundary: string = BOUNDARY): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let disposition = `form-data; name="${part.name}"`;
    if (part.filename !== undefined) {
      disposition += `; filename="${part.filename}"`;
    }
    let head = `--${boundary}\r\nContent-Disposition: ${disposition}\r\n`;
    if (part.contentType !== undefined) {
      head += `Content-Type: ${part.contentType}\r\n`;
    }
    head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function multipartHeaders(boundary: string = BOUNDARY) {
  return { ...AUTHED_HEADERS, 'content-type': `multipart/form-data; boundary=${boundary}` };
}

describe('multipart shape parser', () => {
  it('describes one file part without keeping its bytes', () => {
    const body = multipartBody([
      { name: 'archive', filename: 'backup.ngwbackup', contentType: 'application/octet-stream', content: 'secret-bytes' },
    ]);
    const parts = parseMultipartParts(body, BOUNDARY);
    expect(parts).toEqual([
      { name: 'archive', filename: 'backup.ngwbackup', contentType: 'application/octet-stream', sizeBytes: 12 },
    ]);
    expect(parts[0]).not.toHaveProperty('content');
  });

  it('rejects a body that does not start with the opening delimiter', () => {
    const body = Buffer.from('preamble\r\n--' + BOUNDARY + '--\r\n', 'utf8');
    expect(thrownCode(() => parseMultipartParts(body, BOUNDARY))).toBe('invalid_upload');
  });

  it('rejects a truncated body without a closing delimiter', () => {
    const full = multipartBody([{ name: 'file', filename: 'doc.pdf', content: 'abc' }]);
    const truncated = full.subarray(0, full.length - 10);
    expect(thrownCode(() => parseMultipartParts(truncated, BOUNDARY))).toBe('invalid_upload');
  });

  it('rejects a part without a disposition header', () => {
    const body = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${BOUNDARY}--\r\n`,
      'utf8',
    );
    expect(thrownCode(() => parseMultipartParts(body, BOUNDARY))).toBe('invalid_upload');
  });

  it('rejects a part whose headers never end', () => {
    const body = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="x"`, 'utf8');
    expect(thrownCode(() => parseMultipartParts(body, BOUNDARY))).toBe('invalid_upload');
  });

  it('accepts a file name containing a semicolon inside quotes', () => {
    const body = multipartBody([{ name: 'file', filename: 'my;report.pdf', content: 'x' }]);
    const parts = parseMultipartParts(body, BOUNDARY);
    expect(parts[0]?.filename).toBe('my;report.pdf');
  });
});

describe('multipart boundary extraction', () => {
  it('extracts an unquoted boundary', () => {
    expect(extractMultipartBoundary(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
  });

  it('extracts a quoted boundary', () => {
    expect(extractMultipartBoundary(`multipart/form-data; boundary="${BOUNDARY}"`)).toBe(BOUNDARY);
  });

  it('returns null without a boundary or for a non-multipart type', () => {
    expect(extractMultipartBoundary('multipart/form-data')).toBeNull();
    expect(extractMultipartBoundary('application/json')).toBeNull();
    expect(extractMultipartBoundary(undefined)).toBeNull();
    expect(extractMultipartBoundary(['multipart/form-data'])).toBeNull();
  });

  it('returns null for an empty or overlong boundary', () => {
    expect(extractMultipartBoundary('multipart/form-data; boundary=')).toBeNull();
    expect(extractMultipartBoundary(`multipart/form-data; boundary=${'b'.repeat(71)}`)).toBeNull();
  });
});

describe('restore JSON shape', () => {
  it('accepts exactly backupId', () => {
    expect(() => validateRestoreJsonBody({ backupId: 'backup-1' })).not.toThrow();
  });

  it('rejects a missing backupId naming the field', () => {
    try {
      validateRestoreJsonBody({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiError = err as ApiError;
      expect(apiError.code).toBe('validation_failed');
      expect(apiError.details).toEqual({ fields: [{ field: 'backupId', issue: 'required' }] });
    }
  });

  it('rejects an empty or mistyped backupId', () => {
    expect(thrownCode(() => validateRestoreJsonBody({ backupId: '   ' }))).toBe('validation_failed');
    expect(thrownCode(() => validateRestoreJsonBody({ backupId: 42 }))).toBe('validation_failed');
  });

  it('rejects unknown fields naming each one', () => {
    try {
      validateRestoreJsonBody({ backupId: 'backup-1', path: '/data/home/x.ngwbackup' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiError = err as ApiError;
      expect(apiError.code).toBe('validation_failed');
      expect(apiError.details).toEqual({ fields: [{ field: 'path', issue: 'unknown_field' }] });
    }
  });

  it('rejects a non-object body', () => {
    expect(thrownCode(() => validateRestoreJsonBody(['backup-1']))).toBe('validation_failed');
    expect(thrownCode(() => validateRestoreJsonBody(null))).toBe('validation_failed');
    expect(thrownCode(() => validateRestoreJsonBody('backup-1'))).toBe('validation_failed');
  });
});

describe('request shape validators', () => {
  it('rejects a JSON-shaped parse body as an invalid upload', () => {
    expect(thrownCode(() => validateParseRequest({}, 'application/json'))).toBe('invalid_upload');
    expect(thrownCode(() => validateParseRequest({ path: '/x/y.pdf' }, 'application/json'))).toBe(
      'invalid_upload',
    );
  });

  it('rejects a restore body with no recognized shape as a validation failure', () => {
    expect(thrownCode(() => validateRestoreRequest(undefined, undefined))).toBe('validation_failed');
  });

  it('rejects a non-buffer multipart body as an invalid upload', () => {
    expect(
      thrownCode(() => validateRestoreRequest('text', `multipart/form-data; boundary=${BOUNDARY}`)),
    ).toBe('invalid_upload');
  });
});

describe('restore stub', () => {
  it('answers 501 restore_unavailable for a multipart archive', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'archive', filename: 'backup.ngwbackup', content: 'archive-bytes' }]),
    });
    expect(res.statusCode).toBe(501);
    const body = res.json();
    assertErrorBody(body, 'restore_unavailable');
    expect(body.error.details).toEqual({});
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
    await app.close();
  });

  it('answers 501 restore_unavailable for a JSON backupId', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ backupId: 'backup-1' }),
    });
    expect(res.statusCode).toBe(501);
    assertErrorBody(res.json(), 'restore_unavailable');
    await app.close();
  });

  it('answers 501 for a multipart upload with a quoted boundary', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: { ...AUTHED_HEADERS, 'content-type': `multipart/form-data; boundary="${BOUNDARY}"` },
      payload: multipartBody([{ name: 'archive', filename: 'backup.ngwbackup', content: 'x' }]),
    });
    expect(res.statusCode).toBe(501);
    assertErrorBody(res.json(), 'restore_unavailable');
    await app.close();
  });

  it('answers 501 for an old desktop extension, never a format rejection', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'archive', filename: 'old.ngbackup', content: 'old-format-bytes' }]),
    });
    expect(res.statusCode).toBe(501);
    assertErrorBody(res.json(), 'restore_unavailable');
    await app.close();
  });

  it('answers 401 without a session, for both accepted shapes', async () => {
    const app = await stubApp();
    const multipart = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: { origin: CANONICAL_ORIGIN, 'x-csrf-token': 'good-csrf', 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody([{ name: 'archive', filename: 'backup.ngwbackup', content: 'x' }]),
    });
    expect(multipart.statusCode).toBe(401);
    assertErrorBody(multipart.json(), 'unauthenticated');
    const json = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: { origin: CANONICAL_ORIGIN, 'x-csrf-token': 'good-csrf', 'content-type': 'application/json' },
      payload: JSON.stringify({ backupId: 'backup-1' }),
    });
    expect(json.statusCode).toBe(401);
    assertErrorBody(json.json(), 'unauthenticated');
    await app.close();
  });

  it('answers 403 with distinct codes and one shared message for Origin and CSRF failures', async () => {
    const app = await stubApp();
    const badOrigin = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: { ...AUTHED_HEADERS, origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ backupId: 'backup-1' }),
    });
    expect(badOrigin.statusCode).toBe(403);
    const badOriginBody = badOrigin.json();
    assertErrorBody(badOriginBody, 'origin_rejected');
    const badCsrf = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: { cookie: 'notegen_session=good-session', origin: CANONICAL_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ backupId: 'backup-1' }),
    });
    expect(badCsrf.statusCode).toBe(403);
    const badCsrfBody = badCsrf.json();
    assertErrorBody(badCsrfBody, 'csrf_invalid');
    expect(badOriginBody.error.message).toBe(badCsrfBody.error.message);
    await app.close();
  });

  it('answers 400 invalid_upload for a malformed multipart body', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: multipartHeaders(),
      payload: Buffer.from('this is not a multipart body', 'utf8'),
    });
    expect(res.statusCode).toBe(400);
    assertErrorBody(res.json(), 'invalid_upload');
    await app.close();
  });

  it('answers 400 invalid_upload for multipart without a boundary', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: { ...AUTHED_HEADERS, 'content-type': 'multipart/form-data' },
      payload: multipartBody([{ name: 'archive', filename: 'backup.ngwbackup', content: 'x' }]),
    });
    expect(res.statusCode).toBe(400);
    assertErrorBody(res.json(), 'invalid_upload');
    await app.close();
  });

  it('answers 400 invalid_upload for multipart without a file part', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'note', content: 'hello' }]),
    });
    expect(res.statusCode).toBe(400);
    assertErrorBody(res.json(), 'invalid_upload');
    await app.close();
  });

  it('answers 400 invalid_upload unless the upload is exactly one archive part', async () => {
    const app = await stubApp();
    const wrongName = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'file', filename: 'backup.ngwbackup', content: 'x' }]),
    });
    expect(wrongName.statusCode).toBe(400);
    assertErrorBody(wrongName.json(), 'invalid_upload');
    const twoFiles = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'archive', filename: 'a.ngwbackup', content: 'x' },
        { name: 'archive', filename: 'b.ngwbackup', content: 'y' },
      ]),
    });
    expect(twoFiles.statusCode).toBe(400);
    assertErrorBody(twoFiles.json(), 'invalid_upload');
    const withText = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'archive', filename: 'backup.ngwbackup', content: 'x' },
        { name: 'note', content: 'hello' },
      ]),
    });
    expect(withText.statusCode).toBe(400);
    assertErrorBody(withText.json(), 'invalid_upload');
    await app.close();
  });

  it('answers 400 validation_failed for JSON without backupId', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    assertErrorBody(body, 'validation_failed');
    expect(body.error.details).toEqual({ fields: [{ field: 'backupId', issue: 'required' }] });
    await app.close();
  });

  it('answers 400 validation_failed for JSON carrying a path field', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ backupId: 'backup-1', path: '/data/home/x.ngwbackup' }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    assertErrorBody(body, 'validation_failed');
    expect(body.error.details).toEqual({ fields: [{ field: 'path', issue: 'unknown_field' }] });
    await app.close();
  });

  // Known foundation gap, recorded for the coordinator (V3-39a report):
  // the contract expects malformed JSON to answer invalid_json, but the
  // frozen envelope maps only the superseded Fastify error code
  // FST_ERR_CTP_INVALID_JSON_CONTENT, while Fastify 5.12 throws
  // FST_ERR_CTP_INVALID_JSON_BODY, so the shared error handler falls
  // through to validation_failed. The stub does not parse JSON itself
  // and must not change the frozen envelope without an amendment
  // (AD-40). Update this expectation to invalid_json when the envelope
  // mapping is amended.
  it('answers 400 for a malformed JSON body through the shared error handler', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    assertErrorBody(res.json(), 'validation_failed');
    await app.close();
  });

  it('answers 404 for a wrong method and for a trailing slash', async () => {
    const app = await stubApp();
    const get = await app.inject({ method: 'GET', url: RESTORE_PATH, headers: AUTHED_HEADERS });
    expect(get.statusCode).toBe(404);
    assertErrorBody(get.json(), 'not_found');
    const trailing = await app.inject({
      method: 'POST',
      url: `${RESTORE_PATH}/`,
      headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ backupId: 'backup-1' }),
    });
    expect(trailing.statusCode).toBe(404);
    assertErrorBody(trailing.json(), 'not_found');
    await app.close();
  });
});

describe('document parse stub', () => {
  it('answers 501 document_parse_unavailable for a multipart file upload', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: DOCUMENT_PARSE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'file', filename: 'report.pdf', contentType: 'application/pdf', content: 'pdf-bytes' },
      ]),
    });
    expect(res.statusCode).toBe(501);
    const body = res.json();
    assertErrorBody(body, 'document_parse_unavailable');
    expect(body.error.details).toEqual({});
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
    await app.close();
  });

  it('answers 501 for binary bytes without inspecting them', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: DOCUMENT_PARSE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'file', filename: 'scan.bin', content: Buffer.from([0x00, 0xff, 0x25, 0x50, 0x44, 0x46]) },
      ]),
    });
    expect(res.statusCode).toBe(501);
    assertErrorBody(res.json(), 'document_parse_unavailable');
    await app.close();
  });

  it('answers 401 without a session and 403 without a CSRF token', async () => {
    const app = await stubApp();
    const noSession = await app.inject({
      method: 'POST',
      url: DOCUMENT_PARSE_PATH,
      headers: { origin: CANONICAL_ORIGIN, 'x-csrf-token': 'good-csrf', 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody([{ name: 'file', filename: 'doc.pdf', content: 'x' }]),
    });
    expect(noSession.statusCode).toBe(401);
    assertErrorBody(noSession.json(), 'unauthenticated');
    const noCsrf = await app.inject({
      method: 'POST',
      url: DOCUMENT_PARSE_PATH,
      headers: { cookie: 'notegen_session=good-session', origin: CANONICAL_ORIGIN, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody([{ name: 'file', filename: 'doc.pdf', content: 'x' }]),
    });
    expect(noCsrf.statusCode).toBe(403);
    assertErrorBody(noCsrf.json(), 'csrf_invalid');
    await app.close();
  });

  it('answers 400 invalid_upload for JSON naming a file path', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: DOCUMENT_PARSE_PATH,
      headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: '/home/user/report.pdf' }),
    });
    expect(res.statusCode).toBe(400);
    assertErrorBody(res.json(), 'invalid_upload');
    await app.close();
  });

  it('answers 400 invalid_upload for any JSON body', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: DOCUMENT_PARSE_PATH,
      headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
    assertErrorBody(res.json(), 'invalid_upload');
    await app.close();
  });

  it('answers 400 invalid_upload for multipart without a file part', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: DOCUMENT_PARSE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'note', content: 'hello' }]),
    });
    expect(res.statusCode).toBe(400);
    assertErrorBody(res.json(), 'invalid_upload');
    await app.close();
  });

  it('answers 400 invalid_upload for multipart with two files', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: DOCUMENT_PARSE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'file', filename: 'a.pdf', content: 'x' },
        { name: 'file', filename: 'b.pdf', content: 'y' },
      ]),
    });
    expect(res.statusCode).toBe(400);
    assertErrorBody(res.json(), 'invalid_upload');
    await app.close();
  });

  it('answers 400 invalid_upload for a file part with an empty file name', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: DOCUMENT_PARSE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'file', filename: '', content: '' }]),
    });
    expect(res.statusCode).toBe(400);
    assertErrorBody(res.json(), 'invalid_upload');
    await app.close();
  });

  it('answers 400 invalid_upload for a file part plus a path text part', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: DOCUMENT_PARSE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'file', filename: 'doc.pdf', content: 'x' },
        { name: 'path', content: '/home/user/doc.pdf' },
      ]),
    });
    expect(res.statusCode).toBe(400);
    assertErrorBody(res.json(), 'invalid_upload');
    await app.close();
  });

  it('answers 400 invalid_upload for a malformed multipart body', async () => {
    const app = await stubApp();
    const res = await app.inject({
      method: 'POST',
      url: DOCUMENT_PARSE_PATH,
      headers: multipartHeaders(),
      payload: Buffer.from('garbage', 'utf8'),
    });
    expect(res.statusCode).toBe(400);
    assertErrorBody(res.json(), 'invalid_upload');
    await app.close();
  });

  it('answers 404 for a wrong method', async () => {
    const app = await stubApp();
    const res = await app.inject({ method: 'GET', url: DOCUMENT_PARSE_PATH, headers: AUTHED_HEADERS });
    expect(res.statusCode).toBe(404);
    assertErrorBody(res.json(), 'not_found');
    await app.close();
  });
});

describe('stub limits and side effects', () => {
  it('rejects an oversized multipart body with payload_too_large', async () => {
    const app = await stubApp({ maxBodyBytes: 64 });
    const res = await app.inject({
      method: 'POST',
      url: RESTORE_PATH,
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'archive', filename: 'backup.ngwbackup', content: 'x'.repeat(200) }]),
    });
    expect(res.statusCode).toBe(413);
    assertErrorBody(res.json(), 'payload_too_large');
    await app.close();
  });

  it('leaves the workspace directory untouched and repeats the same 501', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stubs-noop-'));
    try {
      const app = await stubApp({ workspaceRoot: dir });
      const first = await app.inject({
        method: 'POST',
        url: RESTORE_PATH,
        headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ backupId: 'backup-1' }),
      });
      const second = await app.inject({
        method: 'POST',
        url: DOCUMENT_PARSE_PATH,
        headers: multipartHeaders(),
        payload: multipartBody([{ name: 'file', filename: 'doc.pdf', content: 'x' }]),
      });
      expect(first.statusCode).toBe(501);
      expect(second.statusCode).toBe(501);
      // The app was built with a null pool, so any database use would
      // have failed; the empty directory proves no disk writes either.
      expect(await readdir(dir)).toEqual([]);
      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
