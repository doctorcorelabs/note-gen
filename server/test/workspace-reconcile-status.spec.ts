// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// GET /api/workspace/reconcile status route (W4-WIRE, S5-Q5):
// the alert-rule computation over the shared job registry, plus
// the HTTP surface through buildApp. Thresholds are the desain
// 4.5 alert table: warning at 5 remaining entries or 1 percent
// of scanned files; critical at 50 entries, 5 percent, the same
// path drifting in two consecutive full scans, or two total job
// failures in a row.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  type SessionPrincipal,
} from '../src/middleware/auth-hook.js';
import { computeReconcileStatus } from '../src/routes/workspace-reconcile.js';
import {
  ReconcileJobRegistry,
  type ReconcileReport,
} from '../src/services/workspace/reconcile.js';
import { testConfig } from './auth/helpers.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const TEST_PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'sess-1' };

function makeReport(overrides: Partial<ReconcileReport> = {}): ReconcileReport {
  return {
    jobId: 'rec-test-1',
    startedAt: '2026-11-17T13:00:00.000Z',
    finishedAt: '2026-11-17T13:00:01.000Z',
    durationMs: 1000,
    filesScanned: 1000,
    indexRowsChecked: 1000,
    driftFound: 0,
    driftRepaired: 0,
    driftRemaining: 0,
    skippedLocked: 0,
    categories: { orphanDisk: 0, phantomIndex: 0, hashMismatch: 0, metadataMismatch: 0 },
    dryRun: false,
    driftPaths: [],
    driftPathsTruncated: false,
    status: 'completed',
    ...overrides,
  };
}

function completeRun(registry: ReconcileJobRegistry, report: ReconcileReport): void {
  const started = registry.tryStart(report.jobId, true, report.dryRun, new Date(report.startedAt));
  expect(started).not.toBeNull();
  registry.complete(report.jobId, report);
}

function failRun(registry: ReconcileJobRegistry, jobId: string): void {
  const started = registry.tryStart(jobId, true, false, new Date());
  expect(started).not.toBeNull();
  registry.fail(jobId, new Date());
}

