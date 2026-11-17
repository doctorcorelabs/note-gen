// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Route census for W4-WIRE (Gelombang 4): the routes this slot
// wires into buildApp must be present in the built app, the
// excepted routes must stay absent, and a wrong method on a
// newly wired path must answer 405 (W4-FAILCLOSED semantics),
// not 404. The expected set grows with each W4-WIRE increment;
// the final set is the 32 HTTP routes outside the exceptions
// (AD-114: backup-7 + admin-4 stay excepted, never registered).
//
// Presence is probed behaviorally, not by introspection: every
// route in this slot requires a session, so a request with no
// credentials answers 401 when the route is registered and 404
// when it is not. The 405 probes use a wrong method on a known
// path, which the not-found handler answers without reaching
// auth. Counting convention (V3-41 census): one route is one
// (method, path) pair; the media wildcard registers GET and
// HEAD explicitly, so both are probed.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './auth/helpers.js';

// Increment 1 (adapters 60/70/80): workspace structure (10),
// reconcile (2), media wildcard (2).
// Increment 2 (adapter 130): record assets (2).
// Increment 3 (adapter 120): search (2, fuzzy stub included). Concrete ids stand in for
// :id segments; the wildcard probe uses a nested media path.
const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/api/workspace/mkdir'],
  ['POST', '/api/workspace/move'],
  ['POST', '/api/workspace/move/repair-links'],
  ['DELETE', '/api/workspace/file'],
  ['DELETE', '/api/workspace/folder'],
  ['GET', '/api/workspace/trash'],
  ['POST', '/api/workspace/trash'],
  ['POST', '/api/workspace/trash/123/restore'],
  ['DELETE', '/api/workspace/trash/123'],
  ['DELETE', '/api/workspace/trash'],
  ['POST', '/api/workspace/reconcile'],
  ['GET', '/api/workspace/reconcile'],
  ['GET', '/api/workspace/media/pic.png'],
  ['HEAD', '/api/workspace/media/pic.png'],
  ['POST', '/api/assets'],
  ['GET', '/api/assets/ast_0123456789abcdef0123456789abcdef'],
  ['GET', '/api/search'],
  ['POST', '/api/search/fuzzy'],
];

// Excepted routes (AD-114, kontrak 3.10/3.13): backup CRUD (7)
// and admin (4) must NOT be registered by this slot. The backup
// restore stub is a separate contract row and is not in this
// list.
const EXCEPTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/api/backups'],
  ['GET', '/api/backups'],
  ['GET', '/api/backups/abc'],
  ['GET', '/api/backups/abc/download'],
  ['POST', '/api/backups/export'],
  ['GET', '/api/backups/downloads/token-1'],
  ['GET', '/api/backups/jobs/job-1'],
  ['GET', '/api/admin/users'],
  ['POST', '/api/admin/users/abc/disable'],
  ['POST', '/api/admin/users/abc/restore'],
  ['DELETE', '/api/admin/users/abc/sessions/sess-1'],
];

describe('W4-WIRE route census', () => {
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

  async function censusApp(): Promise<FastifyInstance> {
    dir = await mkdtemp(join(tmpdir(), 'w4wire-census-'));
    app = await buildApp({ config: testConfig({ workspaceRoot: dir }), pool: null, version: 'test' });
    return app;
  }

  it('registers every increment-1 to increment-3 route (unauthenticated probe answers 401, not 404)', async () => {
    const built = await censusApp();
    for (const [method, url] of EXPECTED_ROUTES) {
      const res = await built.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('does not register excepted backup/admin routes (probe answers 404)', async () => {
    const built = await censusApp();
    for (const [method, url] of EXCEPTED_ROUTES) {
      const res = await built.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('answers 405 for a wrong method on newly wired paths', async () => {
    const built = await censusApp();
    for (const target of [
      { method: 'GET', url: '/api/workspace/mkdir' },
      { method: 'PUT', url: '/api/workspace/reconcile' },
      { method: 'POST', url: '/api/workspace/media/pic.png' },
      { method: 'GET', url: '/api/workspace/trash/abc' },
    ] as const) {
      const res = await built.inject({ method: target.method, url: target.url });
      expect(res.statusCode, `${target.method} ${target.url}`).toBe(405);
      const body = res.json() as { ok: boolean; error: { code: string; retryable: boolean } };
      expect(body.error.code).toBe('method_not_allowed');
      expect(body.error.retryable).toBe(false);
    }
  });
});
