// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Setting key classification data for the server settings routes.
//
// Source of truth: inventaris-pengaturan.md (V2-27 FINAL), which
// catalogues 236 distinct Store keys plus 1 key pattern, classified
// under the rules of desain-store-adapter.md (V1-02) section 2.3:
// 79 class S keys, 1 split S+R key (`aiModelList`), 23 R-MVP-REJECT
// keys, 1 rejected key (`pin`), and 132 class L keys. This module
// carries that catalogue as code, with a secret-vs-plain marker per
// key, so the settings routes (V3-10a) can decide acceptance and
// the contract rejection reason (`unknown_key`, `local_only`,
// `secret_only`) without re-deriving the classification.
//
// This module is DATA plus classification lookup only. It does no
// value validation: per-key value schemas and the D-07 unknown-key
// write rule belong to the client key-schema module owned by V3-11,
// and the aiModelList split/merge behaviour belongs to the secrets
// route (V3-10a) and V3-11. The aiModelList field lists below are
// classification data for those owners, not split logic.
//
// Classification rules applied here, in V1-02 section 2.3 order:
// exact table verdicts first (special keys, the aiModelList split,
// SENSITIVE verdicts, the ALWAYS list, known S keys); then the
// secret-name patterns and the gitlab project-id pattern for keys
// not in the table; then colon-scope inheritance from the base key
// (except an `aiModelList` base, which fails closed to R); then
// unknown. No S or L key in the table matches a secret-name
// pattern, so the exact verdicts and the patterns never disagree.
//
// Open item, recorded without assumption: `editorShortcuts` is
// classified S here following V2-27 sections 3.6 and 5.2, and is
// listed in SETTING_KEY_OPEN_ITEMS under KEP-7. Nothing beyond the
// V2-27 classification is assumed about that key in this module.
// Two further V2-27 caveats are recorded, not resolved, here:
// `useImageRepo` and `mainImageHosting` are S only under the CT-07
// condition that their values carry no secret-pattern field
// (V2-27 A-02), and `agentSystemPromptExtension` is S by the
// complement rule although no writer was found (V2-27 A-05).

/** The three storage classes of V1-02 section 2.2. */
export type SettingKeyClass = 'S' | 'R' | 'L';

/** How the settings endpoint must treat one key on write. */
export type SettingsRouteDecision = 'accept' | 'split' | 'local_only' | 'secret_only';

/** The contract rejection reason for a key refused by PATCH /api/settings. */
export type SettingsRejectionReason = 'unknown_key' | 'local_only' | 'secret_only';

export interface SettingKeyInfo {
  /** The exact Store key. */
  readonly key: string;
  /** Storage class: S (server settings), R (server secrets), L (device local). */
  readonly keyClass: SettingKeyClass;
  /** True when the key carries secret material that must never reach the browser. */
  readonly secret: boolean;
  /** True only for `aiModelList`: metadata is S, the secret fields are R. */
  readonly split: boolean;
  /** True for R keys with no Fase 1 write endpoint, and for the rejected key. */
  readonly mvpRejected: boolean;
  /** True only for `pin`: stored in no layer at all. */
  readonly rejected: boolean;
  /** Write decision for PATCH /api/settings. */
  readonly settingsRoute: SettingsRouteDecision;
  /** Where the verdict comes from: a V2-27 section, or the V1-02 ALWAYS list. */
  readonly source: string;
}

