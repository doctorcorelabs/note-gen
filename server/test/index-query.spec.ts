// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the files index query layer (V3-06 part 2): version
// lookup hit/miss, name search, content search hooks, and stale
// version behavior, all against the in-memory store. The specs pin
// the frozen contracts: version null when no index row exists
// (desain-workspace-api.md section 1.4), version 1 for a new path
// and plus 1 per write (section 3.7 step 7), AND terms with
// case-insensitive containment and name-above-content ranking
// (desain-record-search.md section 8.3), and hidden paths answering
// as misses (desain-workspace-api.md section 8.6).

import { describe, expect, it } from 'vitest';
import { InvalidWorkspacePathError } from '../src/lib/paths.js';
import {
  buildContentSnippet,
  compareFileVersion,
  createWorkspaceIndexPort,
  InvalidIndexQueryError,
  lookupFileEntry,
  lookupFileVersion,
  searchFilesByContent,
  searchFilesByName,
  type FileContentProvider,
  type FilesIndexEntry,
} from '../src/services/index/query.js';
import { createInMemoryFilesIndexStore } from '../src/services/index/memory-store.js';

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';

function hash(char: string): string {
  return char.repeat(64);
}

function seedEntry(store: ReturnType<typeof createInMemoryFilesIndexStore>, entry: FilesIndexEntry): void {
  store.putEntry(entry);
}

function makeEntry(path: string, overrides: Partial<FilesIndexEntry> = {}): FilesIndexEntry {
  return {
    workspaceId: WS_A,
    path,
    contentHash: hash('a'),
    sizeBytes: 10,
    version: 1,
    mimeType: 'text/markdown',
    ...overrides,
  };
}

async function record(
  store: ReturnType<typeof createInMemoryFilesIndexStore>,
  path: string,
  overrides: { workspaceId?: string; contentHash?: string; sizeBytes?: number; eventType?: 'created' | 'changed' } = {},
): Promise<{ version: number }> {
  return store.recordWrite({
    workspaceId: overrides.workspaceId ?? WS_A,
    actorId: undefined,
    path,
    contentHash: overrides.contentHash ?? hash('a'),
    sizeBytes: overrides.sizeBytes ?? 10,
    mimeType: 'text/markdown',
    eventType: overrides.eventType ?? 'created',
    created: true,
  });
}

function mapProvider(contents: ReadonlyMap<string, string | null>): FileContentProvider {
  return {
    async readText(_workspaceId: string, path: string): Promise<string | null> {
      return contents.get(path) ?? null;
    },
  };
}

describe('version lookup', () => {
  it('returns the current version on a hit', async () => {
    const store = createInMemoryFilesIndexStore();
    await record(store, 'notes/a.md');
    await record(store, 'notes/a.md', { eventType: 'changed', contentHash: hash('b') });
    await expect(lookupFileVersion(store, WS_A, 'notes/a.md')).resolves.toBe(2);
    const entry = await lookupFileEntry(store, WS_A, 'notes/a.md');
    expect(entry).toEqual({
      workspaceId: WS_A,
      path: 'notes/a.md',
      contentHash: hash('b'),
      sizeBytes: 10,
      version: 2,
      mimeType: 'text/markdown',
    });
  });

  it('returns null for a path with no index row', async () => {
    const store = createInMemoryFilesIndexStore();
    await expect(lookupFileVersion(store, WS_A, 'notes/missing.md')).resolves.toBeNull();
    await expect(lookupFileEntry(store, WS_A, 'notes/missing.md')).resolves.toBeNull();
  });

  it('returns null for a row owned by another workspace', async () => {
    const store = createInMemoryFilesIndexStore();
    await record(store, 'notes/a.md');
    await expect(lookupFileVersion(store, WS_B, 'notes/a.md')).resolves.toBeNull();
  });

  it('returns null after the row is soft-deleted', async () => {
    const store = createInMemoryFilesIndexStore();
    await record(store, 'notes/a.md');
    expect(await store.markDeleted(WS_A, 'notes/a.md')).toBe(true);
    await expect(lookupFileVersion(store, WS_A, 'notes/a.md')).resolves.toBeNull();
    expect(await store.markDeleted(WS_A, 'notes/a.md')).toBe(false);
    expect(await store.markDeleted(WS_A, 'notes/never.md')).toBe(false);
  });

  it('restarts at version 1 when a deleted path is written again', async () => {
    const store = createInMemoryFilesIndexStore();
    await record(store, 'notes/a.md');
    await record(store, 'notes/a.md', { eventType: 'changed' });
    await store.markDeleted(WS_A, 'notes/a.md');
    await expect(record(store, 'notes/a.md')).resolves.toEqual({ version: 1 });
  });

  it('answers null for hidden paths without leaking existence', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('.hidden/gagal.md', { version: 5 }));
    seedEntry(store, makeEntry('notes/.dot.md', { version: 5 }));
    await expect(lookupFileVersion(store, WS_A, '.hidden/gagal.md')).resolves.toBeNull();
    await expect(lookupFileVersion(store, WS_A, 'notes/.dot.md')).resolves.toBeNull();
  });

  it('throws for syntactically invalid paths', async () => {
    const store = createInMemoryFilesIndexStore();
    for (const bad of ['../escape.md', '/abs.md', 'a//b.md', '', 'a\\b.md', 'a/./b.md', 42, null]) {
      await expect(lookupFileVersion(store, WS_A, bad)).rejects.toThrow(InvalidWorkspacePathError);
    }
  });
});

