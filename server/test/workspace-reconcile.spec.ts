// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for POST /api/workspace/reconcile (V3-05 part 4) and the
// reconcile diff service.
//
// What is pinned here: the 202 accepted shape from the canonical
// contract (jobId, status running, full, dryRun, startedAt); the
// diff against a fake index port (matching tree, extra file on
// disk, missing file, changed content, metadata-only drift, and
// index rows that name disk directories); invalid requests answer
// 400, including unknown fields, wrong types, and full false; a
// second POST while a run is in flight answers 409
// reconcile_already_running and never queues; dry runs never call
// the repair port; non-dry runs report exactly the repairs the
// port performed; disk contents are never modified; missing wiring
// fails closed with 503; and session, Origin, and CSRF checks run
// before the handler through the frozen auth hook. The real index
// lands in V3-06, so every index interaction here goes through
// the fake port; no test touches Postgres.
//
// File name note: this file uses the .spec.ts suffix, matching the
// other server specs and the Vitest include pattern.

import Fastify, { type FastifyInstance } from 'fastify';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash } from '../src/lib/revision.js';
import {
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';
import type { WorkspaceIdentityResolver } from '../src/services/workspace/write-ports.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import { ApiError } from '../src/plugins/envelope.js';
import {
  RECONCILE_PATH,
  registerWorkspaceReconcileRoutes,
} from '../src/routes/workspace-reconcile.js';
import {
  ReconcileJobRegistry,
  computeReconcileDiff,
  scanWorkspaceTree,
  type DriftEntry,
  type ReconcileIndexPort,
  type ReconcileIndexRow,
  type ReconcileRepairPort,
} from '../src/services/workspace/reconcile.js';

const CANONICAL_ORIGIN = 'https://app.example.invalid';
const PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'good-session' };

const AUTHED_HEADERS = {
  cookie: 'notegen_session=good-session',
  origin: CANONICAL_ORIGIN,
  'x-csrf-token': 'good-csrf',
};

const tempDirs: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop() as FastifyInstance;
    await app.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    await rm(dir, { recursive: true, force: true });
  }
});

class FakeIndex implements ReconcileIndexPort {
  rows: ReconcileIndexRow[] = [];
  calls = 0;
  gate: Promise<void> | null = null;
  error: Error | null = null;

  async listActiveRows(_workspaceId: string): Promise<readonly ReconcileIndexRow[]> {
    this.calls += 1;
    if (this.gate !== null) {
      await this.gate;
    }
    if (this.error !== null) {
      throw this.error;
    }
    return [...this.rows];
  }
}

class FakeRepairs implements ReconcileRepairPort {
  calls: Array<{ workspaceId: string; drift: readonly DriftEntry[] }> = [];
  repaired: number | null = null;

  async applyRepairs(
    workspaceId: string,
    drift: readonly DriftEntry[],
  ): Promise<{ repaired: number }> {
    this.calls.push({ workspaceId, drift });
    return { repaired: this.repaired ?? drift.length };
  }
}

const resolveIdentity: WorkspaceIdentityResolver = async () => ({
  workspaceId: 'workspace-1',
  userId: 'user-1',
  actorId: undefined,
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'reconcile-test-'));
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, ...relative.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return root;
}

function indexRow(path: string, content: string, overrides: Partial<ReconcileIndexRow> = {}): ReconcileIndexRow {
  return {
    path,
    contentHash: contentHash(content),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    version: 1,
    ...overrides,
  };
}

interface HarnessOptions {
  workspaceRoot: string;
  index?: FakeIndex;
  repairs?: FakeRepairs;
  resolver?: WorkspaceIdentityResolver | undefined;
  registry?: ReconcileJobRegistry;
  withAuth?: boolean;
}

