// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for the DA-2 vector honesty fixes in
// knowledge-index.ts: K-02 (failed state on register failure),
// K-05 (queue survives a bad source, no unhandled rejection),
// K-08 (source row deleted even when vector cleanup fails),
// K-10 (purge continues past a failing source).
//
// Run: `pnpm vitest run --project unit src/lib/knowledge-index.spec.ts`

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getKnowledgeSource: vi.fn(),
  getKnowledgeSources: vi.fn(),
  upsertKnowledgeSource: vi.fn(),
  updateKnowledgeSourceIndexState: vi.fn(),
  deleteKnowledgeSource: vi.fn(),
  deleteVectorDocumentsByFilename: vi.fn(),
  getVectorDocumentsByFilename: vi.fn(),
  replaceVectorDocumentsByFilename: vi.fn(),
  fetchEmbeddings: vi.fn(),
  getKnowledgeSourceDocument: vi.fn(),
  collectRecordKnowledgeDocuments: vi.fn(),
  collectCanvasKnowledgeDocuments: vi.fn(),
  getKnowledgeSettings: vi.fn(),
  isKnowledgeSourceEnabled: vi.fn(),
  storeGet: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({
  platform: {
    store: {
      load: async () => ({ get: mocks.storeGet }),
    },
  },
}));

vi.mock("@/db/knowledge", () => ({
  getKnowledgeSource: mocks.getKnowledgeSource,
  getKnowledgeSources: mocks.getKnowledgeSources,
  upsertKnowledgeSource: mocks.upsertKnowledgeSource,
  updateKnowledgeSourceIndexState: mocks.updateKnowledgeSourceIndexState,
  deleteKnowledgeSource: mocks.deleteKnowledgeSource,
}));

vi.mock("@/db/vector", () => ({
  deleteVectorDocumentsByFilename: mocks.deleteVectorDocumentsByFilename,
  getVectorDocumentsByFilename: mocks.getVectorDocumentsByFilename,
  replaceVectorDocumentsByFilename: mocks.replaceVectorDocumentsByFilename,
}));

vi.mock("@/lib/ai", () => ({
  fetchEmbeddings: mocks.fetchEmbeddings,
}));

vi.mock("@/lib/bm25", () => ({
  getBM25Index: () => null,
}));

vi.mock("@/lib/knowledge-content", () => ({
  collectCanvasKnowledgeDocuments: mocks.collectCanvasKnowledgeDocuments,
  collectRecordKnowledgeDocuments: mocks.collectRecordKnowledgeDocuments,
  getKnowledgeSourceDocument: mocks.getKnowledgeSourceDocument,
}));

vi.mock("@/lib/knowledge-settings", () => ({
  getKnowledgeSettings: mocks.getKnowledgeSettings,
  isKnowledgeSourceEnabled: mocks.isKnowledgeSourceEnabled,
}));

vi.mock("@/lib/wiki/queue", () => ({
  enqueueWikiSource: vi.fn(),
  removeWikiSource: vi.fn(async () => {}),
}));

import {
  enqueueKnowledgeSourceIndex,
  indexKnowledgeDocument,
  purgeDisabledKnowledgeVectors,
  removeKnowledgeSourceIndex,
} from "./knowledge-index";
import type { KnowledgeSourceDocument } from "@/types/knowledge";

function makeDocument(): KnowledgeSourceDocument {
  return {
    sourceKey: "record:1",
    sourceType: "record",
    sourceId: "1",
    title: "Record 1",
    contentHash: "hash-1",
    indexedHash: null,
    updatedAt: 1,
    locator: {},
    status: "pending",
    error: null,
    content: "hello",
    chunks: [{ content: "hello" }],
  };
}

describe("knowledge-index DA-2 honesty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeGet.mockResolvedValue(true);
    mocks.getKnowledgeSettings.mockResolvedValue({
      semanticSearchEnabled: true,
      indexPaused: false,
    });
    mocks.isKnowledgeSourceEnabled.mockReturnValue(true);
    mocks.getKnowledgeSource.mockResolvedValue(null);
    mocks.upsertKnowledgeSource.mockResolvedValue(undefined);
    mocks.updateKnowledgeSourceIndexState.mockResolvedValue(undefined);
    mocks.deleteKnowledgeSource.mockResolvedValue(undefined);
    mocks.deleteVectorDocumentsByFilename.mockResolvedValue(undefined);
  });

  it("K-02: marks the source failed when registration rejects", async () => {
    mocks.getKnowledgeSource.mockRejectedValue(new Error("db down"));
    const ok = await indexKnowledgeDocument(makeDocument());
    expect(ok).toBe(false);
    expect(mocks.updateKnowledgeSourceIndexState).toHaveBeenCalledWith(
      "record:1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("K-08: deletes the source row even when vector cleanup rejects", async () => {
    mocks.deleteVectorDocumentsByFilename.mockRejectedValue(new Error("legacy facade"));
    await expect(removeKnowledgeSourceIndex("record:1")).resolves.toBeUndefined();
    expect(mocks.deleteKnowledgeSource).toHaveBeenCalledWith("record:1");
  });

  it("K-10: purge processes every disabled source and counts failures", async () => {
    mocks.getKnowledgeSources.mockResolvedValue([
      { sourceKey: "record:1" },
      { sourceKey: "record:2" },
      { sourceKey: "record:3" },
    ]);
    mocks.isKnowledgeSourceEnabled.mockReturnValue(false);
    mocks.deleteVectorDocumentsByFilename
      .mockRejectedValueOnce(new Error("legacy facade"))
      .mockResolvedValue(undefined);
    const result = await purgeDisabledKnowledgeVectors();
    expect(result).toEqual({ purged: 2, failed: 1 });
    expect(mocks.updateKnowledgeSourceIndexState).toHaveBeenCalledTimes(3);
  });

  it("K-05: enqueue never produces an unhandled rejection when the queue fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getKnowledgeSettings.mockRejectedValue(new Error("settings down"));
    enqueueKnowledgeSourceIndex("record:9");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