describe('stale version behavior', () => {
  it('reports current, then stale after a write, then missing after delete', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/a.md', { version: 7 }));
    await expect(compareFileVersion(store, WS_A, 'notes/a.md', 7)).resolves.toBe('current');
    await record(store, 'notes/a.md', { eventType: 'changed' });
    await expect(lookupFileVersion(store, WS_A, 'notes/a.md')).resolves.toBe(8);
    await expect(compareFileVersion(store, WS_A, 'notes/a.md', 7)).resolves.toBe('stale');
    await expect(compareFileVersion(store, WS_A, 'notes/a.md', 8)).resolves.toBe('current');
    await store.markDeleted(WS_A, 'notes/a.md');
    await expect(compareFileVersion(store, WS_A, 'notes/a.md', 8)).resolves.toBe('missing');
  });

  it('never serves a cached version: a lookup after a write sees the new version', async () => {
    const store = createInMemoryFilesIndexStore();
    await record(store, 'notes/a.md');
    await expect(lookupFileVersion(store, WS_A, 'notes/a.md')).resolves.toBe(1);
    await record(store, 'notes/a.md', { eventType: 'changed' });
    await record(store, 'notes/a.md', { eventType: 'changed' });
    await expect(lookupFileVersion(store, WS_A, 'notes/a.md')).resolves.toBe(3);
  });

  it('reports missing for a path the index never saw', async () => {
    const store = createInMemoryFilesIndexStore();
    await expect(compareFileVersion(store, WS_A, 'notes/new.md', 1)).resolves.toBe('missing');
  });

  it('rejects a non-positive expected version', async () => {
    const store = createInMemoryFilesIndexStore();
    await expect(compareFileVersion(store, WS_A, 'notes/a.md', 0)).rejects.toThrow(InvalidIndexQueryError);
    await expect(compareFileVersion(store, WS_A, 'notes/a.md', 1.5)).rejects.toThrow(InvalidIndexQueryError);
  });
});

describe('WorkspaceIndexPort adapter', () => {
  it('gives writes real versions instead of null', async () => {
    const store = createInMemoryFilesIndexStore();
    const port = createWorkspaceIndexPort(store);
    await expect(port.currentVersion(WS_A, 'notes/a.md')).resolves.toBeNull();
    await expect(
      port.recordWrite({
        workspaceId: WS_A,
        actorId: undefined,
        path: 'notes/a.md',
        contentHash: hash('a'),
        sizeBytes: 12,
        mimeType: 'text/markdown',
        eventType: 'created',
        created: true,
      }),
    ).resolves.toEqual({ version: 1 });
    await expect(port.currentVersion(WS_A, 'notes/a.md')).resolves.toBe(1);
    await expect(lookupFileVersion(store, WS_A, 'notes/a.md')).resolves.toBe(1);
  });
});

