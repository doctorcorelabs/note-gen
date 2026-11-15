// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the files-index scanner (V3-06 part 1, wave 3B overlap,
// AD-57). Fixtures are temp directories built per test; the store is
// an in-memory fake implementing the FilesIndexStore port, standing
// in for the Postgres implementation owned by V3-06 part 2. No test
// here touches a database, the network, or the app factory.

import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceRootUnavailableError } from '../src/lib/paths.js';
import { buildRevision, contentHash, isRevision } from '../src/lib/revision.js';
import {
  INDEX_BATCH_SIZE,
  mimeTypeForScannedPath,
  planIndexSync,
  scanWorkspaceTree,
  syncIndexFromScan,
  type FilesIndexStore,
  type IndexRowSnapshot,
  type IndexSyncBatch,
  type ScannedFile,
} from '../src/services/index/scanner.js';

const WORKSPACE_KEY = 'test-workspace-key-v3b-06a';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop() as string;
    await rm(root, { recursive: true, force: true });
  }
});

async function write(root: string, rel: string, content: string): Promise<void> {
  const target = join(root, ...rel.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function pathsOf(entries: readonly ScannedFile[]): string[] {
  return entries.map((entry) => entry.path);
}

// In-memory fake for the FilesIndexStore port. Deletes remove the
// row from the active map, modelling the soft delete (deleted_at)
// the Postgres store performs; the fake keeps no tombstones because
// the scanner only ever reads active rows.
class FakeIndexStore implements FilesIndexStore {
  readonly rows = new Map<string, IndexRowSnapshot>();

  readonly applied: IndexSyncBatch[] = [];

  async listActive(_workspaceId: string): Promise<IndexRowSnapshot[]> {
    return [...this.rows.values()];
  }

  async applyBatch(_workspaceId: string, batch: IndexSyncBatch): Promise<void> {
    this.applied.push(batch);
    for (const upsert of batch.upserts) {
      const existing = this.rows.get(upsert.path);
      this.rows.set(upsert.path, {
        path: upsert.path,
        contentHash: upsert.contentHash,
        sizeBytes: upsert.sizeBytes,
        version: existing === undefined ? 1 : existing.version + 1,
        mimeType: upsert.mimeType,
      });
    }
    for (const path of batch.deletes) {
      this.rows.delete(path);
    }
  }
}

describe('scanWorkspaceTree', () => {
  it('walks a nested tree and returns sorted entries with frozen revision and hash values', async () => {
    const root = await makeRoot('notegen-scan-nested-');
    await write(root, 'b.md', '# B');
    await write(root, 'a/nested/deep.md', '# deep');
    await write(root, 'a/note.txt', 'hello');
    await write(root, 'a/image.png', 'fake-png-bytes');

    const { entries, stats } = await scanWorkspaceTree({
      workspaceRoot: root,
      workspaceKey: WORKSPACE_KEY,
    });

    expect(pathsOf(entries)).toEqual(['a/image.png', 'a/nested/deep.md', 'a/note.txt', 'b.md']);
    expect(stats.files).toBe(4);
    expect(stats.directoriesVisited).toBe(3);
    expect(stats.hashesComputed).toBe(4);
    expect(stats.hashesReused).toBe(0);

    const deep = entries.find((entry) => entry.path === 'a/nested/deep.md') as ScannedFile;
    expect(deep.name).toBe('deep.md');
    expect(deep.sizeBytes).toBe(6);
    expect(deep.modifiedAt).toBeInstanceOf(Date);
    expect(deep.createdAt === null || deep.createdAt instanceof Date).toBe(true);
    expect(deep.contentHash).toBe(contentHash(Buffer.from('# deep', 'utf8')));
    expect(deep.revision).toBe(buildRevision(WORKSPACE_KEY, 'a/nested/deep.md', Buffer.from('# deep', 'utf8')));
    expect(isRevision(deep.revision)).toBe(true);
    expect(deep.mimeType).toBe('text/markdown');

    const txt = entries.find((entry) => entry.path === 'a/note.txt') as ScannedFile;
    expect(txt.mimeType).toBe('text/plain');
    const png = entries.find((entry) => entry.path === 'a/image.png') as ScannedFile;
    expect(png.mimeType).toBeNull();

    // The scan never writes disk: contents are untouched.
    expect(await readFile(join(root, 'b.md'), 'utf8')).toBe('# B');
  });

  it('skips hidden paths per desain 8.4 but keeps node_modules and skills visible', async () => {
    const root = await makeRoot('notegen-scan-hidden-');
    await write(root, 'visible.md', 'v');
    await write(root, '.git/config', 'git');
    await write(root, '.DS_Store', 'ds');
    await write(root, '.notegen/cache.bin', 'cache');
    await write(root, '.notegen-tmp-12345', 'temp');
    await write(root, 'sub/.hidden/secret.md', 'secret');
    await write(root, 'sub/.hiddenfile.md', 'hidden');
    await write(root, 'node_modules/pkg/readme.md', 'pkg');
    await write(root, 'skills/skill.md', 'skill');

    const { entries, stats } = await scanWorkspaceTree({
      workspaceRoot: root,
      workspaceKey: WORKSPACE_KEY,
    });

    expect(pathsOf(entries)).toEqual([
      'node_modules/pkg/readme.md',
      'skills/skill.md',
      'visible.md',
    ]);
    expect(stats.skippedHidden).toBe(6);
  });

  it('produces no entries for empty directories and does not fail on them', async () => {
    const root = await makeRoot('notegen-scan-empty-');
    await mkdir(join(root, 'empty'), { recursive: true });
    await mkdir(join(root, 'a', 'b', 'c'), { recursive: true });
    await write(root, 'only.md', 'one');

    const { entries, stats } = await scanWorkspaceTree({
      workspaceRoot: root,
      workspaceKey: WORKSPACE_KEY,
    });

    expect(pathsOf(entries)).toEqual(['only.md']);
    expect(stats.files).toBe(1);
    expect(stats.directoriesVisited).toBe(5);

    const bare = await makeRoot('notegen-scan-bare-');
    const bareResult = await scanWorkspaceTree({ workspaceRoot: bare, workspaceKey: WORKSPACE_KEY });
    expect(bareResult.entries).toEqual([]);
    expect(bareResult.stats.files).toBe(0);
    expect(bareResult.stats.directoriesVisited).toBe(1);
  });

  it('rejects symlinks silently: file links, dir links, outside links, and broken links', async () => {
    const root = await makeRoot('notegen-scan-symlink-');
    const outside = await makeRoot('notegen-scan-outside-');
    await write(root, 'real.md', 'real');
    await write(root, 'dir/inner.md', 'inner');
    await write(outside, 'outside.md', 'outside');
    await symlink(join(root, 'real.md'), join(root, 'link-file.md'));
    await symlink(join(root, 'dir'), join(root, 'link-dir'));
    await symlink(join(outside, 'outside.md'), join(root, 'link-outside.md'));
    await symlink(join(root, 'missing-target.md'), join(root, 'link-broken.md'));

    const { entries, stats } = await scanWorkspaceTree({
      workspaceRoot: root,
      workspaceKey: WORKSPACE_KEY,
    });

    // The symlinked directory is not traversed, so dir/inner.md
    // appears once, through the real directory only.
    expect(pathsOf(entries)).toEqual(['dir/inner.md', 'real.md']);
    expect(stats.skippedSymlinks).toBe(4);
  });

  it('reuses hashes on the fast path and rehashes only changed files', async () => {
    const root = await makeRoot('notegen-scan-fastpath-');
    await write(root, 'a.md', 'aaa');
    await write(root, 'b.md', 'bbb');

    const first = await scanWorkspaceTree({ workspaceRoot: root, workspaceKey: WORKSPACE_KEY });
    expect(first.stats.hashesComputed).toBe(2);

    const known = await Promise.all(
      first.entries.map(async (entry) => {
        const info = await stat(join(root, ...entry.path.split('/')));
        return {
          path: entry.path,
          sizeBytes: entry.sizeBytes,
          modifiedAtMs: info.mtimeMs,
          contentHash: entry.contentHash,
          revision: entry.revision,
        };
      }),
    );
    const second = await scanWorkspaceTree({
      workspaceRoot: root,
      workspaceKey: WORKSPACE_KEY,
      known,
    });
    expect(second.stats.hashesComputed).toBe(0);
    expect(second.stats.hashesReused).toBe(2);
    expect(second.entries).toEqual(first.entries);

    // Change one file and force a new mtime so the change is visible
    // even on coarse filesystems.
    await write(root, 'b.md', 'bbb-changed');
    const info = await stat(join(root, 'b.md'));
    await utimes(join(root, 'b.md'), info.atime, new Date(info.mtimeMs + 10_000));
    const third = await scanWorkspaceTree({
      workspaceRoot: root,
      workspaceKey: WORKSPACE_KEY,
      known,
    });
    expect(third.stats.hashesComputed).toBe(1);
    expect(third.stats.hashesReused).toBe(1);
    const changed = third.entries.find((entry) => entry.path === 'b.md') as ScannedFile;
    expect(changed.contentHash).toBe(contentHash(Buffer.from('bbb-changed', 'utf8')));
    expect(changed.revision).toBe(
      buildRevision(WORKSPACE_KEY, 'b.md', Buffer.from('bbb-changed', 'utf8')),
    );
  });

  it(
    'handles a large tree: 300 files across nested directories',
    async () => {
      const root = await makeRoot('notegen-scan-large-');
      const pending: Promise<void>[] = [];
      for (let dir = 0; dir < 20; dir += 1) {
        for (let file = 0; file < 15; file += 1) {
          pending.push(write(root, `d${dir}/f${file}.md`, `# file ${dir}/${file}\nbody\n`));
        }
      }
      await Promise.all(pending);
      const { entries, stats } = await scanWorkspaceTree({
        workspaceRoot: root,
        workspaceKey: WORKSPACE_KEY,
      });
      expect(entries).toHaveLength(300);
      expect(stats.files).toBe(300);
      expect(stats.hashesComputed).toBe(300);
      expect(pathsOf(entries)).toEqual([...pathsOf(entries)].sort());
      for (const entry of entries) {
        expect(isRevision(entry.revision)).toBe(true);
        expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
      }
    },
    30000,
  );

  it('throws WorkspaceRootUnavailableError for a missing root or a file root', async () => {
    const root = await makeRoot('notegen-scan-noroot-');
    await expect(
      scanWorkspaceTree({ workspaceRoot: join(root, 'missing'), workspaceKey: WORKSPACE_KEY }),
    ).rejects.toBeInstanceOf(WorkspaceRootUnavailableError);

    const fileRoot = join(root, 'afile.md');
    await writeFile(fileRoot, 'x', 'utf8');
    await expect(
      scanWorkspaceTree({ workspaceRoot: fileRoot, workspaceKey: WORKSPACE_KEY }),
    ).rejects.toBeInstanceOf(WorkspaceRootUnavailableError);
  });

  it('skips paths over the segment limit and counts them', async () => {
    const root = await makeRoot('notegen-scan-limits-');
    const deepSegments = Array.from({ length: 51 }, (_v, i) => `s${i}`);
    await write(root, `${deepSegments.join('/')}.md`, 'too deep');
    await write(root, 'ok.md', 'ok');
    const { entries, stats } = await scanWorkspaceTree({
      workspaceRoot: root,
      workspaceKey: WORKSPACE_KEY,
    });
    expect(pathsOf(entries)).toEqual(['ok.md']);
    expect(stats.skippedOverLimit).toBeGreaterThanOrEqual(1);
  });

  it('keeps lstat evidence: a symlink entry is a symlink on disk, not a missed file', async () => {
    const root = await makeRoot('notegen-scan-lstat-');
    await write(root, 'real.md', 'real');
    await symlink(join(root, 'real.md'), join(root, 'alias.md'));
    const aliasStats = await lstat(join(root, 'alias.md'));
    expect(aliasStats.isSymbolicLink()).toBe(true);
    const { entries } = await scanWorkspaceTree({ workspaceRoot: root, workspaceKey: WORKSPACE_KEY });
    expect(pathsOf(entries)).toEqual(['real.md']);
  });
});

describe('mimeTypeForScannedPath', () => {
  it('maps .md and .txt case-sensitively, null otherwise', () => {
    expect(mimeTypeForScannedPath('a.md')).toBe('text/markdown');
    expect(mimeTypeForScannedPath('a/b.txt')).toBe('text/plain');
    expect(mimeTypeForScannedPath('a.MD')).toBeNull();
    expect(mimeTypeForScannedPath('a.png')).toBeNull();
    expect(mimeTypeForScannedPath('a.markdown')).toBeNull();
    expect(mimeTypeForScannedPath('md')).toBeNull();
  });
});

describe('planIndexSync', () => {
  function scannedFile(path: string, hash: string): ScannedFile {
    return {
      path,
      name: path.split('/').pop() as string,
      sizeBytes: 3,
      modifiedAt: new Date('2026-11-15T00:00:00.000Z'),
      createdAt: null,
      contentHash: hash,
      revision: `sha256:${'0'.repeat(64)}`,
      mimeType: 'text/markdown',
    };
  }

  function indexRow(path: string, hash: string): IndexRowSnapshot {
    return { path, contentHash: hash, sizeBytes: 3, version: 1, mimeType: 'text/markdown' };
  }

  it('classifies orphan, hash mismatch, phantom, and no-op rows', () => {
    const scanned = [
      scannedFile('changed.md', 'b'.repeat(64)),
      scannedFile('new.md', 'c'.repeat(64)),
      scannedFile('same.md', 'a'.repeat(64)),
    ];
    const rows = [
      indexRow('changed.md', 'a'.repeat(64)),
      indexRow('gone.md', 'd'.repeat(64)),
      indexRow('same.md', 'a'.repeat(64)),
    ];
    const plan = planIndexSync(scanned, rows);
    expect(plan.summary).toEqual({
      orphanDisk: 1,
      phantomIndex: 1,
      hashMismatch: 1,
      metadataMismatch: 0,
    });
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]?.upserts.map((u) => u.path)).toEqual(['changed.md', 'new.md']);
    expect(plan.batches[0]?.deletes).toEqual(['gone.md']);
    // Upsert fields match IndexWriteInput names and types exactly.
    const upsert = plan.batches[0]?.upserts[0];
    expect(upsert?.contentHash).toBe('b'.repeat(64));
    expect(upsert?.sizeBytes).toBe(3);
    expect(upsert?.mimeType).toBe('text/markdown');
  });

  it('yields zero batches when disk and index agree', () => {
    const scanned = [scannedFile('a.md', 'a'.repeat(64))];
    const rows = [indexRow('a.md', 'a'.repeat(64))];
    const plan = planIndexSync(scanned, rows);
    expect(plan.batches).toEqual([]);
    expect(plan.summary).toEqual({
      orphanDisk: 0,
      phantomIndex: 0,
      hashMismatch: 0,
      metadataMismatch: 0,
    });
  });

  it('chunks operations into batches of INDEX_BATCH_SIZE', () => {
    const scanned = Array.from({ length: INDEX_BATCH_SIZE + 1 }, (_v, i) =>
      scannedFile(`f${i}.md`, 'a'.repeat(64)),
    );
    const plan = planIndexSync(scanned, []);
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches[0]?.upserts).toHaveLength(INDEX_BATCH_SIZE);
    expect(plan.batches[1]?.upserts).toHaveLength(1);
    expect(plan.summary.orphanDisk).toBe(INDEX_BATCH_SIZE + 1);

    const exact = Array.from({ length: INDEX_BATCH_SIZE }, (_v, i) =>
      scannedFile(`g${i}.md`, 'a'.repeat(64)),
    );
    expect(planIndexSync(exact, []).batches).toHaveLength(1);
  });
});

