// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Behavior tests for the client key schema (key-schema.ts, V3-11).
 *
 * Runner: node:test with node:assert/strict, the pattern the repo
 * already uses for its colocated specs (see store.fake.spec.ts).
 * Bundle with the installed esbuild, then run the bundle under
 * node:test:
 *
 *   node_modules/.bin/esbuild src/lib/platform/store/key-schema.spec.ts \
 *     --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert \
 *     --outfile=/tmp/key-schema.spec.mjs
 *   node --test /tmp/key-schema.spec.mjs
 *
 * The bundle step exists because the sources use extensionless
 * imports (repo convention, bundler module resolution), which Node
 * type stripping cannot resolve directly.
 *
 * What this spec pins:
 *
 * - The 236-key catalogue counts (79 S, 132 L, 23 R-MVP-REJECT,
 *   1 split aiModelList, 1 rejected pin) and that the key lists,
 *   the table, and KNOWN_KEYS agree with each other.
 * - AD-53: editorShortcuts is S. AD-31/D-07: writes to unknown
 *   keys throw invalid_argument; reads stay tolerant (UNKNOWN).
 * - The section 2.3 rule order: exact verdicts, secret-name
 *   patterns, the GitLab project-id pattern, colon-scope
 *   inheritance (with the aiModelList fail-closed exception),
 *   then unknown.
 * - The section 2.7 aiModelList split: metadata fields S,
 *   credential-bearing fields R.
 * - Full per-key agreement with the server table contents as
 *   documented in server/src/lib/settings-key-classification.ts
 *   (V3-10b) at base 13e4e3e5, pinned as a literal snapshot of all
 *   236 server keys grouped by verdict. The client bundle must
 *   never import server code, so the pinned snapshot below is the
 *   conformance proof on this side; the live two-table proof
 *   between the two server modules lives in the server
 *   conformance spec
 *   (server/test/settings-classification-conformance.spec.ts).
 *   The R2 worker re-verified the full 236-key agreement out of
 *   band (0 field differences, identical lists and patterns)
 *   before adding the snapshot; the R3 worker re-verified it again
 *   independently (0 field differences over all 236 table entries,
 *   identical lists in order, patterns, and aiModelList field lists)
 *   before committing it. If the server table ever changes,
 *   regenerate the snapshot from the server file in the same
 *   change.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlatformCapabilityError } from "../errors";
import {
  AI_MODEL_LIST_MAX_ENTRIES,
  AI_MODEL_LIST_METADATA_FIELDS,
  AI_MODEL_LIST_SECRET_FIELDS,
  assertValidKeyValue,
  assertWritable,
  classifyKey,
  classifyKeyDetailed,
  COMPUTED_PROVIDER_FIELDS,
  getKeyInfo,
  GITLAB_PROJECT_ID_PATTERN,
  isJsonValue,
  isKnownKey,
  KEY_SCHEMA_COUNTS,
  KEY_SCHEMA_TABLE,
  KEY_VALUE_VALIDATORS,
  KNOWN_KEYS,
  KNOWN_S_KEYS,
  LOCAL_ONLY_KEYS,
  matchesSecretNamePattern,
  mergeAiModelMetadata,
  providerEntryHasSecretFields,
  REJECTED_KEYS,
  SECRET_KEY_VERDICTS,
  SECRET_NAME_PATTERNS,
  SECRET_REJECT_KEYS,
  settingsRejectionReasonFor,
  SPLIT_KEYS,
  splitAiModelList,
  stripAiModelListSecrets,
  validateKeyValue,
} from "./key-schema";

function assertCapabilityError(
  error: unknown,
  code: string,
  capability: string,
): void {
  assert.ok(
    error instanceof PlatformCapabilityError,
    `expected PlatformCapabilityError, got ${String(error)}`,
  );
  assert.equal(error.code, code);
  assert.equal(error.adapter, "store");
  assert.equal(error.capability, capability);
  assert.equal(error.mode, "web");
  assert.equal(error.name, "PlatformCapabilityError");
}

function assertThrowsCapability(
  fn: () => unknown,
  code: string,
  capability: string,
): PlatformCapabilityError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.notEqual(caught, undefined, "expected the call to throw");
  assertCapabilityError(caught, code, capability);
  return caught as PlatformCapabilityError;
}