describe('name search', () => {
  it('ranks a name match above a directory-only match', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('kardiologi/gagal-jantung.md'));
    seedEntry(store, makeEntry('gagal/catatan.md'));
    seedEntry(store, makeEntry('notes/jantung-notes.md'));
    const results = await searchFilesByName(store, WS_A, 'gagal');
    expect(results.map((result) => result.path)).toEqual(['kardiologi/gagal-jantung.md', 'gagal/catatan.md']);
    expect(results[0]?.score).toBe(18);
    expect(results[1]?.score).toBe(7);
    expect(results[0]).toMatchObject({ title: 'gagal-jantung.md', version: 1, contentHash: hash('a') });
  });

  it('requires all terms and ignores case', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('kardiologi/gagal-jantung.md'));
    seedEntry(store, makeEntry('kardiologi/gagal-lain.md'));
    const results = await searchFilesByName(store, WS_A, 'GAGAL JANTUNG');
    expect(results.map((result) => result.path)).toEqual(['kardiologi/gagal-jantung.md']);
    expect(results[0]?.score).toBe(20);
  });

  it('gives a whole-phrase match a bonus over separate terms', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/gagal-jantung.md'));
    seedEntry(store, makeEntry('notes/gagal jantung.md'));
    const results = await searchFilesByName(store, WS_A, 'gagal jantung');
    expect(results.map((result) => result.path)).toEqual(['notes/gagal jantung.md', 'notes/gagal-jantung.md']);
    expect(results[0]?.score).toBe(28);
    expect(results[1]?.score).toBe(20);
  });

  it('breaks score ties by path ascending', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('b/gagal.md'));
    seedEntry(store, makeEntry('a/gagal.md'));
    const results = await searchFilesByName(store, WS_A, 'gagal');
    expect(results.map((result) => result.path)).toEqual(['a/gagal.md', 'b/gagal.md']);
  });

  it('excludes hidden, deleted, and other-workspace rows', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('.hidden/gagal.md'));
    seedEntry(store, makeEntry('notes/gagal.md', { workspaceId: WS_B }));
    seedEntry(store, makeEntry('notes/gagal-usang.md'));
    await store.markDeleted(WS_A, 'notes/gagal-usang.md');
    seedEntry(store, makeEntry('notes/gagal.md'));
    const results = await searchFilesByName(store, WS_A, 'gagal');
    expect(results.map((result) => result.path)).toEqual(['notes/gagal.md']);
    await expect(searchFilesByName(store, WS_B, 'gagal')).resolves.toHaveLength(1);
  });

  it('returns an empty list when nothing matches', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/a.md'));
    await expect(searchFilesByName(store, WS_A, 'zzzqqq')).resolves.toEqual([]);
  });

  it('rejects an empty, overlong, or non-string query', async () => {
    const store = createInMemoryFilesIndexStore();
    await expect(searchFilesByName(store, WS_A, '')).rejects.toThrow(InvalidIndexQueryError);
    await expect(searchFilesByName(store, WS_A, '   ')).rejects.toThrow(InvalidIndexQueryError);
    await expect(searchFilesByName(store, WS_A, 'x'.repeat(201))).rejects.toThrow(InvalidIndexQueryError);
    await expect(searchFilesByName(store, WS_A, 42)).rejects.toThrow(InvalidIndexQueryError);
    await expect(searchFilesByName(store, WS_A, 'x'.repeat(200))).resolves.toEqual([]);
  });

  it('applies the limit after ranking, with default 50 and max 200', async () => {
    const store = createInMemoryFilesIndexStore();
    for (let i = 0; i < 55; i += 1) {
      seedEntry(store, makeEntry(`bulk/note-${String(i).padStart(2, '0')}.md`));
    }
    const defaulted = await searchFilesByName(store, WS_A, 'note');
    expect(defaulted).toHaveLength(50);
    expect(defaulted[0]?.path).toBe('bulk/note-00.md');
    expect(defaulted[49]?.path).toBe('bulk/note-49.md');
    await expect(searchFilesByName(store, WS_A, 'note', { limit: 2 })).resolves.toHaveLength(2);
    await expect(searchFilesByName(store, WS_A, 'note', { limit: 500 })).resolves.toHaveLength(55);
    await expect(searchFilesByName(store, WS_A, 'note', { limit: 0 })).rejects.toThrow(InvalidIndexQueryError);
    await expect(searchFilesByName(store, WS_A, 'note', { limit: 1.5 })).rejects.toThrow(InvalidIndexQueryError);
  });
});

