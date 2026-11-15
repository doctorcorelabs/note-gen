// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Specs for the media delete seam (V3-07 part 2, wave 3B overlap,
// AD-57): media-delete.ts supplies the media-specific facts for a
// delete that flows through DELETE /api/workspace/file and DELETE
// /api/workspace/folder to trash (kontrak-api-kanonis.md section
// 3.1; desain-workspace-api.md section 2.8). There is no DELETE
// media route to test. The unit specs exercise the seam directly
// against the REAL frozen path and revision modules through the
// landed V3-04a adapter, so traversal, symlink, hidden-path, and
// revision behavior is pinned against the real code, not doubles.
// The HTTP specs use a TEST-ONLY harness route (DELETE
// /api/workspace/file, defined in this file, never shipped) that
// calls only the seam inspection, to pin the frozen auth hook
// behavior (401 unauthenticated, 403 on missing CSRF/Origin) and
// the envelope error mapping the trash route inherits.
//
// Pinned rules and their sources:
// - Media file delete: plan carries the section 3.1/7.4 revision
//   over binary bytes, the section 7.3 classification, and the
//   media URL that must 404 after the trash move (5.1).
// - No non-media rejection: .md/.txt, unknown-extension, and
//   magic-mismatched files are all deletable (2.8 has no 415).
// - Missing file 404; traversal/absolute/hidden/root 400
//   invalid_path; symlink 400 symlink_not_allowed; wrong kind 409
//   wrong_kind; permanent=true 400 invalid_query (2.8, 8.5, 8.6).
// - Deleted event: revision and modifiedAt null (9.3), published
//   for media too (7.6). Purge publishes no event (5.2).

import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRevision, contentHash } from '../src/lib/revision.js';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../src/plugins/envelope.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import { registerRequestId, requestIdFromHeaders } from '../src/plugins/request-id.js';
import { createV304aWritePorts } from '../src/services/workspace/write-adapter.js';
import {
  buildDeletedEvent,
  buildIndexSoftDelete,
  classifyMediaPath,
  inspectMediaDeleteTarget,
  MEDIA_DELETE_CONSEQUENCES,
  MEDIA_PURGE_CONSEQUENCES,
  rejectPermanentDeleteQuery,
  type MediaDeletePorts,
} from '../src/services/workspace/media-delete.js';

const TEST_WORKSPACE_KEY = 'test-workspace-key';
const TEST_ORIGIN = 'https://app.example.invalid';
const TEST_PRINCIPAL: SessionPrincipal = {
  userId: '00000000-0000-4000-8000-000000000002',
  role: 'user',
  sessionId: 'good-session',
};
const AUTH_HEADERS = {
  cookie: 'notegen_session=good-session',
  origin: TEST_ORIGIN,
  'x-csrf-token': 'good-csrf',
} as const;

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

let root: string | undefined;
let ports: MediaDeletePorts | undefined;
let app: FastifyInstance | undefined;

async function seed(relPath: string, content: Buffer | string): Promise<void> {
  const absolute = join(root as string, relPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function setupPorts(): Promise<{ root: string; ports: MediaDeletePorts }> {
  const dir = await mkdtemp(join(tmpdir(), 'notegen-media-delete-'));
  root = dir;
  ports = createV304aWritePorts(dir, TEST_WORKSPACE_KEY);
  return { root: dir, ports };
}

// Test-only harness: the DELETE file shape the trash route (V3-05c)
// will own, reduced to seam inspection only. It performs no trash
// move and no mutation, so these specs pin auth + validation + the
// plan without duplicating the trash route.
async function setupHarness(): Promise<{ root: string; app: FastifyInstance }> {
  const { root: dir, ports: harnessPorts } = await setupPorts();
  const instance = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });
  registerRequestId(instance);
  registerErrorHandling(instance, { version: 'test' });
  registerAuthHooks(instance, {
    verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? TEST_PRINCIPAL : null),
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
    canonicalOrigin: TEST_ORIGIN,
  });
  instance.delete(
    '/api/workspace/file',
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const query = request.query as Record<string, unknown>;
      rejectPermanentDeleteQuery(query['permanent']);
      const plan = await inspectMediaDeleteTarget(harnessPorts, query['path'], 'file');
      return successEnvelope({
        path: plan.path,
        kind: plan.kind,
        size: plan.size,
        revision: plan.revision,
        mediaKind: plan.media?.kind ?? null,
        mediaUrl: plan.mediaUrl,
      });
    },
  );
  await instance.ready();
  app = instance;
  return { root: dir, app: instance };
}

