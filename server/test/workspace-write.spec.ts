// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// HTTP contract tests for the workspace write endpoints (V3-04b):
// PUT file, append, patch, and media upload, with the amended K-03
// status rule (412 for PUT file/media, 409 for append/patch),
// the guard matrix, atomic writes, and idempotency replay.
//
// Path and revision behavior comes from the TEST DOUBLES in
// test/helpers/workspace-test-ports.ts, which implement the
// spec-faithful subset of desain-workspace-api.md. These tests pin
// the write path's behavior given those ports; the V3-04a adapter
// must keep the same wire behavior with the real modules.

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
} from '../src/middleware/auth-hook.js';
import { AUTH_HEADERS, buildWriteTestApp, errorBody, TEST_ORIGIN, TEST_PRINCIPAL } from './helpers/workspace-test-app.js';
import { createTestPorts, TEST_WORKSPACE_ID, type TestPortsBundle } from './helpers/workspace-test-ports.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
const HTML_BYTES = Buffer.from('<!doctype html><html><body>x</body></html>', 'utf8');

interface Fixture {
  app: FastifyInstance;
  root: string;
  bundle: TestPortsBundle;
}

let fixture: Fixture | undefined;

async function setup(
  overrides: Parameters<typeof buildWriteTestApp>[1] = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'notegen-write-'));
  const bundle = createTestPorts(root);
  const app = await buildWriteTestApp(bundle, overrides);
  fixture = { app, root, bundle };
  return fixture;
}

beforeEach(() => {
  fixture = undefined;
});

afterEach(async () => {
  if (fixture !== undefined) {
    await fixture.app.close();
    await rm(fixture.root, { recursive: true, force: true });
    fixture = undefined;
  }
});