describe('computeReconcileStatus', () => {
  it('reports an empty, non-alerting status before any run', () => {
    const status = computeReconcileStatus(new ReconcileJobRegistry());
    expect(status.running).toBe(false);
    expect(status.lastRun).toBeNull();
    expect(status.driftWarning).toBe(false);
    expect(status.driftCritical).toBe(false);
    expect(status.watcherDegraded).toBe(true);
    expect(status.nextScheduledRunAt).toBeNull();
  });

  it('reports running while a job is in flight', () => {
    const registry = new ReconcileJobRegistry();
    expect(registry.tryStart('rec-1', true, false, new Date())).not.toBeNull();
    expect(computeReconcileStatus(registry).running).toBe(true);
  });

  it('warns at 5 remaining entries and stays quiet below', () => {
    const quiet = new ReconcileJobRegistry();
    completeRun(quiet, makeReport({ driftRemaining: 4, driftFound: 4, driftPaths: ['a.md'] }));
    expect(computeReconcileStatus(quiet).driftWarning).toBe(false);
    const warned = new ReconcileJobRegistry();
    completeRun(warned, makeReport({ driftRemaining: 5, driftFound: 5, driftPaths: ['a.md'] }));
    const status = computeReconcileStatus(warned);
    expect(status.driftWarning).toBe(true);
    expect(status.driftCritical).toBe(false);
    expect(status.lastRun?.driftRemaining).toBe(5);
  });

  it('warns at a 1 percent drift ratio even under 5 entries', () => {
    const registry = new ReconcileJobRegistry();
    completeRun(
      registry,
      makeReport({ filesScanned: 100, driftRemaining: 1, driftFound: 1, driftPaths: ['a.md'] }),
    );
    expect(computeReconcileStatus(registry).driftWarning).toBe(true);
  });

  it('goes critical at 50 entries or a 5 percent ratio', () => {
    const byCount = new ReconcileJobRegistry();
    completeRun(byCount, makeReport({ driftRemaining: 50, driftFound: 50, driftPaths: ['a.md'] }));
    expect(computeReconcileStatus(byCount).driftCritical).toBe(true);
    const byRatio = new ReconcileJobRegistry();
    completeRun(
      byRatio,
      makeReport({ filesScanned: 100, driftRemaining: 5, driftFound: 5, driftPaths: ['a.md'] }),
    );
    expect(computeReconcileStatus(byRatio).driftCritical).toBe(true);
  });

  it('goes critical when the same path drifts in two consecutive scans', () => {
    const registry = new ReconcileJobRegistry();
    completeRun(
      registry,
      makeReport({ jobId: 'rec-1', driftRemaining: 1, driftFound: 1, driftPaths: ['x.md'] }),
    );
    completeRun(
      registry,
      makeReport({ jobId: 'rec-2', driftRemaining: 1, driftFound: 1, driftPaths: ['x.md', 'y.md'] }),
    );
    expect(computeReconcileStatus(registry).driftCritical).toBe(true);
    const disjoint = new ReconcileJobRegistry();
    completeRun(
      disjoint,
      makeReport({ jobId: 'rec-1', driftRemaining: 1, driftFound: 1, driftPaths: ['x.md'] }),
    );
    completeRun(
      disjoint,
      makeReport({ jobId: 'rec-2', driftRemaining: 1, driftFound: 1, driftPaths: ['y.md'] }),
    );
    expect(computeReconcileStatus(disjoint).driftCritical).toBe(false);
  });

  it('goes critical after two consecutive failures and recovers on completion', () => {
    const registry = new ReconcileJobRegistry();
    failRun(registry, 'rec-1');
    expect(computeReconcileStatus(registry).driftCritical).toBe(false);
    failRun(registry, 'rec-2');
    expect(computeReconcileStatus(registry).driftCritical).toBe(true);
    completeRun(registry, makeReport({ jobId: 'rec-3' }));
    const status = computeReconcileStatus(registry);
    expect(status.driftCritical).toBe(false);
    expect(status.lastRun?.jobId).toBe('rec-3');
  });

  it('keeps the last completed report behind a failed tail', () => {
    const registry = new ReconcileJobRegistry();
    completeRun(registry, makeReport({ jobId: 'rec-1', driftRemaining: 2, driftFound: 2 }));
    failRun(registry, 'rec-2');
    const status = computeReconcileStatus(registry);
    expect(status.lastRun?.jobId).toBe('rec-1');
    expect(status.driftCritical).toBe(false);
  });
});

describe('GET /api/workspace/reconcile over HTTP', () => {
  let app: FastifyInstance | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('answers the empty status shape for an authenticated session', async () => {
    dir = await mkdtemp(join(tmpdir(), 'w4wire-reconcile-'));
    app = await buildApp({
      config: testConfig({ workspaceRoot: dir }),
      pool: null,
      version: 'test',
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? TEST_PRINCIPAL : null),
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
      verifyOrigin: defaultVerifyOrigin,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/workspace/reconcile',
      headers: { cookie: 'notegen_session=good-session', origin: TEST_ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data['running']).toBe(false);
    expect(body.data['lastRun']).toBeNull();
    expect(body.data['driftWarning']).toBe(false);
    expect(body.data['driftCritical']).toBe(false);
    expect(body.data['watcherDegraded']).toBe(true);
    expect(body.data['nextScheduledRunAt']).toBeNull();
  });

  it('requires a session', async () => {
    dir = await mkdtemp(join(tmpdir(), 'w4wire-reconcile-'));
    app = await buildApp({
      config: testConfig({ workspaceRoot: dir }),
      pool: null,
      version: 'test',
      verifySession: async () => null,
      verifyCsrf: async () => false,
      verifyOrigin: defaultVerifyOrigin,
    });
    const res = await app.inject({ method: 'GET', url: '/api/workspace/reconcile' });
    expect(res.statusCode).toBe(401);
  });

  it('answers 503 for POST without a database URL (fail-closed, no index)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'w4wire-reconcile-'));
    app = await buildApp({
      config: testConfig({ workspaceRoot: dir }),
      pool: null,
      version: 'test',
      verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? TEST_PRINCIPAL : null),
      verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
      verifyOrigin: defaultVerifyOrigin,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/reconcile',
      headers: {
        cookie: 'notegen_session=good-session',
        origin: TEST_ORIGIN,
        'x-csrf-token': 'good-csrf',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('service_unavailable');
  });
});