describe("key schema: catalogue counts (V2-27)", () => {
  it("holds exactly 236 keys: 79 S, 132 L, 23 R-MVP-REJECT, 1 split, 1 rejected", () => {
    assert.equal(KNOWN_S_KEYS.length, 79);
    assert.equal(LOCAL_ONLY_KEYS.length, 132);
    assert.equal(SECRET_REJECT_KEYS.length, 23);
    assert.deepEqual([...SPLIT_KEYS], ["aiModelList"]);
    assert.deepEqual([...REJECTED_KEYS], ["pin"]);
    assert.equal(Object.keys(KEY_SCHEMA_TABLE).length, 236);
    assert.equal(KNOWN_KEYS.size, 236);
    assert.deepEqual({ ...KEY_SCHEMA_COUNTS }, {
      l: 132,
      rReject: 23,
      rejected: 1,
      s: 79,
      split: 1,
      total: 236,
    });
  });

  it("has no key in two lists and no duplicates inside a list", () => {
    const lists = [
      KNOWN_S_KEYS,
      LOCAL_ONLY_KEYS,
      SECRET_REJECT_KEYS,
      SPLIT_KEYS,
      REJECTED_KEYS,
    ];
    for (const list of lists) {
      assert.equal(new Set(list).size, list.length);
    }
    const union = new Set<string>();
    for (const list of lists) {
      for (const key of list) {
        assert.ok(!union.has(key), `key ${key} appears in two lists`);
        union.add(key);
      }
    }
    assert.equal(union.size, 236);
    assert.deepEqual([...union].sort(), [...KNOWN_KEYS].sort());
    assert.deepEqual([...union].sort(), Object.keys(KEY_SCHEMA_TABLE).sort());
  });

  it("gives every table entry a self-consistent key field and route", () => {
    for (const [name, info] of Object.entries(KEY_SCHEMA_TABLE)) {
      assert.equal(info.key, name);
      assert.ok(info.source.length > 0, `key ${name} has no source`);
      if (info.split) {
        assert.equal(info.keyClass, "S");
        assert.equal(info.settingsRoute, "split");
      } else if (info.rejected) {
        assert.equal(info.keyClass, "R");
        assert.equal(info.settingsRoute, "secret_only");
      } else if (info.keyClass === "S") {
        assert.equal(info.settingsRoute, "accept");
        assert.equal(info.secret, false);
      } else if (info.keyClass === "L") {
        assert.equal(info.settingsRoute, "local_only");
        assert.equal(info.secret, false);
      } else {
        assert.equal(info.keyClass, "R");
        assert.equal(info.settingsRoute, "secret_only");
        assert.equal(info.secret, true);
        assert.equal(info.mvpRejected, true);
      }
    }
  });

  it("has exactly one split key and one rejected key", () => {
    const split = Object.values(KEY_SCHEMA_TABLE).filter((info) => info.split);
    const rejected = Object.values(KEY_SCHEMA_TABLE).filter((info) => info.rejected);
    assert.deepEqual(split.map((info) => info.key), ["aiModelList"]);
    assert.deepEqual(rejected.map((info) => info.key), ["pin"]);
  });
});

describe("key schema: classifyKey vocabulary", () => {
  it("classifies every catalogued key as S, L, or R_REJECT, never R or UNKNOWN", () => {
    for (const key of KNOWN_S_KEYS) {
      assert.equal(classifyKey(key), "S", key);
    }
    assert.equal(classifyKey("aiModelList"), "S");
    for (const key of LOCAL_ONLY_KEYS) {
      assert.equal(classifyKey(key), "L", key);
    }
    for (const key of SECRET_REJECT_KEYS) {
      assert.equal(classifyKey(key), "R_REJECT", key);
    }
    assert.equal(classifyKey("pin"), "R_REJECT");
  });

  it("classifies editorShortcuts as S (AD-53, AD-33/KEP-7)", () => {
    assert.equal(classifyKey("editorShortcuts"), "S");
    const detailed = classifyKeyDetailed("editorShortcuts");
    assert.equal(detailed.schemaClass, "S");
    assert.equal(detailed.keyClass, "S");
    assert.equal(detailed.secret, false);
    assert.equal(detailed.split, false);
    const info = getKeyInfo("editorShortcuts");
    assert.ok(info !== null);
    assert.equal(info.keyClass, "S");
    assert.equal(info.settingsRoute, "accept");
    assert.equal(info.source, "V2-27 3.6");
  });

  it("distinguishes the split and rejected keys in detailed form", () => {
    const split = classifyKeyDetailed("aiModelList");
    assert.equal(split.schemaClass, "SPLIT");
    assert.equal(split.storeClass, "S");
    assert.equal(split.keyClass, "S");
    assert.equal(split.split, true);
    assert.equal(split.secret, true);
    assert.equal(split.settingsRejectionReason, null);
    const rejected = classifyKeyDetailed("pin");
    assert.equal(rejected.schemaClass, "REJECTED");
    assert.equal(rejected.storeClass, "R_REJECT");
    assert.equal(rejected.keyClass, "R");
    assert.equal(rejected.rejected, true);
    assert.equal(rejected.mvpRejected, true);
    assert.equal(rejected.settingsRejectionReason, "secret_only");
  });
});