async function seed(root: string, relPath: string, content: Buffer | string): Promise<void> {
  const absolute = join(root, relPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

function revisionOf(bundle: TestPortsBundle, path: string, content: Buffer | string): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return bundle.ports.revisions.compute(path, bytes);
}

function dataOf(res: { json(): unknown }): Record<string, unknown> {
  return (res.json() as { data: Record<string, unknown> }).data;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function multipartBody(
  boundary: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer | string }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) {
      header += `; filename="${part.filename}"`;
    }
    header += '\r\n';
    if (part.contentType !== undefined) {
      header += `Content-Type: ${part.contentType}\r\n`;
    }
    header += '\r\n';
    chunks.push(Buffer.from(header, 'utf8'));
    chunks.push(typeof part.data === 'string' ? Buffer.from(part.data, 'utf8') : part.data);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

describe('PUT /api/workspace/file', () => {
  it('creates a new file with If-None-Match: * and answers 201', async () => {
    const { app, root, bundle } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=notes%2Fone.md',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(201);
    const data = dataOf(res);
    const expectedRevision = revisionOf(bundle, 'notes/one.md', 'hello');
    expect(data['path']).toBe('notes/one.md');
    expect(data['revision']).toBe(expectedRevision);
    expect(data['version']).toBe(1);
    expect(data['size']).toBe(5);
    expect(data['created']).toBe(true);
    expect(res.headers['etag']).toBe(`"${expectedRevision}"`);
    expect(res.headers['x-revision']).toBe(expectedRevision);
    expect(res.headers['x-version']).toBe('1');
    expect(res.headers['last-modified']).toBeDefined();
    expect(await readFile(join(root, 'notes', 'one.md'), 'utf8')).toBe('hello');
    expect(await bundle.index.currentVersion(TEST_WORKSPACE_ID, 'notes/one.md')).toBe(1);
  });

  it('overwrites with a matching If-Match and bumps the version', async () => {
    const { app, root, bundle } = await setup();
    await seed(root, 'a.md', 'first');
    const rev = revisionOf(bundle, 'a.md', 'first');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=a.md',
      headers: { ...AUTH_HEADERS, 'if-match': `"${rev}"`, 'content-type': 'text/plain' },
      payload: 'second',
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['created']).toBe(false);
    expect(data['revision']).toBe(revisionOf(bundle, 'a.md', 'second'));
    expect(data['version']).toBe(1);
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('second');
  });

  it('answers 412 revision_conflict for a stale If-Match and leaves the bytes untouched', async () => {
    const { app, root } = await setup();
    const created = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=conf.md',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'server text',
    });
    expect(created.statusCode).toBe(201);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=conf.md',
      headers: { ...AUTH_HEADERS, 'if-match': '"sha256:stale"', 'content-type': 'text/plain' },
      payload: 'client text',
    });
    expect(res.statusCode).toBe(412);
    const error = errorBody(res);
    expect(error.code).toBe('revision_conflict');
    expect(error.details?.['path']).toBe('conf.md');
    expect(error.details?.['serverRevision']).toBe(dataOf(created)['revision']);
    expect(error.details?.['serverVersion']).toBe(1);
    expect(error.details?.['serverSize']).toBe(11);
    expect(error.details?.['currentPreview']).toBe('server text');
    expect(error.details?.['previewTruncated']).toBe(false);
    expect(error.details?.['suggestedCopyPath']).toBe('conf (salinan).md');
    expect(error.details?.['actions']).toEqual(['reload', 'saveAsCopy', 'forceOverwrite']);
    expect(await readFile(join(root, 'conf.md'), 'utf8')).toBe('server text');
  });

  it('answers 404 for If-Match on a missing file', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=missing.md',
      headers: { ...AUTH_HEADERS, 'if-match': '"sha256:anything"', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(404);
    expect(errorBody(res).code).toBe('not_found');
  });

  it('answers 409 already_exists for If-None-Match: * on an existing file', async () => {
    const { app, root } = await setup();
    await seed(root, 'exists.md', 'there');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=exists.md',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'again',
    });
    expect(res.statusCode).toBe(409);
    expect(errorBody(res).code).toBe('already_exists');
  });

  it('answers 428 when no guard is sent', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=noguard.md',
      headers: { ...AUTH_HEADERS, 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(428);
    expect(errorBody(res).code).toBe('precondition_required');
  });

  it('answers 400 invalid_precondition when both guard headers are present', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=both.md',
      headers: {
        ...AUTH_HEADERS,
        'if-match': '"sha256:x"',
        'if-none-match': '*',
        'content-type': 'text/plain',
      },
      payload: 'x',
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('invalid_precondition');
  });

  it('answers 400 invalid_precondition for an If-Match list', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=list.md',
      headers: { ...AUTH_HEADERS, 'if-match': '"a", "b"', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('invalid_precondition');
  });

  it('answers 400 invalid_precondition for an unsupported If-None-Match value', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=nonematch.md',
      headers: { ...AUTH_HEADERS, 'if-none-match': '"sha256:x"', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('invalid_precondition');
  });

  it('accepts a weak If-Match validator', async () => {
    const { app, root, bundle } = await setup();
    await seed(root, 'weak.md', 'v1');
    const rev = revisionOf(bundle, 'weak.md', 'v1');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=weak.md',
      headers: { ...AUTH_HEADERS, 'if-match': `W/"${rev}"`, 'content-type': 'text/plain' },
      payload: 'v2',
    });
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(root, 'weak.md'), 'utf8')).toBe('v2');
  });

  it('force-overwrites with If-Match: * and creates with If-Match: * on a missing file', async () => {
    const { app, root } = await setup();
    await seed(root, 'force.md', 'old');
    const overwrite = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=force.md',
      headers: { ...AUTH_HEADERS, 'if-match': '*', 'content-type': 'text/plain' },
      payload: 'new',
    });
    expect(overwrite.statusCode).toBe(200);
    expect(await readFile(join(root, 'force.md'), 'utf8')).toBe('new');
    const create = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=force-new.md',
      headers: { ...AUTH_HEADERS, 'if-match': '*', 'content-type': 'text/plain' },
      payload: 'born',
    });
    expect(create.statusCode).toBe(201);
    expect(await readFile(join(root, 'force-new.md'), 'utf8')).toBe('born');
  });

  it('rejects traversal, absolute, and dot-leading paths with invalid_path', async () => {
    const { app } = await setup();
    for (const bad of ['../escape.md', 'a/../b.md', '/abs.md', '.hidden.md', 'a/.git/x.md', '']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/workspace/file?path=${encodeURIComponent(bad)}`,
        headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
        payload: 'x',
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe('invalid_path');
    }
  });

  it('collapses repeated slashes in the path', async () => {
    const { app, root } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=a%2F%2Fb.md',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(201);
    expect(dataOf(res)['path']).toBe('a/b.md');
    expect(await readFile(join(root, 'a', 'b.md'), 'utf8')).toBe('x');
  });

  it('answers 400 invalid_path for a missing or repeated path query', async () => {
    const { app } = await setup();
    const missing = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(missing.statusCode).toBe(400);
    expect(errorBody(missing).code).toBe('invalid_path');
    const repeated = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=a.md&path=b.md',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(repeated.statusCode).toBe(400);
    expect(errorBody(repeated).code).toBe('invalid_path');
  });

  it('answers 400 invalid_path when the target is a directory', async () => {
    const { app, root } = await setup();
    await mkdir(join(root, 'dir'), { recursive: true });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=dir',
      headers: { ...AUTH_HEADERS, 'if-match': '*', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('invalid_path');
  });

  it('answers 422 invalid_text_encoding for invalid UTF-8 bytes', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=bad.md',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: Buffer.from([0xff, 0xfe, 0x41]),
    });
    expect(res.statusCode).toBe(422);
    expect(errorBody(res).code).toBe('invalid_text_encoding');
  });

  it('answers 413 text_too_large past the text limit', async () => {
    const { app } = await setup({ textLimitBytes: 16 });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=big.md',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'x'.repeat(17),
    });
    expect(res.statusCode).toBe(413);
    expect(errorBody(res).code).toBe('text_too_large');
  });

  it('answers 400 symlink_not_allowed for a symlinked target or parent', async () => {
    const { app, root } = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'notegen-outside-'));
    try {
      await writeFile(join(outside, 'secret.md'), 'outside');
      await symlink(join(outside, 'secret.md'), join(root, 'link.md'));
      const res = await app.inject({
        method: 'PUT',
        url: '/api/workspace/file?path=link.md',
        headers: { ...AUTH_HEADERS, 'if-match': '*', 'content-type': 'text/plain' },
        payload: 'x',
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe('symlink_not_allowed');
      expect(await readFile(join(outside, 'secret.md'), 'utf8')).toBe('outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('leaves no temp files behind after success and after conflict', async () => {
    const { app, root, bundle } = await setup();
    await seed(root, 'temp.md', 'one');
    const rev = revisionOf(bundle, 'temp.md', 'one');
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=temp.md',
      headers: { ...AUTH_HEADERS, 'if-match': `"${rev}"`, 'content-type': 'text/plain' },
      payload: 'two',
    });
    expect(ok.statusCode).toBe(200);
    const conflict = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=temp.md',
      headers: { ...AUTH_HEADERS, 'if-match': '"sha256:stale"', 'content-type': 'text/plain' },
      payload: 'three',
    });
    expect(conflict.statusCode).toBe(412);
    const entries = await readdir(root);
    expect(entries.filter((name) => name.startsWith('.notegen-tmp-'))).toEqual([]);
  });
});

describe('write route auth', () => {
  it('answers 401 without a session cookie', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=a.md',
      headers: { origin: 'https://app.example.invalid', 'x-csrf-token': 'good-csrf', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(401);
    expect(errorBody(res).code).toBe('unauthenticated');
  });

  it('answers 403 csrf_invalid for a bad CSRF token', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=a.md',
      headers: {
        cookie: 'notegen_session=good-session',
        origin: 'https://app.example.invalid',
        'x-csrf-token': 'stale',
        'content-type': 'text/plain',
      },
      payload: 'x',
    });
    expect(res.statusCode).toBe(403);
    expect(errorBody(res).code).toBe('csrf_invalid');
  });

  it('answers 403 origin_rejected for a wrong Origin', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=a.md',
      headers: {
        cookie: 'notegen_session=good-session',
        origin: 'https://evil.example.invalid',
        'x-csrf-token': 'good-csrf',
        'content-type': 'text/plain',
      },
      payload: 'x',
    });
    expect(res.statusCode).toBe(403);
    expect(errorBody(res).code).toBe('origin_rejected');
  });
});

describe('POST /api/workspace/file/append', () => {
  async function createViaApi(app: FastifyInstance, path: string, content: string): Promise<void> {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/workspace/file?path=${encodeURIComponent(path)}`,
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: content,
    });
    expect(res.statusCode).toBe(201);
  }

  const JSON_HEADERS = { ...AUTH_HEADERS, 'content-type': 'application/json' };

  it('appends with a matching expectedRevision and bumps the version', async () => {
    const { app, root, bundle } = await setup();
    await createViaApi(app, 'log.md', 'one\n');
    const rev = revisionOf(bundle, 'log.md', 'one\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ expectedRevision: rev, content: 'two\n' }),
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['appendedBytes']).toBe(4);
    expect(data['version']).toBe(2);
    expect(data['revision']).toBe(revisionOf(bundle, 'log.md', 'one\ntwo\n'));
    expect(await readFile(join(root, 'log.md'), 'utf8')).toBe('one\ntwo\n');
  });

  it('answers 409 revision_conflict for a stale expectedRevision', async () => {
    const { app, root } = await setup();
    await createViaApi(app, 'log.md', 'one\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ expectedRevision: 'sha256:stale', content: 'two\n' }),
    });
    expect(res.statusCode).toBe(409);
    const error = errorBody(res);
    expect(error.code).toBe('revision_conflict');
    expect(error.details?.['failedOperation']).toBe('append');
    expect(error.details?.['currentPreview']).toBe('one\n');
    expect(await readFile(join(root, 'log.md'), 'utf8')).toBe('one\n');
  });

  it('answers 400 validation_failed when no guard is sent', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ content: 'x' }),
    });
    expect(res.statusCode).toBe(400);
    const error = errorBody(res);
    expect(error.code).toBe('validation_failed');
    expect(error.details?.['fields']).toEqual([{ field: 'expectedRevision', issue: 'required unless force is true' }]);
  });

  it('appends with force despite a stale revision', async () => {
    const { app, root } = await setup();
    await createViaApi(app, 'log.md', 'one\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ expectedRevision: 'sha256:stale', force: true, content: 'two\n' }),
    });
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(root, 'log.md'), 'utf8')).toBe('one\ntwo\n');
  });

  it('answers 404 for a missing file or a directory', async () => {
    const { app, root } = await setup();
    await mkdir(join(root, 'dir'), { recursive: true });
    for (const path of ['missing.md', 'dir']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspace/file/append?path=${path}`,
        headers: JSON_HEADERS,
        payload: JSON.stringify({ expectedRevision: 'sha256:x', content: 'x' }),
      });
      expect(res.statusCode).toBe(404);
      expect(errorBody(res).code).toBe('not_found');
    }
  });

  it('treats an empty append as a no-op: same revision, no version bump, no event', async () => {
    const { app, root, bundle } = await setup({
      sinkOptions: { coalesceWindowMs: 5, maxDelayMs: 10 },
    });
    await createViaApi(app, 'log.md', 'one\n');
    await sleep(30);
    bundle.events.all.length = 0;
    bundle.events.batches.length = 0;
    const rev = revisionOf(bundle, 'log.md', 'one\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ expectedRevision: rev, content: '' }),
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['appendedBytes']).toBe(0);
    expect(data['revision']).toBe(rev);
    expect(data['version']).toBe(1);
    await sleep(30);
    expect(bundle.events.all).toEqual([]);
    expect(await readFile(join(root, 'log.md'), 'utf8')).toBe('one\n');
  });

  it('answers 400 validation_failed for unknown fields and wrong-typed content', async () => {
    const { app } = await setup();
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ expectedRevision: 'sha256:x', content: 'x', workspaceId: 'nope' }),
    });
    expect(unknown.statusCode).toBe(400);
    expect(errorBody(unknown).code).toBe('validation_failed');
    expect(errorBody(unknown).details?.['fields']).toEqual([{ field: 'workspaceId', issue: 'unknown field' }]);
    const wrongType = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ expectedRevision: 'sha256:x', content: 42 }),
    });
    expect(wrongType.statusCode).toBe(400);
    expect(errorBody(wrongType).code).toBe('validation_failed');
    expect(errorBody(wrongType).details?.['fields']).toEqual([{ field: 'content', issue: 'expected a string' }]);
  });

  it('answers 400 invalid_json for a non-object JSON body', async () => {
    const { app } = await setup();
    const array = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers: JSON_HEADERS,
      payload: '[1, 2]',
    });
    expect(array.statusCode).toBe(400);
    expect(errorBody(array).code).toBe('invalid_json');
  });

  it('answers 400 for a malformed JSON body (frozen-mapper gap, see report)', async () => {
    // NOTE: the contract wants invalid_json here, but Fastify 5.6
    // emits FST_ERR_CTP_INVALID_JSON_BODY, which the frozen
    // toErrorEnvelope does not recognize (it checks
    // FST_ERR_CTP_INVALID_JSON_CONTENT), so the generic 4xx branch
    // answers validation_failed. The mapper is frozen middleware
    // (AD-40) and is not this worker's to fix; the gap is flagged
    // in the V3-04b report for the foundation worker. This test
    // pins the actual wire behavior so the fix, when it lands, is
    // a visible test change.
    const { app } = await setup();
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers: JSON_HEADERS,
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(400);
    expect(errorBody(malformed).code).toBe('validation_failed');
  });

  it('accepts and ignores expectedModifiedAt', async () => {
    const { app, bundle } = await setup();
    await createViaApi(app, 'log.md', 'one\n');
    const rev = revisionOf(bundle, 'log.md', 'one\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({
        expectedRevision: rev,
        content: 'two\n',
        expectedModifiedAt: '2000-01-01T00:00:00.000Z',
      }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('replays an identical idempotent request without a second write', async () => {
    const { app, root, bundle } = await setup();
    await createViaApi(app, 'log.md', 'one\n');
    const rev = revisionOf(bundle, 'log.md', 'one\n');
    const headers = { ...JSON_HEADERS, 'idempotency-key': 'key-1' };
    const payload = JSON.stringify({ expectedRevision: rev, content: 'two\n' });
    const first = await app.inject({ method: 'POST', url: '/api/workspace/file/append?path=log.md', headers, payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/api/workspace/file/append?path=log.md', headers, payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await bundle.index.currentVersion(TEST_WORKSPACE_ID, 'log.md')).toBe(2);
    expect(await readFile(join(root, 'log.md'), 'utf8')).toBe('one\ntwo\n');
  });

  it('answers 409 idempotency_key_reused when the same key carries a different request', async () => {
    const { app, bundle } = await setup();
    await createViaApi(app, 'log.md', 'one\n');
    const rev = revisionOf(bundle, 'log.md', 'one\n');
    const headers = { ...JSON_HEADERS, 'idempotency-key': 'key-2' };
    const first = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers,
      payload: JSON.stringify({ expectedRevision: rev, content: 'two\n' }),
    });
    expect(first.statusCode).toBe(200);
    const reused = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers,
      payload: JSON.stringify({ expectedRevision: rev, content: 'THREE\n' }),
    });
    expect(reused.statusCode).toBe(409);
    expect(errorBody(reused).code).toBe('idempotency_key_reused');
  });

  it('answers 400 validation_failed for an overlong idempotency key', async () => {
    const { app, bundle } = await setup();
    await createViaApi(app, 'log.md', 'one\n');
    const rev = revisionOf(bundle, 'log.md', 'one\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=log.md',
      headers: { ...JSON_HEADERS, 'idempotency-key': 'k'.repeat(129) },
      payload: JSON.stringify({ expectedRevision: rev, content: 'two\n' }),
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('validation_failed');
  });
});

describe('POST /api/workspace/file/patch', () => {
  async function createViaApi(app: FastifyInstance, path: string, content: string): Promise<void> {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/workspace/file?path=${encodeURIComponent(path)}`,
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: content,
    });
    expect(res.statusCode).toBe(201);
  }

  const JSON_HEADERS = { ...AUTH_HEADERS, 'content-type': 'application/json' };

  it('replaces a line range verbatim and reports patchedLines', async () => {
    const { app, root, bundle } = await setup();
    await createViaApi(app, 'doc.md', 'a\nb\nc\n');
    const rev = revisionOf(bundle, 'doc.md', 'a\nb\nc\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/patch?path=doc.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ expectedRevision: rev, startLine: 2, endLine: 3, replacement: 'B1\nB2\n' }),
    });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)['patchedLines']).toBe(1);
    expect(await readFile(join(root, 'doc.md'), 'utf8')).toBe('a\nB1\nB2\nc\n');
  });

  it('preserves CRLF line endings outside the patched range', async () => {
    const { app, root, bundle } = await setup();
    await createViaApi(app, 'crlf.md', 'a\r\nb\r\nc\r\n');
    const rev = revisionOf(bundle, 'crlf.md', 'a\r\nb\r\nc\r\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/patch?path=crlf.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ expectedRevision: rev, startLine: 2, endLine: 3, replacement: 'B\r\n' }),
    });
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(root, 'crlf.md'), 'utf8')).toBe('a\r\nB\r\nc\r\n');
  });

  it('inserts at the end with startLine == lineCount + 1', async () => {
    const { app, root, bundle } = await setup();
    await createViaApi(app, 'doc.md', 'a\nb\n');
    const rev = revisionOf(bundle, 'doc.md', 'a\nb\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/patch?path=doc.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ expectedRevision: rev, startLine: 3, endLine: 3, replacement: 'c\n' }),
    });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)['patchedLines']).toBe(0);
    expect(await readFile(join(root, 'doc.md'), 'utf8')).toBe('a\nb\nc\n');
  });

  it('inserts into an empty file at line 1', async () => {
    const { app, root, bundle } = await setup();
    await createViaApi(app, 'empty.md', '');
    const rev = revisionOf(bundle, 'empty.md', '');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/patch?path=empty.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ expectedRevision: rev, startLine: 1, endLine: 1, replacement: 'first\n' }),
    });
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(root, 'empty.md'), 'utf8')).toBe('first\n');
  });

  it('answers 400 invalid_patch_range outside the file', async () => {
    const { app, bundle } = await setup();
    await createViaApi(app, 'doc.md', 'a\nb\n');
    const rev = revisionOf(bundle, 'doc.md', 'a\nb\n');
    for (const range of [
      { startLine: 0, endLine: 1 },
      { startLine: 5, endLine: 5 },
      { startLine: 2, endLine: 1 },
      { startLine: 1, endLine: 5 },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/patch?path=doc.md',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ expectedRevision: rev, ...range, replacement: 'x' }),
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe('invalid_patch_range');
    }
  });

  it('answers 409 revision_conflict for a stale guard with failedOperation patch', async () => {
    const { app } = await setup();
    await createViaApi(app, 'doc.md', 'a\nb\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/patch?path=doc.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ expectedRevision: 'sha256:stale', startLine: 1, endLine: 2, replacement: 'x\n' }),
    });
    expect(res.statusCode).toBe(409);
    expect(errorBody(res).code).toBe('revision_conflict');
    expect(errorBody(res).details?.['failedOperation']).toBe('patch');
  });

  it('patches with force and answers 404 for a missing file', async () => {
    const { app, root } = await setup();
    await createViaApi(app, 'doc.md', 'a\nb\n');
    const forced = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/patch?path=doc.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ force: true, startLine: 1, endLine: 2, replacement: 'A\n' }),
    });
    expect(forced.statusCode).toBe(200);
    expect(await readFile(join(root, 'doc.md'), 'utf8')).toBe('A\nb\n');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/patch?path=nope.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ force: true, startLine: 1, endLine: 1, replacement: 'x' }),
    });
    expect(missing.statusCode).toBe(404);
    expect(errorBody(missing).code).toBe('not_found');
  });

  it('answers 400 validation_failed for non-integer line numbers', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/patch?path=doc.md',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ force: true, startLine: 1.5, endLine: 2, replacement: 'x' }),
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('validation_failed');
    expect(errorBody(res).details?.['fields']).toEqual([{ field: 'startLine', issue: 'expected an integer' }]);
  });
});

