// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Client key schema for the Store adapter (V3-11, wave 3B).
 *
 * This module is the single client source of truth for Store key
 * classification, following desain-store-adapter.md (V1-02) sections
 * 2.3 (rule order), 2.5 (SENSITIVE verdicts), 2.7 (aiModelList split),
 * 2.10 (special keys), and 4.4 (module exports). It carries the
 * 236-key V2-27 catalogue (79 S, 1 split, 23 R-MVP-REJECT, 1 rejected,
 * 132 L) as data, plus the secret-name patterns, the GitLab project-id
 * pattern, and colon-scope inheritance, so the web adapter
 * (store.web.ts) and the fake can classify keys without re-deriving
 * the rules.
 *
 * Agreement with the server is pinned, not shared by import: the
 * server enforcement table (server/src/services/settings/
 * classification.ts, V3-10a) and the server catalogue
 * (server/src/lib/settings-key-classification.ts, V3-10b) hold the
 * same 236 keys, and the colocated spec pins this module against
 * frozen snapshots generated from those files at base 13e4e3e5. The
 * two sides must never import each other: the server must never
 * import client store code, and the client bundle must never import
 * server code. When either side changes the catalogue, regenerate
 * the snapshots and update this module in the same change; the spec
 * fails loudly otherwise. The server conformance spec
 * (server/test/settings-classification-conformance.spec.ts) pins the
 * two server tables together; this module plus its spec complete the
 * triangle.
 *
 * Classification vocabulary: classifyKey() returns StoreKeyClass
 * from interface.ts (S, R, L, R_REJECT, UNKNOWN), the vocabulary the
 * adapter contract uses. The split key aiModelList classifies as S
 * there, because its metadata lives in class S; the split itself is
 * visible through classifyKeyDetailed() (schemaClass SPLIT) and the
 * splitAiModelList() helper. The rejected key pin classifies as
 * R_REJECT there, matching the interface set() contract, which
 * groups R_REJECT and pin; the rejected distinction is visible
 * through classifyKeyDetailed() (schemaClass REJECTED, rejected true).
 * No other key is split or rejected.
 *
 * D-07 (AD-31, decided at merge M6): a write to an unknown key throws
 * PlatformCapabilityError with code invalid_argument, applied here
 * through assertWritable() and consumed by store.web.ts set(). Reads
 * stay tolerant: an unknown key reads as absent. A write to an
 * R_REJECT key or to pin throws PlatformCapabilityError with code
 * unavailable, matching the fake (store.fake.ts), because no Fase 1
 * write endpoint exists for those keys. Error messages name the key
 * (a catalogue identifier) but never a value.
 *
 * Value validation: every known key has a validation hook in
 * KEY_VALUE_VALIDATORS. The default hook requires a JSON value,
 * mirroring the server isJsonValue check (depth at most 32, finite
 * numbers, no cycles, no undefined, functions, symbols, or bigints),
 * which is the only value rule the server enforces for plain S keys;
 * inventing stricter per-key shapes would make the client reject
 * values the server accepts, the exact drift CT-06 exists to catch.
 * The hooks are the seam where evidenced per-key shapes land later.
 * Two keys carry extra hooks from the design: aiModelList has the
 * strict shape the server PATCH validates (array, at most 100
 * entries, plain objects with a non-empty unique string key), except
 * that secret fields are accepted here because the adapter splits
 * them out before any request (desain section 2.7 rule 3), while the
 * server PATCH rejects them secret_only; useImageRepo and
 * mainImageHosting carry the CT-07/A-02 condition that their values
 * hold no secret-pattern field, because both are S only under that
 * condition (V2-27 A-02).
 *
 * editorShortcuts is class S (AD-33 ratifies KEP-7; AD-53 confirms S
 * wins over the earlier UNCLASSIFIED reading). The single enforcement
 * point server-side stays the V3-10a module; this module agrees with
 * it and does not re-litigate the classification.
 *
 * This module holds no application defaults (desain section 4.4:
 * defaults belong to initSettingData), no secret values, and no I/O.
 * It must never import Tauri packages or any *.tauri.ts / *.web.ts
 * module. The Tauri adapter must not import this module (desain
 * section 3.2: desktop behavior is unchanged).
 */

import { capabilityError } from "../errors";
import type { StoreKeyClass } from "./interface";

/** The three storage classes of V1-02 section 2.2. */
export type SettingKeyClass = "S" | "R" | "L";

/**
 * Fine-grained verdict vocabulary, mirroring the server V3-10a
 * SettingsKeyClass so the conformance spec can compare the two sides
 * key for key. SPLIT is aiModelList only; REJECTED is pin only.
 */
export type SchemaVerdict =
  | "S"
  | "L"
  | "R_REJECT"
  | "SPLIT"
  | "REJECTED"
  | "UNKNOWN";

/** How the settings endpoint must treat one key on write. */
export type SettingsRouteDecision =
  | "accept"
  | "split"
  | "local_only"
  | "secret_only";

/** The contract rejection reason for a key refused by PATCH /api/settings. */
export type SettingsRejectionReason =
  | "unknown_key"
  | "local_only"
  | "secret_only"
  | "invalid_value";

/** Key-only rejection reasons: invalid_value depends on the value, not the key. */
export type KeyRejectionReason = Exclude<SettingsRejectionReason, "invalid_value">;

export interface KeySchemaInfo {
  /** The exact Store key. */
  readonly key: string;
  /** Storage class: S (server settings), R (server secrets), L (device local). */
  readonly keyClass: SettingKeyClass;
  /** True when the key carries secret material that must never reach the browser. */
  readonly secret: boolean;
  /** True only for aiModelList: metadata is S, the secret fields are R. */
  readonly split: boolean;
  /** True for R keys with no Fase 1 write endpoint, and for the rejected key. */
  readonly mvpRejected: boolean;
  /** True only for pin: stored in no layer at all. */
  readonly rejected: boolean;
  /** Write decision for PATCH /api/settings. */
  readonly settingsRoute: SettingsRouteDecision;
  /** Where the verdict comes from: a V2-27 section, or the V1-02 ALWAYS list. */
  readonly source: string;
}

/**
 * SENSITIVE verdicts from V1-02 section 2.5 (the full 21-key
 * SENSITIVE_SYNC_EXCLUDED_FIELDS table). Checked before the
 * secret-name patterns, because the verdict table (rule 3) outranks
 * the pattern rule (rule 4). Keys reclassified to L here stay L even
 * though they sit on the upstream SENSITIVE list.
 */
export type SensitiveKeyVerdict = "L" | "S" | "SPLIT" | "R_REJECT";

export const SECRET_KEY_VERDICTS: Readonly<Record<string, SensitiveKeyVerdict>> =
  Object.freeze({
    appFontFamily: "L",
    uiScale: "L",
    contentTextScale: "L",
    aiModelList: "SPLIT",
    useImageRepo: "S",
    mainImageHosting: "S",
    s3SyncConfig: "R_REJECT",
    webdavSyncConfig: "R_REJECT",
    imageHostingConfig: "R_REJECT",
    s3Config: "R_REJECT",
    smms: "R_REJECT",
    picgo: "R_REJECT",
    lskyImageConfig: "R_REJECT",
    webdavImageConfig: "R_REJECT",
    customHttpImageConfig: "R_REJECT",
    cloudinaryImageConfig: "R_REJECT",
    imageKitImageConfig: "R_REJECT",
    qiniuImageConfig: "R_REJECT",
    upyunImageConfig: "R_REJECT",
    mcpServers: "R_REJECT",
    "mcp.servers": "R_REJECT",
  });

