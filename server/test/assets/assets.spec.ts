// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for record assets (V3-31): key format, magic-byte typing,
// file name resolution, the filesystem store, the service, and the
// two HTTP routes (POST /api/assets, GET /api/assets/:assetKey).
//
// What is pinned here: keys are opaque, slash-free, and validated by
// exact match; types come from magic bytes only and HTML/SVG/unknown
// binary is rejected 415; oversized uploads answer 413 with
// details.limitBytes; upload and re-read are byte-identical; a
// malformed key, an unknown key, and a key from another workspace all
// answer the same generic 404; requests without a session answer 401
// and mutations with a bad CSRF token or Origin answer 403; and every
// upload yields a fresh key (no hash dedupe promise).
//
// No database is touched by this module (there is no asset table in
// the canonical schema), so there is no live-Postgres section here:
// the workspace resolver is an injected fake, and the store runs
// against temporary directories. The production resolver (membership
// lookup, same rule as services/db/workspace.ts) is supplied at
// wiring time; its behavior is covered by the db route specs, not
// duplicated here.
//
// The routes are registered directly on a test app composed of the
// same frozen plugins as buildApp (request ids, error handling, auth
// hooks), following the settings test-app pattern. The production
// buildApp block is the integrator's (the overlap batch forbids
// editing app.ts), so no buildApp smoke test is possible in this
// branch; the wiring requirement is recorded in routes/assets.ts.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  registerAuthHooks,
  type SessionPrincipal,
  type VerifyCsrfTokenFn,
  type VerifyOriginFn,
  type VerifySessionFn,
} from '../../src/middleware/auth-hook.js';
import { ApiError } from '../../src/plugins/envelope.js';
import { registerErrorHandling } from '../../src/plugins/error-handler.js';
import { buildLoggerOptions } from '../../src/plugins/logging.js';
import { registerRequestId, requestIdFromHeaders } from '../../src/plugins/request-id.js';
import { registerAssetRoutes, type AssetWorkspaceResolver } from '../../src/routes/assets.js';
import { generateAssetKey, isValidAssetKey } from '../../src/services/assets/keys.js';
import {
  AssetService,
  DEFAULT_ASSET_LIMIT_BYTES,
  resolveFileName,
} from '../../src/services/assets/service.js';
import {
  createFilesystemAssetStore,
  type AssetStore,
} from '../../src/services/assets/store.js';
import { detectAssetType, validateAssetBytes } from '../../src/services/assets/types.js';

const TEST_ORIGIN = 'http://localhost:3001';
const TEST_CSRF_TOKEN = 'good-csrf-token';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOUNDARY = '----asset-test-boundary-9';

const PRINCIPAL_A: SessionPrincipal = { userId: USER_A, role: 'user', sessionId: 'session-a' };
const PRINCIPAL_B: SessionPrincipal = { userId: USER_B, role: 'user', sessionId: 'session-b' };

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png-payload-bytes'),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-payload')]);
const PDF_BYTES = Buffer.from('%PDF-1.4 fake pdf payload');
const ZIP_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip-payload')]);
const TEXT_BYTES = Buffer.from('plain text record attachment, no magic bytes here');
const HTML_BYTES = Buffer.from('<!doctype html><html><body>nope</body></html>');
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const UNKNOWN_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0xfc]);

function errorOf(response: { body: string }): { code: string; details: Record<string, unknown> } {
  const parsed = JSON.parse(response.body) as {
    error: { code: string; details: Record<string, unknown> };
  };
  return parsed.error;
}

function dataOf<T>(response: { body: string }): T {
  return (JSON.parse(response.body) as { data: T }).data;
}

function rawBodyOf(response: { rawPayload?: Buffer; body: string }): Buffer {
  // Fastify 5 inject responses carry the exact bytes in rawPayload;
  // body is a UTF-8 string and mangles non-UTF-8 bytes (for example
  // the PNG signature), so byte-identity assertions must use the
  // raw payload, never the decoded body.
  if (response.rawPayload !== undefined) {
    return response.rawPayload;
  }
  return Buffer.from(response.body, 'utf8');
}

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer | string;
}

