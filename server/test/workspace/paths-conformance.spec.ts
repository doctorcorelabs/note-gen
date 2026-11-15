// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Conformance specs for the REAL V3-04a path module
// (server/src/lib/paths.ts), the single authority for
// workspace-relative paths on the server.
//
// Contract: desain-workspace-api.md section 8 (validation order,
// dot-segment filter, symlink refusal, 400 vs 404 mapping) and
// section 1.7 (length and segment limits), as tightened by the
// strict-segment rule in the module header: malformed segment forms
// are errors, never spellings to repair silently. Backslashes are
// never normalized into slashes and ".." is never resolved as "go up
// one level".
//
// These specs call the real module directly. The HTTP-level
// consequences (status codes, no-corruption) are pinned in
// write-conformance.spec.ts with the same module wired behind the
// real write routes.

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertNoSymlinkComponents,
  InvalidWorkspacePathError,
  isTextFilePath,
  textContentTypeForPath,
  validateWorkspacePath,
  workspaceFsPath,
  WorkspaceRootUnavailableError,
  WorkspaceSymlinkError,
} from '../../src/lib/paths.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'notegen-paths-conformance-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('validateWorkspacePath: accepted shapes', () => {
  it('accepts a normal nested path with segments and flags', () => {
    const validated = validateWorkspacePath('sub/folder/note.md');
    expect(validated.path).toBe('sub/folder/note.md');
    expect(validated.segments).toEqual(['sub', 'folder', 'note.md']);
    expect(validated.hidden).toBe(false);
    expect(validated.isRoot).toBe(false);
  });

  it('accepts spaces and non-ASCII names', () => {
    expect(validateWorkspacePath('my file.md').path).toBe('my file.md');
    expect(validateWorkspacePath('catatan-e.md').path).toBe('catatan-e.md');
  });

  it('accepts exactly 1024 UTF-8 bytes and exactly 50 segments', () => {
    expect(validateWorkspacePath('a'.repeat(1024)).path).toBe('a'.repeat(1024));
    const fifty = Array.from({ length: 50 }, () => 's').join('/');
    expect(validateWorkspacePath(fifty).segments).toHaveLength(50);
  });

  it('treats percent sequences as literal file-name characters, never decoded', () => {
    const single = validateWorkspacePath('%2e%2e.md');
    expect(single.path).toBe('%2e%2e.md');
    expect(single.hidden).toBe(false);
    const doubled = validateWorkspacePath('%252e%252e.md');
    expect(doubled.path).toBe('%252e%252e.md');
  });
});

describe('validateWorkspacePath: traversal and malformed shapes', () => {
  it.each(['..', '../x.md', 'a/../b.md', 'a/b/..', 'a/../../x.md'])(
    'rejects a ".." segment in %s',
    (input) => {
      expect(() => validateWorkspacePath(input)).toThrow(InvalidWorkspacePathError);
    },
  );

  it.each(['.', './x.md', 'a/./b.md', 'a/.'])('rejects a "." segment in %s', (input) => {
    expect(() => validateWorkspacePath(input)).toThrow(InvalidWorkspacePathError);
  });

  it.each(['/x.md', '/a/b', 'C:/x.md', 'C:x.md', 'd:/x.md'])(
    'rejects an absolute or drive-letter path %s',
    (input) => {
      expect(() => validateWorkspacePath(input)).toThrow(InvalidWorkspacePathError);
    },
  );

  it.each(['a\\b.md', 'a\\..\\b.md', '\\x.md'])('rejects a backslash in %s', (input) => {
    expect(() => validateWorkspacePath(input)).toThrow(InvalidWorkspacePathError);
  });

  it.each(['a//b.md', 'a/b/', 'a///b.md'])('rejects an empty segment in %s', (input) => {
    expect(() => validateWorkspacePath(input)).toThrow(InvalidWorkspacePathError);
  });

  it('rejects the empty string unless the endpoint allows the root', () => {
    expect(() => validateWorkspacePath('')).toThrow(InvalidWorkspacePathError);
    const rootPath = validateWorkspacePath('', { allowEmptyAsRoot: true });
    expect(rootPath.isRoot).toBe(true);
    expect(rootPath.path).toBe('');
    expect(rootPath.segments).toEqual([]);
  });

  it.each([42, null, undefined, {}, []])('rejects a non-string input %s', (input) => {
    expect(() => validateWorkspacePath(input)).toThrow(InvalidWorkspacePathError);
  });

  it.each(['a\x00b.md', 'a\x01b.md', 'a\x1fb.md', 'a\x7fb.md'])(
    'rejects NUL and control characters',
    (input) => {
      expect(() => validateWorkspacePath(input)).toThrow(InvalidWorkspacePathError);
    },
  );

  it('rejects more than 1024 bytes and more than 50 segments', () => {
    expect(() => validateWorkspacePath('a'.repeat(1025))).toThrow(InvalidWorkspacePathError);
    const fiftyOne = Array.from({ length: 51 }, () => 's').join('/');
    expect(() => validateWorkspacePath(fiftyOne)).toThrow(InvalidWorkspacePathError);
  });
});

