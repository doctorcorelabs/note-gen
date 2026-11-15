// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Direct reader tests for the injection points V3-06 will use: an
// explicit workspace key for the revision formula and an index
// version lookup. These run against the reader and the route
// registrar directly, without the auth hook, to prove the wiring
// contract before the index exists.

import Fastify from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRevision } from '../../src/lib/revision.js';
import { registerWorkspaceReadRoutes } from '../../src/routes/workspace-read.js';
import { createWorkspaceReader } from '../../src/services/workspace/read.js';

describe('workspace reader injections', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'v3-04a-inject-'));
    await writeFile(join(dir, 'a.md'), 'hello');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses the injected workspace key in revisions', async () => {
    const reader = createWorkspaceReader({ workspaceRoot: dir, workspaceKey: 'ws-uuid-9' });
    const result = await reader.readFile('a.md', undefined);
    expect(result.revision).toBe(buildRevision('ws-uuid-9', 'a.md', 'hello'));
    const statResult = await reader.stat('a.md');
    expect(statResult.revision).toBe(buildRevision('ws-uuid-9', 'a.md', 'hello'));
  });

  it('reports injected versions and omits them when no resolver exists', async () => {
    const withIndex = createWorkspaceReader({
      workspaceRoot: dir,
      resolveVersion: async () => 7,
    });
    expect((await withIndex.stat('a.md')).entry.version).toBe(7);
    expect((await withIndex.readFile('a.md', undefined)).version).toBe(7);
    const listed = await withIndex.list('', {});
    expect(listed.entries[0]?.version).toBe(7);

    const withoutIndex = createWorkspaceReader({ workspaceRoot: dir });
    expect((await withoutIndex.stat('a.md')).entry.version).toBeNull();
    expect((await withoutIndex.readFile('a.md', undefined)).version).toBeNull();
  });

  it('exposes X-Version through the route when a version is injected', async () => {
    const app = Fastify();
    await registerWorkspaceReadRoutes(app, {
      workspaceRoot: dir,
      workspaceKey: 'ws-uuid-9',
      resolveVersion: async () => 7,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/workspace/file?path=a.md' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-version']).toBe('7');
      expect(res.headers['x-revision']).toBe(buildRevision('ws-uuid-9', 'a.md', 'hello'));
    } finally {
      await app.close();
    }
  });
});
