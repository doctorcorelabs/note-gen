// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Conformance specs for the REAL V3-04a revision module
// (server/src/lib/revision.ts).
//
// Contract: desain-workspace-api.md section 3.1 (revision formula),
// section 3.2 (ETag presentation and If-Match / If-None-Match
// parsing). The formula is verified against an independent SHA-256
// computation in this file, never by calling buildRevision twice:
// revision = "sha256:" + hex(SHA-256(workspaceKey + NUL + filePath
// + NUL + content bytes)). A revision changes when the path changes
// even if the bytes are identical, so revisions must never be reused
// across a move or restore.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildRevision,
  contentHash,
  ifNoneMatchMatches,
  InvalidPreconditionError,
  isRevision,
  parseETagValue,
  parseIfMatch,
  parseIfNoneMatchForWrite,
  parseWritePreconditions,
  quoteETag,
} from '../../src/lib/revision.js';

const KEY = 'workspace-key-for-conformance';

function independentRevision(workspaceKey: string, filePath: string, content: Uint8Array | string): string {
  const hash = createHash('sha256');
  hash.update(workspaceKey, 'utf8');
  hash.update(Buffer.from([0]));
  hash.update(filePath, 'utf8');
  hash.update(Buffer.from([0]));
  hash.update(content);
  return `sha256:${hash.digest('hex')}`;
}

