// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Unit tests for the frozen workspace path validator (owner V3-04a).

import { lstat, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidWorkspacePathError,
  WorkspaceRootUnavailableError,
  WorkspaceSymlinkError,
  assertNoSymlinkComponents,
  isHiddenWorkspacePath,
  isTextFilePath,
  textContentTypeForPath,
  validateWorkspacePath,
  workspaceFsPath,
} from '../../src/lib/paths.js';

describe('validateWorkspacePath accepts valid relative paths', () => {
  it('accepts a nested markdown path', () => {
    const result = validateWorkspacePath('sub/folder/materi-baru.md');
    expect(result.path).toBe('sub/folder/materi-baru.md');
    expect(result.segments).toEqual(['sub', 'folder', 'materi-baru.md']);
    expect(result.hidden).toBe(false);
    expect(result.isRoot).toBe(false);
  });

  it('accepts spaces and non-ASCII names', () => {
    expect(validateWorkspacePath('catatan saya/ringkasan kopi.md').path).toBe(
      'catatan saya/ringkasan kopi.md',
    );
  });

  it('accepts the empty string as root only when allowed', () => {
    const root = validateWorkspacePath('', { allowEmptyAsRoot: true });
    expect(root.isRoot).toBe(true);
    expect(root.path).toBe('');
    expect(root.segments).toEqual([]);
    expect(() => validateWorkspacePath('')).toThrow(InvalidWorkspacePathError);
    expect(() => validateWorkspacePath('', {})).toThrow(InvalidWorkspacePathError);
  });

  it('accepts exactly 1024 bytes and exactly 50 segments', () => {
    const longName = `a/${'x'.repeat(1022)}`;
    expect(Buffer.byteLength(longName, 'utf8')).toBe(1024);
    expect(validateWorkspacePath(longName).path).toBe(longName);
    const deep = Array.from({ length: 50 }, (_v, i) => `s${i}`).join('/');
    expect(validateWorkspacePath(deep).segments).toHaveLength(50);
  });

  it('flags dot segments as hidden without rejecting them', () => {
    expect(validateWorkspacePath('.git/config').hidden).toBe(true);
    expect(validateWorkspacePath('a/.notegen/thumb.png').hidden).toBe(true);
    expect(validateWorkspacePath('.hidden/x.md').hidden).toBe(true);
    expect(validateWorkspacePath('..foo/bar.md').hidden).toBe(true);
    expect(validateWorkspacePath('a/b.md').hidden).toBe(false);
  });
});

describe('validateWorkspacePath rejects traversal and malformed forms', () => {
  const bad: Array<[string, unknown]> = [
    ['non-string number', 42],
    ['non-string null', null],
    ['non-string undefined', undefined],
    ['non-string array', ['a.md']],
    ['absolute', '/abs.md'],
    ['absolute nested', '/a/b.md'],
    ['drive letter', 'C:/win.md'],
    ['drive letter lowercase', 'c:win.md'],
    ['parent only', '..'],
    ['parent prefix', '../escape.md'],
    ['parent middle', 'a/../b.md'],
    ['parent deep', 'a/../../escape.md'],
    ['dot only', '.'],
    ['dot segment', 'a/./b.md'],
    ['dot prefix', './a.md'],
    ['double slash', 'a//b.md'],
    ['trailing slash', 'a/b.md/'],
    ['backslash', 'a\\b.md'],
    ['backslash only', '\\a.md'],
    ['NUL byte', 'a\0b.md'],
    ['control character', 'a\x01b.md'],
    ['delete character', 'a\x7fb.md'],
    ['over length', `a/${'x'.repeat(1023)}`],
    ['over segments', Array.from({ length: 51 }, (_v, i) => `s${i}`).join('/')],
  ];

  for (const [label, input] of bad) {
    it(`rejects ${label}`, () => {
      expect(() => validateWorkspacePath(input)).toThrow(InvalidWorkspacePathError);
      expect(() => validateWorkspacePath(input, { allowEmptyAsRoot: true })).toThrow(
        InvalidWorkspacePathError,
      );
    });
  }

  it('treats percent sequences as literal names, never decodes', () => {
    const result = validateWorkspacePath('a%2Fb.md');
    expect(result.path).toBe('a%2Fb.md');
    expect(result.segments).toEqual(['a%2Fb.md']);
  });
});

describe('isHiddenWorkspacePath', () => {
  it('detects dot segments anywhere', () => {
    expect(isHiddenWorkspacePath('.git')).toBe(true);
    expect(isHiddenWorkspacePath('a/.b/c')).toBe(true);
    expect(isHiddenWorkspacePath('a/b')).toBe(false);
    expect(isHiddenWorkspacePath('')).toBe(false);
  });
});

