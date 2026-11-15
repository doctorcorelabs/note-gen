// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// HTTP conformance specs for the workspace write endpoints, wired
// with the REAL V3-04a path and revision modules behind the REAL
// V3-04b routes, guards, queue, and service.
//
// What is real in this wiring: the Fastify routes, the frozen auth
// hooks, the guard parsers, the atomic write path, the write queue,
// validateWorkspacePath, assertNoSymlinkComponents, and
// buildRevision. What is faked, and why: the index, event, and
// idempotency ports use the V3-04b fakes (Postgres wiring is an
// integrator step, fan-out belongs to V3-08, key storage belongs to
// the auth worker); the session/CSRF verifiers are stubs behind the
// real hooks; the workspace identity comes from a test resolver.
// The V3-04b suite pins the same wire behavior against path/revision
// doubles; these specs pin it against the real modules, including
// the strict-segment rule the doubles do not share (double slashes
// and dot segments are rejected, never collapsed).
//
// Contract: kontrak-api-kanonis.md section 3.1 with the amended
// K-03 status rule (412 for PUT file/media, 409 for append/patch,
// one code revision_conflict), desain-workspace-api.md sections 3
// (guards, conflict payload, ETag) and 8 (path validation), and
// kontrak section 1.5 (unknown JSON fields rejected with 400
// validation_failed).
//
// Read-side conformance (list, GET/HEAD file, scan, stat) lives in
// read-conformance.spec.ts in this directory (V3-04cR2), against
// the real V3-04a read routes.

import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_HEADERS, buildWriteTestApp, errorBody } from '../helpers/workspace-test-app.js';
import { TEST_WORKSPACE_ID, type TestPortsBundle } from '../helpers/workspace-test-ports.js';
import { createRealPortsBundle, REAL_WORKSPACE_KEY } from './real-ports.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

// Independent revision computation: the desain section 3.1 formula
// recomputed here with node:crypto, never through buildRevision.
function independentRevision(path: string, content: Buffer | string): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const digest = createHash('sha256')
    .update(REAL_WORKSPACE_KEY, 'utf8')
    .update(Buffer.from([0]))
    .update(path, 'utf8')
    .update(Buffer.from([0]))
    .update(bytes)
    .digest('hex');
  return `sha256:${digest}`;
}

interface Fixture {
  app: FastifyInstance;
  root: string;
  bundle: TestPortsBundle;
}

let fixture: Fixture | undefined;

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'notegen-write-conformance-'));
  const bundle = createRealPortsBundle(root);
  const app = await buildWriteTestApp(bundle);
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

function dataOf(res: { json(): unknown }): Record<string, unknown> {
  return (res.json() as { data: Record<string, unknown> }).data;
}

function fileUrl(path: string): string {
  return `/api/workspace/file?path=${encodeURIComponent(path)}`;
}

async function createViaPut(
  app: FastifyInstance,
  path: string,
  content: string,
): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'PUT',
    url: fileUrl(path),
    headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
    payload: content,
  });
  expect(res.statusCode).toBe(201);
  return dataOf(res);
}