describe('buildRevision', () => {
  it('matches the independent SHA-256 formula for text content', () => {
    const content = 'hello workspace\nsecond line\n';
    expect(buildRevision(KEY, 'notes/a.md', content)).toBe(independentRevision(KEY, 'notes/a.md', content));
  });

  it('matches the independent SHA-256 formula for raw binary bytes', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01]);
    expect(buildRevision(KEY, 'img/a.png', bytes)).toBe(independentRevision(KEY, 'img/a.png', bytes));
  });

  it('is deterministic for the same inputs', () => {
    expect(buildRevision(KEY, 'a.md', 'x')).toBe(buildRevision(KEY, 'a.md', 'x'));
  });

  it('changes when the path changes even if the bytes are identical', () => {
    expect(buildRevision(KEY, 'a.md', 'same')).not.toBe(buildRevision(KEY, 'b.md', 'same'));
  });

  it('changes when the content changes and when the workspace key changes', () => {
    expect(buildRevision(KEY, 'a.md', 'one')).not.toBe(buildRevision(KEY, 'a.md', 'two'));
    expect(buildRevision(KEY, 'a.md', 'one')).not.toBe(buildRevision('other-key', 'a.md', 'one'));
  });

  it('uses the sha256 prefix with 64 lowercase hex characters', () => {
    expect(buildRevision(KEY, 'a.md', 'x')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('treats a string and its UTF-8 bytes as the same content', () => {
    expect(buildRevision(KEY, 'a.md', 'e')).toBe(buildRevision(KEY, 'a.md', Buffer.from('e', 'utf8')));
  });
});

describe('isRevision and contentHash', () => {
  it('recognizes well-formed revisions and rejects the rest', () => {
    const good = buildRevision(KEY, 'a.md', 'x');
    expect(isRevision(good)).toBe(true);
    expect(isRevision('sha256:xyz')).toBe(false);
    expect(isRevision('sha256:')).toBe(false);
    expect(isRevision(`"${good}"`)).toBe(false);
    expect(isRevision(42)).toBe(false);
    expect(isRevision(null)).toBe(false);
  });

  it('computes contentHash as bare SHA-256 over the bytes alone, distinct from the revision', () => {
    const bytes = Buffer.from('hello', 'utf8');
    const bare = createHash('sha256').update(bytes).digest('hex');
    expect(contentHash(bytes)).toBe(bare);
    expect(contentHash(bytes)).not.toBe(buildRevision(KEY, 'a.md', bytes));
    expect(contentHash('hello')).toBe(bare);
  });
});

describe('quoteETag and parseETagValue', () => {
  it('quotes a revision as one pair of double quotes', () => {
    expect(quoteETag('sha256:abc')).toBe('"sha256:abc"');
  });

  it.each([
    ['"sha256:abc"', 'sha256:abc'],
    ['sha256:abc', 'sha256:abc'],
    ['W/"sha256:abc"', 'sha256:abc'],
    ['  "sha256:abc"  ', 'sha256:abc'],
    ['*', '*'],
    ['"*""', null],
  ])('parses %s', (raw, expected) => {
    expect(parseETagValue(raw)).toBe(expected);
  });

  it.each(['', '"unbalanced', 'a"b', 'a,b', '"a","b"'])('rejects malformed value %s', (raw) => {
    expect(parseETagValue(raw)).toBeNull();
  });
});

describe('parseIfMatch', () => {
  it('returns none when no header is sent', () => {
    expect(parseIfMatch(undefined)).toEqual({ kind: 'none' });
    expect(parseIfMatch('')).toEqual({ kind: 'none' });
  });

  it('parses quoted and unquoted revisions exactly', () => {
    expect(parseIfMatch('"sha256:abc"')).toEqual({ kind: 'revision', revision: 'sha256:abc' });
    expect(parseIfMatch('sha256:abc')).toEqual({ kind: 'revision', revision: 'sha256:abc' });
    expect(parseIfMatch('W/"sha256:abc"')).toEqual({ kind: 'revision', revision: 'sha256:abc' });
  });

  it('parses "*" as the force form, quoted or bare', () => {
    expect(parseIfMatch('*')).toEqual({ kind: 'star' });
    expect(parseIfMatch('"*"')).toEqual({ kind: 'star' });
  });

  it('rejects lists, repeated headers, and unbalanced values', () => {
    expect(() => parseIfMatch('"a", "b"')).toThrow(InvalidPreconditionError);
    expect(() => parseIfMatch(['a', 'b'])).toThrow(InvalidPreconditionError);
    expect(() => parseIfMatch('"unbalanced')).toThrow(InvalidPreconditionError);
  });
});

describe('parseIfNoneMatchForWrite and parseWritePreconditions', () => {
  it('accepts only "*" for writes', () => {
    expect(parseIfNoneMatchForWrite('*')).toBe(true);
    expect(parseIfNoneMatchForWrite('"*"')).toBe(true);
    expect(parseIfNoneMatchForWrite(undefined)).toBe(false);
  });

  it('rejects revision values and lists for writes', () => {
    expect(() => parseIfNoneMatchForWrite('"sha256:abc"')).toThrow(InvalidPreconditionError);
    expect(() => parseIfNoneMatchForWrite('sha256:abc')).toThrow(InvalidPreconditionError);
    expect(() => parseIfNoneMatchForWrite('*, "sha256:abc"')).toThrow(InvalidPreconditionError);
  });

  it('parses both guards together and rejects sending both', () => {
    expect(parseWritePreconditions(undefined, undefined)).toEqual({
      ifMatch: { kind: 'none' },
      ifNoneMatchStar: false,
    });
    expect(parseWritePreconditions('"sha256:abc"', undefined).ifMatch).toEqual({
      kind: 'revision',
      revision: 'sha256:abc',
    });
    expect(parseWritePreconditions(undefined, '*').ifNoneMatchStar).toBe(true);
    expect(() => parseWritePreconditions('"sha256:abc"', '*')).toThrow(InvalidPreconditionError);
  });
});

describe('ifNoneMatchMatches (GET revalidation)', () => {
  const revision = buildRevision(KEY, 'a.md', 'x');

  it('matches an exact revision, a list member, and "*"', () => {
    expect(ifNoneMatchMatches(`"${revision}"`, revision)).toBe(true);
    expect(ifNoneMatchMatches(revision, revision)).toBe(true);
    expect(ifNoneMatchMatches(`"other", "${revision}"`, revision)).toBe(true);
    expect(ifNoneMatchMatches('*', revision)).toBe(true);
  });

  it('does not match other revisions, missing headers, or malformed values', () => {
    expect(ifNoneMatchMatches('"sha256:other"', revision)).toBe(false);
    expect(ifNoneMatchMatches(undefined, revision)).toBe(false);
    expect(ifNoneMatchMatches('"unbalanced', revision)).toBe(false);
  });
});