async function reconcileApp(options: HarnessOptions): Promise<{
  app: FastifyInstance;
  registry: ReconcileJobRegistry;
  index: FakeIndex;
  repairs: FakeRepairs;
}> {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerErrorHandling(app, { version: '0.39.2-fork.1' });
  if (options.withAuth !== false) {
    registerAuthHooks(app, {
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? PRINCIPAL : null),
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
      verifyOrigin: async (request) => request.headers.origin === CANONICAL_ORIGIN,
      canonicalOrigin: CANONICAL_ORIGIN,
    });
  }
  const registry = options.registry ?? new ReconcileJobRegistry();
  const index = options.index ?? new FakeIndex();
  const repairs = options.repairs ?? new FakeRepairs();
  await registerWorkspaceReconcileRoutes(app, {
    workspaceRoot: options.workspaceRoot,
    resolveIdentity: options.resolver === undefined ? resolveIdentity : options.resolver,
    index,
    repairs,
    registry,
  });
  await app.ready();
  return { app, registry, index, repairs };
}

interface SuccessBody {
  ok: true;
  data: {
    jobId: string;
    status: string;
    full: boolean;
    dryRun: boolean;
    startedAt: string;
  };
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

function assertErrorBody(body: unknown, expectedCode: string): asserts body is ErrorBody {
  const parsed = body as ErrorBody;
  expect(parsed.ok).toBe(false);
  expect(parsed.error.code).toBe(expectedCode);
  expect(parsed.error.retryable).toBe(false);
  expect(typeof parsed.error.requestId).toBe('string');
  expect(parsed.error.requestId).not.toBe('');
  expect(parsed.error.message).toBeTruthy();
  expect(parsed.error.details).toEqual(expect.any(Object));
}

describe('computeReconcileDiff', () => {
  it('reports no drift when the disk tree matches the index', () => {
    const disk = [
      { path: 'a.md', sizeBytes: 5, contentHash: 'hash-a' },
      { path: 'sub/b.md', sizeBytes: 3, contentHash: 'hash-b' },
    ];
    const rows = [
      { path: 'a.md', contentHash: 'hash-a', sizeBytes: 5, version: 2 },
      { path: 'sub/b.md', contentHash: 'hash-b', sizeBytes: 3, version: 1 },
    ];
    const diff = computeReconcileDiff(disk, rows, new Set(['sub']));
    expect(diff.entries).toEqual([]);
    expect(diff.categories).toEqual({
      orphanDisk: 0,
      phantomIndex: 0,
      hashMismatch: 0,
      metadataMismatch: 0,
    });
    expect(diff.filesScanned).toBe(2);
    expect(diff.indexRowsChecked).toBe(2);
  });

  it('classifies an extra file on disk as orphanDisk', () => {
    const diff = computeReconcileDiff(
      [{ path: 'extra.md', sizeBytes: 4, contentHash: 'hash-x' }],
      [],
      new Set(),
    );
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]?.category).toBe('orphanDisk');
    expect(diff.entries[0]?.index).toBeNull();
    expect(diff.categories.orphanDisk).toBe(1);
  });

  it('classifies a missing file as phantomIndex', () => {
    const diff = computeReconcileDiff(
      [],
      [{ path: 'gone.md', contentHash: 'hash-g', sizeBytes: 4, version: 1 }],
      new Set(),
    );
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]?.category).toBe('phantomIndex');
    expect(diff.entries[0]?.disk).toBeNull();
    expect(diff.categories.phantomIndex).toBe(1);
  });

  it('classifies changed content as hashMismatch', () => {
    const diff = computeReconcileDiff(
      [{ path: 'a.md', sizeBytes: 6, contentHash: 'hash-new' }],
      [{ path: 'a.md', contentHash: 'hash-old', sizeBytes: 5, version: 1 }],
      new Set(),
    );
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]?.category).toBe('hashMismatch');
    expect(diff.categories.hashMismatch).toBe(1);
  });

  it('classifies a same-hash size difference as metadataMismatch', () => {
    const diff = computeReconcileDiff(
      [{ path: 'a.md', sizeBytes: 5, contentHash: 'hash-a' }],
      [{ path: 'a.md', contentHash: 'hash-a', sizeBytes: 99, version: 1 }],
      new Set(),
    );
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]?.category).toBe('metadataMismatch');
  });

  it('does not treat a version difference alone as drift', () => {
    const diff = computeReconcileDiff(
      [{ path: 'a.md', sizeBytes: 5, contentHash: 'hash-a' }],
      [{ path: 'a.md', contentHash: 'hash-a', sizeBytes: 5, version: 47 }],
      new Set(),
    );
    expect(diff.entries).toEqual([]);
  });

  it('does not flag an index row that names a disk directory', () => {
    const diff = computeReconcileDiff(
      [],
      [{ path: 'sub', contentHash: 'hash-d', sizeBytes: 0, version: 1 }],
      new Set(['sub']),
    );
    expect(diff.entries).toEqual([]);
    expect(diff.indexRowsChecked).toBe(1);
  });

  it('sorts drift entries by path', () => {
    const diff = computeReconcileDiff(
      [
        { path: 'z.md', sizeBytes: 1, contentHash: 'h1' },
        { path: 'a.md', sizeBytes: 1, contentHash: 'h2' },
      ],
      [],
      new Set(),
    );
    expect(diff.entries.map((entry) => entry.path)).toEqual(['a.md', 'z.md']);
  });
});

