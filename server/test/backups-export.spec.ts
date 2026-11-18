// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the minimal workspace export assembly (R24-DEC2E, AD-201
// item 2A). The assembly is exercised through a fake reader, so no
// filesystem or HTTP harness is needed: these specs pin the document
// shape, the omission honesty rules, and the fail-closed size caps.
// Wire behavior (auth, CSRF, headers) belongs to the gate live
// verification, not to this spec.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/plugins/envelope.js';
import {
  buildWorkspaceExport,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type WorkspaceExportReader,
} from '../src/services/workspace/export.js';
import type {
  ListResult,
  PaginationQuery,
  ReadFileResult,
  WorkspaceEntry,
} from '../src/services/workspace/read.js';

function entry(path: string, isDirectory: boolean, size: number | null): WorkspaceEntry {
  const name = path.split('/').at(-1) ?? path;
  return {
    name,
    path,
    isDirectory,
    isFile: !isDirectory,
    size,
    modifiedAt: null,
    createdAt: null,
    revision: null,
    version: null,
    isLocale: true,
  };
}

interface FakeTree {
  folders: Record<string, WorkspaceEntry[]>;
  contents: Record<string, string | ApiError>;
}

function fakeReader(tree: FakeTree, pageSize?: number): WorkspaceExportReader {
  return {
    async list(pathInput: unknown, query: PaginationQuery): Promise<ListResult> {
      const folder = String(pathInput ?? '');
      const all = tree.folders[folder] ?? [];
      const size = pageSize ?? all.length;
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const page = all.slice(start, start + size);
      const hasMore = start + page.length < all.length;
      return {
        path: folder,
        entries: page,
        nextCursor: hasMore ? String(start + page.length) : null,
        hasMore,
      };
    },
    async readFile(pathInput: unknown): Promise<ReadFileResult> {
      const path = String(pathInput ?? '');
      const stored = tree.contents[path];
      if (stored instanceof ApiError) {
        throw stored;
      }
      if (typeof stored !== 'string') {
        throw ApiError.notFound();
      }
      return {
        notModified: false,
        text: stored,
        contentType: 'text/markdown',
        revision: 'rev',
        version: null,
        size: Buffer.byteLength(stored, 'utf8'),
        modifiedAt: new Date(0),
      };
    },
  };
}

const TREE: FakeTree = {
  folders: {
    '': [entry('notes', true, null), entry('a.md', false, 5)],
    notes: [entry('notes/b.md', false, 5), entry('notes/pic.png', false, 9)],
  },
  contents: {
    'a.md': 'hello',
    'notes/b.md': 'world',
    'notes/pic.png': new ApiError(415, 'not_text_file', 'The file is not a text file.'),
  },
};

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

describe('buildWorkspaceExport', () => {
  it('collects nested text files sorted by path with hashes and counts', async () => {
    const document = await buildWorkspaceExport(fakeReader(TREE), {
      exportedAt: '2026-11-18T00:00:00.000Z',
    });
    expect(document.format).toBe(EXPORT_FORMAT);
    expect(document.version).toBe(EXPORT_VERSION);
    expect(document.exportedAt).toBe('2026-11-18T00:00:00.000Z');
    expect(document.files.map((file) => file.path)).toEqual(['a.md', 'notes/b.md']);
    expect(document.files[0]).toEqual({
      path: 'a.md',
      size: 5,
      sha256: sha256('hello'),
      content: 'hello',
    });
    expect(document.fileCount).toBe(2);
    expect(document.totalBytes).toBe(10);
    expect(document.omittedCount).toBe(1);
  });

  it('lists unreadable files as omitted with catalog reasons and keeps going', async () => {
    const document = await buildWorkspaceExport(fakeReader(TREE));
    expect(document.omitted).toEqual([
      { path: 'notes/pic.png', size: 9, reason: 'not_text_file' },
    ]);
    expect(document.files).toHaveLength(2);
  });

  it('omits files that vanish or fail decoding instead of failing', async () => {
    const tree: FakeTree = {
      folders: {
        '': [entry('gone.md', false, 3), entry('bad.md', false, 3), entry('ok.md', false, 2)],
      },
      contents: {
        'gone.md': ApiError.notFound(),
        'bad.md': new ApiError(422, 'invalid_text_encoding', 'The file is not valid UTF-8 text.'),
        'ok.md': 'ok',
      },
    };
    const document = await buildWorkspaceExport(fakeReader(tree));
    expect(document.files.map((file) => file.path)).toEqual(['ok.md']);
    expect(document.omitted).toEqual([
      { path: 'bad.md', size: 3, reason: 'invalid_text_encoding' },
      { path: 'gone.md', size: 3, reason: 'not_found' },
    ]);
  });

  it('follows list pagination cursors until the folder is exhausted', async () => {
    const document = await buildWorkspaceExport(fakeReader(TREE, 1));
    expect(document.files.map((file) => file.path)).toEqual(['a.md', 'notes/b.md']);
    expect(document.omitted).toHaveLength(1);
  });

  it('fails closed with payload_too_large past the file cap', async () => {
    const error = await buildWorkspaceExport(fakeReader(TREE), { maxFiles: 1 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(413);
    expect((error as ApiError).code).toBe('payload_too_large');
  });

  it('fails closed with payload_too_large past the byte cap', async () => {
    const error = await buildWorkspaceExport(fakeReader(TREE), {
      maxTotalBytes: 6,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(413);
    expect((error as ApiError).code).toBe('payload_too_large');
  });

  it('rethrows unexpected reader failures instead of inventing omissions', async () => {
    const reader = fakeReader(TREE);
    const failing: WorkspaceExportReader = {
      list: reader.list,
      readFile: async () => {
        throw ApiError.serviceUnavailable();
      },
    };
    const error = await buildWorkspaceExport(failing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('service_unavailable');
  });

  it('returns an empty document for an empty workspace', async () => {
    const document = await buildWorkspaceExport(fakeReader({ folders: { '': [] }, contents: {} }));
    expect(document.files).toEqual([]);
    expect(document.omitted).toEqual([]);
    expect(document.fileCount).toBe(0);
    expect(document.omittedCount).toBe(0);
    expect(document.totalBytes).toBe(0);
  });
});
