// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the V2-27 setting key classification data (V3-10b).
// The catalogue counts and verdicts below come from
// inventaris-pengaturan.md (V2-27 FINAL) section 6: 236 keys plus
// 1 pattern, 79 S, 1 split, 23 R-MVP-REJECT, 1 rejected, 132 L.

import { describe, expect, it } from 'vitest';

import {
  AI_MODEL_LIST_METADATA_FIELDS,
  AI_MODEL_LIST_SECRET_FIELDS,
  GITLAB_PROJECT_ID_PATTERN,
  KNOWN_SETTING_KEYS,
  L_SETTING_KEYS,
  REJECTED_SETTING_KEYS,
  R_REJECT_SETTING_KEYS,
  SECRET_NAME_PATTERNS,
  SETTING_KEY_COUNTS,
  SETTING_KEY_OPEN_ITEMS,
  SETTING_KEY_TABLE,
  SPLIT_SETTING_KEYS,
  S_SETTING_KEYS,
  classifySettingKey,
  isKnownSettingKey,
} from '../src/lib/settings-key-classification.js';

describe('catalogue counts', () => {
  it('holds exactly 236 keys', () => {
    expect(Object.keys(SETTING_KEY_TABLE)).toHaveLength(236);
    expect(KNOWN_SETTING_KEYS.size).toBe(236);
    expect(SETTING_KEY_COUNTS.total).toBe(236);
  });

  it('matches the V2-27 per-class counts', () => {
    expect(S_SETTING_KEYS).toHaveLength(79);
    expect(SPLIT_SETTING_KEYS).toHaveLength(1);
    expect(R_REJECT_SETTING_KEYS).toHaveLength(23);
    expect(REJECTED_SETTING_KEYS).toHaveLength(1);
    expect(L_SETTING_KEYS).toHaveLength(132);
    expect(SETTING_KEY_COUNTS).toEqual({
      total: 236,
      s: 79,
      split: 1,
      rReject: 23,
      rejected: 1,
      l: 132,
    });
  });

  it('has no key in two classes', () => {
    const all = [
      ...S_SETTING_KEYS,
      ...SPLIT_SETTING_KEYS,
      ...R_REJECT_SETTING_KEYS,
      ...REJECTED_SETTING_KEYS,
      ...L_SETTING_KEYS,
    ];
    expect(new Set(all).size).toBe(236);
  });

  it('keeps every table entry consistent with its class lists', () => {
    for (const key of S_SETTING_KEYS) {
      const info = SETTING_KEY_TABLE[key];
      expect(info.keyClass).toBe('S');
      expect(info.secret).toBe(false);
      expect(info.settingsRoute).toBe('accept');
    }
    for (const key of L_SETTING_KEYS) {
      const info = SETTING_KEY_TABLE[key];
      expect(info.keyClass).toBe('L');
      expect(info.secret).toBe(false);
      expect(info.settingsRoute).toBe('local_only');
    }
    for (const key of R_REJECT_SETTING_KEYS) {
      const info = SETTING_KEY_TABLE[key];
      expect(info.keyClass).toBe('R');
      expect(info.secret).toBe(true);
      expect(info.mvpRejected).toBe(true);
      expect(info.settingsRoute).toBe('secret_only');
    }
  });

  it('freezes the table, its entries, and the class lists', () => {
    expect(Object.isFrozen(SETTING_KEY_TABLE)).toBe(true);
    expect(Object.isFrozen(SETTING_KEY_TABLE.language)).toBe(true);
    expect(Object.isFrozen(S_SETTING_KEYS)).toBe(true);
    expect(Object.isFrozen(L_SETTING_KEYS)).toBe(true);
    expect(Object.isFrozen(SECRET_NAME_PATTERNS)).toBe(true);
  });
});

describe('spot verdicts', () => {
  it('classifies plain server keys as S and accepted', () => {
    for (const key of ['language', 'editorViewMode', 'recordViewMode', 'shortcuts', 'primaryModel', 'systemPrompt']) {
      const result = classifySettingKey(key);
      expect(result.known).toBe(true);
      expect(result.keyClass).toBe('S');
      expect(result.secret).toBe(false);
      expect(result.settingsRejectionReason).toBe(null);
      expect(result.viaPattern).toBe(false);
    }
  });

  it('classifies device-local keys as L with local_only', () => {
    for (const key of ['openTabs', 'activeFilePath', 'customCss', 'appFontFamily', 'workspacePath', 'deviceId']) {
      const result = classifySettingKey(key);
      expect(result.known).toBe(true);
      expect(result.keyClass).toBe('L');
      expect(result.settingsRejectionReason).toBe('local_only');
    }
  });

  it('classifies credential keys as R with secret_only', () => {
    for (const key of ['accessToken', 'giteeAccessToken', 'apiKey', 's3SyncConfig', 'mcp.servers', 'smms']) {
      const result = classifySettingKey(key);
      expect(result.known).toBe(true);
      expect(result.keyClass).toBe('R');
      expect(result.secret).toBe(true);
      expect(result.settingsRejectionReason).toBe('secret_only');
    }
  });

  it('marks pin as the rejected key, stored in no layer', () => {
    const info = SETTING_KEY_TABLE.pin;
    expect(info.rejected).toBe(true);
    expect(info.mvpRejected).toBe(true);
    expect(info.keyClass).toBe('R');
    expect(info.secret).toBe(true);
    expect(classifySettingKey('pin').settingsRejectionReason).toBe('secret_only');
  });

  it('marks aiModelList as the split key with secret fields', () => {
    const info = SETTING_KEY_TABLE.aiModelList;
    expect(info.split).toBe(true);
    expect(info.keyClass).toBe('S');
    expect(info.secret).toBe(true);
    expect(info.settingsRoute).toBe('split');
    expect(classifySettingKey('aiModelList').settingsRejectionReason).toBe(null);
    expect([...AI_MODEL_LIST_SECRET_FIELDS].sort()).toEqual([
      'apiKey',
      'customHeaders',
      'webSearchApiKey',
      'webSearchApiKeys',
    ]);
    expect(AI_MODEL_LIST_METADATA_FIELDS).toContain('baseURL');
    expect(AI_MODEL_LIST_METADATA_FIELDS).toContain('title');
    expect(AI_MODEL_LIST_METADATA_FIELDS).not.toContain('apiKey');
  });
});