describe('PUT file with real path and revision modules', () => {
  it('creates a file with envelope, quoted ETag, and an independently recomputed revision', async () => {
    const { app, root } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('notes/one.md'),
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(201);
    const data = dataOf(res);
    const expected = independentRevision('notes/one.md', 'hello');
    expect(data['path']).toBe('notes/one.md');
    expect(data['revision']).toBe(expected);
    expect(data['version']).toBe(1);
    expect(data['size']).toBe(5);
    expect(data['created']).toBe(true);
    expect(typeof data['modifiedAt']).toBe('string');
    expect(res.headers['etag']).toBe(`"${expected}"`);
    expect(res.headers['x-revision']).toBe(expected);
    expect(res.headers['x-version']).toBe('1');
    expect(res.headers['last-modified']).toBeDefined();
    expect(await readFile(join(root, 'notes', 'one.md'), 'utf8')).toBe('hello');
  });

  it('overwrites with the verbatim quoted ETag as If-Match and bumps version and revision', async () => {
    const { app, root } = await setup();
    const created = await createViaPut(app, 'a.md', 'first');
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('a.md'),
      headers: { ...AUTH_HEADERS, 'if-match': `"${String(created['revision'])}"`, 'content-type': 'text/plain' },
      payload: 'second',
    });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect(data['created']).toBe(false);
    expect(data['version']).toBe(2);
    expect(data['revision']).toBe(independentRevision('a.md', 'second'));
    expect(res.headers['etag']).toBe(`"${String(data['revision'])}"`);
    expect(res.headers['x-revision']).toBe(data['revision']);
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('second');
  });

  it('tolerates an unquoted If-Match', async () => {
    const { app } = await setup();
    const created = await createViaPut(app, 'a.md', 'first');
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('a.md'),
      headers: { ...AUTH_HEADERS, 'if-match': String(created['revision']), 'content-type': 'text/plain' },
      payload: 'second',
    });
    expect(res.statusCode).toBe(200);
  });

  it('tolerates a weak If-Match validator', async () => {
    const { app } = await setup();
    const created = await createViaPut(app, 'a.md', 'first');
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('a.md'),
      headers: { ...AUTH_HEADERS, 'if-match': `W/"${String(created['revision'])}"`, 'content-type': 'text/plain' },
      payload: 'second',
    });
    expect(res.statusCode).toBe(200);
  });

  it('force-overwrites with If-Match: *', async () => {
    const { app, root } = await setup();
    await createViaPut(app, 'a.md', 'first');
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('a.md'),
      headers: { ...AUTH_HEADERS, 'if-match': '*', 'content-type': 'text/plain' },
      payload: 'forced',
    });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)['revision']).toBe(independentRevision('a.md', 'forced'));
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('forced');
  });

  it('answers 428 when no guard is sent', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('a.md'),
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
      url: fileUrl('a.md'),
      headers: { ...AUTH_HEADERS, 'if-match': '"sha256:x"', 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('invalid_precondition');
  });

  it('answers 400 invalid_precondition for an If-Match list', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('a.md'),
      headers: { ...AUTH_HEADERS, 'if-match': '"sha256:a", "sha256:b"', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('invalid_precondition');
  });

  it('answers 400 invalid_precondition for an If-None-Match revision value', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('a.md'),
      headers: { ...AUTH_HEADERS, 'if-none-match': '"sha256:abc"', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('invalid_precondition');
  });

  it('answers 404 for If-Match on a missing file', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('missing.md'),
      headers: { ...AUTH_HEADERS, 'if-match': '"sha256:abc"', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(404);
    expect(errorBody(res).code).toBe('not_found');
  });

  it('answers 409 already_exists for If-None-Match: * on an existing file and leaves it untouched', async () => {
    const { app, root } = await setup();
    await createViaPut(app, 'a.md', 'kept');
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('a.md'),
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'other',
    });
    expect(res.statusCode).toBe(409);
    expect(errorBody(res).code).toBe('already_exists');
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('kept');
  });

  it('answers 400 invalid_path when the target is a directory', async () => {
    const { app, root } = await setup();
    await mkdir(join(root, 'dir'), { recursive: true });
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('dir'),
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('invalid_path');
  });
});

