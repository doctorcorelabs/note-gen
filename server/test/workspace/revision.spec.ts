// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Unit tests for the frozen revision scheme (owner V3-04a). The
// formula is checked against an independent computation from
// node:crypto primitives, not against buildRevision itself.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InvalidPreconditionError,
  buildRevision,
  contentHash,
  ifNoneMatchMatches,
  isRevision,
  parseETagValue,
  parseIfMatch,
  parseIfNoneMatchForWrite,
  parseWritePreconditions,
  quoteETag,
} from '../../src/lib/revision.js';

function independentRevision(workspaceKey: string, filePath: string, content: Buffer): string {
  const parts = [
    Buffer.from(workspaceKey, 'utf8'),
    Buffer.from([0]),
    Buffer.from(filePath, 'utf8'),
    Buffer.from([0]),
    content,
  ];
  return `sha256:${createHash('sha256').update(Buffer.concat(parts)).digest('hex')}`;
}

describe('buildRevision formula', () => {
  it('equals sha256 over workspaceKey, NUL, path, NUL, bytes', () => {
    const content = Buffer.from('line one\nline two\n', 'utf8');
    expect(buildRevision('ws-uuid-1', 'sub/file.md', content)).toBe(
      independentRevision('ws-uuid-1', 'sub/file.md', content),
    );
  });

  it('matches the upstream string form for text content', () => {
    const content = 'hello\n';
    const fromString = buildRevision('ws', 'a.md', content);
    const fromBytes = buildRevision('ws', 'a.md', Buffer.from(content, 'utf8'));
    expect(fromString).toBe(fromBytes);
    const upstream = `sha256:${createHash('sha256').update(`ws\0a.md\0${content}`, 'utf8').digest('hex')}`;
    expect(fromString).toBe(upstream);
  });

  it('changes when the path changes even with identical bytes', () => {
    const content = Buffer.from('same', 'utf8');
    expect(buildRevision('ws', 'a.md', content)).not.toBe(buildRevision('ws', 'b.md', content));
  });

  it('changes when the content or workspace key changes', () => {
    expect(buildRevision('ws', 'a.md', 'one')).not.toBe(buildRevision('ws', 'a.md', 'two'));
    expect(buildRevision('ws-1', 'a.md', 'one')).not.toBe(buildRevision('ws-2', 'a.md', 'one'));
  });

  it('is stable across calls and has the sha256 prefix with 64 hex chars', () => {
    const first = buildRevision('ws', 'a.md', 'x');
    expect(first).toBe(buildRevision('ws', 'a.md', 'x'));
    expect(isRevision(first)).toBe(true);
    expect(first.startsWith('sha256:')).toBe(true);
  });

  it('does not normalize line endings', () => {
    expect(buildRevision('ws', 'a.md', 'a\r\nb')).not.toBe(buildRevision('ws', 'a.md', 'a\nb'));
  });
});

describe('contentHash', () => {
  it('is hex sha256 over content bytes alone and differs from the revision', () => {
    const content = Buffer.from('hello', 'utf8');
    expect(contentHash(content)).toBe(createHash('sha256').update(content).digest('hex'));
    expect(contentHash(content)).not.toBe(buildRevision('ws', 'a.md', content).slice('sha256:'.length));
  });
});