describe('POST /api/workspace/media', () => {
  const BOUNDARY = 'test-boundary-1';

  async function upload(
    app: FastifyInstance,
    parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer | string }>,
    extraHeaders: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/workspace/media',
      headers: {
        ...AUTH_HEADERS,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        ...extraHeaders,
      },
      payload: multipartBody(BOUNDARY, parts),
    });
  }

  it('uploads a PNG with a header guard and answers 201', async () => {
    const { app, root } = await setup();
    const res = await upload(
      app,
      [
        { name: 'path', data: 'media/pic.png' },
        { name: 'file', filename: 'pic.png', contentType: 'image/png', data: PNG_BYTES },
      ],
      { 'if-none-match': '*' },
    );
    expect(res.statusCode).toBe(201);
    const data = dataOf(res);
    expect(data['path']).toBe('media/pic.png');
    expect(data['detectedType']).toBe('png');
    expect(data['mimeType']).toBe('image/png');
    expect(data['disposition']).toBe('inline');
    expect(data['mediaUrl']).toBe('/api/workspace/media/media/pic.png');
    expect(data['size']).toBe(PNG_BYTES.length);
    expect(await readFile(join(root, 'media', 'pic.png'))).toEqual(PNG_BYTES);
  });

  it('answers 415 with details when the extension mismatches the magic bytes', async () => {
    const { app } = await setup();
    const res = await upload(
      app,
      [
        { name: 'path', data: 'media/fake.png' },
        { name: 'file', filename: 'fake.png', contentType: 'image/png', data: JPEG_BYTES },
      ],
      { 'if-none-match': '*' },
    );
    expect(res.statusCode).toBe(415);
    const error = errorBody(res);
    expect(error.code).toBe('unsupported_media_type');
    expect(error.details?.['extension']).toBe('.png');
    expect(error.details?.['detectedType']).toBe('jpeg');
  });

  it('rejects HTML extensions and detected HTML with 415', async () => {
    const { app } = await setup();
    const byExt = await upload(
      app,
      [
        { name: 'path', data: 'media/page.html' },
        { name: 'file', filename: 'page.html', contentType: 'text/html', data: Buffer.from('plain text', 'utf8') },
      ],
      { 'if-none-match': '*' },
    );
    expect(byExt.statusCode).toBe(415);
    expect(errorBody(byExt).code).toBe('unsupported_media_type');
    const byMagic = await upload(
      app,
      [
        { name: 'path', data: 'media/page.bin' },
        { name: 'file', filename: 'page.bin', contentType: 'application/octet-stream', data: HTML_BYTES },
      ],
      { 'if-none-match': '*' },
    );
    expect(byMagic.statusCode).toBe(415);
    expect(errorBody(byMagic).code).toBe('unsupported_media_type');
  });

  it('stores SVG as attachment with octet-stream, and rejects a non-SVG .svg', async () => {
    const { app } = await setup();
    const ok = await upload(
      app,
      [
        { name: 'path', data: 'media/icon.svg' },
        { name: 'file', filename: 'icon.svg', contentType: 'image/svg+xml', data: SVG_BYTES },
      ],
      { 'if-none-match': '*' },
    );
    expect(ok.statusCode).toBe(201);
    expect(dataOf(ok)['detectedType']).toBe('svg');
    expect(dataOf(ok)['mimeType']).toBe('application/octet-stream');
    expect(dataOf(ok)['disposition']).toBe('attachment');
    const bad = await upload(
      app,
      [
        { name: 'path', data: 'media/fake.svg' },
        { name: 'file', filename: 'fake.svg', contentType: 'image/svg+xml', data: PNG_BYTES },
      ],
      { 'if-none-match': '*' },
    );
    expect(bad.statusCode).toBe(415);
    expect(errorBody(bad).code).toBe('unsupported_media_type');
  });

  it('stores unknown extensions with unknown magic as octet-stream attachment', async () => {
    const { app } = await setup();
    const res = await upload(
      app,
      [
        { name: 'path', data: 'media/blob.xyz' },
        { name: 'file', filename: 'blob.xyz', contentType: 'application/octet-stream', data: Buffer.from([1, 2, 3, 4]) },
      ],
      { 'if-none-match': '*' },
    );
    expect(res.statusCode).toBe(201);
    expect(dataOf(res)['detectedType']).toBe('unknown');
    expect(dataOf(res)['mimeType']).toBe('application/octet-stream');
    expect(dataOf(res)['disposition']).toBe('attachment');
  });

  it('answers 415 for a .md upload with invalid UTF-8', async () => {
    const { app } = await setup();
    const res = await upload(
      app,
      [
        { name: 'path', data: 'media/bad.md' },
        { name: 'file', filename: 'bad.md', contentType: 'text/markdown', data: Buffer.from([0xff, 0xfe]) },
      ],
      { 'if-none-match': '*' },
    );
    expect(res.statusCode).toBe(415);
    expect(errorBody(res).code).toBe('unsupported_media_type');
  });

  it('answers 400 invalid_upload for a missing path field or extra files', async () => {
    const { app } = await setup();
    const noPath = await upload(
      app,
      [{ name: 'file', filename: 'pic.png', contentType: 'image/png', data: PNG_BYTES }],
      { 'if-none-match': '*' },
    );
    expect(noPath.statusCode).toBe(400);
    expect(errorBody(noPath).code).toBe('invalid_upload');
    const twoFiles = await upload(
      app,
      [
        { name: 'path', data: 'media/pic.png' },
        { name: 'file', filename: 'a.png', contentType: 'image/png', data: PNG_BYTES },
        { name: 'file', filename: 'b.png', contentType: 'image/png', data: PNG_BYTES },
      ],
      { 'if-none-match': '*' },
    );
    expect(twoFiles.statusCode).toBe(400);
    expect(errorBody(twoFiles).code).toBe('invalid_upload');
  });

  it('answers 400 invalid_upload for a non-multipart body', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/media',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'not multipart',
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('invalid_upload');
  });

  it('accepts a guard from the body field and rejects header/body disagreement', async () => {
    const { app, root, bundle } = await setup();
    await seed(root, 'media/pic.png', PNG_BYTES);
    const rev = revisionOf(bundle, 'media/pic.png', PNG_BYTES);
    const viaBody = await upload(app, [
      { name: 'path', data: 'media/pic.png' },
      { name: 'ifMatch', data: rev },
      { name: 'file', filename: 'pic.png', contentType: 'image/png', data: PNG_BYTES },
    ]);
    expect(viaBody.statusCode).toBe(200);
    const disagree = await upload(
      app,
      [
        { name: 'path', data: 'media/pic.png' },
        { name: 'ifMatch', data: 'sha256:other' },
        { name: 'file', filename: 'pic.png', contentType: 'image/png', data: PNG_BYTES },
      ],
      { 'if-match': `"${rev}"` },
    );
    expect(disagree.statusCode).toBe(400);
    expect(errorBody(disagree).code).toBe('invalid_precondition');
    const bothBody = await upload(app, [
      { name: 'path', data: 'media/pic.png' },
      { name: 'ifMatch', data: rev },
      { name: 'ifNoneMatch', data: '*' },
      { name: 'file', filename: 'pic.png', contentType: 'image/png', data: PNG_BYTES },
    ]);
    expect(bothBody.statusCode).toBe(400);
    expect(errorBody(bothBody).code).toBe('invalid_precondition');
  });

  it('answers 412 for a stale media guard and 428 when no guard is sent', async () => {
    const { app, root } = await setup();
    await seed(root, 'media/pic.png', PNG_BYTES);
    const stale = await upload(
      app,
      [
        { name: 'path', data: 'media/pic.png' },
        { name: 'file', filename: 'pic.png', contentType: 'image/png', data: PNG_BYTES },
      ],
      { 'if-match': '"sha256:stale"' },
    );
    expect(stale.statusCode).toBe(412);
    expect(errorBody(stale).code).toBe('revision_conflict');
    expect(errorBody(stale).details?.['currentPreview']).toBeNull();
    const noGuard = await upload(app, [
      { name: 'path', data: 'media/other.png' },
      { name: 'file', filename: 'other.png', contentType: 'image/png', data: PNG_BYTES },
    ]);
    expect(noGuard.statusCode).toBe(428);
    expect(errorBody(noGuard).code).toBe('precondition_required');
  });

  it('answers 413 media_too_large past the media limit', async () => {
    const { app } = await setup({ mediaLimitBytes: 16 });
    const res = await upload(
      app,
      [
        { name: 'path', data: 'media/big.png' },
        { name: 'file', filename: 'big.png', contentType: 'image/png', data: Buffer.concat([PNG_BYTES, Buffer.alloc(64)]) },
      ],
      { 'if-none-match': '*' },
    );
    expect(res.statusCode).toBe(413);
    expect(errorBody(res).code).toBe('media_too_large');
  });
});

