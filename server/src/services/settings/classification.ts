// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Server-side classification of settings keys (V3-10a).
//
// Sources, in authority order:
// - fase1/inventaris-pengaturan.md (V2-27 FINAL): 236 keys plus 1
//   pattern, 21 sections, classes S/R/L. The key lists below reproduce
//   that inventory exactly: 79 S, 1 split, 132 L, 23 R-MVP-REJECT,
//   1 rejected, verified by a generator run with zero conflicts
//   against the inventory tables and the upstream exclusion lists.
// - fase1/desain-store-adapter.md (V1-02) section 2.3: the rule order
//   implemented by classifyKey, and section 2.5: the SENSITIVE verdict
//   table. Rule order matters: special keys, then aiModelList, then
//   SENSITIVE verdicts, then secret-name patterns, then the GitLab
//   pattern, then the ALWAYS list, then colon-scope inheritance, then
//   known S keys, then unknown.
// - src/config/sync-exclusions.ts at the trunk: ALWAYS_SYNC_EXCLUDED_
//   FIELDS (132 entries) and SENSITIVE_SYNC_EXCLUDED_FIELDS (21
//   entries) plus SENSITIVE_SYNC_FIELD_PATTERNS, read verbatim.
//
// This module is the SERVER enforcement point. It is not the client
// key-schema module: src/lib/platform/store/key-schema.ts and the
// D-07 unknown-key validation sites belong to V3-11 (wave 3B). The two
// modules must agree on the key lists; drift between them is caught by
// comparing the exported lists in review, not by sharing code, because
// the server must never import client store code.
//
// `editorShortcuts` is class S (AD-33 ratifies KEP-7: server-side
// via GET/PATCH /api/settings, per inventaris-pengaturan.md V2-27
// sections 3.6 and 5.2). An earlier revision of this module held the
// key UNCLASSIFIED pending the written KEP-7 decision; AD-33 closed
// that item, so the key now sits in KNOWN_S_KEYS like every other
// inventory S key, and colon-scoped variants inherit S. This matches
// the V3-10b classification data module
// (server/src/lib/settings-key-classification.ts), whose 236-key
// table agrees with the lists below key for key.

export type SettingsKeyClass =
  | 'S'
  | 'L'
  | 'R_REJECT'
  | 'SPLIT'
  | 'REJECTED'
  | 'UNKNOWN';

// Known class S keys: server settings, stored in the settings table.
// 79 keys, the full inventory S count (V2-27).
export const KNOWN_S_KEYS: readonly string[] = [
  'agentSystemPromptExtension', 'audioModel', 'autoUpdate',
  'canvasDefaultZoom', 'canvasGridGap', 'canvasGridStyle',
  'canvasGridVisible', 'canvasInsertBehavior', 'canvasManagerSortMode',
  'canvasManagerViewMode', 'canvasMinimapVisible', 'canvasSnapToGrid',
  'canvasWheelBehavior', 'centeredContent', 'codeTheme', 'commitModel',
  'completionModel', 'customThemeColors', 'darkMode', 'editorContentWidth',
  'editorLineHeight', 'editorModel', 'editorShortcuts',
  'editorSourceWrap', 'editorViewMode',
  'embeddingModel', 'enableImageRecognition', 'enableOutline',
  'fileManagerTextSize', 'fixedRecordTagId', 'giteaCustomUrl',
  'giteaInstanceType', 'githubCustomImageRepo', 'gitlabCustomUrl',
  'gitlabInstanceType', 'imageMethodModel', 'isRagEnabled', 'jsdelivr',
  'language', 'mainImageHosting', 'markDescModel', 'outlinePlacement',
  'outlinePosition', 'placeholderModel', 'previewTheme', 'primaryModel',
  'promptList', 'ragAgentStrategy', 'ragAutomaticSearchEnabled',
  'ragChunkOverlap', 'ragChunkSize', 'ragEnabledSourceTypes',
  'ragExcludedPaths', 'ragGlobalSemanticSearchEnabled', 'ragRerankThreshold',
  'ragResultCount', 'ragSimilarityThreshold', 'recordCompletionBehavior',
  'recordSaveTargetMode', 'recordSortMode', 'recordTextSize',
  'recordToolbarConfig', 'recordViewMode', 'rerankingModel', 'shortcuts',
  'showEditorStats', 'showEditorUndoRedo', 'showMobileEditorToolbar',
  'showSourceLineNumbers', 'skills.autoMatch', 'skills.enabled',
  'skills.enabledSkills', 'speechToTextMode', 'sttModel', 'systemPrompt',
  'templateList', 'textToSpeechMode', 'useImageRepo',
  'wikiSemanticSearchEnabled',
];
const KNOWN_S_SET: ReadonlySet<string> = new Set(KNOWN_S_KEYS);

