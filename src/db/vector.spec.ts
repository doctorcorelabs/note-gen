// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for the vector rename path (src/db/vector.ts, K-01):
// rename/move in the file tree calls these functions after the disk
// rename succeeds. They used to run raw SQL through the legacy `db`
// facade, which always rejects in this fork, so every rename/move
// errored (and batch move rolled back, then the rollback threw too).
// The Fase 1 fix re-keys only the in-memory indexes; persistent
// chunk rename is Fase 2 work (vector.replaceChunks is a stub, so
// no chunks can exist yet).
//
// Run: `pnpm vitest run --project unit src/db/vector.spec.ts`

import { beforeEach, describe, expect, it, vi } from "vitest";

const bm25 = vi.hoisted(() => ({
  renameFilename: vi.fn(),
  renameFilenamePrefix: vi.fn(),
  deleteByFilename: vi.fn(),
  deleteByFilenamePrefix: vi.fn(),
  getStats: vi.fn(() => ({ documentCount: 0, chunkCount: 0 })),
}));

vi.mock("@/lib/bm25", () => ({
  getBM25Index: () => bm25,
}));

import {
  renameVectorDocumentsByFilename,
  renameVectorDocumentsByPrefix,
} from "./vector";

describe("vector rename (K-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renameVectorDocumentsByFilename resolves and re-keys BM25", async () => {
    await expect(
      renameVectorDocumentsByFilename("a.md", "b.md"),
    ).resolves.toBeUndefined();
    expect(bm25.renameFilename).toHaveBeenCalledWith(
      "article:a.md",
      "article:b.md",
    );
  });

  it("renameVectorDocumentsByFilename is a no-op for the same name", async () => {
    await renameVectorDocumentsByFilename("a.md", "a.md");
    expect(bm25.renameFilename).not.toHaveBeenCalled();
  });

  it("renameVectorDocumentsByPrefix resolves and re-keys BM25", async () => {
    await expect(
      renameVectorDocumentsByPrefix("dir", "dir2"),
    ).resolves.toBeUndefined();
    expect(bm25.renameFilenamePrefix).toHaveBeenCalledWith(
      "article:dir",
      "article:dir2",
    );
  });

  it("renameVectorDocumentsByPrefix is a no-op for the same prefix", async () => {
    await renameVectorDocumentsByPrefix("dir", "dir");
    expect(bm25.renameFilenamePrefix).not.toHaveBeenCalled();
  });
});