function multipartBody(parts: MultipartPart[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let header = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) {
      header += `; filename="${part.filename}"`;
    }
    header += '\r\n';
    if (part.contentType !== undefined) {
      header += `Content-Type: ${part.contentType}\r\n`;
    }
    header += '\r\n';
    chunks.push(Buffer.from(header, 'utf8'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

describe('asset keys', () => {
  it('generates opaque keys in the canonical format, unique across calls', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const key = generateAssetKey();
      expect(key).toMatch(/^ast_[0-9a-f]{32}$/);
      expect(key).toHaveLength(36);
      keys.add(key);
    }
    expect(keys.size).toBe(100);
  });

  it('rejects traversal, encoded separators, wrong case, and wrong length', () => {
    const valid = generateAssetKey();
    expect(isValidAssetKey(valid)).toBe(true);
    const rejected: unknown[] = [
      '',
      'ast_',
      valid.toUpperCase(),
      valid.slice(0, 35),
      `${valid}x`,
      ` ${valid}`,
      `${valid} `,
      '../etc/passwd',
      'assets/01k0000000000000000000000/photo.png',
      `${valid}/extra`,
      `${valid}%2Fextra`,
      'ast_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      'ast_0123456789abcdef0123456789abcdeg',
      42,
      null,
      undefined,
      {},
    ];
    for (const candidate of rejected) {
      expect(isValidAssetKey(candidate)).toBe(false);
    }
  });
});

describe('asset type detection', () => {
  it('detects types from magic bytes', () => {
    expect(detectAssetType(PNG_BYTES)).toBe('png');
    expect(detectAssetType(JPEG_BYTES)).toBe('jpeg');
    expect(detectAssetType(Buffer.from('GIF89aXXXX'))).toBe('gif');
    expect(detectAssetType(Buffer.from('%PDF-2.0 x'))).toBe('pdf');
    expect(detectAssetType(ZIP_BYTES)).toBe('zip');
    expect(detectAssetType(Buffer.from('ID3xxxx'))).toBe('mp3');
    expect(detectAssetType(Buffer.from('OggSxxxx'))).toBe('ogg');
    expect(detectAssetType(TEXT_BYTES)).toBe('text');
  });

  it('flags HTML, SVG, unknown binary, and empty input', () => {
    expect(detectAssetType(HTML_BYTES)).toBe('html');
    expect(detectAssetType(SVG_BYTES)).toBe('svg');
    expect(detectAssetType(UNKNOWN_BYTES)).toBe('unknown');
    expect(detectAssetType(Buffer.alloc(0))).toBe('unknown');
  });

  it('validates accepted types with the right MIME type and disposition', () => {
    expect(validateAssetBytes(PNG_BYTES)).toEqual({
      detectedType: 'png',
      mimeType: 'image/png',
      disposition: 'inline',
    });
    expect(validateAssetBytes(PDF_BYTES)).toMatchObject({
      mimeType: 'application/pdf',
      disposition: 'inline',
    });
    expect(validateAssetBytes(ZIP_BYTES)).toMatchObject({
      mimeType: 'application/zip',
      disposition: 'attachment',
    });
    expect(validateAssetBytes(TEXT_BYTES)).toMatchObject({
      mimeType: 'text/plain',
      disposition: 'attachment',
    });
  });

  it('rejects HTML, SVG, and unknown binary with 415 unsupported_media_type', () => {
    for (const bytes of [HTML_BYTES, SVG_BYTES, UNKNOWN_BYTES]) {
      let caught: unknown;
      try {
        validateAssetBytes(bytes);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      const apiError = caught as ApiError;
      expect(apiError.statusCode).toBe(415);
      expect(apiError.code).toBe('unsupported_media_type');
    }
  });
});

describe('file name resolution', () => {
  it('prefers the fileName part and falls back to the part filename', () => {
    expect(resolveFileName('photo.png', 'upload.bin')).toBe('photo.png');
    expect(resolveFileName(undefined, 'upload.bin')).toBe('upload.bin');
    expect(resolveFileName('  ', 'upload.bin')).toBe('upload.bin');
    expect(resolveFileName('  spaced.png  ', undefined)).toBe('spaced.png');
  });

  it('strips directory components from either source', () => {
    expect(resolveFileName('a/b/c.png', undefined)).toBe('c.png');
    expect(resolveFileName(undefined, 'C:\\Users\\x\\doc.pdf')).toBe('doc.pdf');
  });

  it('rejects empty, dot-only, overlong, and control-character names', () => {
    const rejected: Array<[string | undefined, string | undefined]> = [
      [undefined, undefined],
      ['', ''],
      ['.', undefined],
      ['..', undefined],
      ['/', undefined],
      ['a'.repeat(256), undefined],
      ['bad\nname.png', undefined],
      ['bad\x00name.png', undefined],
    ];
    for (const [part, filename] of rejected) {
      expect(() => resolveFileName(part, filename)).toThrow(ApiError);
      try {
        resolveFileName(part, filename);
      } catch (error) {
        expect((error as ApiError).code).toBe('validation_failed');
      }
    }
  });
});

describe('filesystem asset store', () => {
  let root = '';
  let store: AssetStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notegen-assets-'));
    store = createFilesystemAssetStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips bytes and metadata byte-identically', async () => {
    const key = generateAssetKey();
    const hash = `sha256:${createHash('sha256').update(PNG_BYTES).digest('hex')}`;
    expect(
      await store.save({
        workspaceId: WORKSPACE_A,
        assetKey: key,
        fileName: 'photo.png',
        mimeType: 'image/png',
        bytes: PNG_BYTES,
        contentHash: hash,
        createdAt: 1794660000000,
      }),
    ).toBe('saved');
    const loaded = await store.load(WORKSPACE_A, key);
    expect(loaded).not.toBeNull();
    expect(loaded?.bytes.equals(PNG_BYTES)).toBe(true);
    expect(loaded?.metadata).toEqual({
      assetKey: key,
      workspaceId: WORKSPACE_A,
      fileName: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: PNG_BYTES.length,
      contentHash: hash,
      createdAt: 1794660000000,
    });
    expect(await store.loadMetadata(WORKSPACE_A, key)).toEqual(loaded?.metadata);
  });

  it('isolates workspaces and unknown keys as misses', async () => {
    const key = generateAssetKey();
    await store.save({
      workspaceId: WORKSPACE_A,
      assetKey: key,
      fileName: 'a.png',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      contentHash: `sha256:${createHash('sha256').update(PNG_BYTES).digest('hex')}`,
      createdAt: 1,
    });
    expect(await store.load(WORKSPACE_B, key)).toBeNull();
    expect(await store.load(WORKSPACE_A, generateAssetKey())).toBeNull();
    expect(await store.loadMetadata(WORKSPACE_B, key)).toBeNull();
  });

  it('returns null for malformed keys without touching the disk', async () => {
    expect(await store.load(WORKSPACE_A, '../etc/passwd')).toBeNull();
    expect(await store.load('not-a-uuid', generateAssetKey())).toBeNull();
    expect(await store.loadMetadata(WORKSPACE_A, 'ast_bad')).toBeNull();
  });

  it('reports collisions and preserves the original bytes', async () => {
    const key = generateAssetKey();
    const first = {
      workspaceId: WORKSPACE_A,
      assetKey: key,
      fileName: 'first.png',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      contentHash: `sha256:${createHash('sha256').update(PNG_BYTES).digest('hex')}`,
      createdAt: 1,
    };
    expect(await store.save(first)).toBe('saved');
    expect(await store.save({ ...first, fileName: 'second.png', bytes: JPEG_BYTES })).toBe('exists');
    const loaded = await store.load(WORKSPACE_A, key);
    expect(loaded?.bytes.equals(PNG_BYTES)).toBe(true);
    expect(loaded?.metadata.fileName).toBe('first.png');
  });

  it('treats corrupted bytes and tampered sidecars as misses', async () => {
    const key = generateAssetKey();
    await store.save({
      workspaceId: WORKSPACE_A,
      assetKey: key,
      fileName: 'a.png',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      contentHash: `sha256:${createHash('sha256').update(PNG_BYTES).digest('hex')}`,
      createdAt: 1,
    });
    const bytesPath = join(root, WORKSPACE_A, `${key}.bin`);
    const metaPath = join(root, WORKSPACE_A, `${key}.json`);
    await writeFile(bytesPath, Buffer.from('tampered bytes, wrong length and hash'));
    expect(await store.load(WORKSPACE_A, key)).toBeNull();
    await writeFile(bytesPath, PNG_BYTES);
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    meta['workspaceId'] = WORKSPACE_B;
    await writeFile(metaPath, JSON.stringify(meta));
    expect(await store.load(WORKSPACE_A, key)).toBeNull();
  });
});

