// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// HTTP tests for the workspace media read routes (owner V3-07, part
// 1): GET and HEAD over a real scratch directory, through a minimal
// test app built from the same frozen plugin functions buildApp uses
// (request id, error handling, auth hooks). The media routes are not
// wired into buildApp yet (the integrator registers them in the media
// block per AD-40), so this spec registers the route module directly,
// mirroring test/helpers/workspace-test-app.ts. The session stub
// accepts only the cookie value "good-session"; anything else
// exercises the frozen deny-by-default hook.

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import { registerRequestId, requestIdFromHeaders } from '../src/plugins/request-id.js';
import {
  registerWorkspaceMediaReadRoutes,
  type WorkspaceMediaReadRouteDeps,
} from '../src/routes/workspace-media-read.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const VALID_COOKIE = 'notegen_session=good-session';
const TEST_PRINCIPAL: SessionPrincipal = {
  userId: 'user-1',
  role: 'user',
  sessionId: 'good-session',
};

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('PNGDATA', 'utf8'),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('JPEGDATA', 'utf8')]);
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-', 'utf8'), Buffer.from('PDFDATA', 'utf8')]);
const ZIP_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('ZIPDATA', 'utf8'),
]);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
const TEXT_BYTES = Buffer.from('hello text', 'utf8');
const HTML_BYTES = Buffer.from('<html><body>x</body></html>', 'utf8');
const RANGE_BYTES = Buffer.from('0123456789abcdef', 'utf8');
const EMPTY_BYTES = Buffer.alloc(0);

async function buildMediaTestApp(
  deps: WorkspaceMediaReadRouteDeps,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  registerAuthHooks(app, {
    verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? TEST_PRINCIPAL : null),
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
    canonicalOrigin: TEST_ORIGIN,
  });
  await registerWorkspaceMediaReadRoutes(app, deps);
  await app.ready();
  return app;
}

interface ErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

function expectError(
  res: { statusCode: number; body: string },
  status: number,
  code: string,
): ErrorBody {
  expect(res.statusCode).toBe(status);
  const body = JSON.parse(res.body) as ErrorBody;
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.requestId).toBe('string');
  expect(body.error.requestId).not.toBe('');
  expect(typeof body.error.details).toBe('object');
  return body;
}