describe("key schema: server-table agreement spot-checks (V3-10b contents)", () => {
  it("matches the documented server entry for representative keys", () => {
    const expected = [
      {
        key: "agentSystemPromptExtension",
        keyClass: "S",
        rejected: false,
        secret: false,
        settingsRoute: "accept",
        source: "V2-27 3.13",
        split: false,
      },
      {
        key: "language",
        keyClass: "S",
        rejected: false,
        secret: false,
        settingsRoute: "accept",
        source: "V2-27 3.1",
        split: false,
      },
      {
        key: "skills.enabled",
        keyClass: "S",
        rejected: false,
        secret: false,
        settingsRoute: "accept",
        source: "V2-27 3.15",
        split: false,
      },
      {
        key: "useImageRepo",
        keyClass: "S",
        rejected: false,
        secret: false,
        settingsRoute: "accept",
        source: "V2-27 3.19",
        split: false,
      },
      {
        key: "mainImageHosting",
        keyClass: "S",
        rejected: false,
        secret: false,
        settingsRoute: "accept",
        source: "V2-27 3.19",
        split: false,
      },
      {
        key: "aiModelList",
        keyClass: "S",
        rejected: false,
        secret: true,
        settingsRoute: "split",
        source: "V2-27 3.9",
        split: true,
      },
      {
        key: "apiKey",
        keyClass: "R",
        rejected: false,
        secret: true,
        settingsRoute: "secret_only",
        source: "V2-27 3.9",
        split: false,
      },
      {
        key: "s3SyncConfig",
        keyClass: "R",
        rejected: false,
        secret: true,
        settingsRoute: "secret_only",
        source: "V2-27 3.17",
        split: false,
      },
      {
        key: "mcp.servers",
        keyClass: "R",
        rejected: false,
        secret: true,
        settingsRoute: "secret_only",
        source: "V2-27 3.14",
        split: false,
      },
      {
        key: "oneDriveAuthTokens",
        keyClass: "R",
        rejected: false,
        secret: true,
        settingsRoute: "secret_only",
        source: "V2-27 3.17",
        split: false,
      },
      {
        key: "pendingOneDriveConfig",
        keyClass: "R",
        rejected: false,
        secret: true,
        settingsRoute: "secret_only",
        source: "V2-27 3.17",
        split: false,
      },
      {
        key: "pin",
        keyClass: "R",
        rejected: true,
        secret: true,
        settingsRoute: "secret_only",
        source: "V2-27 3.1",
        split: false,
      },
      {
        key: "appFontFamily",
        keyClass: "L",
        rejected: false,
        secret: false,
        settingsRoute: "local_only",
        source: "V2-27 3.1",
        split: false,
      },
      {
        key: "openTabs",
        keyClass: "L",
        rejected: false,
        secret: false,
        settingsRoute: "local_only",
        source: "V1-02 2.4",
        split: false,
      },
      {
        key: "version",
        keyClass: "L",
        rejected: false,
        secret: false,
        settingsRoute: "local_only",
        source: "V1-02 2.4",
        split: false,
      },
      {
        key: "wikiModel",
        keyClass: "L",
        rejected: false,
        secret: false,
        settingsRoute: "local_only",
        source: "V1-02 2.4",
        split: false,
      },
      {
        key: "workspacePath",
        keyClass: "L",
        rejected: false,
        secret: false,
        settingsRoute: "local_only",
        source: "V1-02 2.4",
        split: false,
      },
    ] as const;
    for (const want of expected) {
      const info = getKeyInfo(want.key);
      assert.ok(info !== null, want.key);
      assert.equal(info.keyClass, want.keyClass, want.key);
      assert.equal(info.secret, want.secret, want.key);
      assert.equal(info.split, want.split, want.key);
      assert.equal(info.rejected, want.rejected, want.key);
      assert.equal(info.settingsRoute, want.settingsRoute, want.key);
      assert.equal(info.source, want.source, want.key);
    }
  });

  it("shares the documented secret-name patterns and gitlab pattern with the server", () => {
    assert.deepEqual([...SECRET_NAME_PATTERNS], [
      "apikey",
      "accesskey",
      "accesskeyid",
      "accesstoken",
      "password",
      "secret",
      "token",
      "credential",
    ]);
    assert.equal(
      GITLAB_PROJECT_ID_PATTERN.source,
      "^gitlab_.+_project_id(?::.*)?$",
    );
  });

  it("shares the documented aiModelList field lists with the server", () => {
    assert.deepEqual([...AI_MODEL_LIST_SECRET_FIELDS], [
      "apiKey",
      "customHeaders",
      "webSearchApiKey",
      "webSearchApiKeys",
    ]);
    assert.deepEqual([...AI_MODEL_LIST_METADATA_FIELDS], [
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
    assert.deepEqual([...COMPUTED_PROVIDER_FIELDS], ["hasApiKey", "updatedAt"]);
    assert.equal(AI_MODEL_LIST_MAX_ENTRIES, 100);
  });
});

/**
 * Pinned snapshot of the server V3-10b catalogue
 * (server/src/lib/settings-key-classification.ts at base 13e4e3e5:
 * S_SETTING_KEYS, L_SETTING_KEYS, R_REJECT_SETTING_KEYS,
 * SPLIT_SETTING_KEYS, REJECTED_SETTING_KEYS), generated verbatim
 * from that file by the R2 worker and checked key for key against
 * the V3-10a enforcement lists, which agree in full (same keys, same
 * order). The client bundle must never import server code, so this
 * snapshot is the conformance pin: any drift between the server
 * catalogue and this module fails the tests below. When the server
 * catalogue changes, regenerate this snapshot from the server file
 * in the same change; never edit the snapshot to match a drifted
 * client table. Vocabulary mapping (server to client SchemaVerdict):
 * S to S, L to L, R with mvpRejected to R_REJECT, S with split to
 * SPLIT, R with rejected to REJECTED.
 */
const PINNED_SERVER_S_KEYS: readonly string[] = [
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
];

const PINNED_SERVER_L_KEYS: readonly string[] = [
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
];

const PINNED_SERVER_R_REJECT_KEYS: readonly string[] = [
  "accessToken", "apiKey", "cloudinaryImageConfig", "customHttpImageConfig", "giteaAccessToken", "giteeAccessToken",
  "githubImageAccessToken", "gitlabAccessToken", "imageHostingConfig", "imageKitImageConfig", "lskyImageConfig", "mcp.servers",
  "mcpServers", "oneDriveAuthTokens", "pendingOneDriveConfig", "picgo", "qiniuImageConfig", "s3Config",
  "s3SyncConfig", "smms", "upyunImageConfig", "webdavImageConfig", "webdavSyncConfig",
];

const PINNED_SERVER_SPLIT_KEYS: readonly string[] = [
  "aiModelList",
];

const PINNED_SERVER_REJECTED_KEYS: readonly string[] = [
  "pin",
];

describe("key schema: full per-key agreement with the pinned server catalogue (V3-10b)", () => {
  it("pins all 236 server keys, grouped by verdict, against the client lists", () => {
    assert.deepEqual([...KNOWN_S_KEYS].sort(), [...PINNED_SERVER_S_KEYS].sort());
    assert.deepEqual([...LOCAL_ONLY_KEYS].sort(), [...PINNED_SERVER_L_KEYS].sort());
    assert.deepEqual([...SECRET_REJECT_KEYS].sort(), [...PINNED_SERVER_R_REJECT_KEYS].sort());
    assert.deepEqual([...SPLIT_KEYS], [...PINNED_SERVER_SPLIT_KEYS]);
    assert.deepEqual([...REJECTED_KEYS], [...PINNED_SERVER_REJECTED_KEYS]);
    const pinned = [
      ...PINNED_SERVER_S_KEYS,
      ...PINNED_SERVER_L_KEYS,
      ...PINNED_SERVER_R_REJECT_KEYS,
      ...PINNED_SERVER_SPLIT_KEYS,
      ...PINNED_SERVER_REJECTED_KEYS,
    ];
    assert.equal(pinned.length, 236);
    assert.equal(new Set(pinned).size, 236);
  });

  it("agrees with the server verdict for every one of the 236 keys", () => {
    const expectations: Array<{
      keys: readonly string[];
      keyClass: "S" | "L" | "R";
      mvpRejected: boolean;
      rejected: boolean;
      schemaClass: "S" | "L" | "R_REJECT" | "SPLIT" | "REJECTED";
      secret: boolean;
      settingsRejectionReason: "local_only" | "secret_only" | null;
      settingsRoute: "accept" | "local_only" | "secret_only" | "split";
      split: boolean;
    }> = [
      { keys: PINNED_SERVER_S_KEYS, keyClass: "S", mvpRejected: false, rejected: false, schemaClass: "S", secret: false, settingsRejectionReason: null, settingsRoute: "accept", split: false },
      { keys: PINNED_SERVER_L_KEYS, keyClass: "L", mvpRejected: false, rejected: false, schemaClass: "L", secret: false, settingsRejectionReason: "local_only", settingsRoute: "local_only", split: false },
      { keys: PINNED_SERVER_R_REJECT_KEYS, keyClass: "R", mvpRejected: true, rejected: false, schemaClass: "R_REJECT", secret: true, settingsRejectionReason: "secret_only", settingsRoute: "secret_only", split: false },
      { keys: PINNED_SERVER_SPLIT_KEYS, keyClass: "S", mvpRejected: false, rejected: false, schemaClass: "SPLIT", secret: true, settingsRejectionReason: null, settingsRoute: "split", split: true },
      { keys: PINNED_SERVER_REJECTED_KEYS, keyClass: "R", mvpRejected: true, rejected: true, schemaClass: "REJECTED", secret: true, settingsRejectionReason: "secret_only", settingsRoute: "secret_only", split: false },
    ];
    let checked = 0;
    for (const want of expectations) {
      for (const key of want.keys) {
        const detailed = classifyKeyDetailed(key);
        assert.equal(detailed.schemaClass, want.schemaClass, key);
        assert.equal(detailed.keyClass, want.keyClass, key);
        assert.equal(detailed.secret, want.secret, key);
        assert.equal(detailed.split, want.split, key);
        assert.equal(detailed.rejected, want.rejected, key);
        assert.equal(detailed.mvpRejected, want.mvpRejected, key);
        assert.equal(detailed.settingsRejectionReason, want.settingsRejectionReason, key);
        const info = getKeyInfo(key);
        assert.ok(info !== null, key);
        assert.equal(info.keyClass, want.keyClass, key);
        assert.equal(info.secret, want.secret, key);
        assert.equal(info.split, want.split, key);
        assert.equal(info.mvpRejected, want.mvpRejected, key);
        assert.equal(info.rejected, want.rejected, key);
        assert.equal(info.settingsRoute, want.settingsRoute, key);
        checked += 1;
      }
    }
    assert.equal(checked, 236);
  });
});

describe("key schema: SENSITIVE verdicts (section 2.5)", () => {
  it("carries all 21 SENSITIVE verdicts exactly", () => {
    assert.deepEqual({ ...SECRET_KEY_VERDICTS }, {
      aiModelList: "SPLIT",
      appFontFamily: "L",
      cloudinaryImageConfig: "R_REJECT",
      contentTextScale: "L",
      customHttpImageConfig: "R_REJECT",
      imageHostingConfig: "R_REJECT",
      imageKitImageConfig: "R_REJECT",
      lskyImageConfig: "R_REJECT",
      mainImageHosting: "S",
      "mcp.servers": "R_REJECT",
      mcpServers: "R_REJECT",
      picgo: "R_REJECT",
      qiniuImageConfig: "R_REJECT",
      s3Config: "R_REJECT",
      s3SyncConfig: "R_REJECT",
      smms: "R_REJECT",
      uiScale: "L",
      upyunImageConfig: "R_REJECT",
      useImageRepo: "S",
      webdavImageConfig: "R_REJECT",
      webdavSyncConfig: "R_REJECT",
    });
  });

  it("keeps the three reclassified SENSITIVE keys at L", () => {
    for (const key of ["appFontFamily", "uiScale", "contentTextScale"]) {
      assert.equal(classifyKey(key), "L", key);
    }
  });
});

describe("key schema: secret-name and gitlab patterns", () => {
  it("matches every secret-name pattern, case-insensitively", () => {
    const cases: Array<[string, string]> = [
      ["myApiKey", "apikey"],
      ["awsAccessKey", "accesskey"],
      ["awsAccessKeyId", "accesskeyid"],
      ["refreshAccessToken", "accesstoken"],
      ["dbPassword", "password"],
      ["clientSecret", "secret"],
      ["sessionToken", "token"],
      ["storedCredential", "credential"],
      ["MYAPIKEY", "apikey"],
      ["SuperSecretValue", "secret"],
    ];
    for (const [key, pattern] of cases) {
      assert.equal(matchesSecretNamePattern(key), true, `${key} (${pattern})`);
      assert.equal(classifyKey(key), "R_REJECT", key);
      assert.equal(classifyKeyDetailed(key).viaPattern, true, key);
      assert.equal(classifyKeyDetailed(key).secret, true, key);
    }
  });

  it("does not match ordinary keys against the secret-name patterns", () => {
    for (const key of ["language", "openTabs", "primaryModel", "version"]) {
      assert.equal(matchesSecretNamePattern(key), false, key);
    }
    assert.equal(matchesSecretNamePattern("monkey"), false);
  });

  it("classifies gitlab project-id keys as L, with or without a colon scope", () => {
    for (const key of [
      "gitlab_myrepo_project_id",
      "gitlab_myrepo_project_id:123",
      "gitlab_a-b_c_project_id:scope:deep",
    ]) {
      assert.equal(classifyKey(key), "L", key);
      assert.equal(classifyKeyDetailed(key).viaPattern, true, key);
      assert.equal(settingsRejectionReasonFor(key), "local_only", key);
    }
  });

  it("does not match near-miss gitlab keys", () => {
    for (const key of [
      "gitlab_project_id",
      "xgitlab_repo_project_id",
      "gitlab_repo_project_idx",
      "gitlab_repo_project_id2",
    ]) {
      assert.equal(classifyKey(key), "UNKNOWN", key);
    }
  });

  it("lets the exact table win over the patterns", () => {
    assert.equal(classifyKey("oneDriveAuthTokens"), "R_REJECT");
    assert.equal(classifyKeyDetailed("oneDriveAuthTokens").viaPattern, false);
    assert.ok(getKeyInfo("oneDriveAuthTokens") !== null);
  });
});

describe("key schema: colon-scope inheritance (matchesSyncField)", () => {
  it("inherits S, L, and R classes from the base key", () => {
    const language = classifyKeyDetailed("language:en");
    assert.equal(language.storeClass, "S");
    assert.equal(language.baseKey, "language");
    assert.equal(language.viaPattern, true);
    assert.equal(language.info, null);
    const tabs = classifyKeyDetailed("openTabs:workspace-1");
    assert.equal(tabs.storeClass, "L");
    assert.equal(tabs.baseKey, "openTabs");
    const secret = classifyKeyDetailed("s3SyncConfig:backup");
    assert.equal(secret.storeClass, "R_REJECT");
    assert.equal(secret.baseKey, "s3SyncConfig");
    assert.equal(secret.secret, true);
  });

  it("inherits the rejected verdict from a pin base", () => {
    const scoped = classifyKeyDetailed("pin:scope");
    assert.equal(scoped.schemaClass, "REJECTED");
    assert.equal(scoped.storeClass, "R_REJECT");
    assert.equal(scoped.rejected, true);
    assert.equal(scoped.baseKey, "pin");
  });

  it("fails closed to R for an aiModelList base", () => {
    const scoped = classifyKeyDetailed("aiModelList:provider-1");
    assert.equal(scoped.schemaClass, "R_REJECT");
    assert.equal(scoped.storeClass, "R_REJECT");
    assert.equal(scoped.split, false);
    assert.equal(scoped.secret, true);
    assert.equal(scoped.settingsRejectionReason, "secret_only");
  });

  it("stays unknown for an unknown base, an empty base, or an empty key", () => {
    for (const key of ["noSuchKey:scope", ":scope", "", "noSuchKey:"]) {
      assert.equal(classifyKey(key), "UNKNOWN", JSON.stringify(key));
      assert.equal(classifyKeyDetailed(key).known, false, JSON.stringify(key));
    }
  });

  it("treats prototype member names as unknown, not catalogued", () => {
    for (const key of ["__proto__", "toString", "constructor", "hasOwnProperty"]) {
      assert.equal(classifyKey(key), "UNKNOWN", key);
      assert.equal(isKnownKey(key), false, key);
      assert.equal(getKeyInfo(key), null, key);
    }
  });
});

describe("key schema: unknown keys and D-07 write enforcement", () => {
  it("reports unknown keys as UNKNOWN with the unknown_key reason", () => {
    const detailed = classifyKeyDetailed("definitelyNotAKey");
    assert.equal(detailed.known, false);
    assert.equal(detailed.keyClass, "UNKNOWN");
    assert.equal(detailed.storeClass, "UNKNOWN");
    assert.equal(detailed.schemaClass, "UNKNOWN");
    assert.equal(detailed.settingsRejectionReason, "unknown_key");
    assert.equal(isKnownKey("definitelyNotAKey"), false);
    assert.equal(getKeyInfo("definitelyNotAKey"), null);
    assert.equal(settingsRejectionReasonFor("definitelyNotAKey"), "unknown_key");
  });

  it("throws invalid_argument for writes to unknown keys (D-07)", () => {
    const error = assertThrowsCapability(
      () => assertWritable("definitelyNotAKey"),
      "invalid_argument",
      "store.set",
    );
    assert.match(error.message, /definitelyNotAKey/);
    assertThrowsCapability(() => assertWritable(""), "invalid_argument", "store.set");
    assertThrowsCapability(
      () => assertWritable("noSuchKey:scope"),
      "invalid_argument",
      "store.set",
    );
  });

  it("throws unavailable for writes to R_REJECT keys and pin", () => {
    for (const key of ["apiKey", "s3SyncConfig", "mcpServers", "fooToken"]) {
      assertThrowsCapability(
        () => assertWritable(key),
        "unavailable",
        "store.setSecretKey",
      );
    }
    const pinError = assertThrowsCapability(
      () => assertWritable("pin"),
      "unavailable",
      "store.setSecretKey",
    );
    assert.match(pinError.message, /pin/);
    assertThrowsCapability(
      () => assertWritable("aiModelList:provider-1"),
      "unavailable",
      "store.setSecretKey",
    );
  });

  it("allows writes to S, L, split, pattern-L, and inherited keys", () => {
    for (const key of [
      "language",
      "editorShortcuts",
      "openTabs",
      "aiModelList",
      "gitlab_repo_project_id",
      "language:en",
      "openTabs:workspace-1",
    ]) {
      assert.doesNotThrow(() => assertWritable(key), key);
    }
  });

  it("maps settings rejection reasons per class", () => {
    assert.equal(settingsRejectionReasonFor("language"), null);
    assert.equal(settingsRejectionReasonFor("aiModelList"), null);
    assert.equal(settingsRejectionReasonFor("openTabs"), "local_only");
    assert.equal(settingsRejectionReasonFor("apiKey"), "secret_only");
    assert.equal(settingsRejectionReasonFor("pin"), "secret_only");
    assert.equal(settingsRejectionReasonFor("definitelyNotAKey"), "unknown_key");
  });
});

describe("key schema: value validation", () => {
  it("covers every catalogued key with a validator hook", () => {
    assert.equal(Object.keys(KEY_VALUE_VALIDATORS).length, 236);
    assert.deepEqual(
      Object.keys(KEY_VALUE_VALIDATORS).sort(),
      Object.keys(KEY_SCHEMA_TABLE).sort(),
    );
  });

  it("accepts JSON values and rejects non-JSON values for plain keys", () => {
    for (const value of ["en", 1, true, null, [1, "a"], { a: [1, { b: 2 }] }]) {
      assert.equal(validateKeyValue("language", value).valid, true);
    }
    for (const value of [undefined, () => 1, Symbol("x"), BigInt(10), Number.NaN]) {
      assert.equal(validateKeyValue("language", value).valid, false);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(validateKeyValue("language", cyclic).valid, false);
    assert.equal(validateKeyValue("definitelyNotAKey", 1).valid, false);
    assert.equal(validateKeyValue("definitelyNotAKey", 1).issue, "unknown key");
  });

  it("validates colon-scoped variants under the base key hook", () => {
    assert.equal(validateKeyValue("language:en", "x").valid, true);
    assert.equal(validateKeyValue("language:en", undefined).valid, false);
  });

  it("enforces the CT-07/A-02 condition on useImageRepo and mainImageHosting", () => {
    for (const key of ["useImageRepo", "mainImageHosting"]) {
      assert.equal(validateKeyValue(key, true).valid, true, key);
      assert.equal(validateKeyValue(key, "s3").valid, true, key);
      assert.equal(validateKeyValue(key, { apiKey: "x" }).valid, false, key);
      assert.equal(
        validateKeyValue(key, { nested: { token: "x" } }).valid,
        false,
        key,
      );
      assert.equal(validateKeyValue(key, [{ password: "x" }]).valid, false, key);
    }
  });

  it("rejects malformed aiModelList shapes", () => {
    assert.equal(validateKeyValue("aiModelList", "nope").valid, false);
    assert.equal(validateKeyValue("aiModelList", [null]).valid, false);
    assert.equal(validateKeyValue("aiModelList", [{ title: "x" }]).valid, false);
    assert.equal(validateKeyValue("aiModelList", [{ key: "" }]).valid, false);
    assert.equal(
      validateKeyValue("aiModelList", [{ key: "a" }, { key: "a" }]).valid,
      false,
    );
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ key: `p${i}` }));
    assert.equal(validateKeyValue("aiModelList", tooMany).valid, false);
    assert.equal(
      validateKeyValue("aiModelList", [
        { key: "a", models: [{ id: "m", apiKey: "x" }] },
      ]).valid,
      false,
    );
  });

  it("accepts aiModelList entries carrying secret fields (split before send)", () => {
    assert.equal(
      validateKeyValue("aiModelList", [{ key: "a", apiKey: "x" }]).valid,
      true,
    );
    assert.equal(validateKeyValue("aiModelList", []).valid, true);
  });

  it("throws invalid_argument without echoing the value", () => {
    const error = assertThrowsCapability(
      () => assertValidKeyValue("language", () => 1),
      "invalid_argument",
      "store.set",
    );
    assert.match(error.message, /language/);
    const secretValue = "sk-test-please-do-not-echo";
    const aiError = assertThrowsCapability(
      () =>
        assertValidKeyValue("aiModelList", [
          { key: "a", models: [{ id: "m", apiKey: secretValue }] },
        ]),
      "invalid_argument",
      "store.set",
    );
    assert.doesNotMatch(aiError.message, /sk-test-please-do-not-echo/);
  });

  it("checks JSON values with the depth cap", () => {
    assert.equal(isJsonValue("x"), true);
    assert.equal(isJsonValue([1, { a: null }]), true);
    assert.equal(isJsonValue(undefined), false);
    assert.equal(isJsonValue(Number.POSITIVE_INFINITY), false);
    let shallow: unknown = 1;
    for (let i = 0; i < 10; i += 1) {
      shallow = [shallow];
    }
    assert.equal(isJsonValue(shallow), true);
    let deep: unknown = 1;
    for (let i = 0; i < 40; i += 1) {
      deep = [deep];
    }
    assert.equal(isJsonValue(deep), false);
  });
});

