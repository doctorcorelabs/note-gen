// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for src/lib/editor-disabled.ts (Fase 1, V3-24).
// Runner: Vitest, unit project. No DOM, no network, no storage.
// The Tauri marker on globalThis is toggled per case and always
// restored, because getPlatformMode reads it on every call.

import { afterEach, describe, expect, it } from "vitest";

import {
  AI_EDITOR_SHORTCUT_IDS,
  ALL_EDITOR_DISABLED_FEATURES,
  EDITOR_DISABLED_FEATURES,
  editorDisabledMessageKeys,
  isAiEditorShortcutId,
  isEditorFeatureDisabled,
  isEditorFeatureDisabledInMode,
} from "./editor-disabled";

const TAURI_MARKER = "__TAURI_INTERNALS__";

function setTauriMarker(present: boolean): void {
  const g = globalThis as Record<string, unknown>;
  if (present) {
    g[TAURI_MARKER] = {};
  } else {
    delete g[TAURI_MARKER];
  }
}

afterEach(() => {
  setTauriMarker(false);
});

describe("isEditorFeatureDisabledInMode", () => {
  it("disables every listed feature in web mode", () => {
    for (const feature of ALL_EDITOR_DISABLED_FEATURES) {
      expect(isEditorFeatureDisabledInMode(feature, "web")).toBe(true);
    }
  });

  it("disables nothing in Tauri mode", () => {
    for (const feature of ALL_EDITOR_DISABLED_FEATURES) {
      expect(isEditorFeatureDisabledInMode(feature, "tauri")).toBe(false);
    }
  });
});

describe("isEditorFeatureDisabled", () => {
  it("follows the runtime marker: disabled without it, enabled with it", () => {
    setTauriMarker(false);
    expect(isEditorFeatureDisabled("canvas")).toBe(true);
    setTauriMarker(true);
    expect(isEditorFeatureDisabled("canvas")).toBe(false);
  });
});

describe("editorDisabledMessageKeys", () => {
  it("maps every surfaced feature to title and message keys under its segment", () => {
    for (const feature of ALL_EDITOR_DISABLED_FEATURES) {
      const segment = EDITOR_DISABLED_FEATURES[feature].catalogSegment;
      if (segment === null) continue;
      const keys = editorDisabledMessageKeys(
        feature as Exclude<typeof feature, "staticAssetSync">,
      );
      expect(keys.titleKey).toBe(`${segment}.title`);
      expect(keys.messageKey).toBe(`${segment}.message`);
    }
  });

  it("covers exactly the twelve surfaced features plus the flag-only one", () => {
    expect(ALL_EDITOR_DISABLED_FEATURES).toHaveLength(13);
    const surfaced = ALL_EDITOR_DISABLED_FEATURES.filter(
      (feature) => EDITOR_DISABLED_FEATURES[feature].catalogSegment !== null,
    );
    expect(surfaced).toHaveLength(12);
    expect(EDITOR_DISABLED_FEATURES.staticAssetSync.catalogSegment).toBeNull();
  });
});

describe("AI editor shortcuts", () => {
  it("lists exactly the 9 ai-group shortcut ids from the audit", () => {
    expect([...AI_EDITOR_SHORTCUT_IDS]).toEqual([
      "openAiMenu",
      "aiContinue",
      "aiPolish",
      "aiConcise",
      "aiExpand",
      "aiTranslate",
      "acceptAiSuggestion",
      "rejectAiSuggestion",
      "abortAiGeneration",
    ]);
  });

  it("recognizes only ai-group ids", () => {
    expect(isAiEditorShortcutId("aiPolish")).toBe(true);
    expect(isAiEditorShortcutId("toggleBold")).toBe(false);
    expect(isAiEditorShortcutId("")).toBe(false);
  });
});