describe('content search hooks', () => {
  it('matches a term that only appears in content', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/ringkasan.md'));
    seedEntry(store, makeEntry('notes/lain.md'));
    const provider = mapProvider(
      new Map([
        ['notes/ringkasan.md', 'Tatalaksana gagal jantung akut di IGD.'],
        ['notes/lain.md', 'Tidak ada kata kunci di sini.'],
      ]),
    );
    const results = await searchFilesByContent(store, provider, WS_A, 'gagal jantung');
    expect(results.map((result) => result.path)).toEqual(['notes/ringkasan.md']);
    expect(results[0]?.score).toBe(9);
    expect(results[0]?.snippet).toBe('Tatalaksana gagal jantung akut di IGD.');
    expect(results[0]?.snippetField).toBe('content');
    expect(results[0]?.snippetMatches).toEqual([
      { start: 12, end: 17 },
      { start: 18, end: 25 },
    ]);
  });

  it('matches across fields: one term in the name, one in the content', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/gagal.md'));
    const provider = mapProvider(new Map([['notes/gagal.md', 'Catatan jantung akut.']]));
    const results = await searchFilesByContent(store, provider, WS_A, 'gagal jantung');
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(14);
  });

  it('ranks a name match above a content-only match', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/ringkasan.md'));
    seedEntry(store, makeEntry('notes/gagal-jantung.md'));
    const provider = mapProvider(
      new Map([
        ['notes/ringkasan.md', 'Tatalaksana gagal jantung akut.'],
        ['notes/gagal-jantung.md', 'Isi tanpa kata kunci.'],
      ]),
    );
    const results = await searchFilesByContent(store, provider, WS_A, 'gagal jantung');
    expect(results.map((result) => result.path)).toEqual(['notes/gagal-jantung.md', 'notes/ringkasan.md']);
  });

  it('centers the snippet on the first content match with valid offsets', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/panjang.md'));
    const content = `${'x'.repeat(500)} gagal ${'y'.repeat(500)}`;
    const provider = mapProvider(new Map([['notes/panjang.md', content]]));
    const results = await searchFilesByContent(store, provider, WS_A, 'gagal');
    expect(results).toHaveLength(1);
    const snippet = results[0]?.snippet ?? '';
    expect(snippet).toHaveLength(200);
    expect(snippet.indexOf('gagal')).toBe(100);
    expect(results[0]?.snippetMatches).toEqual([{ start: 100, end: 105 }]);
    for (const match of results[0]?.snippetMatches ?? []) {
      expect(snippet.slice(match.start, match.end).toLowerCase()).toBe('gagal');
    }
  });

  it('uses the head of the content when only the name matches', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/ringkasan.md'));
    const provider = mapProvider(new Map([['notes/ringkasan.md', 'Isi awal dokumen.']]));
    const results = await searchFilesByContent(store, provider, WS_A, 'ringkasan');
    expect(results[0]?.snippet).toBe('Isi awal dokumen.');
    expect(results[0]?.snippetField).toBe('content');
    expect(results[0]?.snippetMatches).toEqual([]);
  });

  it('keeps a name match when the provider has no text', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/ringkasan.md'));
    const provider = mapProvider(new Map());
    const results = await searchFilesByContent(store, provider, WS_A, 'ringkasan');
    expect(results[0]?.snippet).toBe('');
    expect(results[0]?.snippetField).toBe('name');
    expect(results[0]?.snippetMatches).toEqual([]);
  });

  it('treats a throwing provider as unavailable, without failing the search', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/ringkasan.md'));
    seedEntry(store, makeEntry('notes/lain.md'));
    const throwing: FileContentProvider = {
      async readText(): Promise<string | null> {
        throw new Error('disk gone');
      },
    };
    const results = await searchFilesByContent(store, throwing, WS_A, 'ringkasan');
    expect(results.map((result) => result.path)).toEqual(['notes/ringkasan.md']);
  });

  it('calls the provider once per searchable entry and never for hidden rows', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/a.md'));
    seedEntry(store, makeEntry('notes/b.md'));
    seedEntry(store, makeEntry('.hidden/c.md'));
    const calls: string[] = [];
    const provider: FileContentProvider = {
      async readText(_workspaceId: string, path: string): Promise<string | null> {
        calls.push(path);
        return 'gagal';
      },
    };
    const results = await searchFilesByContent(store, provider, WS_A, 'gagal');
    expect(results).toHaveLength(2);
    expect(calls.sort()).toEqual(['notes/a.md', 'notes/b.md']);
  });

  it('honors a smaller snippet length cap', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/panjang.md'));
    const provider = mapProvider(new Map([['notes/panjang.md', `${'x'.repeat(100)} gagal ${'y'.repeat(100)}`]]));
    const results = await searchFilesByContent(store, provider, WS_A, 'gagal', { maxSnippetLength: 20 });
    expect(results[0]?.snippet).toHaveLength(20);
    expect(results[0]?.snippet).toContain('gagal');
  });
});