describe('stale guards: 412/409 with full conflict payload and zero corruption', () => {
  it('stale PUT answers 412 with the action-chooser payload and leaves bytes, mtime, and directory clean', async () => {
    const { app, root, bundle } = await setup();
    const created = await createViaPut(app, 'conf.md', 'server text');
    const absolute = join(root, 'conf.md');
    const before = await stat(absolute);
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('conf.md'),
      headers: { ...AUTH_HEADERS, 'if-match': '"sha256:stale"', 'content-type': 'text/plain' },
      payload: 'client text',
    });
    expect(res.statusCode).toBe(412);
    const body = res.json() as { ok: boolean; error: { code: string; requestId: string; retryable: boolean } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('revision_conflict');
    expect(body.error.retryable).toBe(false);
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
    const details = errorBody(res).details ?? {};
    expect(details['path']).toBe('conf.md');
    expect(details['serverRevision']).toBe(created['revision']);
    expect(details['serverVersion']).toBe(1);
    expect(details['serverSize']).toBe(11);
    expect(details['serverModifiedAt']).toBeDefined();
    expect(details['currentPreview']).toBe('server text');
    expect(details['previewTruncated']).toBe(false);
    expect(details['suggestedCopyPath']).toBe('conf (salinan).md');
    expect(details['actions']).toEqual(['reload', 'saveAsCopy', 'forceOverwrite']);
    expect(await readFile(absolute, 'utf8')).toBe('server text');
    expect((await stat(absolute)).mtimeMs).toBe(before.mtimeMs);
    expect(await bundle.index.currentVersion(TEST_WORKSPACE_ID, 'conf.md')).toBe(1);
    const entries = await readdir(root);
    expect(entries.filter((entry) => entry.startsWith('.notegen-tmp-'))).toEqual([]);
  });

  it('truncates the conflict preview at 1000 characters', async () => {
    const { app } = await setup();
    await createViaPut(app, 'long.md', 'x'.repeat(1500));
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('long.md'),
      headers: { ...AUTH_HEADERS, 'if-match': '"sha256:stale"', 'content-type': 'text/plain' },
      payload: 'y',
    });
    expect(res.statusCode).toBe(412);
    const details = errorBody(res).details ?? {};
    expect(String(details['currentPreview'])).toBe('x'.repeat(1000));
    expect(details['previewTruncated']).toBe(true);
  });

  it('numbers the suggested copy path when the first suggestion already exists', async () => {
    const { app } = await setup();
    await createViaPut(app, 'n.md', 'one');
    await createViaPut(app, 'n (salinan).md', 'copy');
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('n.md'),
      headers: { ...AUTH_HEADERS, 'if-match': '"sha256:stale"', 'content-type': 'text/plain' },
      payload: 'other',
    });
    expect(res.statusCode).toBe(412);
    expect(errorBody(res).details?.['suggestedCopyPath']).toBe('n (salinan 2).md');
  });

  it('stale append answers 409 with failedOperation append and leaves the bytes untouched', async () => {
    const { app, root } = await setup();
    await createViaPut(app, 'a.md', 'base');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=a.md',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ expectedRevision: 'sha256:stale', content: 'more' }),
    });
    expect(res.statusCode).toBe(409);
    expect(errorBody(res).code).toBe('revision_conflict');
    const details = errorBody(res).details ?? {};
    expect(details['failedOperation']).toBe('append');
    expect(details['serverRevision']).toBe(independentRevision('a.md', 'base'));
    expect(details['actions']).toEqual(['reload', 'saveAsCopy', 'forceOverwrite']);
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('base');
  });

  it('stale patch answers 409 with failedOperation patch and leaves the bytes untouched', async () => {
    const { app, root } = await setup();
    await createViaPut(app, 'a.md', 'line one\nline two\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/patch?path=a.md',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        expectedRevision: 'sha256:stale',
        startLine: 1,
        endLine: 2,
        replacement: 'replaced\n',
      }),
    });
    expect(res.statusCode).toBe(409);
    expect(errorBody(res).code).toBe('revision_conflict');
    expect(errorBody(res).details?.['failedOperation']).toBe('patch');
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('line one\nline two\n');
  });

  it('matching append and patch succeed with independently recomputed revisions', async () => {
    const { app, root } = await setup();
    const created = await createViaPut(app, 'a.md', 'line one\nline two\n');
    const appended = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=a.md',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ expectedRevision: created['revision'], content: 'line three\n' }),
    });
    expect(appended.statusCode).toBe(200);
    expect(dataOf(appended)['appendedBytes']).toBe(11);
    expect(dataOf(appended)['revision']).toBe(independentRevision('a.md', 'line one\nline two\nline three\n'));
    const patched = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/patch?path=a.md',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        expectedRevision: dataOf(appended)['revision'],
        startLine: 2,
        endLine: 3,
        replacement: 'LINE TWO\n',
      }),
    });
    expect(patched.statusCode).toBe(200);
    expect(dataOf(patched)['patchedLines']).toBe(1);
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('line one\nLINE TWO\nline three\n');
  });

  it('append with force:true succeeds despite a stale revision', async () => {
    const { app, root } = await setup();
    await createViaPut(app, 'a.md', 'base');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=a.md',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ expectedRevision: 'sha256:stale', content: '!', force: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('base!');
  });

  it('append without any guard answers 400 validation_failed naming expectedRevision', async () => {
    const { app } = await setup();
    await createViaPut(app, 'a.md', 'base');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=a.md',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ content: 'more' }),
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('validation_failed');
    const fields = (errorBody(res).details?.['fields'] ?? []) as Array<{ field: string }>;
    expect(fields.map((field) => field.field)).toContain('expectedRevision');
  });
});