describe('scanWorkspaceTree', () => {
  it('finds nested files and skips dot entries, symlinks, and temp files', async () => {
    const root = await makeWorkspace({
      'a.md': 'alpha',
      'sub/b.md': 'beta',
      '.hidden.md': 'hidden',
      '.notegen-tmp-123': 'temp',
    });
    await symlink(join(root, 'a.md'), join(root, 'link.md'));
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'config'), 'git', 'utf8');
    const snapshot = await scanWorkspaceTree(root);
    expect(snapshot.files.map((file) => file.path)).toEqual(['a.md', 'sub/b.md']);
    expect(snapshot.directories.has('sub')).toBe(true);
    expect(snapshot.directories.has('.git')).toBe(false);
    const stats = await lstat(join(root, 'link.md'));
    expect(stats.isSymbolicLink()).toBe(true);
  });

  it('answers service_unavailable for a missing root', async () => {
    const missing = join(tmpdir(), `reconcile-missing-${Date.now()}`);
    await expect(scanWorkspaceTree(missing)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
  });
});

describe('POST /api/workspace/reconcile', () => {
  it('accepts a matching tree with 202 and an empty drift report', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha', 'sub/b.md': 'beta' });
    const index = new FakeIndex();
    index.rows = [indexRow('a.md', 'alpha'), indexRow('sub/b.md', 'beta')];
    const { app, registry } = await reconcileApp({ workspaceRoot: root, index });
    const response = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(202);
    const body = response.json() as SuccessBody;
    expect(body.ok).toBe(true);
    expect(body.data.jobId.startsWith('rec-')).toBe(true);
    expect(body.data.status).toBe('running');
    expect(body.data.full).toBe(true);
    expect(body.data.dryRun).toBe(false);
    expect(Number.isNaN(Date.parse(body.data.startedAt))).toBe(false);
    await registry.waitForIdle();
    const report = registry.lastReport();
    expect(report).not.toBeNull();
    expect(report?.status).toBe('completed');
    expect(report?.filesScanned).toBe(2);
    expect(report?.indexRowsChecked).toBe(2);
    expect(report?.driftFound).toBe(0);
    expect(report?.driftPaths).toEqual([]);
    expect(report?.driftPathsTruncated).toBe(false);
    expect(report?.dryRun).toBe(false);
    expect(report?.jobId).toBe(body.data.jobId);
  });

  it('reports an extra file on disk as orphanDisk drift', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha', 'extra.md': 'new' });
    const index = new FakeIndex();
    index.rows = [indexRow('a.md', 'alpha')];
    const { app, registry } = await reconcileApp({ workspaceRoot: root, index });
    const response = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: { dryRun: true },
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(202);
    await registry.waitForIdle();
    const report = registry.lastReport();
    expect(report?.driftFound).toBe(1);
    expect(report?.categories.orphanDisk).toBe(1);
    expect(report?.driftPaths).toEqual(['extra.md']);
    expect(report?.dryRun).toBe(true);
  });

  it('reports a missing file as phantomIndex drift', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha' });
    const index = new FakeIndex();
    index.rows = [indexRow('a.md', 'alpha'), indexRow('gone.md', 'gone')];
    const { app, registry } = await reconcileApp({ workspaceRoot: root, index });
    const response = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: { dryRun: true },
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(202);
    await registry.waitForIdle();
    const report = registry.lastReport();
    expect(report?.driftFound).toBe(1);
    expect(report?.categories.phantomIndex).toBe(1);
    expect(report?.driftPaths).toEqual(['gone.md']);
  });

  it('reports changed content as hashMismatch drift', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha-changed' });
    const index = new FakeIndex();
    index.rows = [indexRow('a.md', 'alpha')];
    const { app, registry } = await reconcileApp({ workspaceRoot: root, index });
    const response = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: { dryRun: true },
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(202);
    await registry.waitForIdle();
    const report = registry.lastReport();
    expect(report?.driftFound).toBe(1);
    expect(report?.categories.hashMismatch).toBe(1);
    expect(report?.driftPaths).toEqual(['a.md']);
  });

  it('treats an absent body as defaults', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha' });
    const index = new FakeIndex();
    index.rows = [indexRow('a.md', 'alpha')];
    const { app, registry } = await reconcileApp({ workspaceRoot: root, index });
    const response = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(202);
    const body = response.json() as SuccessBody;
    expect(body.data.full).toBe(true);
    expect(body.data.dryRun).toBe(false);
    await registry.waitForIdle();
    expect(registry.lastReport()?.driftFound).toBe(0);
  });

  it('rejects invalid requests with 400', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha' });
    const { app, registry } = await reconcileApp({ workspaceRoot: root });
    const cases: Array<{ payload: unknown; code: string }> = [
      { payload: { workspaceId: 'workspace-1' }, code: 'validation_failed' },
      { payload: { full: 'yes' }, code: 'validation_failed' },
      { payload: { dryRun: 1 }, code: 'validation_failed' },
      { payload: { full: false }, code: 'validation_failed' },
      { payload: { unknownField: true }, code: 'validation_failed' },
      { payload: [1, 2], code: 'validation_failed' },
    ];
    for (const { payload, code } of cases) {
      const response = await app.inject({
        method: 'POST',
        url: RECONCILE_PATH,
        payload: JSON.stringify(payload),
        headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
      });
      expect(response.statusCode).toBe(400);
      assertErrorBody(response.json(), code);
    }
    const nullBody = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: 'null',
      headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
    });
    expect(nullBody.statusCode).toBe(400);
    assertErrorBody(nullBody.json(), 'validation_failed');
    const malformed = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: '{not json',
      headers: { ...AUTHED_HEADERS, 'content-type': 'application/json' },
    });
    expect(malformed.statusCode).toBe(400);
    assertErrorBody(malformed.json(), 'invalid_json');
    expect(registry.running()).toBeNull();
    expect(registry.lastRecord()).toBeNull();
  });

  it('names the rejected field for an unknown body field', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha' });
    const { app } = await reconcileApp({ workspaceRoot: root });
    const response = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: { workspaceId: 'workspace-1' },
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as ErrorBody;
    expect(body.error.details['fields']).toEqual([{ field: 'workspaceId', issue: 'unknown field' }]);
  });

  it('rejects a second run while one is in flight and accepts the next after it finishes', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha' });
    const gate = deferred();
    const index = new FakeIndex();
    index.rows = [indexRow('a.md', 'alpha')];
    index.gate = gate.promise;
    const { app, registry } = await reconcileApp({ workspaceRoot: root, index });
    const first = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
      headers: AUTHED_HEADERS,
    });
    expect(first.statusCode).toBe(202);
    const invalidWhileRunning = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: { dryRun: 'yes' },
      headers: AUTHED_HEADERS,
    });
    expect(invalidWhileRunning.statusCode).toBe(400);
    const second = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
      headers: AUTHED_HEADERS,
    });
    expect(second.statusCode).toBe(409);
    assertErrorBody(second.json(), 'reconcile_already_running');
    gate.resolve();
    await registry.waitForIdle();
    expect(index.calls).toBe(1);
    const third = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
      headers: AUTHED_HEADERS,
    });
    expect(third.statusCode).toBe(202);
    expect((third.json() as SuccessBody).data.jobId).not.toBe(
      (first.json() as SuccessBody).data.jobId,
    );
    await registry.waitForIdle();
    expect(index.calls).toBe(2);
  });

  it('never calls the repair port on a dry run', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha', 'extra.md': 'new' });
    const index = new FakeIndex();
    index.rows = [indexRow('a.md', 'alpha')];
    const repairs = new FakeRepairs();
    const { app, registry } = await reconcileApp({ workspaceRoot: root, index, repairs });
    const response = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: { dryRun: true },
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(202);
    await registry.waitForIdle();
    expect(repairs.calls).toHaveLength(0);
    const report = registry.lastReport();
    expect(report?.driftFound).toBe(1);
    expect(report?.driftRepaired).toBe(0);
    expect(report?.driftRemaining).toBe(1);
  });

  it('reports exactly the repairs the port performed on a real run', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha', 'extra.md': 'new' });
    const index = new FakeIndex();
    index.rows = [indexRow('a.md', 'alpha')];
    const repairs = new FakeRepairs();
    const { app, registry } = await reconcileApp({ workspaceRoot: root, index, repairs });
    const response = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(202);
    await registry.waitForIdle();
    expect(repairs.calls).toHaveLength(1);
    expect(repairs.calls[0]?.workspaceId).toBe('workspace-1');
    expect(repairs.calls[0]?.drift.map((entry) => entry.path)).toEqual(['extra.md']);
    const report = registry.lastReport();
    expect(report?.driftFound).toBe(1);
    expect(report?.driftRepaired).toBe(1);
    expect(report?.driftRemaining).toBe(0);
  });

  it('never modifies disk contents', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha', 'sub/b.md': 'beta' });
    const index = new FakeIndex();
    index.rows = [indexRow('gone.md', 'gone')];
    const { app, registry } = await reconcileApp({ workspaceRoot: root, index });
    const response = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(202);
    await registry.waitForIdle();
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('alpha');
    expect(await readFile(join(root, 'sub', 'b.md'), 'utf8')).toBe('beta');
    expect((await readdir(root)).sort()).toEqual(['a.md', 'sub']);
    expect(registry.lastReport()?.driftFound).toBe(3);
  });

  it('marks the job failed and frees the slot when the index read throws', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha' });
    const index = new FakeIndex();
    index.error = new Error('index down');
    const { app, registry } = await reconcileApp({ workspaceRoot: root, index });
    const response = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(202);
    await registry.waitForIdle();
    const record = registry.lastRecord();
    expect(record?.status).toBe('failed');
    expect(record?.report).toBeNull();
    expect(record?.finishedAt).not.toBeNull();
    expect(registry.running()).toBeNull();
    index.error = null;
    index.rows = [indexRow('a.md', 'alpha')];
    const retry = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
      headers: AUTHED_HEADERS,
    });
    expect(retry.statusCode).toBe(202);
    await registry.waitForIdle();
    expect(registry.lastRecord()?.status).toBe('completed');
  });

  it('fails closed with 503 when the index port is not wired', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha' });
    const app = Fastify({ logger: false });
    apps.push(app);
    registerErrorHandling(app, { version: '0.39.2-fork.1' });
    registerAuthHooks(app, {
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? PRINCIPAL : null),
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
      verifyOrigin: async (request) => request.headers.origin === CANONICAL_ORIGIN,
      canonicalOrigin: CANONICAL_ORIGIN,
    });
    await registerWorkspaceReconcileRoutes(app, {
      workspaceRoot: root,
      resolveIdentity,
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(503);
    const body = response.json() as ErrorBody;
    expect(body.error.code).toBe('service_unavailable');
    expect(body.error.retryable).toBe(true);
  });

  it('fails closed with 503 when identity cannot be resolved', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha' });
    const nullResolver: WorkspaceIdentityResolver = async () => null;
    const { app } = await reconcileApp({ workspaceRoot: root, resolver: nullResolver });
    const response = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(503);
    const body = response.json() as ErrorBody;
    expect(body.error.code).toBe('service_unavailable');
    expect(body.error.retryable).toBe(true);
  });

  it('answers 401 without a session, 403 for bad origin, and 403 for bad CSRF', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha' });
    const { app } = await reconcileApp({ workspaceRoot: root });
    const unauthenticated = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
    });
    expect(unauthenticated.statusCode).toBe(401);
    assertErrorBody(unauthenticated.json(), 'unauthenticated');
    const badOrigin = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
      headers: { ...AUTHED_HEADERS, origin: 'https://evil.example.invalid' },
    });
    expect(badOrigin.statusCode).toBe(403);
    assertErrorBody(badOrigin.json(), 'origin_rejected');
    const badCsrf = await app.inject({
      method: 'POST',
      url: RECONCILE_PATH,
      payload: {},
      headers: { ...AUTHED_HEADERS, 'x-csrf-token': 'wrong-csrf' },
    });
    expect(badCsrf.statusCode).toBe(403);
    assertErrorBody(badCsrf.json(), 'csrf_invalid');
  });

  it('registers POST only in this slice', async () => {
    const root = await makeWorkspace({ 'a.md': 'alpha' });
    const { app } = await reconcileApp({ workspaceRoot: root });
    const response = await app.inject({
      method: 'GET',
      url: RECONCILE_PATH,
      headers: AUTHED_HEADERS,
    });
    expect(response.statusCode).toBe(405);
    assertErrorBody(response.json(), 'method_not_allowed');
  });
});