describe('PUT /api/workspace/media', () => {
  it('uploads raw bytes with a header guard and answers 201', async () => {
    const { app, root } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/media?path=media/raw.png',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'application/octet-stream' },
      payload: PNG_BYTES,
    });
    expect(res.statusCode).toBe(201);
    expect(dataOf(res)['detectedType']).toBe('png');
    expect(dataOf(res)['disposition']).toBe('inline');
    expect(await readFile(join(root, 'media', 'raw.png'))).toEqual(PNG_BYTES);
  });

  it('answers 412 for a stale guard and 400 invalid_path for a directory', async () => {
    const { app, root } = await setup();
    await seed(root, 'media/pic.png', PNG_BYTES);
    await mkdir(join(root, 'media', 'dir'), { recursive: true });
    const stale = await app.inject({
      method: 'PUT',
      url: '/api/workspace/media?path=media/pic.png',
      headers: { ...AUTH_HEADERS, 'if-match': '"sha256:stale"', 'content-type': 'application/octet-stream' },
      payload: PNG_BYTES,
    });
    expect(stale.statusCode).toBe(412);
    expect(errorBody(stale).code).toBe('revision_conflict');
    const dir = await app.inject({
      method: 'PUT',
      url: '/api/workspace/media?path=media/dir',
      headers: { ...AUTH_HEADERS, 'if-match': '*', 'content-type': 'application/octet-stream' },
      payload: PNG_BYTES,
    });
    expect(dir.statusCode).toBe(400);
    expect(errorBody(dir).code).toBe('invalid_path');
  });
});