/** SENSITIVE keys reclassified to L by the verdict table (rule 3). */
export const SENSITIVE_TO_L_KEYS: readonly string[] = Object.freeze([
  "appFontFamily",
  "contentTextScale",
  "uiScale",
]);

// Secret-name substrings from sync-exclusions.ts
// (SENSITIVE_SYNC_FIELD_PATTERNS), matched against the lowercased
// key name. Any key matching one is class R, even when it also
// appears on a device-local list (V1-02 section 2.3 rule 4).
export const SECRET_NAME_PATTERNS: readonly string[] = Object.freeze([
  "apikey",
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "password",
  "secret",
  "token",
  "credential",
]);

// The one key pattern in the V2-27 catalogue (V2-27 section 3.17):
// per-repository GitLab project ids, class L, with or without a
// colon scope. This is a pattern, not a 237th key.
export const GITLAB_PROJECT_ID_PATTERN = /^gitlab_.+_project_id(?::.*)?$/;

// aiModelList field classification (desain-store-adapter.md section
// 2.7). Field names only; no secret value ever appears here. Entries
// under `models` are assumed to carry no secret-pattern field (V1-02
// assumption A-04, contract test CT-08).
export const AI_MODEL_LIST_SECRET_FIELDS: readonly string[] = Object.freeze([
  "apiKey",
  "customHeaders",
  "webSearchApiKey",
  "webSearchApiKeys",
]);

export const AI_MODEL_LIST_METADATA_FIELDS: readonly string[] = Object.freeze([
  "key",
  "title",
  "baseURL",
  "templateKey",
  "templateSource",
  "icon",
  "apiKeyUrl",
  "promotion",
  "sponsored",
  "proxyMode",
  "proxyURL",
  "models",
  "model",
  "temperature",
  "topP",
  "modelType",
  "voice",
  "speed",
  "enableStream",
  "maxTokens",
  "contextWindow",
  "tokenLimitParam",
  "reasoningEffort",
  "enableWebSearch",
  "enableNativeWebSearch",
  "enableThirdPartyWebSearch",
  "enableBasicWebSearch",
  "webSearchProvider",
  "webSearchProviderOrder",
]);

/** Credential-carrying fields of one AiConfig entry (the secret bundle). */
export type SecretBundleField =
  | "apiKey"
  | "webSearchApiKey"
  | "webSearchApiKeys"
  | "customHeaders";

/** Computed read-enrichment fields, never stored in metadata (server-computed). */
export const COMPUTED_PROVIDER_FIELDS: readonly string[] = Object.freeze([
  "hasApiKey",
  "updatedAt",
]);

/** Maximum aiModelList entries, mirroring the server PATCH limit. */
export const AI_MODEL_LIST_MAX_ENTRIES = 100;

/** The 79 plain server-synchronized keys (V2-27 catalogue). */
export const KNOWN_S_KEYS: readonly string[] = Object.freeze([
  "agentSystemPromptExtension", "audioModel", "autoUpdate", "canvasDefaultZoom", "canvasGridGap", "canvasGridStyle",
  "canvasGridVisible", "canvasInsertBehavior", "canvasManagerSortMode", "canvasManagerViewMode", "canvasMinimapVisible", "canvasSnapToGrid",
  "canvasWheelBehavior", "centeredContent", "codeTheme", "commitModel", "completionModel", "customThemeColors",
  "darkMode", "editorContentWidth", "editorLineHeight", "editorModel", "editorShortcuts", "editorSourceWrap",
  "editorViewMode", "embeddingModel", "enableImageRecognition", "enableOutline", "fileManagerTextSize", "fixedRecordTagId",
  "giteaCustomUrl", "giteaInstanceType", "githubCustomImageRepo", "gitlabCustomUrl", "gitlabInstanceType", "imageMethodModel",
  "isRagEnabled", "jsdelivr", "language", "mainImageHosting", "markDescModel", "outlinePlacement",
  "outlinePosition", "placeholderModel", "previewTheme", "primaryModel", "promptList", "ragAgentStrategy",
  "ragAutomaticSearchEnabled", "ragChunkOverlap", "ragChunkSize", "ragEnabledSourceTypes", "ragExcludedPaths", "ragGlobalSemanticSearchEnabled",
  "ragRerankThreshold", "ragResultCount", "ragSimilarityThreshold", "recordCompletionBehavior", "recordSaveTargetMode", "recordSortMode",
  "recordTextSize", "recordToolbarConfig", "recordViewMode", "rerankingModel", "shortcuts", "showEditorStats",
  "showEditorUndoRedo", "showMobileEditorToolbar", "showSourceLineNumbers", "skills.autoMatch", "skills.enabled", "skills.enabledSkills",
  "speechToTextMode", "sttModel", "systemPrompt", "templateList", "textToSpeechMode", "useImageRepo",
  "wikiSemanticSearchEnabled",
]);

/** The split key: metadata S, secret fields R. */
export const SPLIT_KEYS: readonly string[] = Object.freeze([
  "aiModelList",
]);

/** The 23 R keys with no Fase 1 write endpoint (R-MVP-REJECT). */
export const SECRET_REJECT_KEYS: readonly string[] = Object.freeze([
  "accessToken", "apiKey", "cloudinaryImageConfig", "customHttpImageConfig", "giteaAccessToken", "giteeAccessToken",
  "githubImageAccessToken", "gitlabAccessToken", "imageHostingConfig", "imageKitImageConfig", "lskyImageConfig", "mcp.servers",
  "mcpServers", "oneDriveAuthTokens", "pendingOneDriveConfig", "picgo", "qiniuImageConfig", "s3Config",
  "s3SyncConfig", "smms", "upyunImageConfig", "webdavImageConfig", "webdavSyncConfig",
]);

/** The key stored in no layer. */
export const REJECTED_KEYS: readonly string[] = Object.freeze([
  "pin",
]);