/** The full V2-27 catalogue: 236 keys. Frozen; keyed by exact key name. */
export const SETTING_KEY_TABLE: Readonly<Record<string, SettingKeyInfo>> = Object.freeze({
  'agentSystemPromptExtension': Object.freeze({ key: 'agentSystemPromptExtension', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.13' }),
  'audioModel': Object.freeze({ key: 'audioModel', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.8' }),
  'autoUpdate': Object.freeze({ key: 'autoUpdate', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.2' }),
  'canvasDefaultZoom': Object.freeze({ key: 'canvasDefaultZoom', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.5' }),
  'canvasGridGap': Object.freeze({ key: 'canvasGridGap', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.5' }),
  'canvasGridStyle': Object.freeze({ key: 'canvasGridStyle', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.5' }),
  'canvasGridVisible': Object.freeze({ key: 'canvasGridVisible', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.5' }),
  'canvasInsertBehavior': Object.freeze({ key: 'canvasInsertBehavior', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.5' }),
  'canvasManagerSortMode': Object.freeze({ key: 'canvasManagerSortMode', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.5' }),
  'canvasManagerViewMode': Object.freeze({ key: 'canvasManagerViewMode', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.5' }),
  'canvasMinimapVisible': Object.freeze({ key: 'canvasMinimapVisible', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.5' }),
  'canvasSnapToGrid': Object.freeze({ key: 'canvasSnapToGrid', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.5' }),
  'canvasWheelBehavior': Object.freeze({ key: 'canvasWheelBehavior', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.5' }),
  'centeredContent': Object.freeze({ key: 'centeredContent', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.22' }),
  'codeTheme': Object.freeze({ key: 'codeTheme', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.1' }),
  'commitModel': Object.freeze({ key: 'commitModel', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'completionModel': Object.freeze({ key: 'completionModel', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'customThemeColors': Object.freeze({ key: 'customThemeColors', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.1' }),
  'darkMode': Object.freeze({ key: 'darkMode', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.1' }),
  'editorContentWidth': Object.freeze({ key: 'editorContentWidth', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'editorLineHeight': Object.freeze({ key: 'editorLineHeight', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'editorModel': Object.freeze({ key: 'editorModel', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'editorShortcuts': Object.freeze({ key: 'editorShortcuts', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.6' }),
  'editorSourceWrap': Object.freeze({ key: 'editorSourceWrap', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'editorViewMode': Object.freeze({ key: 'editorViewMode', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'embeddingModel': Object.freeze({ key: 'embeddingModel', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'enableImageRecognition': Object.freeze({ key: 'enableImageRecognition', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.7' }),
  'enableOutline': Object.freeze({ key: 'enableOutline', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'fileManagerTextSize': Object.freeze({ key: 'fileManagerTextSize', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.1' }),
  'fixedRecordTagId': Object.freeze({ key: 'fixedRecordTagId', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.3' }),
  'giteaCustomUrl': Object.freeze({ key: 'giteaCustomUrl', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.17' }),
  'giteaInstanceType': Object.freeze({ key: 'giteaInstanceType', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.17' }),
  'githubCustomImageRepo': Object.freeze({ key: 'githubCustomImageRepo', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.17' }),
  'gitlabCustomUrl': Object.freeze({ key: 'gitlabCustomUrl', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.17' }),
  'gitlabInstanceType': Object.freeze({ key: 'gitlabInstanceType', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.17' }),
  'imageMethodModel': Object.freeze({ key: 'imageMethodModel', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.7' }),
  'isRagEnabled': Object.freeze({ key: 'isRagEnabled', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'jsdelivr': Object.freeze({ key: 'jsdelivr', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.19' }),
  'language': Object.freeze({ key: 'language', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.1' }),
  'mainImageHosting': Object.freeze({ key: 'mainImageHosting', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.19' }),
  'markDescModel': Object.freeze({ key: 'markDescModel', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.3' }),
  'outlinePlacement': Object.freeze({ key: 'outlinePlacement', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'outlinePosition': Object.freeze({ key: 'outlinePosition', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'placeholderModel': Object.freeze({ key: 'placeholderModel', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'previewTheme': Object.freeze({ key: 'previewTheme', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.1' }),
  'primaryModel': Object.freeze({ key: 'primaryModel', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.9' }),
  'promptList': Object.freeze({ key: 'promptList', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.13' }),
  'ragAgentStrategy': Object.freeze({ key: 'ragAgentStrategy', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'ragAutomaticSearchEnabled': Object.freeze({ key: 'ragAutomaticSearchEnabled', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'ragChunkOverlap': Object.freeze({ key: 'ragChunkOverlap', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'ragChunkSize': Object.freeze({ key: 'ragChunkSize', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'ragEnabledSourceTypes': Object.freeze({ key: 'ragEnabledSourceTypes', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'ragExcludedPaths': Object.freeze({ key: 'ragExcludedPaths', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'ragGlobalSemanticSearchEnabled': Object.freeze({ key: 'ragGlobalSemanticSearchEnabled', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'ragRerankThreshold': Object.freeze({ key: 'ragRerankThreshold', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'ragResultCount': Object.freeze({ key: 'ragResultCount', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'ragSimilarityThreshold': Object.freeze({ key: 'ragSimilarityThreshold', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'recordCompletionBehavior': Object.freeze({ key: 'recordCompletionBehavior', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.3' }),
  'recordSaveTargetMode': Object.freeze({ key: 'recordSaveTargetMode', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.3' }),
  'recordSortMode': Object.freeze({ key: 'recordSortMode', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.3' }),
  'recordTextSize': Object.freeze({ key: 'recordTextSize', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.1' }),
  'recordToolbarConfig': Object.freeze({ key: 'recordToolbarConfig', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.3' }),
  'recordViewMode': Object.freeze({ key: 'recordViewMode', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.3' }),
  'rerankingModel': Object.freeze({ key: 'rerankingModel', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'shortcuts': Object.freeze({ key: 'shortcuts', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.6' }),
  'showEditorStats': Object.freeze({ key: 'showEditorStats', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'showEditorUndoRedo': Object.freeze({ key: 'showEditorUndoRedo', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'showMobileEditorToolbar': Object.freeze({ key: 'showMobileEditorToolbar', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'showSourceLineNumbers': Object.freeze({ key: 'showSourceLineNumbers', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.4' }),
  'skills.autoMatch': Object.freeze({ key: 'skills.autoMatch', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.15' }),
  'skills.enabled': Object.freeze({ key: 'skills.enabled', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.15' }),
  'skills.enabledSkills': Object.freeze({ key: 'skills.enabledSkills', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.15' }),
  'speechToTextMode': Object.freeze({ key: 'speechToTextMode', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.8' }),
  'sttModel': Object.freeze({ key: 'sttModel', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.8' }),
  'systemPrompt': Object.freeze({ key: 'systemPrompt', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.13' }),
  'templateList': Object.freeze({ key: 'templateList', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.16' }),
  'textToSpeechMode': Object.freeze({ key: 'textToSpeechMode', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.8' }),
  'useImageRepo': Object.freeze({ key: 'useImageRepo', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.19' }),
  'wikiSemanticSearchEnabled': Object.freeze({ key: 'wikiSemanticSearchEnabled', keyClass: 'S', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'accept', source: 'V2-27 3.11' }),
  'aiModelList': Object.freeze({ key: 'aiModelList', keyClass: 'S', secret: true, split: true, mvpRejected: false, rejected: false, settingsRoute: 'split', source: 'V2-27 3.9' }),
  'accessToken': Object.freeze({ key: 'accessToken', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.17' }),
  'apiKey': Object.freeze({ key: 'apiKey', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.9' }),
  'cloudinaryImageConfig': Object.freeze({ key: 'cloudinaryImageConfig', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.19' }),
  'customHttpImageConfig': Object.freeze({ key: 'customHttpImageConfig', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.19' }),
  'giteaAccessToken': Object.freeze({ key: 'giteaAccessToken', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.17' }),
  'giteeAccessToken': Object.freeze({ key: 'giteeAccessToken', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.17' }),
  'githubImageAccessToken': Object.freeze({ key: 'githubImageAccessToken', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.17' }),
  'gitlabAccessToken': Object.freeze({ key: 'gitlabAccessToken', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.17' }),
  'imageHostingConfig': Object.freeze({ key: 'imageHostingConfig', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.19' }),
  'imageKitImageConfig': Object.freeze({ key: 'imageKitImageConfig', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.19' }),
  'lskyImageConfig': Object.freeze({ key: 'lskyImageConfig', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.19' }),
  'mcp.servers': Object.freeze({ key: 'mcp.servers', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.14' }),
  'mcpServers': Object.freeze({ key: 'mcpServers', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.14' }),
  'oneDriveAuthTokens': Object.freeze({ key: 'oneDriveAuthTokens', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.17' }),
  'pendingOneDriveConfig': Object.freeze({ key: 'pendingOneDriveConfig', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.17' }),
  'picgo': Object.freeze({ key: 'picgo', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.19' }),
  'qiniuImageConfig': Object.freeze({ key: 'qiniuImageConfig', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.19' }),
  's3Config': Object.freeze({ key: 's3Config', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.19' }),
  's3SyncConfig': Object.freeze({ key: 's3SyncConfig', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.17' }),
  'smms': Object.freeze({ key: 'smms', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.19' }),
  'upyunImageConfig': Object.freeze({ key: 'upyunImageConfig', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.19' }),
  'webdavImageConfig': Object.freeze({ key: 'webdavImageConfig', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.19' }),
  'webdavSyncConfig': Object.freeze({ key: 'webdavSyncConfig', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: 'secret_only', source: 'V2-27 3.17' }),
  'pin': Object.freeze({ key: 'pin', keyClass: 'R', secret: true, split: false, mvpRejected: true, rejected: true, settingsRoute: 'secret_only', source: 'V2-27 3.1' }),
  'activeFilePath': Object.freeze({ key: 'activeFilePath', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'activeOcrProviderId': Object.freeze({ key: 'activeOcrProviderId', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'activeTabId': Object.freeze({ key: 'activeTabId', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'agentCorePromptVersion': Object.freeze({ key: 'agentCorePromptVersion', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'agentPermissionMode': Object.freeze({ key: 'agentPermissionMode', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'analyticsInstallId': Object.freeze({ key: 'analyticsInstallId', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'analyticsLastActiveDate': Object.freeze({ key: 'analyticsLastActiveDate', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'analyticsSeenVersions': Object.freeze({ key: 'analyticsSeenVersions', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'appFontFamily': Object.freeze({ key: 'appFontFamily', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V2-27 3.1' }),
  'assetsPath': Object.freeze({ key: 'assetsPath', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoConversationSyncDiagnostic': Object.freeze({ key: 'autoConversationSyncDiagnostic', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoConversationSyncEnabled': Object.freeze({ key: 'autoConversationSyncEnabled', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoDataSyncBaselineFingerprints': Object.freeze({ key: 'autoDataSyncBaselineFingerprints', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoDataSyncDirtyDomains': Object.freeze({ key: 'autoDataSyncDirtyDomains', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoDataSyncEnabled': Object.freeze({ key: 'autoDataSyncEnabled', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoDataSyncLastAppliedRemoteMeta': Object.freeze({ key: 'autoDataSyncLastAppliedRemoteMeta', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoDataSyncLastAppliedRemoteMetaUpdatedAtMs': Object.freeze({ key: 'autoDataSyncLastAppliedRemoteMetaUpdatedAtMs', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoDataSyncLastLocalUploadMeta': Object.freeze({ key: 'autoDataSyncLastLocalUploadMeta', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoDataSyncLastLocalUploadMetaUpdatedAtMs': Object.freeze({ key: 'autoDataSyncLastLocalUploadMetaUpdatedAtMs', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoDataSyncMemorySettingsMigrated': Object.freeze({ key: 'autoDataSyncMemorySettingsMigrated', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoDataSyncRecordSnapshots': Object.freeze({ key: 'autoDataSyncRecordSnapshots', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoPullOnOpen': Object.freeze({ key: 'autoPullOnOpen', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoReadClipboard': Object.freeze({ key: 'autoReadClipboard', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoRecordSyncEnabled': Object.freeze({ key: 'autoRecordSyncEnabled', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoSettingsSyncEnabled': Object.freeze({ key: 'autoSettingsSyncEnabled', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoSync': Object.freeze({ key: 'autoSync', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autoVectorEnabled': Object.freeze({ key: 'autoVectorEnabled', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'autostartMinimized': Object.freeze({ key: 'autostartMinimized', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'canvasSyncVersions': Object.freeze({ key: 'canvasSyncVersions', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'centerPanelVisible': Object.freeze({ key: 'centerPanelVisible', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'clipboardMonitor': Object.freeze({ key: 'clipboardMonitor', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'clipboardMonitorEnabled': Object.freeze({ key: 'clipboardMonitorEnabled', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'closeBehavior': Object.freeze({ key: 'closeBehavior', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'cloudFolderSyncConfig': Object.freeze({ key: 'cloudFolderSyncConfig', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'collapsibleList': Object.freeze({ key: 'collapsibleList', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'contentTextScale': Object.freeze({ key: 'contentTextScale', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V2-27 3.1' }),
  'conversationSyncInitialized': Object.freeze({ key: 'conversationSyncInitialized', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'conversationSyncVersions': Object.freeze({ key: 'conversationSyncVersions', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'currentAi': Object.freeze({ key: 'currentAi', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'currentPage': Object.freeze({ key: 'currentPage', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'currentPromptId': Object.freeze({ key: 'currentPromptId', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'currentTagId': Object.freeze({ key: 'currentTagId', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'customCss': Object.freeze({ key: 'customCss', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'desktopOnboardingProgress': Object.freeze({ key: 'desktopOnboardingProgress', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'developerMode': Object.freeze({ key: 'developerMode', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'developerPerformanceInfo': Object.freeze({ key: 'developerPerformanceInfo', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'deviceId': Object.freeze({ key: 'deviceId', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'editorWorkspaceLayout': Object.freeze({ key: 'editorWorkspaceLayout', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'excludeSensitiveConfig': Object.freeze({ key: 'excludeSensitiveConfig', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'fileLocks': Object.freeze({ key: 'fileLocks', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'fileSidebarVisible': Object.freeze({ key: 'fileSidebarVisible', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'fileTreeScrollTop': Object.freeze({ key: 'fileTreeScrollTop', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'giteaAutoSync': Object.freeze({ key: 'giteaAutoSync', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'giteaCustomSyncRepo': Object.freeze({ key: 'giteaCustomSyncRepo', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'giteaUsername': Object.freeze({ key: 'giteaUsername', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'giteeAutoSync': Object.freeze({ key: 'giteeAutoSync', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'giteeCustomSyncRepo': Object.freeze({ key: 'giteeCustomSyncRepo', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'giteeUsername': Object.freeze({ key: 'giteeUsername', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'githubCustomSyncRepo': Object.freeze({ key: 'githubCustomSyncRepo', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'githubImageUsername': Object.freeze({ key: 'githubImageUsername', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'githubReleasesCache': Object.freeze({ key: 'githubReleasesCache', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'githubUsername': Object.freeze({ key: 'githubUsername', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'gitlabAutoSync': Object.freeze({ key: 'gitlabAutoSync', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'gitlabCustomSyncRepo': Object.freeze({ key: 'gitlabCustomSyncRepo', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'gitlabUsername': Object.freeze({ key: 'gitlabUsername', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'globalSearchFilter': Object.freeze({ key: 'globalSearchFilter', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'ignoredVersion': Object.freeze({ key: 'ignoredVersion', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'iosWorkspaceFolderAccess': Object.freeze({ key: 'iosWorkspaceFolderAccess', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'iosWorkspaceFolderAccessHistory': Object.freeze({ key: 'iosWorkspaceFolderAccessHistory', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'lastAppliedRemoteRev': Object.freeze({ key: 'lastAppliedRemoteRev', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'lastDownloadedRagSnapshot': Object.freeze({ key: 'lastDownloadedRagSnapshot', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'lastOrganizeTemplateId': Object.freeze({ key: 'lastOrganizeTemplateId', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'lastRecordPage': Object.freeze({ key: 'lastRecordPage', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'lastRecordTagId': Object.freeze({ key: 'lastRecordTagId', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'lastRestoreTimes': Object.freeze({ key: 'lastRestoreTimes', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'lastSettingPage': Object.freeze({ key: 'lastSettingPage', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'lastSyncTimes': Object.freeze({ key: 'lastSyncTimes', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'lastVectorProcessTime': Object.freeze({ key: 'lastVectorProcessTime', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'learnedContextWindows': Object.freeze({ key: 'learnedContextWindows', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'leftSidebarTab': Object.freeze({ key: 'leftSidebarTab', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'leftSidebarVisible': Object.freeze({ key: 'leftSidebarVisible', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'managedBackupDirectory': Object.freeze({ key: 'managedBackupDirectory', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'managedBackupLastError': Object.freeze({ key: 'managedBackupLastError', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'managedBackupLastSuccessAt': Object.freeze({ key: 'managedBackupLastSuccessAt', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'managedBackupRetention': Object.freeze({ key: 'managedBackupRetention', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'managedBackupSchedule': Object.freeze({ key: 'managedBackupSchedule', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'mcp.selectedServerIds': Object.freeze({ key: 'mcp.selectedServerIds', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'memorySyncInitialized': Object.freeze({ key: 'memorySyncInitialized', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'noteGenDefaultModelsCache': Object.freeze({ key: 'noteGenDefaultModelsCache', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'noteGenModelPolicyCache': Object.freeze({ key: 'noteGenModelPolicyCache', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'noteSidebarVisible': Object.freeze({ key: 'noteSidebarVisible', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'openTabs': Object.freeze({ key: 'openTabs', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'outlineOpenByFile': Object.freeze({ key: 'outlineOpenByFile', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'outlineWidth': Object.freeze({ key: 'outlineWidth', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'pendingRecordAssetRemoteDeletions': Object.freeze({ key: 'pendingRecordAssetRemoteDeletions', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'platformSwitchRecovery': Object.freeze({ key: 'platformSwitchRecovery', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'primaryBackupMethod': Object.freeze({ key: 'primaryBackupMethod', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'providerTemplatesCache': Object.freeze({ key: 'providerTemplatesCache', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'proxy': Object.freeze({ key: 'proxy', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'proxyCustomURL': Object.freeze({ key: 'proxyCustomURL', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'ragIndexNeedsRebuild': Object.freeze({ key: 'ragIndexNeedsRebuild', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'ragKnowledgeIndexPaused': Object.freeze({ key: 'ragKnowledgeIndexPaused', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'ragStructuredKnowledgeConsent': Object.freeze({ key: 'ragStructuredKnowledgeConsent', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'recordFilterTags': Object.freeze({ key: 'recordFilterTags', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'recordFilters': Object.freeze({ key: 'recordFilters', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'remoteSkills.searchCache': Object.freeze({ key: 'remoteSkills.searchCache', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'rightSidebarVisible': Object.freeze({ key: 'rightSidebarVisible', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'selfHostedConnectionReviewProfileId': Object.freeze({ key: 'selfHostedConnectionReviewProfileId', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'selfHostedDeferredWorkspacePaths': Object.freeze({ key: 'selfHostedDeferredWorkspacePaths', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'selfHostedDeviceId': Object.freeze({ key: 'selfHostedDeviceId', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'selfHostedExperimentalAcknowledged': Object.freeze({ key: 'selfHostedExperimentalAcknowledged', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'selfHostedServerUrlDraft': Object.freeze({ key: 'selfHostedServerUrlDraft', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'syncQueue': Object.freeze({ key: 'syncQueue', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'syncStaticAssets': Object.freeze({ key: 'syncStaticAssets', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'syncedFileShas': Object.freeze({ key: 'syncedFileShas', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'systemProxy': Object.freeze({ key: 'systemProxy', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'uiScale': Object.freeze({ key: 'uiScale', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V2-27 3.1' }),
  'vectorAutoCalcDisabled': Object.freeze({ key: 'vectorAutoCalcDisabled', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'vectorExcludedFiles': Object.freeze({ key: 'vectorExcludedFiles', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'version': Object.freeze({ key: 'version', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'wikiDefaultEnabled': Object.freeze({ key: 'wikiDefaultEnabled', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'wikiDeviceId': Object.freeze({ key: 'wikiDeviceId', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'wikiGeneratedNotes': Object.freeze({ key: 'wikiGeneratedNotes', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'wikiLastContextsByWorkspace': Object.freeze({ key: 'wikiLastContextsByWorkspace', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'wikiModel': Object.freeze({ key: 'wikiModel', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'wikiPreferencesInitialized': Object.freeze({ key: 'wikiPreferencesInitialized', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'wikiRemoteIdentities': Object.freeze({ key: 'wikiRemoteIdentities', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'wikiSettingsByContext': Object.freeze({ key: 'wikiSettingsByContext', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'wikiWorkspaceModelsInitialized': Object.freeze({ key: 'wikiWorkspaceModelsInitialized', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'workspaceHistory': Object.freeze({ key: 'workspaceHistory', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'workspacePath': Object.freeze({ key: 'workspacePath', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
  'workspaceSyncRepos': Object.freeze({ key: 'workspaceSyncRepos', keyClass: 'L', secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: 'local_only', source: 'V1-02 2.4' }),
});

/** The 79 plain server-synchronised keys. */
export const S_SETTING_KEYS: readonly string[] = Object.freeze([
  'agentSystemPromptExtension', 'audioModel', 'autoUpdate', 'canvasDefaultZoom', 'canvasGridGap', 'canvasGridStyle',
  'canvasGridVisible', 'canvasInsertBehavior', 'canvasManagerSortMode', 'canvasManagerViewMode', 'canvasMinimapVisible', 'canvasSnapToGrid',
  'canvasWheelBehavior', 'centeredContent', 'codeTheme', 'commitModel', 'completionModel', 'customThemeColors',
  'darkMode', 'editorContentWidth', 'editorLineHeight', 'editorModel', 'editorShortcuts', 'editorSourceWrap',
  'editorViewMode', 'embeddingModel', 'enableImageRecognition', 'enableOutline', 'fileManagerTextSize', 'fixedRecordTagId',
  'giteaCustomUrl', 'giteaInstanceType', 'githubCustomImageRepo', 'gitlabCustomUrl', 'gitlabInstanceType', 'imageMethodModel',
  'isRagEnabled', 'jsdelivr', 'language', 'mainImageHosting', 'markDescModel', 'outlinePlacement',
  'outlinePosition', 'placeholderModel', 'previewTheme', 'primaryModel', 'promptList', 'ragAgentStrategy',
  'ragAutomaticSearchEnabled', 'ragChunkOverlap', 'ragChunkSize', 'ragEnabledSourceTypes', 'ragExcludedPaths', 'ragGlobalSemanticSearchEnabled',
  'ragRerankThreshold', 'ragResultCount', 'ragSimilarityThreshold', 'recordCompletionBehavior', 'recordSaveTargetMode', 'recordSortMode',
  'recordTextSize', 'recordToolbarConfig', 'recordViewMode', 'rerankingModel', 'shortcuts', 'showEditorStats',
  'showEditorUndoRedo', 'showMobileEditorToolbar', 'showSourceLineNumbers', 'skills.autoMatch', 'skills.enabled', 'skills.enabledSkills',
  'speechToTextMode', 'sttModel', 'systemPrompt', 'templateList', 'textToSpeechMode', 'useImageRepo',
  'wikiSemanticSearchEnabled',
]);

/** The split key: metadata S, secret fields R. */
export const SPLIT_SETTING_KEYS: readonly string[] = Object.freeze([
  'aiModelList',
]);

/** The 23 R keys with no Fase 1 write endpoint (R-MVP-REJECT). */
export const R_REJECT_SETTING_KEYS: readonly string[] = Object.freeze([
  'accessToken', 'apiKey', 'cloudinaryImageConfig', 'customHttpImageConfig', 'giteaAccessToken', 'giteeAccessToken',
  'githubImageAccessToken', 'gitlabAccessToken', 'imageHostingConfig', 'imageKitImageConfig', 'lskyImageConfig', 'mcp.servers',
  'mcpServers', 'oneDriveAuthTokens', 'pendingOneDriveConfig', 'picgo', 'qiniuImageConfig', 's3Config',
  's3SyncConfig', 'smms', 'upyunImageConfig', 'webdavImageConfig', 'webdavSyncConfig',
]);

/** The key stored in no layer. */
export const REJECTED_SETTING_KEYS: readonly string[] = Object.freeze([
  'pin',
]);

/** The 132 device-local keys. */
export const L_SETTING_KEYS: readonly string[] = Object.freeze([
  'activeFilePath', 'activeOcrProviderId', 'activeTabId', 'agentCorePromptVersion', 'agentPermissionMode', 'analyticsInstallId',
  'analyticsLastActiveDate', 'analyticsSeenVersions', 'appFontFamily', 'assetsPath', 'autoConversationSyncDiagnostic', 'autoConversationSyncEnabled',
  'autoDataSyncBaselineFingerprints', 'autoDataSyncDirtyDomains', 'autoDataSyncEnabled', 'autoDataSyncLastAppliedRemoteMeta', 'autoDataSyncLastAppliedRemoteMetaUpdatedAtMs', 'autoDataSyncLastLocalUploadMeta',
  'autoDataSyncLastLocalUploadMetaUpdatedAtMs', 'autoDataSyncMemorySettingsMigrated', 'autoDataSyncRecordSnapshots', 'autoPullOnOpen', 'autoReadClipboard', 'autoRecordSyncEnabled',
  'autoSettingsSyncEnabled', 'autoSync', 'autoVectorEnabled', 'autostartMinimized', 'canvasSyncVersions', 'centerPanelVisible',
  'clipboardMonitor', 'clipboardMonitorEnabled', 'closeBehavior', 'cloudFolderSyncConfig', 'collapsibleList', 'contentTextScale',
  'conversationSyncInitialized', 'conversationSyncVersions', 'currentAi', 'currentPage', 'currentPromptId', 'currentTagId',
  'customCss', 'desktopOnboardingProgress', 'developerMode', 'developerPerformanceInfo', 'deviceId', 'editorWorkspaceLayout',
  'excludeSensitiveConfig', 'fileLocks', 'fileSidebarVisible', 'fileTreeScrollTop', 'giteaAutoSync', 'giteaCustomSyncRepo',
  'giteaUsername', 'giteeAutoSync', 'giteeCustomSyncRepo', 'giteeUsername', 'githubCustomSyncRepo', 'githubImageUsername',
  'githubReleasesCache', 'githubUsername', 'gitlabAutoSync', 'gitlabCustomSyncRepo', 'gitlabUsername', 'globalSearchFilter',
  'ignoredVersion', 'iosWorkspaceFolderAccess', 'iosWorkspaceFolderAccessHistory', 'lastAppliedRemoteRev', 'lastDownloadedRagSnapshot', 'lastOrganizeTemplateId',
  'lastRecordPage', 'lastRecordTagId', 'lastRestoreTimes', 'lastSettingPage', 'lastSyncTimes', 'lastVectorProcessTime',
  'learnedContextWindows', 'leftSidebarTab', 'leftSidebarVisible', 'managedBackupDirectory', 'managedBackupLastError', 'managedBackupLastSuccessAt',
  'managedBackupRetention', 'managedBackupSchedule', 'mcp.selectedServerIds', 'memorySyncInitialized', 'noteGenDefaultModelsCache', 'noteGenModelPolicyCache',
  'noteSidebarVisible', 'openTabs', 'outlineOpenByFile', 'outlineWidth', 'pendingRecordAssetRemoteDeletions', 'platformSwitchRecovery',
  'primaryBackupMethod', 'providerTemplatesCache', 'proxy', 'proxyCustomURL', 'ragIndexNeedsRebuild', 'ragKnowledgeIndexPaused',
  'ragStructuredKnowledgeConsent', 'recordFilterTags', 'recordFilters', 'remoteSkills.searchCache', 'rightSidebarVisible', 'selfHostedConnectionReviewProfileId',
  'selfHostedDeferredWorkspacePaths', 'selfHostedDeviceId', 'selfHostedExperimentalAcknowledged', 'selfHostedServerUrlDraft', 'syncQueue', 'syncStaticAssets',
  'syncedFileShas', 'systemProxy', 'uiScale', 'vectorAutoCalcDisabled', 'vectorExcludedFiles', 'version',
  'wikiDefaultEnabled', 'wikiDeviceId', 'wikiGeneratedNotes', 'wikiLastContextsByWorkspace', 'wikiModel', 'wikiPreferencesInitialized',
  'wikiRemoteIdentities', 'wikiSettingsByContext', 'wikiWorkspaceModelsInitialized', 'workspaceHistory', 'workspacePath', 'workspaceSyncRepos',
]);

/** All 236 known keys, sorted. */
export const KNOWN_SETTING_KEYS: ReadonlySet<string> = new Set(
  [...S_SETTING_KEYS, ...SPLIT_SETTING_KEYS, ...R_REJECT_SETTING_KEYS, ...REJECTED_SETTING_KEYS, ...L_SETTING_KEYS],
);

/** Catalogue counts, asserted by test against the table itself. */
export const SETTING_KEY_COUNTS = Object.freeze({
  total: 236,
  s: 79,
  split: 1,
  rReject: 23,
  rejected: 1,
  l: 132,
});

// Secret-name substrings from sync-exclusions.ts
// (SENSITIVE_SYNC_FIELD_PATTERNS), matched against the lowercased
// key name. Any key matching one is class R, even when it also
// appears on a device-local list (V1-02 section 2.3 rule 4).
export const SECRET_NAME_PATTERNS: readonly string[] = Object.freeze([
  'apikey',
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'password',
  'secret',
  'token',
  'credential',
]);

// The one key pattern in the V2-27 catalogue (V2-27 section 3.17):
// per-repository GitLab project ids, class L, with or without a
// colon scope. This is a pattern, not a 237th key.
export const GITLAB_PROJECT_ID_PATTERN = /^gitlab_.+_project_id(?::.*)?$/;

// aiModelList field classification (desain-store-adapter.md section
// 2.7). DATA ONLY: the split/merge behaviour belongs to V3-10a and
// V3-11. Field names, not values, and no secret value ever appears
// here. Entries under `models` are assumed to carry no
// secret-pattern field (V1-02 assumption A-04, contract test CT-08).
export const AI_MODEL_LIST_SECRET_FIELDS: readonly string[] = Object.freeze([
  'apiKey',
  'customHeaders',
  'webSearchApiKey',
  'webSearchApiKeys',
]);
export const AI_MODEL_LIST_METADATA_FIELDS: readonly string[] = Object.freeze([
  'key', 'title', 'baseURL', 'templateKey', 'templateSource', 'icon',
  'apiKeyUrl', 'promotion', 'sponsored', 'proxyMode', 'proxyURL', 'models',
  'model', 'temperature', 'topP', 'modelType', 'voice', 'speed',
  'enableStream', 'maxTokens', 'contextWindow', 'tokenLimitParam', 'reasoningEffort', 'enableWebSearch',
  'enableNativeWebSearch', 'enableThirdPartyWebSearch', 'enableBasicWebSearch', 'webSearchProvider', 'webSearchProviderOrder',
]);

export interface SettingKeyOpenItem {
  readonly key: string;
  readonly item: string;
  readonly note: string;
}

/** Open items recorded without assumption; classification above still applies. */
export const SETTING_KEY_OPEN_ITEMS: readonly SettingKeyOpenItem[] = Object.freeze([
  Object.freeze({
    key: 'editorShortcuts',
    item: 'KEP-7',
    note: 'Classified S following V2-27 sections 3.6 and 5.2. No further assumption is recorded here.',
  }),
]);

export interface ClassificationResult {
  /** The key as asked. */
  readonly key: string;
  /** False only when no rule classifies the key. */
  readonly known: boolean;
  /** The exact table entry, when the key is catalogued exactly. */
  readonly info: SettingKeyInfo | null;
  /** Storage class, or 'UNKNOWN' when no rule classifies the key. */
  readonly keyClass: SettingKeyClass | 'UNKNOWN';
  /** Whether the key carries secret material. */
  readonly secret: boolean;
  /** Contract rejection reason, or null when the settings route accepts the key. */
  readonly settingsRejectionReason: SettingsRejectionReason | null;
  /** True when a pattern or colon-scope rule, not the exact table, classified the key. */
  readonly viaPattern: boolean;
  /** The colon-scope base key, when colon inheritance applied. */
  readonly baseKey: string | null;
}

function resultForInfo(key: string, info: SettingKeyInfo, viaPattern: boolean, baseKey: string | null): ClassificationResult {
  return {
    key,
    known: true,
    info: viaPattern ? null : info,
    keyClass: info.keyClass,
    secret: info.secret,
    settingsRejectionReason: info.settingsRoute === 'accept' || info.settingsRoute === 'split' ? null : info.settingsRoute,
    viaPattern,
    baseKey,
  };
}

function patternReject(key: string): ClassificationResult {
  return {
    key,
    known: true,
    info: null,
    keyClass: 'R',
    secret: true,
    settingsRejectionReason: 'secret_only',
    viaPattern: true,
    baseKey: null,
  };
}

/**
 * Classify one Store key under the V1-02 section 2.3 rule order.
 *
 * Exact catalogue verdicts win first. Keys not in the catalogue
 * are then tested against the secret-name patterns (class R) and
 * the gitlab project-id pattern (class L), then inherit their
 * colon-scope base key, except that an `aiModelList` base fails
 * closed to R because the field split is defined only for the
 * exact key. Anything else is unknown: reads behave as absent
 * and writes are refused with `unknown_key` by the route.
 */
export function classifySettingKey(key: string): ClassificationResult {
  if (typeof key !== 'string' || key === '') {
    return {
      key: typeof key === 'string' ? key : '',
      known: false,
      info: null,
      keyClass: 'UNKNOWN',
      secret: false,
      settingsRejectionReason: 'unknown_key',
      viaPattern: false,
      baseKey: null,
    };
  }
  const exact = SETTING_KEY_TABLE[key];
  if (exact !== undefined) {
    return resultForInfo(key, exact, false, null);
  }
  const lowered = key.toLowerCase();
  for (const pattern of SECRET_NAME_PATTERNS) {
    if (lowered.includes(pattern)) {
      return patternReject(key);
    }
  }
  if (GITLAB_PROJECT_ID_PATTERN.test(key)) {
    return {
      key,
      known: true,
      info: null,
      keyClass: 'L',
      secret: false,
      settingsRejectionReason: 'local_only',
      viaPattern: true,
      baseKey: null,
    };
  }
  const colon = key.indexOf(':');
  if (colon > 0) {
    const base = key.slice(0, colon);
    if (base === 'aiModelList') {
      return patternReject(key);
    }
    const baseInfo = SETTING_KEY_TABLE[base];
    if (baseInfo !== undefined) {
      return resultForInfo(key, baseInfo, true, base);
    }
  }
  return {
    key,
    known: false,
    info: null,
    keyClass: 'UNKNOWN',
    secret: false,
    settingsRejectionReason: 'unknown_key',
    viaPattern: false,
    baseKey: null,
  };
}

/** True when the key is one of the 236 catalogued keys (exact match only). */
export function isKnownSettingKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(SETTING_KEY_TABLE, key);
}
