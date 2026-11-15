// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Cross-module classification conformance (V3-10b integrator, W7/W8,
// AD-53): the V3-10a enforcement table
// (services/settings/classification.ts) and the V3-10b catalogue
// (lib/settings-key-classification.ts) must agree on all 236 keys.
// Enforcement stays single-pointed: the settings service consults
// only the V3-10a module. This spec pins the two tables together so
// a drift fails here instead of silently changing which keys the
// server accepts.
//
// Vocabulary mapping (exact keys only; pattern/colon rules are each
// module's own spec territory):
// - V3-10a 'S'       <-> V3-10b class 'S', split=false
// - V3-10a 'L'       <-> V3-10b class 'L'
// - V3-10a 'R_REJECT'<-> V3-10b class 'R'
// - V3-10a 'SPLIT'   <-> V3-10b class 'S' + split=true (aiModelList)
// - V3-10a 'REJECTED'<-> V3-10b class 'R' + rejected=true (pin)

import { describe, expect, it } from 'vitest';
import {
  classifySettingKey,
  GITLAB_PROJECT_ID_PATTERN as CATALOG_GITLAB,
  SECRET_NAME_PATTERNS as CATALOG_PATTERNS,
  SETTING_KEY_TABLE,
} from '../src/lib/settings-key-classification.js';
import {
  classifyKey,
  GITLAB_PROJECT_ID_PATTERN as SERVICE_GITLAB,
  KNOWN_S_KEYS,
  LOCAL_ONLY_KEYS,
  REJECTED_KEYS,
  SECRET_NAME_PATTERNS as SERVICE_PATTERNS,
  SECRET_REJECT_KEYS,
  SPLIT_KEYS,
} from '../src/services/settings/classification.js';

describe('classification conformance V3-10a vs V3-10b', () => {
  it('covers exactly the same 236 keys on both sides', () => {
    const catalogKeys = Object.keys(SETTING_KEY_TABLE);
    expect(catalogKeys).toHaveLength(236);
    const serviceKeys = new Set([
      ...KNOWN_S_KEYS,
      ...LOCAL_ONLY_KEYS,
      ...SECRET_REJECT_KEYS,
      ...SPLIT_KEYS,
      ...REJECTED_KEYS,
    ]);
    expect(serviceKeys.size).toBe(236);
    expect([...serviceKeys].sort()).toEqual([...catalogKeys].sort());
    expect(KNOWN_S_KEYS).toHaveLength(79);
    expect(LOCAL_ONLY_KEYS).toHaveLength(132);
    expect(SECRET_REJECT_KEYS).toHaveLength(23);
    expect(SPLIT_KEYS).toEqual(['aiModelList']);
    expect(REJECTED_KEYS).toEqual(['pin']);
  });

  it('agrees on the class of every catalogued key', () => {
    for (const key of Object.keys(SETTING_KEY_TABLE)) {
      const serviceClass = classifyKey(key);
      const catalog = classifySettingKey(key);
      expect(catalog.known).toBe(true);
      const info = catalog.info;
      expect(info).not.toBeNull();
      if (key === 'aiModelList') {
        expect(serviceClass).toBe('SPLIT');
        expect(catalog.keyClass).toBe('S');
        expect(info?.split).toBe(true);
      } else if (key === 'pin') {
        expect(serviceClass).toBe('REJECTED');
        expect(catalog.keyClass).toBe('R');
        expect(info?.rejected).toBe(true);
      } else if (serviceClass === 'S') {
        expect(catalog.keyClass).toBe('S');
        expect(info?.split).toBe(false);
      } else if (serviceClass === 'L') {
        expect(catalog.keyClass).toBe('L');
      } else if (serviceClass === 'R_REJECT') {
        expect(catalog.keyClass).toBe('R');
      } else {
        expect.unreachable(`no mapping for ${key}: service=${serviceClass}`);
      }
    }
  });

  it('classifies editorShortcuts as S on both sides (AD-53)', () => {
    expect(classifyKey('editorShortcuts')).toBe('S');
    const catalog = classifySettingKey('editorShortcuts');
    expect(catalog.keyClass).toBe('S');
    expect(catalog.info?.split).toBe(false);
  });

  it('shares the same secret-name patterns and gitlab pattern', () => {
    expect([...SERVICE_PATTERNS].sort()).toEqual([...CATALOG_PATTERNS].sort());
    expect(SERVICE_GITLAB.source).toBe(CATALOG_GITLAB.source);
  });
});