describe('unknown fields are rejected before any mutation', () => {
  it('append rejects workspaceId with 400 validation_failed and leaves the file untouched', async () => {
    const { app, root, bundle } = await setup();
    const created = await createViaPut(app, 'a.md', 'base');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/append?path=a.md',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ expectedRevision: created['revision'], content: 'x', workspaceId: 'forged' }),
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('validation_failed');
    const fields = (errorBody(res).details?.['fields'] ?? []) as Array<{ field: string }>;
    expect(fields.map((field) => field.field)).toContain('workspaceId');
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('base');
    expect(await bundle.index.currentVersion(TEST_WORKSPACE_ID, 'a.md')).toBe(1);
  });

  it('patch rejects unknown fields including workspace_id and append-only content', async () => {
    const { app, root } = await setup();
    const created = await createViaPut(app, 'a.md', 'line one\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/file/patch?path=a.md',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        expectedRevision: created['revision'],
        startLine: 1,
        endLine: 2,
        replacement: 'x\n',
        workspace_id: 'forged',
        content: 'wrong endpoint field',
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('validation_failed');
    const fields = (errorBody(res).details?.['fields'] ?? []) as Array<{ field: string }>;
    const names = fields.map((field) => field.field);
    expect(names).toContain('workspace_id');
    expect(names).toContain('content');
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('line one\n');
  });
});

describe('path traversal and symlink refusal over HTTP', () => {
  it.each(['../x.md', 'a/../../x.md', 'a/../b.md', '..', 'a/b/..'])(
    'rejects traversal path %s with 400 invalid_path and writes nothing outside',
    async (path) => {
      const { app, root } = await setup();
      const before = await readdir(root);
      const res = await app.inject({
        method: 'PUT',
        url: fileUrl(path),
        headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
        payload: 'escape',
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe('invalid_path');
      expect(await readdir(root)).toEqual(before);
    },
  );

  it('rejects absolute, drive-letter, backslash, empty-segment, and dot-segment spellings', async () => {
    const { app } = await setup();
    const spellings = ['/etc/passwd', 'C:/x.md', 'a\\b.md', 'a//b.md', 'a/b/', 'a/./b.md', './x.md'];
    for (const path of spellings) {
      const res = await app.inject({
        method: 'PUT',
        url: fileUrl(path),
        headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
        payload: 'x',
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe('invalid_path');
    }
  });

  it('rejects dot-leading paths for writes with 400 invalid_path', async () => {
    const { app } = await setup();
    for (const path of ['.hidden.md', '.git/config', 'a/.x.md', '.notegen/thumb.png']) {
      const res = await app.inject({
        method: 'PUT',
        url: fileUrl(path),
        headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
        payload: 'x',
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe('invalid_path');
    }
  });

  it('rejects a symlinked target pointing outside and leaves the outside file untouched', async () => {
    const { app, root } = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'notegen-outside-'));
    try {
      const target = join(outside, 'secret.md');
      await writeFile(target, 'outside');
      await symlink(target, join(root, 'escape.md'));
      const res = await app.inject({
        method: 'PUT',
        url: fileUrl('escape.md'),
        headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
        payload: 'pwned',
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe('symlink_not_allowed');
      expect(await readFile(target, 'utf8')).toBe('outside');
      expect((await lstat(join(root, 'escape.md'))).isSymbolicLink()).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects writes through a symlinked parent and a broken symlink', async () => {
    const { app, root } = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'notegen-outside-'));
    try {
      await symlink(outside, join(root, 'linked'));
      await symlink(join(root, 'no-such-target.md'), join(root, 'broken.md'));
      for (const path of ['linked/note.md', 'broken.md']) {
        const res = await app.inject({
          method: 'PUT',
          url: fileUrl(path),
          headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
          payload: 'x',
        });
        expect(res.statusCode).toBe(400);
        expect(errorBody(res).code).toBe('symlink_not_allowed');
      }
      const appended = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/append?path=linked%2Fnote.md',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ expectedRevision: 'sha256:x', content: 'x' }),
      });
      expect(appended.statusCode).toBe(400);
      expect(errorBody(appended).code).toBe('symlink_not_allowed');
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('treats a double-encoded traversal spelling as a literal file name inside the root', async () => {
    const { app, root } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: fileUrl('%2e%2e.md'),
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
      payload: 'literal',
    });
    expect(res.statusCode).toBe(201);
    expect(dataOf(res)['path']).toBe('%2e%2e.md');
    expect(await readFile(join(root, '%2e%2e.md'), 'utf8')).toBe('literal');
  });
});

describe('PUT media with real modules', () => {
  it('creates media with ETag and an independently recomputed binary revision', async () => {
    const { app, root } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/media?path=img%2Fa.png',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'application/octet-stream' },
      payload: PNG_BYTES,
    });
    expect(res.statusCode).toBe(201);
    const data = dataOf(res);
    const expected = independentRevision('img/a.png', PNG_BYTES);
    expect(data['path']).toBe('img/a.png');
    expect(data['revision']).toBe(expected);
    expect(res.headers['etag']).toBe(`"${expected}"`);
    expect(res.headers['x-revision']).toBe(expected);
    expect(await readFile(join(root, 'img', 'a.png'))).toEqual(PNG_BYTES);
  });

  it('stale media guard answers 412 and leaves the bytes untouched', async () => {
    const { app, root } = await setup();
    await app.inject({
      method: 'PUT',
      url: '/api/workspace/media?path=img%2Fa.png',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'application/octet-stream' },
      payload: PNG_BYTES,
    });
    // Valid PNG bytes that differ from the stored file: media type
    // validation (desain 3.7 step 1) runs before the guard check
    // (step 3), so JPEG bytes for a .png target would answer 415
    // before the guard is ever evaluated (see the next test).
    const other = Buffer.concat([PNG_BYTES, Buffer.from([0x00])]);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/media?path=img%2Fa.png',
      headers: { ...AUTH_HEADERS, 'if-match': '"sha256:stale"', 'content-type': 'application/octet-stream' },
      payload: other,
    });
    expect(res.statusCode).toBe(412);
    expect(errorBody(res).code).toBe('revision_conflict');
    expect(errorBody(res).details?.['currentPreview']).toBeNull();
    expect(errorBody(res).details?.['previewTruncated']).toBe(false);
    expect(await readFile(join(root, 'img', 'a.png'))).toEqual(PNG_BYTES);
  });

  it('answers 415 for mismatched media bytes before evaluating a stale guard', async () => {
    const { app, root } = await setup();
    await app.inject({
      method: 'PUT',
      url: '/api/workspace/media?path=img%2Fa.png',
      headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'application/octet-stream' },
      payload: PNG_BYTES,
    });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/media?path=img%2Fa.png',
      headers: { ...AUTH_HEADERS, 'if-match': '"sha256:stale"', 'content-type': 'application/octet-stream' },
      payload: jpeg,
    });
    expect(res.statusCode).toBe(415);
    expect(errorBody(res).code).toBe('unsupported_media_type');
    expect(await readFile(join(root, 'img', 'a.png'))).toEqual(PNG_BYTES);
  });
});