describe('index failure after the disk write', () => {
  it('answers 500 index_update_failed with diskWritten true and keeps the file', async () => {
    const { app, root, bundle } = await setup();
    bundle.index.failNext = true;
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=indexed.md',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'written',
    });
    expect(res.statusCode).toBe(500);
    const error = errorBody(res);
    expect(error.code).toBe('index_update_failed');
    expect(error.details?.['diskWritten']).toBe(true);
    expect(error.details?.['path']).toBe('indexed.md');
    expect(typeof error.details?.['revision']).toBe('string');
    expect(await readFile(join(root, 'indexed.md'), 'utf8')).toBe('written');
  });
});

describe('coalesced change events over HTTP', () => {
  it('publishes one created event with the latest revision after the quiet window', async () => {
    const { app, bundle } = await setup({ sinkOptions: { coalesceWindowMs: 5, maxDelayMs: 10 } });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file?path=ev.md',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'v1',
    });
    expect(res.statusCode).toBe(201);
    await sleep(40);
    expect(bundle.events.all).toHaveLength(1);
    expect(bundle.events.all[0]?.kind).toBe('created');
    expect(bundle.events.all[0]?.path).toBe('ev.md');
    expect(bundle.events.all[0]?.revision).toBe(dataOf(res)['revision']);
    expect(bundle.events.all[0]?.version).toBe(1);
  });
});

describe('fail-closed wiring in buildApp', () => {
  it('answers 503 service_unavailable on write routes until ports are wired', async () => {
    const config: ServerConfig = {
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
      publicBaseUrl: TEST_ORIGIN,
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
    };
    const app = await buildApp({
      config,
      pool: null,
      version: 'test',
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? TEST_PRINCIPAL : null),
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
      verifyOrigin: defaultVerifyOrigin,
    });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/workspace/file?path=a.md',
        headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
        payload: 'x',
      });
      expect(res.statusCode).toBe(503);
      expect(errorBody(res).code).toBe('service_unavailable');
      const unauthenticated = await app.inject({
        method: 'PUT',
        url: '/api/workspace/file?path=a.md',
        headers: { 'if-none-match': '*', 'content-type': 'text/plain' },
        payload: 'x',
      });
      expect(unauthenticated.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