describe('workspaceFsPath', () => {
  it('joins segments under the root and returns the root for root', () => {
    const validated = validateWorkspacePath('a/b.md');
    expect(workspaceFsPath('/root', validated)).toBe(join('/root', 'a', 'b.md'));
    const root = validateWorkspacePath('', { allowEmptyAsRoot: true });
    expect(workspaceFsPath('/root', root)).toBe('/root');
  });
});

describe('assertNoSymlinkComponents', () => {
  let dir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    dir = await mkdtemp(join(tmpdir(), 'v3-04a-paths-'));
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', 'file.md'), 'hello');
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the path under the resolved root for a normal file', async () => {
    const rootReal = await realpath(dir);
    const result = await assertNoSymlinkComponents(dir, validateWorkspacePath('sub/file.md'));
    expect(result).toBe(join(rootReal, 'sub', 'file.md'));
    expect((await lstat(result)).isFile()).toBe(true);
  });

  it('allows a missing tail', async () => {
    const rootReal = await realpath(dir);
    const result = await assertNoSymlinkComponents(dir, validateWorkspacePath('sub/missing.md'));
    expect(result).toBe(join(rootReal, 'sub', 'missing.md'));
  });

  it('rejects a symlink file component', async () => {
    await symlink(join(dir, 'sub', 'file.md'), join(dir, 'sub', 'link.md'));
    await expect(
      assertNoSymlinkComponents(dir, validateWorkspacePath('sub/link.md')),
    ).rejects.toThrow(WorkspaceSymlinkError);
  });

  it('rejects a symlink directory component', async () => {
    await symlink(join(dir, 'sub'), join(dir, 'alias'));
    await expect(
      assertNoSymlinkComponents(dir, validateWorkspacePath('alias/file.md')),
    ).rejects.toThrow(WorkspaceSymlinkError);
  });

  it('rejects a broken symlink the same way', async () => {
    await symlink(join(dir, 'nowhere.md'), join(dir, 'broken.md'));
    await expect(
      assertNoSymlinkComponents(dir, validateWorkspacePath('broken.md')),
    ).rejects.toThrow(WorkspaceSymlinkError);
  });

  it('rejects a symlink pointing inside the root, not only outside', async () => {
    await symlink('file.md', join(dir, 'sub', 'inner-link.md'));
    await expect(
      assertNoSymlinkComponents(dir, validateWorkspacePath('sub/inner-link.md')),
    ).rejects.toThrow(WorkspaceSymlinkError);
  });

  it('reports a missing root as unavailable', async () => {
    await expect(
      assertNoSymlinkComponents(join(dir, 'gone'), validateWorkspacePath('a.md')),
    ).rejects.toThrow(WorkspaceRootUnavailableError);
  });

  it('treats a path through a regular file like a missing tail (ENOTDIR)', async () => {
    const rootReal = await realpath(dir);
    const result = await assertNoSymlinkComponents(
      dir,
      validateWorkspacePath('sub/file.md/child.md'),
    );
    expect(result).toBe(join(rootReal, 'sub', 'file.md', 'child.md'));
  });

  it('treats an overlong segment like a missing tail (ENAMETOOLONG)', async () => {
    const rootReal = await realpath(dir);
    const longSegment = `${'n'.repeat(296)}.md`;
    const result = await assertNoSymlinkComponents(dir, validateWorkspacePath(longSegment));
    expect(result).toBe(join(rootReal, longSegment));
  });
});

describe('text file classification', () => {
  it('treats .md and .txt as text, case-insensitively', () => {
    expect(isTextFilePath('a.md')).toBe(true);
    expect(isTextFilePath('a.txt')).toBe(true);
    expect(isTextFilePath('a.MD')).toBe(true);
    expect(isTextFilePath('a.Txt')).toBe(true);
  });

  it('treats other extensions as non-text', () => {
    expect(isTextFilePath('a.png')).toBe(false);
    expect(isTextFilePath('a.markdown')).toBe(false);
    expect(isTextFilePath('a.mdx')).toBe(false);
    expect(isTextFilePath('a')).toBe(false);
    expect(isTextFilePath('md')).toBe(false);
  });

  it('maps text paths to content types and others to null', () => {
    expect(textContentTypeForPath('a.md')).toBe('text/markdown; charset=utf-8');
    expect(textContentTypeForPath('a.txt')).toBe('text/plain; charset=utf-8');
    expect(textContentTypeForPath('a.png')).toBeNull();
  });
});