describe('paths through a file and overlong names on writes (ENOTDIR/ENAMETOOLONG)', () => {
  // Writes answer 400 invalid_path here, not 404: desain 8.6 maps
  // invalid write paths to 400, katalog 6.2 lists "terlalu panjang"
  // under invalid_path, and the write service already maps ENOTDIR
  // from its disk reads to invalid_path. Reads answer 404 for the
  // same paths (see read.spec.ts); the asymmetry is the designed
  // 400-vs-404 matrix, and 500 is wrong on both sides.
  const LONG_SEGMENT = `${'a'.repeat(1020)}.md`;

  function multipartUpload(path: string, bytes: Buffer): { headers: Record<string, string>; payload: Buffer } {
    const boundary = 'fix02boundary';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${path}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n` +
        'Content-Type: image/png\r\n\r\n',
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    return {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([head, bytes, tail]),
    };
  }

  it('PUT file through a regular file and overlong names answers 400 invalid_path', async () => {
    const { app, root } = await setup();
    await createViaPut(app, 'blocker.md', 'kept');
    for (const path of ['blocker.md/child.md', LONG_SEGMENT]) {
      const res = await app.inject({
        method: 'PUT',
        url: fileUrl(path),
        headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'text/plain' },
        payload: 'x',
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe('invalid_path');
    }
    expect(await readFile(join(root, 'blocker.md'), 'utf8')).toBe('kept');
  });

  it('append and patch through a regular file and overlong names answer 400 invalid_path', async () => {
    const { app, root } = await setup();
    await createViaPut(app, 'blocker.md', 'kept');
    for (const path of ['blocker.md/child.md', LONG_SEGMENT]) {
      const encoded = encodeURIComponent(path);
      const appended = await app.inject({
        method: 'POST',
        url: `/api/workspace/file/append?path=${encoded}`,
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ expectedRevision: 'sha256:x', content: 'x' }),
      });
      expect(appended.statusCode).toBe(400);
      expect(errorBody(appended).code).toBe('invalid_path');
      const patched = await app.inject({
        method: 'POST',
        url: `/api/workspace/file/patch?path=${encoded}`,
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ expectedRevision: 'sha256:x', startLine: 1, endLine: 2, replacement: 'x\n' }),
      });
      expect(patched.statusCode).toBe(400);
      expect(errorBody(patched).code).toBe('invalid_path');
    }
    expect(await readFile(join(root, 'blocker.md'), 'utf8')).toBe('kept');
  });

  it('PUT media through a regular file and overlong names answers 400 invalid_path', async () => {
    const { app, root } = await setup();
    await createViaPut(app, 'blocker.md', 'kept');
    const longPng = `${'a'.repeat(1020)}.png`;
    for (const path of ['blocker.md/pic.png', longPng]) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/workspace/media?path=${encodeURIComponent(path)}`,
        headers: { ...AUTH_HEADERS, 'if-none-match': '*', 'content-type': 'application/octet-stream' },
        payload: PNG_BYTES,
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe('invalid_path');
    }
    expect(await readFile(join(root, 'blocker.md'), 'utf8')).toBe('kept');
  });

  it('POST media through a regular file answers 400 invalid_path', async () => {
    const { app, root } = await setup();
    await createViaPut(app, 'blocker.md', 'kept');
    const { headers, payload } = multipartUpload('blocker.md/pic.png', PNG_BYTES);
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/media',
      headers: { ...AUTH_HEADERS, ...headers, 'if-none-match': '*' },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('invalid_path');
    expect(await readFile(join(root, 'blocker.md'), 'utf8')).toBe('kept');
  });
});