describe("key schema: aiModelList split (section 2.7)", () => {
  it("splits metadata fields from credential-bearing fields", () => {
    const split = splitAiModelList([
      {
        apiKey: "provider-key",
        apiKeyUrl: "https://example.invalid/key",
        baseURL: "https://example.invalid",
        customHeaders: { Authorization: "Bearer x" },
        key: "provider-1",
        models: [{ id: "model-1" }],
        temperature: 0.5,
        title: "Provider One",
        webSearchApiKey: "search-key",
        webSearchApiKeys: { sub: "sub-key" },
      },
    ]);
    assert.equal(split.metadata.length, 1);
    assert.deepEqual(split.metadata[0], {
      apiKeyUrl: "https://example.invalid/key",
      baseURL: "https://example.invalid",
      key: "provider-1",
      models: [{ id: "model-1" }],
      temperature: 0.5,
      title: "Provider One",
    });
    assert.equal(split.secrets.length, 1);
    assert.equal(split.secrets[0]?.providerKey, "provider-1");
    assert.deepEqual(split.secrets[0]?.patch, {
      apiKey: "provider-key",
      customHeaders: { Authorization: "Bearer x" },
      webSearchApiKey: "search-key",
      webSearchApiKeys: { sub: "sub-key" },
    });
  });

  it("drops computed fields from metadata and emits no patch without secrets", () => {
    const split = splitAiModelList([
      { hasApiKey: true, key: "a", title: "A", updatedAt: 42 },
      { key: "b", title: "B" },
    ]);
    assert.deepEqual(split.metadata, [
      { key: "a", title: "A" },
      { key: "b", title: "B" },
    ]);
    assert.deepEqual(split.secrets, []);
  });

  it("carries a present null secret field into the patch (delete-from-bundle)", () => {
    const split = splitAiModelList([{ apiKey: null, key: "a" }]);
    assert.deepEqual(split.metadata, [{ key: "a" }]);
    assert.equal(split.secrets.length, 1);
    assert.deepEqual(split.secrets[0]?.patch, { apiKey: null });
  });

  it("throws invalid_argument for malformed input", () => {
    assertThrowsCapability(
      () => splitAiModelList("nope"),
      "invalid_argument",
      "store.set",
    );
    assertThrowsCapability(
      () => splitAiModelList([{ key: "a" }, { key: "a" }]),
      "invalid_argument",
      "store.set",
    );
  });

  it("returns clones: mutating the split never affects the input", () => {
    const input = [
      { apiKey: "k", key: "a", models: [{ id: "m" }], title: "A" },
    ];
    const split = splitAiModelList(input);
    const first = split.metadata[0];
    assert.ok(first !== undefined);
    first.title = "CHANGED";
    const models = first.models as Array<Record<string, unknown>>;
    const model0 = models[0];
    assert.ok(model0 !== undefined);
    model0.id = "CHANGED";
    assert.equal(input[0]?.title, "A");
    const inputModels = input[0]?.models as Array<Record<string, unknown>>;
    assert.equal(inputModels[0]?.id, "m");
  });

  it("detects secret fields on entries and inside models entries", () => {
    assert.equal(providerEntryHasSecretFields({ key: "a" }), false);
    assert.equal(providerEntryHasSecretFields({ apiKey: "x", key: "a" }), true);
    assert.equal(
      providerEntryHasSecretFields({ key: "a", models: [{ apiKey: "x" }] }),
      true,
    );
    assert.equal(
      providerEntryHasSecretFields({ key: "a", models: [{ id: "m" }] }),
      false,
    );
    assert.equal(providerEntryHasSecretFields(null), false);
    assert.equal(providerEntryHasSecretFields("nope"), false);
  });

  it("merges read-enrichment status onto metadata entries", () => {
    const merged = mergeAiModelMetadata(
      [{ key: "a", title: "A" }, { key: "b", title: "B" }],
      [
        { hasApiKey: true, providerKey: "a", updatedAt: 42 },
        { hasApiKey: false, providerKey: "ghost", updatedAt: 1 },
      ],
    );
    assert.deepEqual(merged, [
      { hasApiKey: true, key: "a", title: "A", updatedAt: 42 },
      { hasApiKey: false, key: "b", title: "B", updatedAt: null },
    ]);
  });

  it("lets later status rows win and passes malformed reads through tolerantly", () => {
    const merged = mergeAiModelMetadata(
      [{ key: "a" }, { title: "no key" }, "junk"],
      [
        { hasApiKey: false, providerKey: "a", updatedAt: null },
        { hasApiKey: true, providerKey: "a", updatedAt: 7 },
      ],
    );
    assert.deepEqual(merged, [
      { hasApiKey: true, key: "a", updatedAt: 7 },
      { title: "no key" },
      "junk",
    ]);
    assert.deepEqual(mergeAiModelMetadata("not-an-array", []), "not-an-array");
    assert.deepEqual(mergeAiModelMetadata(null, []), null);
  });

  it("strips secret and computed fields on the read path without throwing", () => {
    const stripped = stripAiModelListSecrets([
      {
        apiKey: "k",
        hasApiKey: true,
        key: "a",
        models: [{ apiKey: "k2", id: "m" }],
        title: "A",
        updatedAt: 9,
      },
      "junk",
    ]);
    assert.deepEqual(stripped, [
      { key: "a", models: [{ id: "m" }], title: "A" },
      "junk",
    ]);
    assert.deepEqual(stripAiModelListSecrets(null), null);
    assert.deepEqual(stripAiModelListSecrets("nope"), "nope");
  });

  it("keeps the metadata and secret field lists disjoint", () => {
    const metadata = new Set(AI_MODEL_LIST_METADATA_FIELDS);
    for (const field of AI_MODEL_LIST_SECRET_FIELDS) {
      assert.ok(!metadata.has(field), field);
    }
  });
});

describe("key schema: lookup helpers", () => {
  it("answers isKnownKey exactly for catalogued keys", () => {
    assert.equal(isKnownKey("language"), true);
    assert.equal(isKnownKey("aiModelList"), true);
    assert.equal(isKnownKey("pin"), true);
    assert.equal(isKnownKey("language:en"), false);
    assert.equal(isKnownKey("gitlab_repo_project_id"), false);
    assert.equal(isKnownKey("definitelyNotAKey"), false);
  });

  it("returns the exact entry from getKeyInfo and null otherwise", () => {
    const info = getKeyInfo("language");
    assert.ok(info !== null);
    assert.equal(info.key, "language");
    assert.equal(getKeyInfo("language:en"), null);
    assert.equal(getKeyInfo(""), null);
  });
});
