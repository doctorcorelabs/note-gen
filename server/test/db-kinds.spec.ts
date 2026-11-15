// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Conformance: the server-side kind mirror in
// server/src/services/db/kinds.ts must match the canonical catalog
// at src/lib/platform/sql/ops-catalog.ts exactly (membership, wave,
// exposure), except for one ratified delta: `messages.get`, the 74th
// kind (AD-44, AMD-O10-01), which the D/G lock-in ratified as a W1
// client read kind but which has not yet entered the catalog code
// (the catalog amendment is V3-14 work). Until that amendment lands,
// the mirror is catalog + messages.get; once it lands, mirror and
// catalog are equal. Both states pass this test, and any other drift
// fails it. The catalog is read as TEXT, not imported: the server
// build cannot resolve the catalog's "@/types/..." imports, so a
// text-level pin is the binding check. Any catalog change that adds,
// removes, renames, or re-waves a kind fails this test until the
// mirror is updated in the same change.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DB_OP_KINDS,
  DB_READ_OP_KINDS,
  DB_SERVER_ONLY_OP_KIND,
  DB_WAVE2_OP_KINDS,
  DB_WRITE_OP_KINDS,
} from '../src/services/db/kinds.js';

function catalogText(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const catalogPath = join(here, '..', '..', 'src', 'lib', 'platform', 'sql', 'ops-catalog.ts');
  return readFileSync(catalogPath, 'utf8');
}

function parseKindArray(text: string, constName: string): string[] {
  const match = new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const`).exec(text);
  if (match === null) {
    throw new Error(`Could not find ${constName} in the catalog text.`);
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function parseMetadata(text: string): Map<string, { wave: string; exposure: string }> {
  const entries = new Map<string, { wave: string; exposure: string }>();
  const pattern = /"([^"]+)": \{\s*wave: "(W1|W2)",\s*exposure: "([^"]+)",/g;
  for (const match of text.matchAll(pattern)) {
    entries.set(match[1], { wave: match[2], exposure: match[3] });
  }
  return entries;
}

describe('kind mirror conformance with ops-catalog.ts', () => {
  it('matches the catalog kind arrays plus the ratified messages.get delta', () => {
    const text = catalogText();
    const catalogReads = parseKindArray(text, 'SQL_READ_OP_KINDS');
    const expectedReads = [...catalogReads];
    if (!expectedReads.includes('messages.get')) {
      const anchor = expectedReads.indexOf('messages.listByTag');
      expect(anchor).toBeGreaterThanOrEqual(0);
      expectedReads.splice(anchor + 1, 0, 'messages.get');
    }
    expect([...DB_READ_OP_KINDS]).toEqual(expectedReads);
    expect([...DB_WRITE_OP_KINDS]).toEqual(parseKindArray(text, 'SQL_WRITE_OP_KINDS'));
    expect(DB_READ_OP_KINDS).toHaveLength(34);
    expect(DB_WRITE_OP_KINDS).toHaveLength(40);
    expect(DB_OP_KINDS).toHaveLength(74);
    expect(DB_READ_OP_KINDS).toContain('messages.get');
  });

  it('keeps read and write kinds disjoint with no duplicates', () => {
    const all = [...DB_OP_KINDS];
    expect(new Set(all).size).toBe(all.length);
    const readSet = new Set<string>(DB_READ_OP_KINDS);
    for (const kind of DB_WRITE_OP_KINDS) {
      expect(readSet.has(kind)).toBe(false);
    }
  });

  it('matches the catalog wave and exposure metadata', () => {
    const metadata = parseMetadata(catalogText());
    expect([73, 74]).toContain(metadata.size);
    for (const kind of DB_OP_KINDS) {
      if (kind === 'messages.get' && !metadata.has(kind)) {
        continue;
      }
      expect(metadata.has(kind)).toBe(true);
    }
    const messagesGet = metadata.get('messages.get');
    if (messagesGet !== undefined) {
      expect(messagesGet).toEqual({ wave: 'W1', exposure: 'client' });
    }
    const wave2 = [...metadata.entries()]
      .filter(([, meta]) => meta.wave === 'W2')
      .map(([kind]) => kind)
      .sort();
    expect([...DB_WAVE2_OP_KINDS].sort()).toEqual(wave2);
    expect(DB_WAVE2_OP_KINDS).toHaveLength(12);
    const serverOnly = [...metadata.entries()]
      .filter(([, meta]) => meta.exposure === 'server-only')
      .map(([kind]) => kind);
    expect(serverOnly).toEqual([DB_SERVER_ONLY_OP_KIND]);
    expect(DB_SERVER_ONLY_OP_KIND).toBe('vector.replaceChunks');
  });
});