describe('pattern and scope rules', () => {
  it('classifies unknown secret-pattern keys as R', () => {
    for (const key of ['myCustomApiKey', 'somethingSecretValue', 'vendorAccessToken', 'dbPassword']) {
      const result = classifySettingKey(key);
      expect(result.known).toBe(true);
      expect(result.keyClass).toBe('R');
      expect(result.secret).toBe(true);
      expect(result.settingsRejectionReason).toBe('secret_only');
      expect(result.viaPattern).toBe(true);
    }
  });

  it('classifies the gitlab project-id pattern as L, with or without scope', () => {
    expect(GITLAB_PROJECT_ID_PATTERN.test('gitlab_foo_project_id')).toBe(true);
    expect(GITLAB_PROJECT_ID_PATTERN.test('gitlab_foo_project_id:workspace-1')).toBe(true);
    for (const key of ['gitlab_foo_project_id', 'gitlab_foo_project_id:workspace-1']) {
      const result = classifySettingKey(key);
      expect(result.keyClass).toBe('L');
      expect(result.settingsRejectionReason).toBe('local_only');
      expect(result.viaPattern).toBe(true);
    }
    expect(GITLAB_PROJECT_ID_PATTERN.test('gitlab_project_id')).toBe(false);
  });

  it('inherits the colon-scope base key class', () => {
    const local = classifySettingKey('openTabs:workspace-1');
    expect(local.keyClass).toBe('L');
    expect(local.baseKey).toBe('openTabs');
    expect(local.settingsRejectionReason).toBe('local_only');
    const server = classifySettingKey('language:workspace-1');
    expect(server.keyClass).toBe('S');
    expect(server.baseKey).toBe('language');
    expect(server.settingsRejectionReason).toBe(null);
    const secret = classifySettingKey('accessToken:workspace-1');
    expect(secret.keyClass).toBe('R');
    expect(secret.settingsRejectionReason).toBe('secret_only');
  });

  it('fails closed on colon-scoped aiModelList variants', () => {
    const result = classifySettingKey('aiModelList:workspace-1');
    expect(result.keyClass).toBe('R');
    expect(result.secret).toBe(true);
    expect(result.settingsRejectionReason).toBe('secret_only');
  });

  it('reports unknown keys with unknown_key', () => {
    for (const key of ['definitelyNotAKey', 'unknownBase:scope', '']) {
      const result = classifySettingKey(key);
      expect(result.known).toBe(false);
      expect(result.keyClass).toBe('UNKNOWN');
      expect(result.settingsRejectionReason).toBe('unknown_key');
    }
    expect(isKnownSettingKey('definitelyNotAKey')).toBe(false);
    expect(isKnownSettingKey('language')).toBe(true);
  });

  it('treats prototype-shaped keys as unknown, never as catalogued', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const result = classifySettingKey(key);
      expect(result.known).toBe(false);
      expect(result.keyClass).toBe('UNKNOWN');
      expect(result.info).toBe(null);
      expect(result.settingsRejectionReason).toBe('unknown_key');
      expect(isKnownSettingKey(key)).toBe(false);
    }
    for (const key of ['toString:scope', 'constructor:scope', '__proto__:scope']) {
      const result = classifySettingKey(key);
      expect(result.known).toBe(false);
      expect(result.keyClass).toBe('UNKNOWN');
      expect(result.settingsRejectionReason).toBe('unknown_key');
    }
  });

  it('keeps the secret-pattern rule from contradicting the table', () => {
    for (const key of [...S_SETTING_KEYS, ...L_SETTING_KEYS]) {
      const lowered = key.toLowerCase();
      expect(SECRET_NAME_PATTERNS.some((pattern) => lowered.includes(pattern))).toBe(false);
    }
  });
});

describe('secret-vs-plain markers', () => {
  it('marks secret exactly on R keys, the rejected key, and the split key', () => {
    const secretKeys = Object.values(SETTING_KEY_TABLE)
      .filter((info) => info.secret)
      .map((info) => info.key)
      .sort();
    expect(secretKeys).toHaveLength(23 + 1 + 1);
    expect(secretKeys).toContain('pin');
    expect(secretKeys).toContain('aiModelList');
    for (const key of R_REJECT_SETTING_KEYS) {
      expect(secretKeys).toContain(key);
    }
  });

  it('records editorShortcuts as the KEP-7 open item without changing its S verdict', () => {
    expect(classifySettingKey('editorShortcuts').keyClass).toBe('S');
    expect(SETTING_KEY_OPEN_ITEMS).toContainEqual(
      expect.objectContaining({ key: 'editorShortcuts', item: 'KEP-7' }),
    );
  });
});