describe('isRevision', () => {
  it('accepts only well-formed revisions', () => {
    expect(isRevision(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isRevision('sha256:abc')).toBe(false);
    expect(isRevision(`sha256:${'A'.repeat(64)}`)).toBe(false);
    expect(isRevision('sha256:')).toBe(false);
    expect(isRevision(42)).toBe(false);
    expect(isRevision(undefined)).toBe(false);
  });
});

describe('ETag quoting and parsing', () => {
  it('quotes a revision as an ETag', () => {
    expect(quoteETag('sha256:abc')).toBe('"sha256:abc"');
  });

  it('parses quoted, weak, and bare values', () => {
    expect(parseETagValue('"sha256:abc"')).toBe('sha256:abc');
    expect(parseETagValue('W/"sha256:abc"')).toBe('sha256:abc');
    expect(parseETagValue('sha256:abc')).toBe('sha256:abc');
    expect(parseETagValue('*')).toBe('*');
    expect(parseETagValue('  "sha256:abc"  ')).toBe('sha256:abc');
  });

  it('rejects malformed values with null', () => {
    expect(parseETagValue('')).toBeNull();
    expect(parseETagValue('   ')).toBeNull();
    expect(parseETagValue('"sha256:abc')).toBeNull();
    expect(parseETagValue('sha256:abc"')).toBeNull();
    expect(parseETagValue('"a","b"')).toBeNull();
  });
});

describe('ifNoneMatchMatches (GET revalidation)', () => {
  const revision = `sha256:${'b'.repeat(64)}`;

  it('matches quoted, unquoted, and weak forms', () => {
    expect(ifNoneMatchMatches(`"${revision}"`, revision)).toBe(true);
    expect(ifNoneMatchMatches(revision, revision)).toBe(true);
    expect(ifNoneMatchMatches(`W/"${revision}"`, revision)).toBe(true);
  });

  it('matches a list containing the revision and the star form', () => {
    expect(ifNoneMatchMatches(`"sha256:deadbeef", "${revision}"`, revision)).toBe(true);
    expect(ifNoneMatchMatches('*', revision)).toBe(true);
  });

  it('does not match other revisions, missing headers, or malformed values', () => {
    expect(ifNoneMatchMatches('"sha256:other"', revision)).toBe(false);
    expect(ifNoneMatchMatches(undefined, revision)).toBe(false);
    expect(ifNoneMatchMatches('', revision)).toBe(false);
    expect(ifNoneMatchMatches('"unbalanced', revision)).toBe(false);
  });
});

describe('parseIfMatch (write guard)', () => {
  const revision = `sha256:${'c'.repeat(64)}`;

  it('returns none when absent', () => {
    expect(parseIfMatch(undefined)).toEqual({ kind: 'none' });
    expect(parseIfMatch('')).toEqual({ kind: 'none' });
  });

  it('parses star and revision forms, quoted or not', () => {
    expect(parseIfMatch('*')).toEqual({ kind: 'star' });
    expect(parseIfMatch(`"${revision}"`)).toEqual({ kind: 'revision', revision });
    expect(parseIfMatch(revision)).toEqual({ kind: 'revision', revision });
    expect(parseIfMatch(`W/"${revision}"`)).toEqual({ kind: 'revision', revision });
  });

  it('rejects lists, duplicated headers, and malformed values', () => {
    expect(() => parseIfMatch(`"${revision}", "sha256:other"`)).toThrow(InvalidPreconditionError);
    expect(() => parseIfMatch([revision, revision])).toThrow(InvalidPreconditionError);
    expect(() => parseIfMatch('"unbalanced')).toThrow(InvalidPreconditionError);
  });
});

describe('parseIfNoneMatchForWrite', () => {
  const revision = `sha256:${'d'.repeat(64)}`;

  it('accepts absent and star only', () => {
    expect(parseIfNoneMatchForWrite(undefined)).toBe(false);
    expect(parseIfNoneMatchForWrite('*')).toBe(true);
    expect(parseIfNoneMatchForWrite('"*"')).toBe(true);
  });

  it('rejects revision values and lists', () => {
    expect(() => parseIfNoneMatchForWrite(`"${revision}"`)).toThrow(InvalidPreconditionError);
    expect(() => parseIfNoneMatchForWrite(revision)).toThrow(InvalidPreconditionError);
    expect(() => parseIfNoneMatchForWrite('*, *')).toThrow(InvalidPreconditionError);
  });
});

describe('parseWritePreconditions', () => {
  const revision = `sha256:${'e'.repeat(64)}`;

  it('accepts either guard alone and neither', () => {
    expect(parseWritePreconditions(revision, undefined)).toEqual({
      ifMatch: { kind: 'revision', revision },
      ifNoneMatchStar: false,
    });
    expect(parseWritePreconditions(undefined, '*')).toEqual({
      ifMatch: { kind: 'none' },
      ifNoneMatchStar: true,
    });
    expect(parseWritePreconditions(undefined, undefined)).toEqual({
      ifMatch: { kind: 'none' },
      ifNoneMatchStar: false,
    });
  });

  it('rejects both guards together', () => {
    expect(() => parseWritePreconditions(revision, '*')).toThrow(InvalidPreconditionError);
  });
});