beforeEach(() => {
  root = undefined;
  ports = undefined;
  app = undefined;
});

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
  ports = undefined;
});

async function expectApiError(
  promise: Promise<unknown>,
  statusCode: number,
  code: string,
): Promise<void> {
  try {
    await promise;
    expect.unreachable('expected the promise to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(statusCode);
    expect((error as ApiError).code).toBe(code);
  }
}

describe('inspectMediaDeleteTarget: media file happy path', () => {
  it('plans a PNG delete with the binary revision, classification, and media URL', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('assets/pic.png', PNG_BYTES);
    const plan = await inspectMediaDeleteTarget(testPorts, 'assets/pic.png', 'file');
    expect(plan.path).toBe('assets/pic.png');
    expect(plan.kind).toBe('file');
    expect(plan.size).toBe(PNG_BYTES.length);
    expect(plan.revision).toBe(buildRevision(TEST_WORKSPACE_KEY, 'assets/pic.png', PNG_BYTES));
    expect(plan.contentHash).toBe(contentHash(PNG_BYTES));
    expect(plan.media).toEqual({
      kind: 'media',
      extension: '.png',
      detectedType: 'png',
      mimeType: 'image/png',
      disposition: 'inline',
    });
    expect(plan.mediaUrl).toBe('/api/workspace/media/assets/pic.png');
    expect(plan.consequences).toEqual(MEDIA_DELETE_CONSEQUENCES);
    // Inspection mutates nothing: the file is still on disk for the
    // trash route to move.
    expect((await lstat(join(root as string, 'assets/pic.png'))).isFile()).toBe(true);
    expect(await readFile(join(root as string, 'assets/pic.png'))).toEqual(PNG_BYTES);
  });

  it('classifies SVG as attachment + octet-stream, never inline', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('assets/draw.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'));
    const plan = await inspectMediaDeleteTarget(testPorts, 'assets/draw.svg', 'file');
    expect(plan.media?.kind).toBe('media');
    expect(plan.media?.detectedType).toBe('svg');
    expect(plan.media?.mimeType).toBe('application/octet-stream');
    expect(plan.media?.disposition).toBe('attachment');
  });

  it('encodes media URL segments for names with spaces', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('assets/my pic.png', PNG_BYTES);
    const plan = await inspectMediaDeleteTarget(testPorts, 'assets/my pic.png', 'file');
    expect(plan.mediaUrl).toBe('/api/workspace/media/assets/my%20pic.png');
  });
});

