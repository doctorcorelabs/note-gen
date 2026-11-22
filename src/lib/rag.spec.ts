// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Behavior spec for the DA-2 K-04 fix in rag.ts: the canvas
// knowledge collector (legacy getDb throw in web) is isolated so
// its failure no longer kills the whole BM25 build for articles
// and records. Added in PB2 (R6: spec was missing).
//
// Run: `pnpm vitest run --project unit src/lib/rag.spec.ts`

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initBM25Index: vi.fn(),
  collectCanvas: vi.fn(),
  collectRecord: vi.fn(),
  storeGet: vi.fn(),
  readDir: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({
  platform: {
    store: {
      load: async () => ({ get: mocks.storeGet }),
    },
    fs: {
      readDir: mocks.readDir,
      readTextFile: vi.fn(async () => ""),
    },
    path: {
      join: async (...parts: string[]) => parts.join("/"),
    },
  },
  BaseDirectory: {},
}));

vi.mock("./ai", () => ({
  fetchEmbedding: vi.fn(),
  fetchEmbeddings: vi.fn(),
  rerankDocuments: vi.fn(),
}));

vi.mock("@/db/vector", () => ({
  deleteVectorDocumentsByFilename: vi.fn(),
  getSimilarDocuments: vi.fn(),
  getVectorDocumentsByFilename: vi.fn(),
  replaceVectorDocumentsByFilename: vi.fn(),
  initVectorDb: vi.fn(),
  normalizeVectorDocumentKey: (key: string) => key,
}));

vi.mock("@/db/knowledge", () => ({
  deleteKnowledgeSource: vi.fn(),
  upsertKnowledgeSource: vi.fn(),
  updateKnowledgeSourceIndexState: vi.fn(),
}));

vi.mock("@/types/knowledge", () => ({
  createKnowledgeSourceKey: (type: string, id: string) => `${type}:${id}`,
  parseKnowledgeSourceKey: () => null,
}));

vi.mock("./bm25", () => ({
  initBM25Index: mocks.initBM25Index,
  getBM25Index: () => null,
  createBM25ChunkKey: (filename: string, chunkId: number) => `${filename}#${chunkId}`,
  parseBM25ChunkKey: () => null,
}));

vi.mock("./workspace", () => ({
  getFilePathOptions: async (filePath: string) => ({ path: filePath }),
  getWorkspacePath: async () => ({ isCustom: false, path: "" }),
}));

vi.mock("@/stores/article", () => ({}));

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
}));

vi.mock("./lexical-tokenizer", () => ({
  getIdentifierTerms: () => [],
  getLexicalTerms: () => [],
  replaceLexicalTerm: (term: string) => term,
}));

vi.mock("./skills/utils", () => ({
  isSkillsFolder: () => false,
}));

vi.mock("./vector-document-key", () => ({
  getVectorDocumentKey: (key: string) => key,
}));

vi.mock("./rag-retrieval-policy", () => ({
  createRetrievalStrategy: vi.fn(),
  DEFAULT_EXCLUDED_RAG_PATHS: [],
  getRagDisplayFilename: (path: string) => path,
  isPathAllowedForRag: () => true,
  normalizeRagPath: (path: string) => path,
}));

vi.mock("@/lib/knowledge-content", () => ({
  collectCanvasKnowledgeDocuments: mocks.collectCanvas,
  collectRecordKnowledgeDocuments: mocks.collectRecord,
}));

vi.mock("next-intl", () => ({
  createTranslator: () => (key: string) => key,
}));

vi.mock("@/i18n/config", () => ({
  LANGUAGE_STORAGE_KEY: "language",
  loadMessagesWithFallback: async () => ({}),
  normalizeLocale: () => "en",
}));

import { initBM25Search } from "./rag";

describe("rag BM25 init (K-04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeGet.mockResolvedValue(undefined);
    mocks.readDir.mockResolvedValue([]);
    mocks.collectRecord.mockResolvedValue([
      { sourceKey: "record:1", chunks: [{ content: "hello" }] },
    ]);
    mocks.collectCanvas.mockResolvedValue([]);
  });

  it("K-04: builds the index from records even when the canvas collector rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.collectCanvas.mockRejectedValue(new Error("legacy getDb throw"));

    const ok = await initBM25Search();

    expect(ok).toBe(true);
    expect(mocks.initBM25Index).toHaveBeenCalledTimes(1);
    const documents = mocks.initBM25Index.mock.calls[0][0] as Array<{ content: string }>;
    expect(documents).toHaveLength(1);
    expect(documents[0].content).toBe("hello");
    errorSpy.mockRestore();
  });

  it("returns false and does not build when the record collector rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.collectRecord.mockRejectedValue(new Error("records down"));

    const ok = await initBM25Search();

    expect(ok).toBe(false);
    expect(mocks.initBM25Index).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