// Class L keys: device-local only. Sent to the settings endpoint they
// are rejected with reason local_only, never stored server-side.
// This list is the upstream ALWAYS list minus the three keys the V1-02
// special rules move out (pin, oneDriveAuthTokens,
// pendingOneDriveConfig), plus the three SENSITIVE keys reclassified
// to L by the verdict table (appFontFamily, uiScale, contentTextScale).
export const LOCAL_ONLY_KEYS: readonly string[] = [
  'activeFilePath', 'activeOcrProviderId', 'activeTabId',
  'agentCorePromptVersion', 'agentPermissionMode', 'analyticsInstallId',
  'analyticsLastActiveDate', 'analyticsSeenVersions', 'appFontFamily',
  'assetsPath', 'autoConversationSyncDiagnostic',
  'autoConversationSyncEnabled', 'autoDataSyncBaselineFingerprints',
  'autoDataSyncDirtyDomains', 'autoDataSyncEnabled',
  'autoDataSyncLastAppliedRemoteMeta',
  'autoDataSyncLastAppliedRemoteMetaUpdatedAtMs',
  'autoDataSyncLastLocalUploadMeta',
  'autoDataSyncLastLocalUploadMetaUpdatedAtMs',
  'autoDataSyncMemorySettingsMigrated', 'autoDataSyncRecordSnapshots',
  'autoPullOnOpen', 'autoReadClipboard', 'autoRecordSyncEnabled',
  'autoSettingsSyncEnabled', 'autoSync', 'autoVectorEnabled',
  'autostartMinimized', 'canvasSyncVersions', 'centerPanelVisible',
  'clipboardMonitor', 'clipboardMonitorEnabled', 'closeBehavior',
  'cloudFolderSyncConfig', 'collapsibleList', 'contentTextScale',
  'conversationSyncInitialized', 'conversationSyncVersions', 'currentAi',
  'currentPage', 'currentPromptId', 'currentTagId', 'customCss',
  'desktopOnboardingProgress', 'developerMode', 'developerPerformanceInfo',
  'deviceId', 'editorWorkspaceLayout', 'excludeSensitiveConfig', 'fileLocks',
  'fileSidebarVisible', 'fileTreeScrollTop', 'giteaAutoSync',
  'giteaCustomSyncRepo', 'giteaUsername', 'giteeAutoSync',
  'giteeCustomSyncRepo', 'giteeUsername', 'githubCustomSyncRepo',
  'githubImageUsername', 'githubReleasesCache', 'githubUsername',
  'gitlabAutoSync', 'gitlabCustomSyncRepo', 'gitlabUsername',
  'globalSearchFilter', 'ignoredVersion', 'iosWorkspaceFolderAccess',
  'iosWorkspaceFolderAccessHistory', 'lastAppliedRemoteRev',
  'lastDownloadedRagSnapshot', 'lastOrganizeTemplateId', 'lastRecordPage',
  'lastRecordTagId', 'lastRestoreTimes', 'lastSettingPage', 'lastSyncTimes',
  'lastVectorProcessTime', 'learnedContextWindows', 'leftSidebarTab',
  'leftSidebarVisible', 'managedBackupDirectory', 'managedBackupLastError',
  'managedBackupLastSuccessAt', 'managedBackupRetention',
  'managedBackupSchedule', 'mcp.selectedServerIds', 'memorySyncInitialized',
  'noteGenDefaultModelsCache', 'noteGenModelPolicyCache',
  'noteSidebarVisible', 'openTabs', 'outlineOpenByFile', 'outlineWidth',
  'pendingRecordAssetRemoteDeletions', 'platformSwitchRecovery',
  'primaryBackupMethod', 'providerTemplatesCache', 'proxy', 'proxyCustomURL',
  'ragIndexNeedsRebuild', 'ragKnowledgeIndexPaused',
  'ragStructuredKnowledgeConsent', 'recordFilterTags', 'recordFilters',
  'remoteSkills.searchCache', 'rightSidebarVisible',
  'selfHostedConnectionReviewProfileId', 'selfHostedDeferredWorkspacePaths',
  'selfHostedDeviceId', 'selfHostedExperimentalAcknowledged',
  'selfHostedServerUrlDraft', 'syncQueue', 'syncStaticAssets',
  'syncedFileShas', 'systemProxy', 'uiScale', 'vectorAutoCalcDisabled',
  'vectorExcludedFiles', 'version', 'wikiDefaultEnabled', 'wikiDeviceId',
  'wikiGeneratedNotes', 'wikiLastContextsByWorkspace', 'wikiModel',
  'wikiPreferencesInitialized', 'wikiRemoteIdentities',
  'wikiSettingsByContext', 'wikiWorkspaceModelsInitialized',
  'workspaceHistory', 'workspacePath', 'workspaceSyncRepos',
];
const LOCAL_ONLY_SET: ReadonlySet<string> = new Set(LOCAL_ONLY_KEYS);