describe('validateWorkspacePath: hidden flag', () => {
  it.each(['.git/config', '.hidden.md', 'a/.x/b.md', '.notegen/thumb.png'])(
    'reports hidden without rejecting %s',
    (input) => {
      const validated = validateWorkspacePath(input);
      expect(validated.hidden).toBe(true);
      expect(validated.path).toBe(input);
    },
  );

  it('does not flag ordinary names as hidden', () => {
    expect(validateWorkspacePath('notes/a.md').hidden).toBe(false);
    expect(validateWorkspacePath('a.b/c.md').hidden).toBe(false);
  });
});

describe('assertNoSymlinkComponents', () => {
  it('returns the absolute path under the resolved root for existing and missing tails', async () => {
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'sub', 'note.md'), 'x');
    const realRoot = await realpath(root);
    const existing = await assertNoSymlinkComponents(root, validateWorkspacePath('sub/note.md'));
    expect(existing).toBe(join(realRoot, 'sub', 'note.md'));
    const missing = await assertNoSymlinkComponents(root, validateWorkspacePath('sub/new/deep.md'));
    expect(missing).toBe(join(realRoot, 'sub', 'new', 'deep.md'));
  });

  it('rejects a symlink file that points outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'notegen-outside-'));
    try {
      const target = join(outside, 'secret.md');
      await writeFile(target, 'outside');
      await symlink(target, join(root, 'escape.md'));
      await expect(
        assertNoSymlinkComponents(root, validateWorkspacePath('escape.md')),
      ).rejects.toThrow(WorkspaceSymlinkError);
      expect(await readFile(target, 'utf8')).toBe('outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked parent directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'notegen-outside-'));
    try {
      await symlink(outside, join(root, 'linked'));
      await expect(
        assertNoSymlinkComponents(root, validateWorkspacePath('linked/note.md')),
      ).rejects.toThrow(WorkspaceSymlinkError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a broken symlink', async () => {
    await symlink(join(root, 'no-such-target.md'), join(root, 'broken.md'));
    await expect(
      assertNoSymlinkComponents(root, validateWorkspacePath('broken.md')),
    ).rejects.toThrow(WorkspaceSymlinkError);
  });

  it('rejects a symlink that points inside the root: no symlink is ever followed', async () => {
    await writeFile(join(root, 'real.md'), 'real');
    await symlink(join(root, 'real.md'), join(root, 'alias.md'));
    await expect(
      assertNoSymlinkComponents(root, validateWorkspacePath('alias.md')),
    ).rejects.toThrow(WorkspaceSymlinkError);
  });

  it('reports an unresolvable root as unavailable, not as an invalid path', async () => {
    const missing = join(root, 'no-such-root');
    await expect(
      assertNoSymlinkComponents(missing, validateWorkspacePath('a.md')),
    ).rejects.toThrow(WorkspaceRootUnavailableError);
  });
});

describe('workspaceFsPath and text file helpers', () => {
  it('joins a validated path under the root and returns the root for the root', () => {
    expect(workspaceFsPath(root, validateWorkspacePath('a/b.md'))).toBe(join(root, 'a', 'b.md'));
    expect(workspaceFsPath(root, validateWorkspacePath('', { allowEmptyAsRoot: true }))).toBe(root);
  });

  it('treats only .md and .txt as text files for the read endpoint', () => {
    expect(isTextFilePath('a.md')).toBe(true);
    expect(isTextFilePath('a.txt')).toBe(true);
    expect(isTextFilePath('a.MD')).toBe(true);
    expect(isTextFilePath('a.png')).toBe(false);
    expect(isTextFilePath('a.json')).toBe(false);
    expect(isTextFilePath('a.md.bak')).toBe(false);
  });

  it('maps text extensions to content types and returns null otherwise', () => {
    expect(textContentTypeForPath('a.md')).toBe('text/markdown; charset=utf-8');
    expect(textContentTypeForPath('a.txt')).toBe('text/plain; charset=utf-8');
    expect(textContentTypeForPath('a.png')).toBeNull();
  });
});
