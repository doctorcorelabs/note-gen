// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for DA-4 (WIKI-18-03A): in web mode the wiki
// read path must not depend on the writing cache refresh, whose
// write kinds are Phase 2 stubs; reads answer from the W1 cache
// directly. The ambient test runtime has no Tauri shell, so
// isEditorFeatureDisabled("wiki") is true here (same premise as
// editor-disabled.spec.ts). All db and file access is mocked.
//
// Run: `pnpm vitest run --project unit src/lib/wiki/search.spec.ts`

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshWikiFileCache: vi.fn(),
  getActiveWikiRevisions: vi.fn(),
  getWikiPage: vi.fn(),
  listWikiPages: vi.fn(),
  getWikiSettings: vi.fn(),
  getKnowledgeSettings: vi.fn(),
}));

vi.mock("@/lib/bm25", () => ({
  BM25Index: class {
    index() { return undefined; }
    search() { return []; }
  },
}));

vi.mock("@/db/wiki", () => ({
  getActiveWikiRevisions: mocks.getActiveWikiRevisions,
  getWikiPage: mocks.getWikiPage,
  listWikiPages: mocks.listWikiPages,
}));

vi.mock("@/lib/knowledge-settings", () => ({
  getKnowledgeSettings: mocks.getKnowledgeSettings,
}));

vi.mock("./context", () => ({
  assertWikiContextCurrent: vi.fn(async () => undefined),
  captureWikiWorkspaceGuard: vi.fn(() => () => true),
  getWikiContext: vi.fn(async () => ({ id: "ctx-1" })),
}));

vi.mock("./settings", () => ({
  getWikiSettings: mocks.getWikiSettings,
  isWikiSourceSelected: vi.fn(() => true),
  normalizeWikiScopeId: vi.fn((path: string) => path),
}));

vi.mock("./sources", () => ({
  resolveWikiSourceReference: vi.fn(async () => null),
  isWikiSourceDocumentAllowed: vi.fn(async () => true),
  wikiHash: vi.fn(() => "hash"),
}));

vi.mock("./compiler", () => ({
  wikiSourceWithEvidence: vi.fn(),
}));

vi.mock("./files", () => ({
  refreshWikiFileCache: mocks.refreshWikiFileCache,
}));

import { readWikiPage, searchWiki } from "./search";

describe("wiki read path without writing refresh (WIKI-18-03A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshWikiFileCache.mockRejectedValue(
      Object.assign(new Error("capability_unavailable"), { code: "UNAVAILABLE" }));
    mocks.getActiveWikiRevisions.mockResolvedValue([]);
    mocks.getWikiPage.mockResolvedValue(null);
    mocks.listWikiPages.mockResolvedValue([]);
    mocks.getKnowledgeSettings.mockResolvedValue({ enabledSourceTypes: [] });
    mocks.getWikiSettings.mockResolvedValue({ enabled: true, language: "en", scopes: [] });
  });

  it("searchWiki resolves from the W1 cache without calling the refresh", async () => {
    await expect(searchWiki("query")).resolves.toEqual([]);
    expect(mocks.refreshWikiFileCache).not.toHaveBeenCalled();
  });

  it("readWikiPage resolves without calling the refresh", async () => {
    await expect(readWikiPage("page-1")).resolves.toBeNull();
    expect(mocks.refreshWikiFileCache).not.toHaveBeenCalled();
  });

  it("a disabled wiki still returns empty without calling the refresh", async () => {
    mocks.getWikiSettings.mockResolvedValue({ enabled: false, language: "en", scopes: [] });
    await expect(searchWiki("query")).resolves.toEqual([]);
    expect(mocks.refreshWikiFileCache).not.toHaveBeenCalled();
  });
});