describe('workspace media read routes', () => {
  let dir: string;
  let rootReal: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'v3b-07a-media-'));
    rootReal = await realpath(dir);
    await mkdir(join(dir, 'assets', 'nested'), { recursive: true });
    await writeFile(join(dir, 'assets', 'pic.png'), PNG_BYTES);
    await writeFile(join(dir, 'assets', 'photo.jpg'), JPEG_BYTES);
    await writeFile(join(dir, 'assets', 'doc.pdf'), PDF_BYTES);
    await writeFile(join(dir, 'assets', 'arch.zip'), ZIP_BYTES);
    await writeFile(join(dir, 'assets', 'pic.svg'), SVG_BYTES);
    await writeFile(join(dir, 'assets', 'note.txt'), TEXT_BYTES);
    await writeFile(join(dir, 'assets', 'mismatch.png'), JPEG_BYTES);
    await writeFile(join(dir, 'assets', 'page.html'), HTML_BYTES);
    await writeFile(join(dir, 'assets', 'unknown.xyz'), RANGE_BYTES);
    await writeFile(join(dir, 'assets', 'noext'), PNG_BYTES);
    await writeFile(join(dir, 'assets', 'range.bin'), RANGE_BYTES);
    await writeFile(join(dir, 'assets', 'empty.bin'), EMPTY_BYTES);
    await writeFile(join(dir, 'assets', 'my photo.png'), PNG_BYTES);
    await writeFile(join(dir, 'assets', 'nested', 'deep.png'), PNG_BYTES);
    await mkdir(join(dir, '.hidden'), { recursive: true });
    await writeFile(join(dir, '.hidden', 'inner.png'), PNG_BYTES);
    await writeFile(join(dir, '.dotfile.png'), PNG_BYTES);
    await symlink(join(dir, 'assets', 'pic.png'), join(dir, 'link.png'));
    await symlink(join(dir, 'assets'), join(dir, 'linkdir'), 'dir');
    app = await buildMediaTestApp({ workspaceRoot: dir });
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  // Pins the revision formula (workspaceKey + NUL + path + NUL +
  // bytes) independently of lib/revision.ts, as read.spec.ts does.
  function expectedRevision(path: string, content: Buffer): string {
    const parts = [
      Buffer.from(rootReal, 'utf8'),
      Buffer.from([0]),
      Buffer.from(path, 'utf8'),
      Buffer.from([0]),
      content,
    ];
    return `sha256:${createHash('sha256').update(Buffer.concat(parts)).digest('hex')}`;
  }

  function mediaUrl(path: string): string {
    return `/api/workspace/media/${path}`;
  }

  it('GET returns bytes with revision and security headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: mediaUrl('assets/pic.png'),
      headers: { cookie: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(PNG_BYTES);
    expect(res.headers['content-type']).toBe('image/png');
    const revision = expectedRevision('assets/pic.png', PNG_BYTES);
    expect(res.headers['etag']).toBe(`"${revision}"`);
    expect(res.headers['x-revision']).toBe(revision);
    expect(res.headers['x-version']).toBeUndefined();
    expect(res.headers['last-modified']).toBeDefined();
    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(PNG_BYTES.length));
  });

  it('GET with a version query uses the versioned cache-control', async () => {
    const revision = expectedRevision('assets/pic.png', PNG_BYTES);
    const res = await app.inject({
      method: 'GET',
      url: `${mediaUrl('assets/pic.png')}?v=${revision.slice(7, 15)}`,
      headers: { cookie: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(PNG_BYTES);
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.headers['etag']).toBe(`"${revision}"`);
  });

  it('GET serves JPEG and PDF inline with sandbox', async () => {
    for (const [path, bytes, mime] of [
      ['assets/photo.jpg', JPEG_BYTES, 'image/jpeg'],
      ['assets/doc.pdf', PDF_BYTES, 'application/pdf'],
    ] as const) {
      const res = await app.inject({
        method: 'GET',
        url: mediaUrl(path),
        headers: { cookie: VALID_COOKIE },
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload).toEqual(bytes);
      expect(res.headers['content-type']).toBe(mime);
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe('sandbox');
    }
  });

  it('GET decides the type from content, not from the extension alone', async () => {
    // No extension, PNG magic: served as the detected image type.
    const noext = await app.inject({
      method: 'GET',
      url: mediaUrl('assets/noext'),
      headers: { cookie: VALID_COOKIE },
    });
    expect(noext.statusCode).toBe(200);
    expect(noext.headers['content-type']).toBe('image/png');
    expect(noext.headers['content-disposition']).toBe('inline');

    // Extension claims PNG but magic is JPEG: never served as the
    // claimed type and never 415 on the read side; safe fallback.
    const mismatch = await app.inject({
      method: 'GET',
      url: mediaUrl('assets/mismatch.png'),
      headers: { cookie: VALID_COOKIE },
    });
    expect(mismatch.statusCode).toBe(200);
    expect(mismatch.rawPayload).toEqual(JPEG_BYTES);
    expect(mismatch.headers['content-type']).toBe('application/octet-stream');
    expect(mismatch.headers['content-disposition']).toBe('attachment; filename="mismatch.png"');
    expect(mismatch.headers['content-security-policy']).toBeUndefined();
    expect(mismatch.headers['x-content-type-options']).toBe('nosniff');
  });

  it('GET serves ZIP, SVG, text, HTML, and unknown files as attachment', async () => {
    const cases = [
      ['assets/arch.zip', ZIP_BYTES, 'application/zip', 'attachment; filename="arch.zip"'],
      ['assets/pic.svg', SVG_BYTES, 'application/octet-stream', 'attachment; filename="pic.svg"'],
      ['assets/note.txt', TEXT_BYTES, 'text/plain', 'attachment; filename="note.txt"'],
      ['assets/page.html', HTML_BYTES, 'application/octet-stream', 'attachment; filename="page.html"'],
      ['assets/unknown.xyz', RANGE_BYTES, 'application/octet-stream', 'attachment; filename="unknown.xyz"'],
    ] as const;
    for (const [path, bytes, mime, disposition] of cases) {
      const res = await app.inject({
        method: 'GET',
        url: mediaUrl(path),
        headers: { cookie: VALID_COOKIE },
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload).toEqual(bytes);
      expect(res.headers['content-type']).toBe(mime);
      expect(res.headers['content-disposition']).toBe(disposition);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBeUndefined();
    }
  });

  it('GET serves an empty file with content-length 0', async () => {
    const res = await app.inject({
      method: 'GET',
      url: mediaUrl('assets/empty.bin'),
      headers: { cookie: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(EMPTY_BYTES);
    expect(res.headers['content-length']).toBe('0');
    expect(res.headers['content-type']).toBe('application/octet-stream');
  });

  it('GET decodes each path segment once', async () => {
    const spaced = await app.inject({
      method: 'GET',
      url: mediaUrl('assets/my%20photo.png'),
      headers: { cookie: VALID_COOKIE },
    });
    expect(spaced.statusCode).toBe(200);
    expect(spaced.rawPayload).toEqual(PNG_BYTES);
    const nested = await app.inject({
      method: 'GET',
      url: mediaUrl('assets/nested/deep.png'),
      headers: { cookie: VALID_COOKIE },
    });
    expect(nested.statusCode).toBe(200);
    expect(nested.rawPayload).toEqual(PNG_BYTES);
    expect(nested.headers['etag']).toBe(`"${expectedRevision('assets/nested/deep.png', PNG_BYTES)}"`);
  });

  it('HEAD returns the same headers as GET with no body', async () => {
    for (const path of ['assets/pic.png', 'assets/arch.zip']) {
      const get = await app.inject({
        method: 'GET',
        url: mediaUrl(path),
        headers: { cookie: VALID_COOKIE },
      });
      const head = await app.inject({
        method: 'HEAD',
        url: mediaUrl(path),
        headers: { cookie: VALID_COOKIE },
      });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      for (const name of [
        'content-type',
        'etag',
        'x-revision',
        'last-modified',
        'cache-control',
        'content-disposition',
        'x-content-type-options',
        'content-security-policy',
        'accept-ranges',
        'content-length',
      ]) {
        expect(head.headers[name]).toBe(get.headers[name]);
      }
    }
  });

  it('HEAD with a range answers 206 headers with no body', async () => {
    const res = await app.inject({
      method: 'HEAD',
      url: mediaUrl('assets/range.bin'),
      headers: { cookie: VALID_COOKIE, range: 'bytes=0-3' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('');
    expect(res.headers['content-range']).toBe('bytes 0-3/16');
    expect(res.headers['content-length']).toBe('4');
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('matching If-None-Match answers 304 with no body', async () => {
    const revision = expectedRevision('assets/pic.png', PNG_BYTES);
    for (const header of [
      `"${revision}"`,
      revision,
      `W/"${revision}"`,
      '*',
      `"sha256:deadbeef", "${revision}"`,
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: mediaUrl('assets/pic.png'),
        headers: { cookie: VALID_COOKIE, 'if-none-match': header },
      });
      expect(res.statusCode).toBe(304);
      expect(res.body).toBe('');
      expect(res.headers['etag']).toBe(`"${revision}"`);
      expect(res.headers['content-type']).toBe('image/png');
    }
    const miss = await app.inject({
      method: 'GET',
      url: mediaUrl('assets/pic.png'),
      headers: { cookie: VALID_COOKIE, 'if-none-match': '"sha256:other"' },
    });
    expect(miss.statusCode).toBe(200);
    expect(miss.rawPayload).toEqual(PNG_BYTES);
  });

  it('If-None-Match match wins over Range, on GET and HEAD', async () => {
    const revision = expectedRevision('assets/range.bin', RANGE_BYTES);
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await app.inject({
        method,
        url: mediaUrl('assets/range.bin'),
        headers: {
          cookie: VALID_COOKIE,
          'if-none-match': `"${revision}"`,
          range: 'bytes=0-3',
        },
      });
      expect(res.statusCode).toBe(304);
      expect(res.body).toBe('');
      expect(res.headers['content-range']).toBeUndefined();
    }
  });

  it('a single Range answers 206 with the slice', async () => {
    const cases = [
      ['bytes=0-3', 'bytes 0-3/16', '0123'],
      ['bytes=4-', 'bytes 4-15/16', '456789abcdef'],
      ['bytes=-4', 'bytes 12-15/16', 'cdef'],
      ['bytes=0-999', 'bytes 0-15/16', '0123456789abcdef'],
      ['bytes=15-15', 'bytes 15-15/16', 'f'],
    ] as const;
    for (const [range, contentRange, text] of cases) {
      const res = await app.inject({
        method: 'GET',
        url: mediaUrl('assets/range.bin'),
        headers: { cookie: VALID_COOKIE, range },
      });
      expect(res.statusCode).toBe(206);
      expect(res.rawPayload).toEqual(Buffer.from(text, 'utf8'));
      expect(res.headers['content-range']).toBe(contentRange);
      expect(res.headers['content-length']).toBe(String(text.length));
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-type']).toBe('application/octet-stream');
    }
  });

  it('an invalid Range is ignored and the full body is served', async () => {
    for (const range of ['bytes=abc', 'bytes=', 'bytes=1-2,4-5', 'items=0-3', 'bytes=-', 'bytes -0-3']) {
      const res = await app.inject({
        method: 'GET',
        url: mediaUrl('assets/range.bin'),
        headers: { cookie: VALID_COOKIE, range },
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload).toEqual(RANGE_BYTES);
      expect(res.headers['content-range']).toBeUndefined();
      expect(res.headers['content-length']).toBe('16');
    }
  });

  it('an unsatisfiable Range answers 416 range_not_satisfiable', async () => {
    for (const range of ['bytes=16-', 'bytes=100-200', 'bytes=5-2', 'bytes=-0']) {
      const res = await app.inject({
        method: 'GET',
        url: mediaUrl('assets/range.bin'),
        headers: { cookie: VALID_COOKIE, range },
      });
      expectError(res, 416, 'range_not_satisfiable');
      expect(res.headers['content-range']).toBe('bytes */16');
    }
    const empty = await app.inject({
      method: 'GET',
      url: mediaUrl('assets/empty.bin'),
      headers: { cookie: VALID_COOKIE, range: 'bytes=0-0' },
    });
    expectError(empty, 416, 'range_not_satisfiable');
    expect(empty.headers['content-range']).toBe('bytes */0');
  });

  it('missing file and directory answer 404 not_found', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: mediaUrl('assets/nope.png'),
      headers: { cookie: VALID_COOKIE },
    });
    expectError(missing, 404, 'not_found');
    const directory = await app.inject({
      method: 'GET',
      url: mediaUrl('assets'),
      headers: { cookie: VALID_COOKIE },
    });
    expectError(directory, 404, 'not_found');
  });

  it('symlink file and symlink directory component answer 404', async () => {
    const fileLink = await app.inject({
      method: 'GET',
      url: mediaUrl('link.png'),
      headers: { cookie: VALID_COOKIE },
    });
    expectError(fileLink, 404, 'not_found');
    const dirLink = await app.inject({
      method: 'GET',
      url: mediaUrl('linkdir/pic.png'),
      headers: { cookie: VALID_COOKIE },
    });
    expectError(dirLink, 404, 'not_found');
  });

  it('hidden paths answer 404, indistinguishable from missing', async () => {
    for (const path of ['.dotfile.png', '.hidden/inner.png']) {
      const res = await app.inject({
        method: 'GET',
        url: mediaUrl(path),
        headers: { cookie: VALID_COOKIE },
      });
      expectError(res, 404, 'not_found');
    }
  });

  it.each([
    'assets%5cpic.png',
    'assets//pic.png',
    '..%2fpic.png',
  ])('traversal or malformed path %s answers 400 invalid_path', async (path) => {
    const res = await app.inject({
      method: 'GET',
      url: mediaUrl(path),
      headers: { cookie: VALID_COOKIE },
    });
    expectError(res, 400, 'invalid_path');
  });

  // Encoded dot segments (%2e%2e) never reach the handler through
  // inject: the inject transport resolves dot segments with WHATWG
  // URL semantics before routing, so the rewritten request answers
  // 404 for a path that does not exist. No traversal is served either
  // way. The handler-level answer for the raw encoded form is 400
  // invalid_path, proven by the real-socket test below, where the
  // raw request URL reaches the handler untouched.
  it.each([
    '%2e%2e/pic.png',
    'assets/%2e%2e/pic.png',
  ])('encoded dot segments %s are normalized by the transport and answer 404', async (path) => {
    const res = await app.inject({
      method: 'GET',
      url: mediaUrl(path),
      headers: { cookie: VALID_COOKIE },
    });
    expectError(res, 404, 'not_found');
  });

  it('raw encoded dot segments over a real socket answer 400 invalid_path', async () => {
    const socketApp = await buildMediaTestApp({ workspaceRoot: dir });
    try {
      await socketApp.listen({ host: '127.0.0.1', port: 0 });
      const address = socketApp.server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      expect(port).toBeGreaterThan(0);
      const get = (path: string): Promise<{ statusCode: number; body: string }> =>
        new Promise((resolve, reject) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port,
              path,
              method: 'GET',
              headers: { cookie: VALID_COOKIE },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk: Buffer) => chunks.push(chunk));
              res.on('end', () =>
                resolve({
                  statusCode: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString('utf8'),
                }),
              );
            },
          );
          req.on('error', reject);
          req.end();
        });
      for (const path of ['%2e%2e/pic.png', 'assets/%2e%2e/pic.png']) {
        const res = await get(mediaUrl(path));
        expectError(res, 400, 'invalid_path');
      }
    } finally {
      await socketApp.close();
    }
  });

  // A malformed percent sequence is rejected by the framework router
  // (FST_ERR_BAD_URL) before any hook or handler runs, in both
  // transports, so it never takes the envelope form. Only the 400
  // status and the framework code are pinned here; converting it to
  // the envelope would need an app-level onBadUrl handler in
  // buildApp, outside this route module.
  it('a malformed percent sequence answers framework 400 FST_ERR_BAD_URL', async () => {
    const res = await app.inject({
      method: 'GET',
      url: mediaUrl('assets/%zz.png'),
      headers: { cookie: VALID_COOKIE },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { code?: string; statusCode?: number };
    expect(body.code).toBe('FST_ERR_BAD_URL');
    expect(body.statusCode).toBe(400);
  });

  it('an empty media path answers 400 invalid_path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/workspace/media/',
      headers: { cookie: VALID_COOKIE },
    });
    expectError(res, 400, 'invalid_path');
  });

  it('double-encoded traversal stays a literal name and answers 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: mediaUrl('%252e%252e/pic.png'),
      headers: { cookie: VALID_COOKIE },
    });
    expectError(res, 404, 'not_found');
  });

  it('unauthenticated GET and HEAD answer 401', async () => {
    for (const method of ['GET', 'HEAD'] as const) {
      const noCookie = await app.inject({ method, url: mediaUrl('assets/pic.png') });
      expectError(noCookie, 401, 'unauthenticated');
      const badCookie = await app.inject({
        method,
        url: mediaUrl('assets/pic.png'),
        headers: { cookie: 'notegen_session=wrong' },
      });
      expectError(badCookie, 401, 'unauthenticated');
    }
  });

  it('GET needs only the session: a wrong Origin header is ignored', async () => {
    const res = await app.inject({
      method: 'GET',
      url: mediaUrl('assets/pic.png'),
      headers: { cookie: VALID_COOKIE, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(PNG_BYTES);
  });

  it('an injected version is reported as X-Version', async () => {
    const versioned = await buildMediaTestApp({
      workspaceRoot: dir,
      resolveVersion: async (path) => (path === 'assets/pic.png' ? 7 : null),
    });
    try {
      const get = await versioned.inject({
        method: 'GET',
        url: mediaUrl('assets/pic.png'),
        headers: { cookie: VALID_COOKIE },
      });
      expect(get.statusCode).toBe(200);
      expect(get.headers['x-version']).toBe('7');
      const head = await versioned.inject({
        method: 'HEAD',
        url: mediaUrl('assets/pic.png'),
        headers: { cookie: VALID_COOKIE },
      });
      expect(head.statusCode).toBe(200);
      expect(head.headers['x-version']).toBe('7');
      const other = await versioned.inject({
        method: 'GET',
        url: mediaUrl('assets/photo.jpg'),
        headers: { cookie: VALID_COOKIE },
      });
      expect(other.statusCode).toBe(200);
      expect(other.headers['x-version']).toBeUndefined();
    } finally {
      await versioned.close();
    }
  });
});