/** The 132 device-local keys. */
export const LOCAL_ONLY_KEYS: readonly string[] = Object.freeze([
  "activeFilePath", "activeOcrProviderId", "activeTabId", "agentCorePromptVersion", "agentPermissionMode", "analyticsInstallId",
  "analyticsLastActiveDate", "analyticsSeenVersions", "appFontFamily", "assetsPath", "autoConversationSyncDiagnostic", "autoConversationSyncEnabled",
  "autoDataSyncBaselineFingerprints", "autoDataSyncDirtyDomains", "autoDataSyncEnabled", "autoDataSyncLastAppliedRemoteMeta", "autoDataSyncLastAppliedRemoteMetaUpdatedAtMs", "autoDataSyncLastLocalUploadMeta",
  "autoDataSyncLastLocalUploadMetaUpdatedAtMs", "autoDataSyncMemorySettingsMigrated", "autoDataSyncRecordSnapshots", "autoPullOnOpen", "autoReadClipboard", "autoRecordSyncEnabled",
  "autoSettingsSyncEnabled", "autoSync", "autoVectorEnabled", "autostartMinimized", "canvasSyncVersions", "centerPanelVisible",
  "clipboardMonitor", "clipboardMonitorEnabled", "closeBehavior", "cloudFolderSyncConfig", "collapsibleList", "contentTextScale",
  "conversationSyncInitialized", "conversationSyncVersions", "currentAi", "currentPage", "currentPromptId", "currentTagId",
  "customCss", "desktopOnboardingProgress", "developerMode", "developerPerformanceInfo", "deviceId", "editorWorkspaceLayout",
  "excludeSensitiveConfig", "fileLocks", "fileSidebarVisible", "fileTreeScrollTop", "giteaAutoSync", "giteaCustomSyncRepo",
  "giteaUsername", "giteeAutoSync", "giteeCustomSyncRepo", "giteeUsername", "githubCustomSyncRepo", "githubImageUsername",
  "githubReleasesCache", "githubUsername", "gitlabAutoSync", "gitlabCustomSyncRepo", "gitlabUsername", "globalSearchFilter",
  "ignoredVersion", "iosWorkspaceFolderAccess", "iosWorkspaceFolderAccessHistory", "lastAppliedRemoteRev", "lastDownloadedRagSnapshot", "lastOrganizeTemplateId",
  "lastRecordPage", "lastRecordTagId", "lastRestoreTimes", "lastSettingPage", "lastSyncTimes", "lastVectorProcessTime",
  "learnedContextWindows", "leftSidebarTab", "leftSidebarVisible", "managedBackupDirectory", "managedBackupLastError", "managedBackupLastSuccessAt",
  "managedBackupRetention", "managedBackupSchedule", "mcp.selectedServerIds", "memorySyncInitialized", "noteGenDefaultModelsCache", "noteGenModelPolicyCache",
  "noteSidebarVisible", "openTabs", "outlineOpenByFile", "outlineWidth", "pendingRecordAssetRemoteDeletions", "platformSwitchRecovery",
  "primaryBackupMethod", "providerTemplatesCache", "proxy", "proxyCustomURL", "ragIndexNeedsRebuild", "ragKnowledgeIndexPaused",
  "ragStructuredKnowledgeConsent", "recordFilterTags", "recordFilters", "remoteSkills.searchCache", "rightSidebarVisible", "selfHostedConnectionReviewProfileId",
  "selfHostedDeferredWorkspacePaths", "selfHostedDeviceId", "selfHostedExperimentalAcknowledged", "selfHostedServerUrlDraft", "syncQueue", "syncStaticAssets",
  "syncedFileShas", "systemProxy", "uiScale", "vectorAutoCalcDisabled", "vectorExcludedFiles", "version",
  "wikiDefaultEnabled", "wikiDeviceId", "wikiGeneratedNotes", "wikiLastContextsByWorkspace", "wikiModel", "wikiPreferencesInitialized",
  "wikiRemoteIdentities", "wikiSettingsByContext", "wikiWorkspaceModelsInitialized", "workspaceHistory", "workspacePath", "workspaceSyncRepos",
]);