describe('syncIndexFromScan with a fake store', () => {
  it('applies upserts, converges to zero batches, then applies deletes', async () => {
    const root = await makeRoot('notegen-scan-sync-');
    await write(root, 'a.md', 'aaa');
    await write(root, 'b.md', 'bbb');
    const store = new FakeIndexStore();

    const first = await syncIndexFromScan(store, {
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      workspaceKey: WORKSPACE_KEY,
    });
    expect(first.scanned).toBe(2);
    expect(first.batchesApplied).toBe(1);
    expect(first.upsertsApplied).toBe(2);
    expect(first.deletesApplied).toBe(0);
    expect(first.summary.orphanDisk).toBe(2);
    expect(store.rows.size).toBe(2);
    expect(store.rows.get('a.md')?.version).toBe(1);

    const second = await syncIndexFromScan(store, {
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      workspaceKey: WORKSPACE_KEY,
    });
    expect(second.batchesApplied).toBe(0);
    expect(store.applied).toHaveLength(1);

    await write(root, 'a.md', 'aaa-changed');
    await rm(join(root, 'b.md'));
    const third = await syncIndexFromScan(store, {
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      workspaceKey: WORKSPACE_KEY,
    });
    expect(third.upsertsApplied).toBe(1);
    expect(third.deletesApplied).toBe(1);
    expect(third.summary.hashMismatch).toBe(1);
    expect(third.summary.phantomIndex).toBe(1);
    expect(store.rows.has('b.md')).toBe(false);
    expect(store.rows.get('a.md')?.version).toBe(2);
    expect(store.rows.get('a.md')?.contentHash).toBe(contentHash(Buffer.from('aaa-changed', 'utf8')));
  });

  it('propagates a store failure without claiming a clean sync', async () => {
    const root = await makeRoot('notegen-scan-syncfail-');
    await write(root, 'a.md', 'aaa');
    const failing: FilesIndexStore = {
      listActive: async () => [],
      applyBatch: async () => {
        throw new Error('store down');
      },
    };
    await expect(
      syncIndexFromScan(failing, {
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        workspaceKey: WORKSPACE_KEY,
      }),
    ).rejects.toThrow('store down');
  });
});