describe('asset service', () => {
  let root = '';
  let store: AssetStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notegen-assets-'));
    store = createFilesystemAssetStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uploads with a fresh key, hash, and clock time', async () => {
    const service = new AssetService({ store, clock: () => 1794660000000 });
    const rep = await service.upload({
      workspaceId: WORKSPACE_A,
      fileName: 'photo.png',
      bytes: PNG_BYTES,
    });
    expect(isValidAssetKey(rep.assetKey)).toBe(true);
    expect(rep.fileName).toBe('photo.png');
    expect(rep.mimeType).toBe('image/png');
    expect(rep.sizeBytes).toBe(PNG_BYTES.length);
    expect(rep.contentHash).toBe(
      `sha256:${createHash('sha256').update(PNG_BYTES).digest('hex')}`,
    );
    expect(rep.createdAt).toBe(1794660000000);
    const second = await service.upload({
      workspaceId: WORKSPACE_A,
      fileName: 'photo.png',
      bytes: PNG_BYTES,
    });
    expect(second.assetKey).not.toBe(rep.assetKey);
  });

  it('enforces the size limit with details.limitBytes', async () => {
    const service = new AssetService({ store, limitBytes: 16 });
    expect(DEFAULT_ASSET_LIMIT_BYTES).toBe(20 * 1024 * 1024);
    try {
      await service.upload({ workspaceId: WORKSPACE_A, fileName: 'a.png', bytes: PNG_BYTES });
      expect.unreachable('oversized upload must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(413);
      expect((error as ApiError).code).toBe('asset_too_large');
      expect((error as ApiError).details).toEqual({ limitBytes: 16 });
    }
  });

  it('rejects empty uploads and unsupported types', async () => {
    const service = new AssetService({ store });
    await expect(
      service.upload({ workspaceId: WORKSPACE_A, fileName: 'a.png', bytes: Buffer.alloc(0) }),
    ).rejects.toMatchObject({ code: 'validation_failed', statusCode: 400 });
    await expect(
      service.upload({ workspaceId: WORKSPACE_A, fileName: 'a.html', bytes: HTML_BYTES }),
    ).rejects.toMatchObject({ code: 'unsupported_media_type', statusCode: 415 });
  });

  it('retries key generation on collision', async () => {
    const taken = generateAssetKey();
    const fresh = generateAssetKey();
    await store.save({
      workspaceId: WORKSPACE_A,
      assetKey: taken,
      fileName: 'taken.png',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      contentHash: `sha256:${createHash('sha256').update(PNG_BYTES).digest('hex')}`,
      createdAt: 1,
    });
    const keys = [taken, fresh];
    const service = new AssetService({
      store,
      generateKey: () => keys.shift() as string,
    });
    const rep = await service.upload({
      workspaceId: WORKSPACE_A,
      fileName: 'new.png',
      bytes: PNG_BYTES,
    });
    expect(rep.assetKey).toBe(fresh);
  });

  it('serves with disposition and ETag, and answers 404 generically', async () => {
    const service = new AssetService({ store });
    const rep = await service.upload({
      workspaceId: WORKSPACE_A,
      fileName: 'photo.png',
      bytes: PNG_BYTES,
    });
    const served = await service.serve(WORKSPACE_A, rep.assetKey);
    expect(served.bytes.equals(PNG_BYTES)).toBe(true);
    expect(served.disposition).toBe('inline');
    expect(served.etag).toBe(`"${rep.contentHash.slice('sha256:'.length)}"`);
    await expect(service.serve(WORKSPACE_A, generateAssetKey())).rejects.toMatchObject({
      code: 'not_found',
      statusCode: 404,
    });
    await expect(service.serve(WORKSPACE_B, rep.assetKey)).rejects.toMatchObject({
      code: 'not_found',
      statusCode: 404,
    });
    await expect(service.serve(WORKSPACE_A, '../x')).rejects.toMatchObject({
      code: 'not_found',
      statusCode: 404,
    });
    expect(await service.findMetadata(WORKSPACE_A, rep.assetKey)).not.toBeNull();
    expect(await service.findMetadata(WORKSPACE_B, rep.assetKey)).toBeNull();
    expect(await service.findMetadata(WORKSPACE_A, 'bogus')).toBeNull();
  });
});

