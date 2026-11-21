// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-14): getKnowledgeSettings degrades to defaults on
// a failed store load instead of rejecting into every caller.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storeGet: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({
  platform: {
    store: {
      load: async () => ({ get: mocks.storeGet }),
    },
  },
}));

import { DEFAULT_KNOWLEDGE_SETTINGS, getKnowledgeSettings } from "./knowledge-settings";

describe("SET-14 getKnowledgeSettings", () => {
  beforeEach(() => {
    mocks.storeGet.mockReset();
  });

  it("returns the defaults when the store rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.storeGet.mockRejectedValue(new Error("store down"));
    await expect(getKnowledgeSettings()).resolves.toEqual(DEFAULT_KNOWLEDGE_SETTINGS);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("mixes stored values with defaults for missing keys", async () => {
    mocks.storeGet.mockImplementation(async (key: string) => {
      if (key === "ragEnabledSourceTypes") return ["record"];
      if (key === "ragKnowledgeIndexPaused") return true;
      return undefined;
    });
    await expect(getKnowledgeSettings()).resolves.toEqual({
      enabledSourceTypes: ["record"],
      globalSemanticSearchEnabled: DEFAULT_KNOWLEDGE_SETTINGS.globalSemanticSearchEnabled,
      semanticSearchEnabled: DEFAULT_KNOWLEDGE_SETTINGS.semanticSearchEnabled,
      indexPaused: true,
    });
  });
});