describe('buildContentSnippet', () => {
  it('returns the head with no matches when no term occurs', () => {
    expect(buildContentSnippet('abcdef', ['zzz'], 3)).toEqual({ snippet: 'abc', matches: [] });
  });

  it('returns an empty snippet for empty content', () => {
    expect(buildContentSnippet('', ['gagal'])).toEqual({ snippet: '', matches: [] });
  });

  it('caps the snippet at 200 characters', () => {
    const built = buildContentSnippet('a'.repeat(500), ['a'], 500);
    expect(built.snippet).toHaveLength(200);
  });

  it('rejects a non-positive snippet length', () => {
    expect(() => buildContentSnippet('abc', ['a'], 0)).toThrow(InvalidIndexQueryError);
  });
});

describe('in-memory store', () => {
  it('lists active rows ordered by path and returns copies', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('b.md'));
    seedEntry(store, makeEntry('a.md'));
    seedEntry(store, makeEntry('a/c.md'));
    const listed = await store.listEntries(WS_A);
    expect(listed.map((entry) => entry.path)).toEqual(['a.md', 'a/c.md', 'b.md']);
    const first = await store.getEntry(WS_A, 'a.md');
    if (first !== null) {
      first.version = 99;
    }
    await expect(lookupFileVersion(store, WS_A, 'a.md')).resolves.toBe(1);
  });

  it('journals one event per write plus one per delete', async () => {
    const store = createInMemoryFilesIndexStore();
    await record(store, 'notes/a.md');
    await record(store, 'notes/a.md', { eventType: 'changed' });
    await store.markDeleted(WS_A, 'notes/a.md');
    expect(store.events()).toEqual([
      { workspaceId: WS_A, actorId: undefined, eventType: 'created', path: 'notes/a.md', previousPath: null },
      { workspaceId: WS_A, actorId: undefined, eventType: 'changed', path: 'notes/a.md', previousPath: null },
      { workspaceId: WS_A, actorId: undefined, eventType: 'deleted', path: 'notes/a.md', previousPath: null },
    ]);
  });

  it('seeds exact rows without journaling', async () => {
    const store = createInMemoryFilesIndexStore();
    seedEntry(store, makeEntry('notes/a.md', { version: 7 }));
    await expect(lookupFileVersion(store, WS_A, 'notes/a.md')).resolves.toBe(7);
    expect(store.events()).toEqual([]);
  });

  it('updates hash, size, and mime type on overwrite', async () => {
    const store = createInMemoryFilesIndexStore();
    await record(store, 'notes/a.md');
    await store.recordWrite({
      workspaceId: WS_A,
      actorId: undefined,
      path: 'notes/a.md',
      contentHash: hash('f'),
      sizeBytes: 42,
      mimeType: 'image/png',
      eventType: 'changed',
      created: false,
    });
    const entry = await lookupFileEntry(store, WS_A, 'notes/a.md');
    expect(entry).toMatchObject({ contentHash: hash('f'), sizeBytes: 42, mimeType: 'image/png', version: 2 });
  });
});