describe('inspectMediaDeleteTarget: no media-kind rejection', () => {
  it('does not reject a Markdown file: it classifies as text and stays deletable', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('notes/one.md', '# hello\n');
    const plan = await inspectMediaDeleteTarget(testPorts, 'notes/one.md', 'file');
    expect(plan.kind).toBe('file');
    expect(plan.media?.kind).toBe('text');
    expect(plan.media?.mimeType).toBe('text/markdown');
    expect(plan.revision).toBe(
      buildRevision(TEST_WORKSPACE_KEY, 'notes/one.md', Buffer.from('# hello\n', 'utf8')),
    );
  });

  it('does not reject an unknown extension', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('data/blob.xyz', Buffer.from([0x01, 0x02, 0x03, 0x04]));
    const plan = await inspectMediaDeleteTarget(testPorts, 'data/blob.xyz', 'file');
    expect(plan.media?.kind).toBe('other');
    expect(plan.media?.detectedType).toBe('unknown');
    expect(plan.media?.mimeType).toBe('application/octet-stream');
  });

  it('does not reject a magic mismatch: bytes win for classification, delete still proceeds', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('assets/wrong.png', JPEG_BYTES);
    const plan = await inspectMediaDeleteTarget(testPorts, 'assets/wrong.png', 'file');
    expect(plan.media?.kind).toBe('media');
    expect(plan.media?.extension).toBe('.png');
    expect(plan.media?.detectedType).toBe('jpeg');
    expect(plan.media?.mimeType).toBe('image/jpeg');
  });

  it('does not trust the extension when bytes match no signature: octet-stream, still deletable', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('assets/broken.png', Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]));
    const plan = await inspectMediaDeleteTarget(testPorts, 'assets/broken.png', 'file');
    expect(plan.media?.kind).toBe('media');
    expect(plan.media?.detectedType).toBe('unknown');
    expect(plan.media?.mimeType).toBe('application/octet-stream');
    expect(plan.media?.disposition).toBe('attachment');
  });

  it('does not reject an HTML file: it classifies as other with octet-stream serving facts', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('assets/page.html', '<!doctype html><html></html>');
    const plan = await inspectMediaDeleteTarget(testPorts, 'assets/page.html', 'file');
    expect(plan.media?.kind).toBe('other');
    expect(plan.media?.detectedType).toBe('html');
    expect(plan.media?.mimeType).toBe('application/octet-stream');
    expect(plan.media?.disposition).toBe('attachment');
  });

  it('serves an SVG extension as octet-stream even when the bytes are a PNG', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('assets/fake.svg', PNG_BYTES);
    const plan = await inspectMediaDeleteTarget(testPorts, 'assets/fake.svg', 'file');
    expect(plan.media?.kind).toBe('media');
    expect(plan.media?.detectedType).toBe('png');
    expect(plan.media?.mimeType).toBe('application/octet-stream');
    expect(plan.media?.disposition).toBe('attachment');
  });

  it('classifies by extension alone when no bytes are supplied', () => {
    expect(classifyMediaPath('assets/pic.png')).toEqual({
      kind: 'media',
      extension: '.png',
      detectedType: null,
      mimeType: 'image/png',
      disposition: 'inline',
    });
    expect(classifyMediaPath('notes/one.md').kind).toBe('text');
    expect(classifyMediaPath('data/blob.xyz')).toEqual({
      kind: 'other',
      extension: '.xyz',
      detectedType: null,
      mimeType: null,
      disposition: null,
    });
  });
});