/** The full V2-27 catalogue: 236 keys. Frozen; keyed by exact key name. */
export const KEY_SCHEMA_TABLE: Readonly<Record<string, KeySchemaInfo>> = Object.freeze({
  "agentSystemPromptExtension": Object.freeze({ key: "agentSystemPromptExtension", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.13" }),
  "audioModel": Object.freeze({ key: "audioModel", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.8" }),
  "autoUpdate": Object.freeze({ key: "autoUpdate", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.2" }),
  "canvasDefaultZoom": Object.freeze({ key: "canvasDefaultZoom", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.5" }),
  "canvasGridGap": Object.freeze({ key: "canvasGridGap", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.5" }),
  "canvasGridStyle": Object.freeze({ key: "canvasGridStyle", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.5" }),
  "canvasGridVisible": Object.freeze({ key: "canvasGridVisible", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.5" }),
  "canvasInsertBehavior": Object.freeze({ key: "canvasInsertBehavior", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.5" }),
  "canvasManagerSortMode": Object.freeze({ key: "canvasManagerSortMode", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.5" }),
  "canvasManagerViewMode": Object.freeze({ key: "canvasManagerViewMode", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.5" }),
  "canvasMinimapVisible": Object.freeze({ key: "canvasMinimapVisible", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.5" }),
  "canvasSnapToGrid": Object.freeze({ key: "canvasSnapToGrid", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.5" }),
  "canvasWheelBehavior": Object.freeze({ key: "canvasWheelBehavior", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.5" }),
  "centeredContent": Object.freeze({ key: "centeredContent", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.22" }),
  "codeTheme": Object.freeze({ key: "codeTheme", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.1" }),
  "commitModel": Object.freeze({ key: "commitModel", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "completionModel": Object.freeze({ key: "completionModel", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "customThemeColors": Object.freeze({ key: "customThemeColors", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.1" }),
  "darkMode": Object.freeze({ key: "darkMode", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.1" }),
  "editorContentWidth": Object.freeze({ key: "editorContentWidth", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "editorLineHeight": Object.freeze({ key: "editorLineHeight", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "editorModel": Object.freeze({ key: "editorModel", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "editorShortcuts": Object.freeze({ key: "editorShortcuts", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.6" }),
  "editorSourceWrap": Object.freeze({ key: "editorSourceWrap", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "editorViewMode": Object.freeze({ key: "editorViewMode", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "embeddingModel": Object.freeze({ key: "embeddingModel", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "enableImageRecognition": Object.freeze({ key: "enableImageRecognition", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.7" }),
  "enableOutline": Object.freeze({ key: "enableOutline", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "fileManagerTextSize": Object.freeze({ key: "fileManagerTextSize", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.1" }),
  "fixedRecordTagId": Object.freeze({ key: "fixedRecordTagId", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.3" }),
  "giteaCustomUrl": Object.freeze({ key: "giteaCustomUrl", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.17" }),
  "giteaInstanceType": Object.freeze({ key: "giteaInstanceType", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.17" }),
  "githubCustomImageRepo": Object.freeze({ key: "githubCustomImageRepo", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.17" }),
  "gitlabCustomUrl": Object.freeze({ key: "gitlabCustomUrl", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.17" }),
  "gitlabInstanceType": Object.freeze({ key: "gitlabInstanceType", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.17" }),
  "imageMethodModel": Object.freeze({ key: "imageMethodModel", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.7" }),
  "isRagEnabled": Object.freeze({ key: "isRagEnabled", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "jsdelivr": Object.freeze({ key: "jsdelivr", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.19" }),
  "language": Object.freeze({ key: "language", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.1" }),
  "mainImageHosting": Object.freeze({ key: "mainImageHosting", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.19" }),
  "markDescModel": Object.freeze({ key: "markDescModel", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.3" }),
  "outlinePlacement": Object.freeze({ key: "outlinePlacement", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "outlinePosition": Object.freeze({ key: "outlinePosition", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "placeholderModel": Object.freeze({ key: "placeholderModel", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "previewTheme": Object.freeze({ key: "previewTheme", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.1" }),
  "primaryModel": Object.freeze({ key: "primaryModel", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.9" }),
  "promptList": Object.freeze({ key: "promptList", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.13" }),
  "ragAgentStrategy": Object.freeze({ key: "ragAgentStrategy", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "ragAutomaticSearchEnabled": Object.freeze({ key: "ragAutomaticSearchEnabled", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "ragChunkOverlap": Object.freeze({ key: "ragChunkOverlap", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "ragChunkSize": Object.freeze({ key: "ragChunkSize", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "ragEnabledSourceTypes": Object.freeze({ key: "ragEnabledSourceTypes", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "ragExcludedPaths": Object.freeze({ key: "ragExcludedPaths", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "ragGlobalSemanticSearchEnabled": Object.freeze({ key: "ragGlobalSemanticSearchEnabled", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "ragRerankThreshold": Object.freeze({ key: "ragRerankThreshold", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "ragResultCount": Object.freeze({ key: "ragResultCount", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "ragSimilarityThreshold": Object.freeze({ key: "ragSimilarityThreshold", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "recordCompletionBehavior": Object.freeze({ key: "recordCompletionBehavior", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.3" }),
  "recordSaveTargetMode": Object.freeze({ key: "recordSaveTargetMode", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.3" }),
  "recordSortMode": Object.freeze({ key: "recordSortMode", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.3" }),
  "recordTextSize": Object.freeze({ key: "recordTextSize", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.1" }),
  "recordToolbarConfig": Object.freeze({ key: "recordToolbarConfig", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.3" }),
  "recordViewMode": Object.freeze({ key: "recordViewMode", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.3" }),
  "rerankingModel": Object.freeze({ key: "rerankingModel", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "shortcuts": Object.freeze({ key: "shortcuts", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.6" }),
  "showEditorStats": Object.freeze({ key: "showEditorStats", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "showEditorUndoRedo": Object.freeze({ key: "showEditorUndoRedo", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "showMobileEditorToolbar": Object.freeze({ key: "showMobileEditorToolbar", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "showSourceLineNumbers": Object.freeze({ key: "showSourceLineNumbers", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.4" }),
  "skills.autoMatch": Object.freeze({ key: "skills.autoMatch", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.15" }),
  "skills.enabled": Object.freeze({ key: "skills.enabled", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.15" }),
  "skills.enabledSkills": Object.freeze({ key: "skills.enabledSkills", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.15" }),
  "speechToTextMode": Object.freeze({ key: "speechToTextMode", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.8" }),
  "sttModel": Object.freeze({ key: "sttModel", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.8" }),
  "systemPrompt": Object.freeze({ key: "systemPrompt", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.13" }),
  "templateList": Object.freeze({ key: "templateList", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.16" }),
  "textToSpeechMode": Object.freeze({ key: "textToSpeechMode", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.8" }),
  "useImageRepo": Object.freeze({ key: "useImageRepo", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.19" }),
  "wikiSemanticSearchEnabled": Object.freeze({ key: "wikiSemanticSearchEnabled", keyClass: "S", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "accept", source: "V2-27 3.11" }),
  "aiModelList": Object.freeze({ key: "aiModelList", keyClass: "S", secret: true, split: true, mvpRejected: false, rejected: false, settingsRoute: "split", source: "V2-27 3.9" }),
  "accessToken": Object.freeze({ key: "accessToken", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.17" }),
  "apiKey": Object.freeze({ key: "apiKey", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.9" }),
  "cloudinaryImageConfig": Object.freeze({ key: "cloudinaryImageConfig", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.19" }),
  "customHttpImageConfig": Object.freeze({ key: "customHttpImageConfig", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.19" }),
  "giteaAccessToken": Object.freeze({ key: "giteaAccessToken", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.17" }),
  "giteeAccessToken": Object.freeze({ key: "giteeAccessToken", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.17" }),
  "githubImageAccessToken": Object.freeze({ key: "githubImageAccessToken", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.17" }),
  "gitlabAccessToken": Object.freeze({ key: "gitlabAccessToken", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.17" }),
  "imageHostingConfig": Object.freeze({ key: "imageHostingConfig", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.19" }),
  "imageKitImageConfig": Object.freeze({ key: "imageKitImageConfig", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.19" }),
  "lskyImageConfig": Object.freeze({ key: "lskyImageConfig", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.19" }),
  "mcp.servers": Object.freeze({ key: "mcp.servers", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.14" }),
  "mcpServers": Object.freeze({ key: "mcpServers", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.14" }),
  "oneDriveAuthTokens": Object.freeze({ key: "oneDriveAuthTokens", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.17" }),
  "pendingOneDriveConfig": Object.freeze({ key: "pendingOneDriveConfig", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.17" }),
  "picgo": Object.freeze({ key: "picgo", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.19" }),
  "qiniuImageConfig": Object.freeze({ key: "qiniuImageConfig", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.19" }),
  "s3Config": Object.freeze({ key: "s3Config", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.19" }),
  "s3SyncConfig": Object.freeze({ key: "s3SyncConfig", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.17" }),
  "smms": Object.freeze({ key: "smms", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.19" }),
  "upyunImageConfig": Object.freeze({ key: "upyunImageConfig", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.19" }),
  "webdavImageConfig": Object.freeze({ key: "webdavImageConfig", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.19" }),
  "webdavSyncConfig": Object.freeze({ key: "webdavSyncConfig", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: false, settingsRoute: "secret_only", source: "V2-27 3.17" }),
  "pin": Object.freeze({ key: "pin", keyClass: "R", secret: true, split: false, mvpRejected: true, rejected: true, settingsRoute: "secret_only", source: "V2-27 3.1" }),
  "activeFilePath": Object.freeze({ key: "activeFilePath", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "activeOcrProviderId": Object.freeze({ key: "activeOcrProviderId", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "activeTabId": Object.freeze({ key: "activeTabId", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "agentCorePromptVersion": Object.freeze({ key: "agentCorePromptVersion", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "agentPermissionMode": Object.freeze({ key: "agentPermissionMode", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "analyticsInstallId": Object.freeze({ key: "analyticsInstallId", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "analyticsLastActiveDate": Object.freeze({ key: "analyticsLastActiveDate", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "analyticsSeenVersions": Object.freeze({ key: "analyticsSeenVersions", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "appFontFamily": Object.freeze({ key: "appFontFamily", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V2-27 3.1" }),
  "assetsPath": Object.freeze({ key: "assetsPath", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoConversationSyncDiagnostic": Object.freeze({ key: "autoConversationSyncDiagnostic", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoConversationSyncEnabled": Object.freeze({ key: "autoConversationSyncEnabled", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoDataSyncBaselineFingerprints": Object.freeze({ key: "autoDataSyncBaselineFingerprints", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoDataSyncDirtyDomains": Object.freeze({ key: "autoDataSyncDirtyDomains", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoDataSyncEnabled": Object.freeze({ key: "autoDataSyncEnabled", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoDataSyncLastAppliedRemoteMeta": Object.freeze({ key: "autoDataSyncLastAppliedRemoteMeta", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoDataSyncLastAppliedRemoteMetaUpdatedAtMs": Object.freeze({ key: "autoDataSyncLastAppliedRemoteMetaUpdatedAtMs", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoDataSyncLastLocalUploadMeta": Object.freeze({ key: "autoDataSyncLastLocalUploadMeta", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoDataSyncLastLocalUploadMetaUpdatedAtMs": Object.freeze({ key: "autoDataSyncLastLocalUploadMetaUpdatedAtMs", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoDataSyncMemorySettingsMigrated": Object.freeze({ key: "autoDataSyncMemorySettingsMigrated", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoDataSyncRecordSnapshots": Object.freeze({ key: "autoDataSyncRecordSnapshots", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoPullOnOpen": Object.freeze({ key: "autoPullOnOpen", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoReadClipboard": Object.freeze({ key: "autoReadClipboard", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoRecordSyncEnabled": Object.freeze({ key: "autoRecordSyncEnabled", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoSettingsSyncEnabled": Object.freeze({ key: "autoSettingsSyncEnabled", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoSync": Object.freeze({ key: "autoSync", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autoVectorEnabled": Object.freeze({ key: "autoVectorEnabled", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "autostartMinimized": Object.freeze({ key: "autostartMinimized", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "canvasSyncVersions": Object.freeze({ key: "canvasSyncVersions", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "centerPanelVisible": Object.freeze({ key: "centerPanelVisible", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "clipboardMonitor": Object.freeze({ key: "clipboardMonitor", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "clipboardMonitorEnabled": Object.freeze({ key: "clipboardMonitorEnabled", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "closeBehavior": Object.freeze({ key: "closeBehavior", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "cloudFolderSyncConfig": Object.freeze({ key: "cloudFolderSyncConfig", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "collapsibleList": Object.freeze({ key: "collapsibleList", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "contentTextScale": Object.freeze({ key: "contentTextScale", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V2-27 3.1" }),
  "conversationSyncInitialized": Object.freeze({ key: "conversationSyncInitialized", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "conversationSyncVersions": Object.freeze({ key: "conversationSyncVersions", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "currentAi": Object.freeze({ key: "currentAi", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "currentPage": Object.freeze({ key: "currentPage", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "currentPromptId": Object.freeze({ key: "currentPromptId", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "currentTagId": Object.freeze({ key: "currentTagId", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "customCss": Object.freeze({ key: "customCss", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "desktopOnboardingProgress": Object.freeze({ key: "desktopOnboardingProgress", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "developerMode": Object.freeze({ key: "developerMode", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "developerPerformanceInfo": Object.freeze({ key: "developerPerformanceInfo", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "deviceId": Object.freeze({ key: "deviceId", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "editorWorkspaceLayout": Object.freeze({ key: "editorWorkspaceLayout", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "excludeSensitiveConfig": Object.freeze({ key: "excludeSensitiveConfig", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "fileLocks": Object.freeze({ key: "fileLocks", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "fileSidebarVisible": Object.freeze({ key: "fileSidebarVisible", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "fileTreeScrollTop": Object.freeze({ key: "fileTreeScrollTop", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "giteaAutoSync": Object.freeze({ key: "giteaAutoSync", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "giteaCustomSyncRepo": Object.freeze({ key: "giteaCustomSyncRepo", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "giteaUsername": Object.freeze({ key: "giteaUsername", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "giteeAutoSync": Object.freeze({ key: "giteeAutoSync", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "giteeCustomSyncRepo": Object.freeze({ key: "giteeCustomSyncRepo", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "giteeUsername": Object.freeze({ key: "giteeUsername", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "githubCustomSyncRepo": Object.freeze({ key: "githubCustomSyncRepo", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "githubImageUsername": Object.freeze({ key: "githubImageUsername", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "githubReleasesCache": Object.freeze({ key: "githubReleasesCache", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "githubUsername": Object.freeze({ key: "githubUsername", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "gitlabAutoSync": Object.freeze({ key: "gitlabAutoSync", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "gitlabCustomSyncRepo": Object.freeze({ key: "gitlabCustomSyncRepo", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "gitlabUsername": Object.freeze({ key: "gitlabUsername", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "globalSearchFilter": Object.freeze({ key: "globalSearchFilter", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "ignoredVersion": Object.freeze({ key: "ignoredVersion", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "iosWorkspaceFolderAccess": Object.freeze({ key: "iosWorkspaceFolderAccess", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "iosWorkspaceFolderAccessHistory": Object.freeze({ key: "iosWorkspaceFolderAccessHistory", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "lastAppliedRemoteRev": Object.freeze({ key: "lastAppliedRemoteRev", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "lastDownloadedRagSnapshot": Object.freeze({ key: "lastDownloadedRagSnapshot", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "lastOrganizeTemplateId": Object.freeze({ key: "lastOrganizeTemplateId", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "lastRecordPage": Object.freeze({ key: "lastRecordPage", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "lastRecordTagId": Object.freeze({ key: "lastRecordTagId", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "lastRestoreTimes": Object.freeze({ key: "lastRestoreTimes", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "lastSettingPage": Object.freeze({ key: "lastSettingPage", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "lastSyncTimes": Object.freeze({ key: "lastSyncTimes", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "lastVectorProcessTime": Object.freeze({ key: "lastVectorProcessTime", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "learnedContextWindows": Object.freeze({ key: "learnedContextWindows", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "leftSidebarTab": Object.freeze({ key: "leftSidebarTab", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "leftSidebarVisible": Object.freeze({ key: "leftSidebarVisible", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "managedBackupDirectory": Object.freeze({ key: "managedBackupDirectory", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "managedBackupLastError": Object.freeze({ key: "managedBackupLastError", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "managedBackupLastSuccessAt": Object.freeze({ key: "managedBackupLastSuccessAt", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "managedBackupRetention": Object.freeze({ key: "managedBackupRetention", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "managedBackupSchedule": Object.freeze({ key: "managedBackupSchedule", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "mcp.selectedServerIds": Object.freeze({ key: "mcp.selectedServerIds", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "memorySyncInitialized": Object.freeze({ key: "memorySyncInitialized", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "noteGenDefaultModelsCache": Object.freeze({ key: "noteGenDefaultModelsCache", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "noteGenModelPolicyCache": Object.freeze({ key: "noteGenModelPolicyCache", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "noteSidebarVisible": Object.freeze({ key: "noteSidebarVisible", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "openTabs": Object.freeze({ key: "openTabs", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "outlineOpenByFile": Object.freeze({ key: "outlineOpenByFile", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "outlineWidth": Object.freeze({ key: "outlineWidth", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "pendingRecordAssetRemoteDeletions": Object.freeze({ key: "pendingRecordAssetRemoteDeletions", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "platformSwitchRecovery": Object.freeze({ key: "platformSwitchRecovery", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "primaryBackupMethod": Object.freeze({ key: "primaryBackupMethod", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "providerTemplatesCache": Object.freeze({ key: "providerTemplatesCache", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "proxy": Object.freeze({ key: "proxy", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "proxyCustomURL": Object.freeze({ key: "proxyCustomURL", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "ragIndexNeedsRebuild": Object.freeze({ key: "ragIndexNeedsRebuild", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "ragKnowledgeIndexPaused": Object.freeze({ key: "ragKnowledgeIndexPaused", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "ragStructuredKnowledgeConsent": Object.freeze({ key: "ragStructuredKnowledgeConsent", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "recordFilterTags": Object.freeze({ key: "recordFilterTags", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "recordFilters": Object.freeze({ key: "recordFilters", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "remoteSkills.searchCache": Object.freeze({ key: "remoteSkills.searchCache", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "rightSidebarVisible": Object.freeze({ key: "rightSidebarVisible", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "selfHostedConnectionReviewProfileId": Object.freeze({ key: "selfHostedConnectionReviewProfileId", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "selfHostedDeferredWorkspacePaths": Object.freeze({ key: "selfHostedDeferredWorkspacePaths", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "selfHostedDeviceId": Object.freeze({ key: "selfHostedDeviceId", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "selfHostedExperimentalAcknowledged": Object.freeze({ key: "selfHostedExperimentalAcknowledged", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "selfHostedServerUrlDraft": Object.freeze({ key: "selfHostedServerUrlDraft", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "syncQueue": Object.freeze({ key: "syncQueue", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "syncStaticAssets": Object.freeze({ key: "syncStaticAssets", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "syncedFileShas": Object.freeze({ key: "syncedFileShas", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "systemProxy": Object.freeze({ key: "systemProxy", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "uiScale": Object.freeze({ key: "uiScale", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V2-27 3.1" }),
  "vectorAutoCalcDisabled": Object.freeze({ key: "vectorAutoCalcDisabled", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "vectorExcludedFiles": Object.freeze({ key: "vectorExcludedFiles", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "version": Object.freeze({ key: "version", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "wikiDefaultEnabled": Object.freeze({ key: "wikiDefaultEnabled", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "wikiDeviceId": Object.freeze({ key: "wikiDeviceId", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "wikiGeneratedNotes": Object.freeze({ key: "wikiGeneratedNotes", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "wikiLastContextsByWorkspace": Object.freeze({ key: "wikiLastContextsByWorkspace", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "wikiModel": Object.freeze({ key: "wikiModel", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "wikiPreferencesInitialized": Object.freeze({ key: "wikiPreferencesInitialized", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "wikiRemoteIdentities": Object.freeze({ key: "wikiRemoteIdentities", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "wikiSettingsByContext": Object.freeze({ key: "wikiSettingsByContext", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "wikiWorkspaceModelsInitialized": Object.freeze({ key: "wikiWorkspaceModelsInitialized", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "workspaceHistory": Object.freeze({ key: "workspaceHistory", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "workspacePath": Object.freeze({ key: "workspacePath", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
  "workspaceSyncRepos": Object.freeze({ key: "workspaceSyncRepos", keyClass: "L", secret: false, split: false, mvpRejected: false, rejected: false, settingsRoute: "local_only", source: "V1-02 2.4" }),
});

/** Catalogue counts, asserted by spec against the table itself. */
export const KEY_SCHEMA_COUNTS = Object.freeze({
  total: 236,
  s: 79,
  split: 1,
  rReject: 23,
  rejected: 1,
  l: 132,
});

/** All 236 known keys. */
export const KNOWN_KEYS: ReadonlySet<string> = new Set([
  ...KNOWN_S_KEYS,
  ...SPLIT_KEYS,
  ...SECRET_REJECT_KEYS,
  ...REJECTED_KEYS,
  ...LOCAL_ONLY_KEYS,
]);

const KNOWN_S_SET: ReadonlySet<string> = new Set(KNOWN_S_KEYS);
const LOCAL_ONLY_SET: ReadonlySet<string> = new Set(LOCAL_ONLY_KEYS);
const SECRET_REJECT_SET: ReadonlySet<string> = new Set(SECRET_REJECT_KEYS);
const SENSITIVE_TO_L_SET: ReadonlySet<string> = new Set(SENSITIVE_TO_L_KEYS);

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function tableEntry(key: string): KeySchemaInfo | undefined {
  // Own-property lookup only: a plain-object table inherits
  // Object.prototype members, so indexing it directly would treat
  // keys such as __proto__ or toString as catalogued entries.
  return hasOwn(KEY_SCHEMA_TABLE, key) ? KEY_SCHEMA_TABLE[key] : undefined;
}

/** The exact catalogue entry for a key, or null when not catalogued exactly. */
export function getKeyInfo(key: string): KeySchemaInfo | null {
  return tableEntry(key) ?? null;
}

/** True when the key is one of the 236 catalogued keys (exact match only). */
export function isKnownKey(key: string): boolean {
  return hasOwn(KEY_SCHEMA_TABLE, key);
}

export function matchesSecretNamePattern(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_NAME_PATTERNS.some((pattern) => lowered.includes(pattern));
}

export interface KeyClassification {
  /** The key as asked. */
  readonly key: string;
  /** False only when no rule classifies the key. */
  readonly known: boolean;
  /** The exact table entry, when the key is catalogued exactly. */
  readonly info: KeySchemaInfo | null;
  /** Storage class, or UNKNOWN when no rule classifies the key. */
  readonly keyClass: SettingKeyClass | "UNKNOWN";
  /** Fine-grained verdict, mirroring the server V3-10a vocabulary. */
  readonly schemaClass: SchemaVerdict;
  /** Adapter vocabulary from interface.ts. SPLIT maps to S, REJECTED to R_REJECT. */
  readonly storeClass: StoreKeyClass;
  /** Whether the key carries secret material. */
  readonly secret: boolean;
  /** True only for the exact split key aiModelList. */
  readonly split: boolean;
  /** True only for the exact rejected key pin. */
  readonly rejected: boolean;
  /** True for R keys with no Fase 1 write endpoint, and for pin. */
  readonly mvpRejected: boolean;
  /** Contract rejection reason, or null when the settings route accepts the key. */
  readonly settingsRejectionReason: KeyRejectionReason | null;
  /** True when a pattern or colon-scope rule, not the exact table, classified the key. */
  readonly viaPattern: boolean;
  /** The colon-scope base key, when colon inheritance applied. */
  readonly baseKey: string | null;
}

function verdictToKeyClass(verdict: SchemaVerdict): SettingKeyClass | "UNKNOWN" {
  if (verdict === "S" || verdict === "SPLIT") {
    return "S";
  }
  if (verdict === "L") {
    return "L";
  }
  if (verdict === "R_REJECT" || verdict === "REJECTED") {
    return "R";
  }
  return "UNKNOWN";
}

function verdictToStoreClass(verdict: SchemaVerdict): StoreKeyClass {
  // No verdict maps to R: in the web fork every class R key is either
  // R_REJECT (no Fase 1 write endpoint, invisible to reads) or the
  // split key (whose metadata is S). R stays in the vocabulary for
  // the Tauri side, where secrets are readable.
  if (verdict === "SPLIT") {
    return "S";
  }
  if (verdict === "REJECTED") {
    return "R_REJECT";
  }
  return verdict;
}

function verdictToRejectionReason(
  verdict: SchemaVerdict,
): KeyRejectionReason | null {
  if (verdict === "S" || verdict === "SPLIT") {
    return null;
  }
  if (verdict === "L") {
    return "local_only";
  }
  if (verdict === "R_REJECT" || verdict === "REJECTED") {
    return "secret_only";
  }
  return "unknown_key";
}

function classificationFor(
  key: string,
  verdict: SchemaVerdict,
  info: KeySchemaInfo | null,
  viaPattern: boolean,
  baseKey: string | null,
  flags: { secret: boolean; split: boolean; rejected: boolean; mvpRejected: boolean },
): KeyClassification {
  return {
    baseKey,
    info,
    key,
    keyClass: verdictToKeyClass(verdict),
    known: verdict !== "UNKNOWN",
    mvpRejected: flags.mvpRejected,
    rejected: flags.rejected,
    schemaClass: verdict,
    secret: flags.secret,
    settingsRejectionReason: verdictToRejectionReason(verdict),
    split: flags.split,
    storeClass: verdictToStoreClass(verdict),
    viaPattern,
  };
}

function classificationForInfo(
  key: string,
  info: KeySchemaInfo,
  viaPattern: boolean,
  baseKey: string | null,
): KeyClassification {
  const verdict: SchemaVerdict = info.rejected
    ? "REJECTED"
    : info.split
      ? "SPLIT"
      : info.keyClass === "S"
        ? "S"
        : info.keyClass === "L"
          ? "L"
          : "R_REJECT";
  return classificationFor(key, verdict, viaPattern ? null : info, viaPattern, baseKey, {
    mvpRejected: info.mvpRejected,
    rejected: info.rejected,
    secret: info.secret,
    // A colon-scoped aiModelList variant never reaches here: it fails
    // closed to R below. Any other scoped variant inherits the base
    // verdict but is not itself the split key.
    split: info.split && !viaPattern,
  });
}

function classificationForPatternR(key: string): KeyClassification {
  return classificationFor(key, "R_REJECT", null, true, null, {
    mvpRejected: true,
    rejected: false,
    secret: true,
    split: false,
  });
}

// Classify an exact key (no colon-scope inheritance). Returns null
// when no exact rule matches, so the caller can try inheritance.
function classifyExact(key: string): SchemaVerdict | null {
  if (key === "pin") {
    return "REJECTED";
  }
  if (key === "aiModelList") {
    return "SPLIT";
  }
  if (SECRET_REJECT_SET.has(key)) {
    return "R_REJECT";
  }
  if (SENSITIVE_TO_L_SET.has(key)) {
    return "L";
  }
  if (matchesSecretNamePattern(key)) {
    return "R_REJECT";
  }
  if (GITLAB_PROJECT_ID_PATTERN.test(key)) {
    return "L";
  }
  if (LOCAL_ONLY_SET.has(key)) {
    return "L";
  }
  if (KNOWN_S_SET.has(key)) {
    return "S";
  }
  return null;
}

/**
 * Classify one Store key under the V1-02 section 2.3 rule order, with
 * full detail. Exact catalogue verdicts win first. Keys not in the
 * catalogue are then tested against the secret-name patterns (class
 * R) and the GitLab project-id pattern (class L), then inherit their
 * colon-scope base key, except that an aiModelList base fails closed
 * to R because the field split is defined only for the exact key.
 * Anything else is unknown: reads behave as absent and writes are
 * refused (D-07, see assertWritable).
 */
export function classifyKeyDetailed(key: string): KeyClassification {
  if (typeof key !== "string" || key === "") {
    return classificationFor(typeof key === "string" ? key : "", "UNKNOWN", null, false, null, {
      mvpRejected: false,
      rejected: false,
      secret: false,
      split: false,
    });
  }
  const exact = tableEntry(key);
  if (exact !== undefined) {
    return classificationForInfo(key, exact, false, null);
  }
  const verdict = classifyExact(key);
  if (verdict === "R_REJECT") {
    return classificationForPatternR(key);
  }
  if (verdict === "L") {
    // Only the GitLab pattern can classify an uncatalogued key as L
    // here: the exact table and the SENSITIVE-to-L set were already
    // consulted above.
    return classificationFor(key, "L", null, true, null, {
      mvpRejected: false,
      rejected: false,
      secret: false,
      split: false,
    });
  }
  const colon = key.indexOf(":");
  if (colon > 0) {
    const base = key.slice(0, colon);
    if (base === "aiModelList") {
      return classificationForPatternR(key);
    }
    const baseInfo = tableEntry(base);
    if (baseInfo !== undefined) {
      return classificationForInfo(key, baseInfo, true, base);
    }
    const baseVerdict = classifyExact(base);
    if (baseVerdict === "R_REJECT") {
      return classificationForPatternR(key);
    }
    if (baseVerdict === "L") {
      return classificationFor(key, "L", null, true, base, {
        mvpRejected: false,
        rejected: false,
        secret: false,
        split: false,
      });
    }
  }
  return classificationFor(key, "UNKNOWN", null, false, null, {
    mvpRejected: false,
    rejected: false,
    secret: false,
    split: false,
  });
}

/**
 * Classify one Store key, returning the StoreKeyClass vocabulary from
 * interface.ts. This is the function desain section 4.4 requires and
 * the one the web adapter calls on the set() path. For the split and
 * rejected distinctions, use classifyKeyDetailed().
 */
export function classifyKey(key: string): StoreKeyClass {
  return classifyKeyDetailed(key).storeClass;
}

/**
 * The settings-route rejection reason for one key, or null when the
 * settings route accepts the key (S keys and the split key). Mirrors
 * the server PATCH decision for the key alone; invalid_value is a
 * value verdict and never appears here (see validateKeyValue).
 */
export function settingsRejectionReasonFor(key: string): KeyRejectionReason | null {
  return classifyKeyDetailed(key).settingsRejectionReason;
}

/**
 * D-07 enforcement for the write path (V3-11 site 1; the store.web.ts
 * set() call is site 2). Throws PlatformCapabilityError with code
 * invalid_argument for an unknown key, leaving the caller's cache
 * unchanged, and with code unavailable for an R_REJECT key or pin.
 * Reads stay tolerant and never call this function. Callers run this
 * before value validation, and run it for every set() including
 * set(key, undefined), which is still a write.
 */
export function assertWritable(key: string): void {
  const classification = classifyKeyDetailed(key);
  if (!classification.known) {
    throw capabilityError(
      "invalid_argument",
      "store",
      "store.set",
      "web",
      `Unknown Store key "${key}": writes to keys outside the key schema are rejected.`,
    );
  }
  if (classification.rejected) {
    throw capabilityError(
      "unavailable",
      "store",
      "store.setSecretKey",
      "web",
      `Key "${key}" is not stored in any layer in the web fork.`,
    );
  }
  if (classification.schemaClass === "R_REJECT") {
    throw capabilityError(
      "unavailable",
      "store",
      "store.setSecretKey",
      "web",
      `Key "${key}" is a server-side secret with no Fase 1 write endpoint; ` +
        `reads behave as if the key does not exist`,
    );
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// True when a value is a finite-depth JSON value (null, boolean,
// string, finite number, array, plain object), with no cycles.
// Mirrors the server isJsonValue check exactly, including the depth
// cap, so the client never accepts a value the server rejects
// invalid_value and never rejects one the server accepts.
export function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    return Object.values(value).every((item) => isJsonValue(item, depth + 1));
  }
  return false;
}

/**
 * A per-key value validation hook. Returns null when the value is
 * valid, or an issue label naming the problem. Issue labels never
 * contain the value, because a rejected value may carry a secret.
 */
export type KeyValueValidator = (value: unknown) => string | null;

export interface KeyValueValidation {
  readonly valid: boolean;
  /** Issue label, or null when valid. Never contains the value. */
  readonly issue: string | null;
}

function jsonValueValidator(value: unknown): string | null {
  return isJsonValue(value) ? null : "value must be a JSON value";
}

function hasSecretPatternField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasSecretPatternField(item));
  }
  if (isPlainObject(value)) {
    for (const [field, item] of Object.entries(value)) {
      if (matchesSecretNamePattern(field) || hasSecretPatternField(item)) {
        return true;
      }
    }
  }
  return false;
}

// CT-07/A-02 condition for useImageRepo and mainImageHosting: both
// are S only while their values carry no secret-pattern field.
function noSecretPatternFieldsValidator(value: unknown): string | null {
  if (!isJsonValue(value)) {
    return "value must be a JSON value";
  }
  return hasSecretPatternField(value)
    ? "value must not carry secret-pattern fields"
    : null;
}

/**
 * Strict aiModelList shape, mirroring the server PATCH validation:
 * an array of at most 100 plain-object entries, each with a
 * non-empty unique string key and a JSON value, and no credential
 * field inside any models entry (assumption A-04, fail closed).
 * Unlike the server PATCH, secret fields at the entry top level are
 * accepted here: the adapter splits them out via splitAiModelList()
 * before any request (desain section 2.7 rule 3), so rejecting them
 * here would break legacy writers the design explicitly keeps
 * working.
 */
export function aiModelListValidator(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return "value must be an array";
  }
  if (value.length > AI_MODEL_LIST_MAX_ENTRIES) {
    return "value must contain at most 100 entries";
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return "entries must be JSON objects";
    }
    if (typeof entry.key !== "string" || entry.key === "") {
      return "entries must have a non-empty string key";
    }
    if (seen.has(entry.key)) {
      return "provider keys must be unique";
    }
    if (!isJsonValue(entry)) {
      return "entries must be JSON values";
    }
    if (modelsCarrySecretFields(entry.models)) {
      return "model entries must not carry credential fields";
    }
    seen.add(entry.key);
  }
  return null;
}

function modelsCarrySecretFields(models: unknown): boolean {
  if (!Array.isArray(models)) {
    return false;
  }
  return models.some(
    (model) =>
      isPlainObject(model) &&
      AI_MODEL_LIST_SECRET_FIELDS.some((field) => hasOwn(model, field)),
  );
}

const KEY_VALIDATOR_OVERRIDES: Readonly<Record<string, KeyValueValidator>> =
  Object.freeze({
    aiModelList: aiModelListValidator,
    mainImageHosting: noSecretPatternFieldsValidator,
    useImageRepo: noSecretPatternFieldsValidator,
  });

/**
 * One validation hook per catalogued key. The default hook requires
 * a JSON value (the only value rule the server enforces for plain S
 * keys); aiModelList, useImageRepo, and mainImageHosting carry the
 * stricter hooks described above. Built from the catalogue so a key
 * can never be catalogued without a hook. The record is frozen; hooks
 * are not registered at runtime.
 */
export const KEY_VALUE_VALIDATORS: Readonly<Record<string, KeyValueValidator>> =
  Object.freeze(
    Object.fromEntries(
      Object.keys(KEY_SCHEMA_TABLE).map((key) => [
        key,
        KEY_VALIDATOR_OVERRIDES[key] ?? jsonValueValidator,
      ]),
    ),
  );

function validatorForKey(key: string, classification: KeyClassification): KeyValueValidator {
  const exact = KEY_VALUE_VALIDATORS[key];
  if (exact !== undefined) {
    return exact;
  }
  // Colon-scoped variants validate under their base key's hook.
  if (classification.baseKey !== null) {
    return KEY_VALUE_VALIDATORS[classification.baseKey] ?? jsonValueValidator;
  }
  // Pattern-known keys (secret-pattern R, GitLab L) have no table
  // entry; the JSON hook is the only applicable value rule.
  return jsonValueValidator;
}

/**
 * Validate a value for one key without throwing. Unknown keys are
 * invalid. Callers on the set() path run assertWritable() first (for
 * the typed D-07 error) and skip value validation when the value is
 * undefined, which means delete (F1-22). A null value passes: null
 * means delete in PATCH, and the adapter handles it before flushing.
 */
export function validateKeyValue(key: string, value: unknown): KeyValueValidation {
  const classification = classifyKeyDetailed(key);
  if (!classification.known) {
    return { issue: "unknown key", valid: false };
  }
  const issue = validatorForKey(key, classification)(value);
  return issue === null ? { issue: null, valid: true } : { issue, valid: false };
}

/** Throwing form of validateKeyValue: invalid_argument, never echoing the value. */
export function assertValidKeyValue(key: string, value: unknown): void {
  const validation = validateKeyValue(key, value);
  if (!validation.valid) {
    throw capabilityError(
      "invalid_argument",
      "store",
      "store.set",
      "web",
      `Invalid value for Store key "${key}": ${validation.issue}.`,
    );
  }
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

const SECRET_BUNDLE_FIELD_LIST: readonly SecretBundleField[] = [
  "apiKey",
  "webSearchApiKey",
  "webSearchApiKeys",
  "customHeaders",
];

/**
 * True when a provider entry carries any credential field, at the
 * top level or inside a models entry. Mirrors the server
 * providerEntryHasSecretFields check exactly.
 */
export function providerEntryHasSecretFields(entry: unknown): boolean {
  if (!isPlainObject(entry)) {
    return false;
  }
  if (AI_MODEL_LIST_SECRET_FIELDS.some((field) => hasOwn(entry, field))) {
    return true;
  }
  return modelsCarrySecretFields(entry.models);
}

export interface AiModelListSplit {
  /** Entries with secret and computed fields removed, safe for PATCH /api/settings. */
  readonly metadata: Array<Record<string, unknown>>;
  /** One patch per provider that carried a secret field, for PUT ai-providers. */
  readonly secrets: Array<{
    providerKey: string;
    patch: Partial<Record<SecretBundleField, unknown>>;
  }>;
}

function toProviderMetadata(entry: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(entry)) {
    if (
      AI_MODEL_LIST_SECRET_FIELDS.includes(field) ||
      COMPUTED_PROVIDER_FIELDS.includes(field)
    ) {
      continue;
    }
    metadata[field] = cloneJsonValue(value);
  }
  return metadata;
}

/**
 * Split aiModelList entries into settings metadata and secret-bundle
 * patches (desain section 2.7). Entries must pass
 * aiModelListValidator; malformed input throws invalid_argument.
 * Secret fields present on an entry (including a present null, which
 * the secrets endpoint reads as delete-from-bundle) move to that
 * provider's patch; computed fields (hasApiKey, updatedAt) are
 * dropped from metadata because the server computes them on read.
 * Providers without a secret field get no patch entry. The returned
 * values are clones; mutating them never affects the input.
 */
export function splitAiModelList(entries: unknown): AiModelListSplit {
  const issue = aiModelListValidator(entries);
  if (issue !== null) {
    throw capabilityError(
      "invalid_argument",
      "store",
      "store.set",
      "web",
      `Invalid value for Store key "aiModelList": ${issue}.`,
    );
  }
  const metadata: Array<Record<string, unknown>> = [];
  const secrets: AiModelListSplit["secrets"] = [];
  for (const entry of entries as Array<Record<string, unknown>>) {
    metadata.push(toProviderMetadata(entry));
    const patch: Partial<Record<SecretBundleField, unknown>> = {};
    let hasSecretField = false;
    for (const field of SECRET_BUNDLE_FIELD_LIST) {
      if (hasOwn(entry, field)) {
        hasSecretField = true;
        patch[field] = cloneJsonValue(entry[field]);
      }
    }
    if (hasSecretField) {
      secrets.push({ patch, providerKey: entry.key as string });
    }
  }
  return { metadata, secrets };
}

export interface AiProviderStatus {
  readonly providerKey: string;
  readonly hasApiKey: boolean;
  readonly updatedAt: number | null;
}

/**
 * Attach read-enrichment status (hasApiKey, updatedAt) to aiModelList
 * metadata entries. Entries whose provider key has no status row get
 * hasApiKey false and updatedAt null, matching the server rule that
 * hasApiKey is computed from sealed-row existence. Status rows for
 * unknown provider keys are ignored, and later rows win on duplicate
 * provider keys. Non-array input and malformed entries pass through
 * cloned and unchanged: reads are tolerant.
 */
export function mergeAiModelMetadata(
  entries: unknown,
  status: readonly AiProviderStatus[],
): unknown {
  if (!Array.isArray(entries)) {
    return cloneJsonValue(entries);
  }
  const byProviderKey = new Map<string, AiProviderStatus>();
  for (const row of status) {
    byProviderKey.set(row.providerKey, row);
  }
  return entries.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.key !== "string") {
      return cloneJsonValue(entry);
    }
    const row = byProviderKey.get(entry.key);
    return {
      ...cloneJsonValue(entry),
      hasApiKey: row !== undefined ? row.hasApiKey : false,
      updatedAt: row !== undefined ? row.updatedAt : null,
    };
  });
}

/**
 * Metadata-only view of an aiModelList value: secret and computed
 * fields stripped from every entry, including secret fields inside
 * models entries. Defense in depth for the read path (the server
 * strips the same fields before responding); unlike
 * splitAiModelList, this never throws and never reports, because a
 * stored value carrying a secret field indicates a legacy or corrupt
 * row that must be dropped, not surfaced.
 */
export function stripAiModelListSecrets(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return cloneJsonValue(value);
  }
  return value.map((entry) => {
    if (!isPlainObject(entry)) {
      return cloneJsonValue(entry);
    }
    const metadata = toProviderMetadata(entry);
    if (Array.isArray(metadata.models)) {
      metadata.models = (metadata.models as unknown[]).map((model) => {
        if (!isPlainObject(model)) {
          return model;
        }
        const clean: Record<string, unknown> = {};
        for (const [field, fieldValue] of Object.entries(model)) {
          if (AI_MODEL_LIST_SECRET_FIELDS.includes(field)) {
            continue;
          }
          clean[field] = fieldValue;
        }
        return clean;
      });
    }
    return metadata;
  });
}