describe('asset routes', () => {
  const apps: FastifyInstance[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    while (apps.length > 0) {
      await apps.pop()?.close();
    }
    while (roots.length > 0) {
      const dir = roots.pop() as string;
      await rm(dir, { recursive: true, force: true });
    }
  });

  interface RouteAppOptions {
    verifySession?: VerifySessionFn;
    verifyCsrf?: VerifyCsrfTokenFn;
    verifyOrigin?: VerifyOriginFn;
    resolveWorkspaceId?: AssetWorkspaceResolver;
    limitBytes?: number;
  }

  async function makeApp(options: RouteAppOptions = {}): Promise<{
    app: FastifyInstance;
    service: AssetService;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'notegen-assets-'));
    roots.push(root);
    const service = new AssetService({
      store: createFilesystemAssetStore(root),
      limitBytes: options.limitBytes,
    });
    const config = loadConfig({
      LOG_LEVEL: 'silent',
      NODE_ENV: 'development',
      PUBLIC_BASE_URL: TEST_ORIGIN,
    });
    const app = Fastify({
      bodyLimit: config.maxBodyBytes,
      genReqId: (request) => requestIdFromHeaders(request.headers),
      logController: new LogController({ disableRequestLogging: true }),
      logger: buildLoggerOptions(config.logLevel),
    });
    registerRequestId(app);
    registerErrorHandling(app, { version: 'test' });
    const verifySession: VerifySessionFn = options.verifySession ?? (async () => PRINCIPAL_A);
    const verifyCsrf: VerifyCsrfTokenFn =
      options.verifyCsrf ?? (async (request) => request.headers['x-csrf-token'] === TEST_CSRF_TOKEN);
    const verifyOrigin: VerifyOriginFn = options.verifyOrigin ?? (async () => true);
    registerAuthHooks(app, {
      canonicalOrigin: config.publicBaseUrl,
      verifyCsrf,
      verifyOrigin,
      verifySession,
    });
    await registerAssetRoutes(app, {
      service,
      resolveWorkspaceId: options.resolveWorkspaceId ?? (async () => WORKSPACE_A),
    });
    await app.ready();
    apps.push(app);
    return { app, service };
  }

  const SESSION_HEADERS = { cookie: 'notegen_session=test-session' };
  const MUTATION_HEADERS = {
    ...SESSION_HEADERS,
    origin: TEST_ORIGIN,
    'x-csrf-token': TEST_CSRF_TOKEN,
  };

  function uploadPayload(
    bytes: Buffer,
    overrides: { fileNamePart?: string; partFilename?: string; contentType?: string } = {},
  ): Buffer {
    return multipartBody([
      ...(overrides.fileNamePart === undefined
        ? []
        : [{ name: 'fileName', data: overrides.fileNamePart }]),
      {
        name: 'file',
        filename: overrides.partFilename ?? 'upload.png',
        contentType: overrides.contentType ?? 'application/octet-stream',
        data: bytes,
      },
    ]);
  }

  it('uploads and serves byte-identically with the contract headers', async () => {
    const { app } = await makeApp();
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: uploadPayload(PNG_BYTES, { fileNamePart: 'photo.png' }),
    });
    expect(uploaded.statusCode).toBe(201);
    const rep = dataOf<{
      assetKey: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      contentHash: string;
      createdAt: number;
    }>(uploaded);
    expect(isValidAssetKey(rep.assetKey)).toBe(true);
    expect(rep.fileName).toBe('photo.png');
    expect(rep.mimeType).toBe('image/png');
    expect(rep.sizeBytes).toBe(PNG_BYTES.length);
    expect(rep.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Number.isInteger(rep.createdAt)).toBe(true);

    const served = await app.inject({
      method: 'GET',
      url: `/api/assets/${rep.assetKey}`,
      headers: SESSION_HEADERS,
    });
    expect(served.statusCode).toBe(200);
    expect(rawBodyOf(served).equals(PNG_BYTES)).toBe(true);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['content-disposition']).toBe(
      "inline; filename*=UTF-8''photo.png",
    );
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['cache-control']).toBe('private');
    expect(served.headers['etag']).toBe(`"${rep.contentHash.slice('sha256:'.length)}"`);
    expect(served.headers['content-length']).toBe(String(PNG_BYTES.length));
  });

  it('serves ZIP as an attachment and falls back to the part filename', async () => {
    const { app } = await makeApp();
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: uploadPayload(ZIP_BYTES, { partFilename: 'bundle.zip' }),
    });
    expect(uploaded.statusCode).toBe(201);
    const rep = dataOf<{ assetKey: string; fileName: string }>(uploaded);
    expect(rep.fileName).toBe('bundle.zip');
    const served = await app.inject({
      method: 'GET',
      url: `/api/assets/${rep.assetKey}`,
      headers: SESSION_HEADERS,
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('application/zip');
    expect(served.headers['content-disposition']).toBe(
      "attachment; filename*=UTF-8''bundle.zip",
    );
    expect(rawBodyOf(served).equals(ZIP_BYTES)).toBe(true);
  });

  it('rejects requests without a session and mutations with bad CSRF or Origin', async () => {
    const denied = await makeApp({ verifySession: async () => null });
    const noSessionPost = await denied.app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: uploadPayload(PNG_BYTES),
    });
    expect(noSessionPost.statusCode).toBe(401);
    expect(errorOf(noSessionPost).code).toBe('unauthenticated');
    const noSessionGet = await denied.app.inject({
      method: 'GET',
      url: `/api/assets/${generateAssetKey()}`,
    });
    expect(noSessionGet.statusCode).toBe(401);

    const badCsrf = await makeApp({ verifyCsrf: async () => false });
    const csrfRes = await badCsrf.app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: uploadPayload(PNG_BYTES),
    });
    expect(csrfRes.statusCode).toBe(403);
    expect(errorOf(csrfRes).code).toBe('csrf_invalid');

    const badOrigin = await makeApp({ verifyOrigin: async () => false });
    const originRes = await badOrigin.app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: uploadPayload(PNG_BYTES),
    });
    expect(originRes.statusCode).toBe(403);
    expect(errorOf(originRes).code).toBe('origin_rejected');
  });

  it('answers 404 generically for unknown, malformed, and foreign keys', async () => {
    const byUser: AssetWorkspaceResolver = async (principal) =>
      principal.userId === USER_A ? WORKSPACE_A : WORKSPACE_B;
    const { app } = await makeApp({
      resolveWorkspaceId: byUser,
      verifySession: async (input) =>
        input.request.headers['x-test-user'] === 'b' ? PRINCIPAL_B : PRINCIPAL_A,
    });
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: uploadPayload(PNG_BYTES),
    });
    const rep = dataOf<{ assetKey: string }>(uploaded);
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/assets/${rep.assetKey}`,
      headers: { ...SESSION_HEADERS, 'x-test-user': 'b' },
    });
    expect(foreign.statusCode).toBe(404);
    expect(errorOf(foreign).code).toBe('not_found');
    for (const key of [generateAssetKey(), 'not-a-key', `ast_${'A'.repeat(32)}`, '..']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assets/${encodeURIComponent(key)}`,
        headers: SESSION_HEADERS,
      });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('not_found');
    }
  });

  it('answers 404 when the principal has no workspace', async () => {
    const { app } = await makeApp({ resolveWorkspaceId: async () => null });
    const posted = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: uploadPayload(PNG_BYTES),
    });
    expect(posted.statusCode).toBe(404);
    expect(errorOf(posted).code).toBe('not_found');
    const served = await app.inject({
      method: 'GET',
      url: `/api/assets/${generateAssetKey()}`,
      headers: SESSION_HEADERS,
    });
    expect(served.statusCode).toBe(404);
    expect(errorOf(served).code).toBe('not_found');
  });

  it('rejects oversized uploads, unsupported types, and malformed multipart', async () => {
    const small = await makeApp({ limitBytes: 16 });
    const big = await small.app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: uploadPayload(PNG_BYTES),
    });
    expect(big.statusCode).toBe(413);
    expect(errorOf(big).code).toBe('asset_too_large');
    expect(errorOf(big).details).toEqual({ limitBytes: 16 });

    const { app } = await makeApp();
    const html = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: uploadPayload(HTML_BYTES),
    });
    expect(html.statusCode).toBe(415);
    expect(errorOf(html).code).toBe('unsupported_media_type');

    const jsonBody = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: { ...MUTATION_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ file: 'x' }),
    });
    expect(jsonBody.statusCode).toBe(400);
    expect(errorOf(jsonBody).code).toBe('invalid_upload');

    const noFile = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody([{ name: 'fileName', data: 'a.png' }]),
    });
    expect(noFile.statusCode).toBe(400);
    expect(errorOf(noFile).code).toBe('invalid_upload');

    const twoFiles = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody([
        { name: 'file', filename: 'a.png', data: PNG_BYTES },
        { name: 'file', filename: 'b.png', data: PNG_BYTES },
      ]),
    });
    expect(twoFiles.statusCode).toBe(400);
    expect(errorOf(twoFiles).code).toBe('invalid_upload');

    const extraField = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: {
        ...MUTATION_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody([
        { name: 'surprise', data: 'x' },
        { name: 'file', filename: 'a.png', data: PNG_BYTES },
      ]),
    });
    expect(extraField.statusCode).toBe(400);
    expect(errorOf(extraField).code).toBe('invalid_upload');
  });

  it('gives every upload a fresh key', async () => {
    const { app } = await makeApp();
    const keys: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/assets',
        headers: {
          ...MUTATION_HEADERS,
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        },
        payload: uploadPayload(PNG_BYTES),
      });
      expect(res.statusCode).toBe(201);
      keys.push(dataOf<{ assetKey: string }>(res).assetKey);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });
}, 20000);