describe('ReconcileJobRegistry', () => {
  it('enforces single flight and reopens the slot after completion', () => {
    const registry = new ReconcileJobRegistry();
    const startedAt = new Date('2026-11-15T02:00:00.000Z');
    const first = registry.tryStart('rec-1', true, false, startedAt);
    expect(first).not.toBeNull();
    expect(first?.status).toBe('running');
    expect(registry.tryStart('rec-2', true, false, startedAt)).toBeNull();
    expect(registry.running()?.jobId).toBe('rec-1');
    registry.complete('rec-1', {
      jobId: 'rec-1',
      startedAt: startedAt.toISOString(),
      finishedAt: '2026-11-15T02:00:01.000Z',
      durationMs: 1000,
      filesScanned: 1,
      indexRowsChecked: 1,
      driftFound: 0,
      driftRepaired: 0,
      driftRemaining: 0,
      skippedLocked: 0,
      categories: { orphanDisk: 0, phantomIndex: 0, hashMismatch: 0, metadataMismatch: 0 },
      dryRun: false,
      driftPaths: [],
      driftPathsTruncated: false,
      status: 'completed',
    });
    expect(registry.running()).toBeNull();
    expect(registry.lastReport()?.jobId).toBe('rec-1');
    expect(registry.tryStart('rec-2', true, true, startedAt)).not.toBeNull();
  });

  it('ignores completion for an unknown job id', () => {
    const registry = new ReconcileJobRegistry();
    expect(() => registry.complete('rec-nope', {
      jobId: 'rec-nope',
      startedAt: '2026-11-15T02:00:00.000Z',
      finishedAt: '2026-11-15T02:00:01.000Z',
      durationMs: 1000,
      filesScanned: 0,
      indexRowsChecked: 0,
      driftFound: 0,
      driftRepaired: 0,
      driftRemaining: 0,
      skippedLocked: 0,
      categories: { orphanDisk: 0, phantomIndex: 0, hashMismatch: 0, metadataMismatch: 0 },
      dryRun: false,
      driftPaths: [],
      driftPathsTruncated: false,
      status: 'completed',
    })).not.toThrow();
    expect(registry.lastReport()).toBeNull();
  });

  it('fails a job and resolves idle waiters', async () => {
    const registry = new ReconcileJobRegistry();
    registry.tryStart('rec-1', true, false, new Date());
    let idle = false;
    const waiting = registry.waitForIdle().then(() => {
      idle = true;
    });
    registry.fail('rec-1', new Date());
    await waiting;
    expect(idle).toBe(true);
    expect(registry.lastRecord()?.status).toBe('failed');
    expect(registry.lastReport()).toBeNull();
  });

  it('resolves waitForIdle immediately when no job runs', async () => {
    const registry = new ReconcileJobRegistry();
    await expect(registry.waitForIdle()).resolves.toBeUndefined();
  });

  it('throws ApiError with the service code for a missing root', async () => {
    await expect(scanWorkspaceTree(join(tmpdir(), `reconcile-missing-${Date.now()}-x`))).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