describe('inspectMediaDeleteTarget: errors', () => {
  it('answers 404 for a missing file', async () => {
    const { ports: testPorts } = await setupPorts();
    await expectApiError(inspectMediaDeleteTarget(testPorts, 'assets/gone.png', 'file'), 404, 'not_found');
  });

  it('answers 400 for traversal, absolute, backslash, empty, and root paths', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('assets/pic.png', PNG_BYTES);
    for (const bad of ['../secret.png', 'assets/../secret.png', '/etc/passwd', 'C:\\pic.png', 'assets\\pic.png', '', 'assets//pic.png', 'assets/pic.png/']) {
      await expectApiError(inspectMediaDeleteTarget(testPorts, bad, 'file'), 400, 'invalid_path');
    }
  });

  it('answers 400 for non-string paths', async () => {
    const { ports: testPorts } = await setupPorts();
    await expectApiError(inspectMediaDeleteTarget(testPorts, 42, 'file'), 400, 'invalid_path');
    await expectApiError(inspectMediaDeleteTarget(testPorts, null, 'file'), 400, 'invalid_path');
  });

  it('answers 400 for hidden paths (write semantics)', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('.hidden.png', PNG_BYTES);
    await seed('.git/config.png', PNG_BYTES);
    await expectApiError(inspectMediaDeleteTarget(testPorts, '.hidden.png', 'file'), 400, 'invalid_path');
    await expectApiError(inspectMediaDeleteTarget(testPorts, '.git/config.png', 'file'), 400, 'invalid_path');
  });

  it('answers 400 for a symlink target and for a symlinked parent component', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('assets/real.png', PNG_BYTES);
    await symlink(join(root as string, 'assets/real.png'), join(root as string, 'assets/link.png'));
    await expectApiError(
      inspectMediaDeleteTarget(testPorts, 'assets/link.png', 'file'),
      400,
      'symlink_not_allowed',
    );
    await mkdir(join(root as string, 'outside'), { recursive: true });
    await seed('outside/pic.png', PNG_BYTES);
    await symlink(join(root as string, 'outside'), join(root as string, 'linked-dir'));
    await expectApiError(
      inspectMediaDeleteTarget(testPorts, 'linked-dir/pic.png', 'file'),
      400,
      'symlink_not_allowed',
    );
  });

  it('answers 409 wrong_kind when the kind does not match', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('assets/pic.png', PNG_BYTES);
    await mkdir(join(root as string, 'assets/folder'), { recursive: true });
    await expectApiError(inspectMediaDeleteTarget(testPorts, 'assets/folder', 'file'), 409, 'wrong_kind');
    await expectApiError(inspectMediaDeleteTarget(testPorts, 'assets/pic.png', 'folder'), 409, 'wrong_kind');
  });

  it('plans a folder delete with null revision, size, and media facts', async () => {
    const { ports: testPorts } = await setupPorts();
    await mkdir(join(root as string, 'assets/folder'), { recursive: true });
    await seed('assets/folder/inner.png', PNG_BYTES);
    const plan = await inspectMediaDeleteTarget(testPorts, 'assets/folder', 'folder');
    expect(plan).toEqual({
      path: 'assets/folder',
      kind: 'folder',
      size: null,
      modifiedAt: null,
      revision: null,
      contentHash: null,
      media: null,
      mediaUrl: null,
      consequences: MEDIA_DELETE_CONSEQUENCES,
    });
  });
});

describe('rejectPermanentDeleteQuery', () => {
  it('rejects permanent=true with 400 invalid_query and passes anything else', () => {
    expect(() => rejectPermanentDeleteQuery('true')).toThrowError(
      expect.objectContaining({ statusCode: 400, code: 'invalid_query' }),
    );
    expect(() => rejectPermanentDeleteQuery(undefined)).not.toThrow();
    expect(() => rejectPermanentDeleteQuery('false')).not.toThrow();
  });
});