// Class R keys without a Fase 1 write endpoint (R-MVP-REJECT): the
// settings endpoint rejects them with reason secret_only, and no
// endpoint in Fase 1 stores them. The ai-provider bundle is the only
// class R data with an endpoint, and it travels under the split key
// aiModelList through the secrets routes, never as one of these keys.
export const SECRET_REJECT_KEYS: readonly string[] = [
  'accessToken', 'apiKey', 'cloudinaryImageConfig', 'customHttpImageConfig',
  'giteaAccessToken', 'giteeAccessToken', 'githubImageAccessToken',
  'gitlabAccessToken', 'imageHostingConfig', 'imageKitImageConfig',
  'lskyImageConfig', 'mcp.servers', 'mcpServers', 'oneDriveAuthTokens',
  'pendingOneDriveConfig', 'picgo', 'qiniuImageConfig', 's3Config',
  's3SyncConfig', 'smms', 'upyunImageConfig', 'webdavImageConfig',
  'webdavSyncConfig',
];
const SECRET_REJECT_SET: ReadonlySet<string> = new Set(SECRET_REJECT_KEYS);

// The one split key: metadata in class S, credential fields in class R
// (desain-store-adapter.md section 2.7). Handled specially by the
// settings service; classifyKey reports SPLIT so callers never treat
// it as a plain S key.
export const SPLIT_KEYS: readonly string[] = ['aiModelList'];

// Rejected outright: the app-lock PIN. Never stored in any layer.
export const REJECTED_KEYS: readonly string[] = ['pin'];

// SENSITIVE verdicts that reclassify to L (desain-store-adapter.md
// section 2.5). Checked before the secret-name patterns, because the
// verdict table (rule 3) outranks the pattern rule (rule 4).
const SENSITIVE_TO_L_KEYS: ReadonlySet<string> = new Set(['appFontFamily', 'uiScale', 'contentTextScale']);

// Secret-name patterns, verbatim from SENSITIVE_SYNC_FIELD_PATTERNS in
// src/config/sync-exclusions.ts. Matched as a substring of the
// lowercased key name. This rule outranks the ALWAYS list: a key that
// matches a pattern is secret-class even if it also appears there.
export const SECRET_NAME_PATTERNS: readonly string[] = [
  'apikey',
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'password',
  'secret',
  'token',
  'credential',
];

export function matchesSecretNamePattern(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_NAME_PATTERNS.some((pattern) => lowered.includes(pattern));
}

// GitLab project-id keys, verbatim from
// ALWAYS_SYNC_EXCLUDED_FIELD_PATTERNS. Class L, with or without a
// colon scope.
export const GITLAB_PROJECT_ID_PATTERN = /^gitlab_.+_project_id(?::.*)?$/;

// Classify an exact key (no colon-scope inheritance). Returns null
// when no exact rule matches, so the caller can try inheritance.
function classifyExact(key: string): SettingsKeyClass | null {
  if (key === 'pin') {
    return 'REJECTED';
  }
  if (key === 'aiModelList') {
    return 'SPLIT';
  }
  if (SECRET_REJECT_SET.has(key)) {
    return 'R_REJECT';
  }
  if (SENSITIVE_TO_L_KEYS.has(key)) {
    return 'L';
  }
  if (matchesSecretNamePattern(key)) {
    return 'R_REJECT';
  }
  if (GITLAB_PROJECT_ID_PATTERN.test(key)) {
    return 'L';
  }
  if (LOCAL_ONLY_SET.has(key)) {
    return 'L';
  }
  if (KNOWN_S_SET.has(key)) {
    return 'S';
  }
  return null;
}

// Classify a settings key following the V1-02 section 2.3 rule order,
// including colon-scope inheritance (rule 6/8): a scoped variant
// inherits its basis key's class, except aiModelList variants, which
// are R_REJECT fail-closed because the split logic is only defined
// for the exact key. Unknown keys answer UNKNOWN; the settings
// endpoint rejects their writes with reason unknown_key.
export function classifyKey(key: string): SettingsKeyClass {
  const exact = classifyExact(key);
  if (exact !== null) {
    return exact;
  }
  const colon = key.indexOf(':');
  if (colon > 0) {
    const basis = key.slice(0, colon);
    if (basis === 'aiModelList') {
      return 'R_REJECT';
    }
    const basisClass = classifyExact(basis);
    if (basisClass !== null) {
      return basisClass;
    }
  }
  return 'UNKNOWN';
}
