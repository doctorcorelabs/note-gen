// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Classification contract tests (V3-10a). The key lists reproduce
// fase1/inventaris-pengaturan.md (V2-27 FINAL): 236 keys plus 1
// pattern. Counts are asserted exactly so inventory drift fails here
// instead of silently changing which keys the server accepts.
// `editorShortcuts` is class S: AD-33 ratifies KEP-7 (server-side,
// per V2-27). See classification.ts.

import { describe, expect, it } from 'vitest';
import {
  classifyKey,
  KNOWN_S_KEYS,
  LOCAL_ONLY_KEYS,
  REJECTED_KEYS,
  SECRET_REJECT_KEYS,
  SPLIT_KEYS,
} from '../src/services/settings/classification.js';

describe('settings key inventory counts', () => {
  it('reproduces the V2-27 inventory: 236 keys', () => {
    expect(KNOWN_S_KEYS).toHaveLength(79);
    expect(LOCAL_ONLY_KEYS).toHaveLength(132);
    expect(SECRET_REJECT_KEYS).toHaveLength(23);
    expect(SPLIT_KEYS).toEqual(['aiModelList']);
    expect(REJECTED_KEYS).toEqual(['pin']);
    const all = [...KNOWN_S_KEYS, ...LOCAL_ONLY_KEYS, ...SECRET_REJECT_KEYS, ...SPLIT_KEYS, ...REJECTED_KEYS];
    expect(new Set(all).size).toBe(236);
    expect(all).toHaveLength(236);
  });

  it('classifies every listed key to its own class', () => {
    for (const key of KNOWN_S_KEYS) {
      expect(classifyKey(key), key).toBe('S');
    }
    for (const key of LOCAL_ONLY_KEYS) {
      expect(classifyKey(key), key).toBe('L');
    }
    for (const key of SECRET_REJECT_KEYS) {
      expect(classifyKey(key), key).toBe('R_REJECT');
    }
    expect(classifyKey('aiModelList')).toBe('SPLIT');
    expect(classifyKey('pin')).toBe('REJECTED');
    expect(classifyKey('editorShortcuts')).toBe('S');
  });

  it('does not treat locale as a known key (V1-02 assumption A-02)', () => {
    expect(classifyKey('locale')).toBe('UNKNOWN');
  });
});

describe('classifyKey rule order', () => {
  it('classifies representative S keys', () => {
    expect(classifyKey('language')).toBe('S');
    expect(classifyKey('editorViewMode')).toBe('S');
    expect(classifyKey('editorLineHeight')).toBe('S');
    expect(classifyKey('primaryModel')).toBe('S');
    expect(classifyKey('shortcuts')).toBe('S');
    expect(classifyKey('useImageRepo')).toBe('S');
    expect(classifyKey('mainImageHosting')).toBe('S');
    expect(classifyKey('centeredContent')).toBe('S');
  });

  it('classifies representative L keys, including SENSITIVE reclassifications', () => {
    expect(classifyKey('openTabs')).toBe('L');
    expect(classifyKey('customCss')).toBe('L');
    expect(classifyKey('appFontFamily')).toBe('L');
    expect(classifyKey('uiScale')).toBe('L');
    expect(classifyKey('contentTextScale')).toBe('L');
    expect(classifyKey('deviceId')).toBe('L');
    expect(classifyKey('workspacePath')).toBe('L');
    expect(classifyKey('autoVectorEnabled')).toBe('L');
  });

  it('classifies representative R-MVP-REJECT keys', () => {
    expect(classifyKey('s3SyncConfig')).toBe('R_REJECT');
    expect(classifyKey('webdavSyncConfig')).toBe('R_REJECT');
    expect(classifyKey('mcp.servers')).toBe('R_REJECT');
    expect(classifyKey('mcpServers')).toBe('R_REJECT');
    expect(classifyKey('apiKey')).toBe('R_REJECT');
    expect(classifyKey('accessToken')).toBe('R_REJECT');
    expect(classifyKey('oneDriveAuthTokens')).toBe('R_REJECT');
    expect(classifyKey('pendingOneDriveConfig')).toBe('R_REJECT');
  });

  it('applies secret-name patterns to unlisted keys (rule 4 outranks the L list)', () => {
    expect(classifyKey('myApiKeyBackup')).toBe('R_REJECT');
    expect(classifyKey('somePasswordField')).toBe('R_REJECT');
    expect(classifyKey('refreshTokenCache')).toBe('R_REJECT');
    expect(classifyKey('clientSecretValue')).toBe('R_REJECT');
    expect(classifyKey('awsAccessKeyId')).toBe('R_REJECT');
    expect(classifyKey('oauthCredentialStore')).toBe('R_REJECT');
  });

  it('applies the GitLab project-id pattern with and without a scope', () => {
    expect(classifyKey('gitlab_myrepo_project_id')).toBe('L');
    expect(classifyKey('gitlab_myrepo_project_id:workspace-1')).toBe('L');
    expect(classifyKey('gitlabCustomUrl')).toBe('S');
  });

  it('inherits the basis class for colon-scoped variants', () => {
    expect(classifyKey('openTabs:workspace-1')).toBe('L');
    expect(classifyKey('language:workspace-1')).toBe('S');
    expect(classifyKey('editorShortcuts:workspace-1')).toBe('S');
    expect(classifyKey('unknownBasis:scope')).toBe('UNKNOWN');
  });

  it('fails closed for scoped aiModelList variants', () => {
    expect(classifyKey('aiModelList:workspace-1')).toBe('R_REJECT');
  });

  it('answers UNKNOWN for unlisted keys', () => {
    expect(classifyKey('definitelyNotAKey')).toBe('UNKNOWN');
    expect(classifyKey('')).toBe('UNKNOWN');
  });
});