describe('delete consequence builders', () => {
  it('builds a deleted event with null revision and modifiedAt for a media file', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('assets/pic.png', PNG_BYTES);
    const plan = await inspectMediaDeleteTarget(testPorts, 'assets/pic.png', 'file');
    expect(buildDeletedEvent(plan)).toEqual({
      kind: 'deleted',
      path: 'assets/pic.png',
      previousPath: null,
      revision: null,
      modifiedAt: null,
      isDirectory: false,
    });
  });

  it('builds a deleted event with isDirectory true for a folder', async () => {
    const { ports: testPorts } = await setupPorts();
    await mkdir(join(root as string, 'assets/folder'), { recursive: true });
    const plan = await inspectMediaDeleteTarget(testPorts, 'assets/folder', 'folder');
    expect(buildDeletedEvent(plan).isDirectory).toBe(true);
  });

  it('builds the index soft-delete input with the trash link and media mime type', async () => {
    const { ports: testPorts } = await setupPorts();
    await seed('assets/pic.png', PNG_BYTES);
    const plan = await inspectMediaDeleteTarget(testPorts, 'assets/pic.png', 'file');
    expect(
      buildIndexSoftDelete(plan, {
        workspaceId: 'ws-1',
        trashId: '3f8a2c1e-0000-4000-8000-000000000001',
        deletedAt: '2026-11-14T13:10:00.000Z',
      }),
    ).toEqual({
      workspaceId: 'ws-1',
      path: 'assets/pic.png',
      kind: 'file',
      trashId: '3f8a2c1e-0000-4000-8000-000000000001',
      deletedAt: '2026-11-14T13:10:00.000Z',
      revision: plan.revision,
      sizeBytes: PNG_BYTES.length,
      mimeType: 'image/png',
    });
  });

  it('states the purge consequences: no event, row removed or tombstoned, blob never served', () => {
    expect(MEDIA_PURGE_CONSEQUENCES).toEqual({
      workspaceEvent: null,
      indexAction: 'remove-or-tombstone',
      trashBlobServedViaMedia: false,
    });
    expect(MEDIA_DELETE_CONSEQUENCES).toEqual({
      publishesDeletedEvent: true,
      indexSoftDelete: true,
      markdownRefsRewritten: false,
      trashBlobServedViaMedia: false,
      purgePublishesEvent: false,
    });
  });
});

describe('DELETE /api/workspace/file harness: auth and envelope mapping', () => {
  it('answers 401 unauthenticated without a session', async () => {
    const { app: harness } = await setupHarness();
    await seed('assets/pic.png', PNG_BYTES);
    const res = await harness.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=assets%2Fpic.png',
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('unauthenticated');
  });

  it('answers 403 without a CSRF token and without a matching Origin', async () => {
    const { app: harness } = await setupHarness();
    await seed('assets/pic.png', PNG_BYTES);
    const noCsrf = await harness.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=assets%2Fpic.png',
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect((noCsrf.json() as { error: { code: string } }).error.code).toBe('csrf_invalid');
    const badOrigin = await harness.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=assets%2Fpic.png',
      headers: { ...AUTH_HEADERS, origin: 'https://evil.example.invalid' },
    });
    expect(badOrigin.statusCode).toBe(403);
    expect((badOrigin.json() as { error: { code: string } }).error.code).toBe('origin_rejected');
  });

  it('answers 200 with the plan for an authenticated media delete inspection', async () => {
    const { app: harness } = await setupHarness();
    await seed('assets/pic.png', PNG_BYTES);
    const res = await harness.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=assets%2Fpic.png',
      headers: { ...AUTH_HEADERS },
    });
    expect(res.statusCode).toBe(200);
    const data = (res.json() as { data: Record<string, unknown> }).data;
    expect(data['path']).toBe('assets/pic.png');
    expect(data['mediaKind']).toBe('media');
    expect(data['mediaUrl']).toBe('/api/workspace/media/assets/pic.png');
    expect(data['revision']).toBe(buildRevision(TEST_WORKSPACE_KEY, 'assets/pic.png', PNG_BYTES));
  });

  it('maps missing, traversal, and permanent=true through the envelope', async () => {
    const { app: harness } = await setupHarness();
    await seed('assets/pic.png', PNG_BYTES);
    const missing = await harness.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=assets%2Fgone.png',
      headers: { ...AUTH_HEADERS },
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe('not_found');
    const traversal = await harness.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=..%2Fsecret.png',
      headers: { ...AUTH_HEADERS },
    });
    expect(traversal.statusCode).toBe(400);
    expect((traversal.json() as { error: { code: string } }).error.code).toBe('invalid_path');
    const permanent = await harness.inject({
      method: 'DELETE',
      url: '/api/workspace/file?path=assets%2Fpic.png&permanent=true',
      headers: { ...AUTH_HEADERS },
    });
    expect(permanent.statusCode).toBe(400);
    expect((permanent.json() as { error: { code: string } }).error.code).toBe('invalid_query');
  });
});
