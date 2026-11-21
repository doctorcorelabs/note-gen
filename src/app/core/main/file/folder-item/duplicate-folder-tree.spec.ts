// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for duplicateFolderTree (F-03): binaries must go
// through copyFile (never a text round-trip), failures are
// counted instead of hidden behind a success toast, and nested
// folders use per-entry path options.
//
// Run: `pnpm vitest run --project unit src/app/core/main/file/folder-item/duplicate-folder-tree.spec.ts`

import { describe, expect, it, vi } from "vitest";

import {
  duplicateFolderTree,
  type DuplicateFolderTreeDeps,
} from "./duplicate-folder-tree";

function makeDeps(overrides: Partial<DuplicateFolderTreeDeps> = {}) {
  const calls = {
    readDir: [] as string[],
    mkdir: [] as string[],
    copyFile: [] as Array<{ from: string; to: string }>,
  };
  const tree: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
    "src": [
      { name: "note.md", isDirectory: false },
      { name: "image.png", isDirectory: false },
      { name: "sub", isDirectory: true },
    ],
    "src/sub": [{ name: "deep.pdf", isDirectory: false }],
  };
  const deps: DuplicateFolderTreeDeps = {
    readDir: async (path) => {
      calls.readDir.push(path);
      const entries = tree[path.replace(/^root\//, "")];
      if (!entries) throw new Error(`no dir ${path}`);
      return entries;
    },
    mkdir: async (path) => {
      calls.mkdir.push(path);
    },
    copyFile: async (from, to) => {
      calls.copyFile.push({ from, to });
    },
    getFilePathOptions: async (relativePath) => ({ path: `root/${relativePath}` }),
    ...overrides,
  };
  return { deps, calls };
}

describe("duplicateFolderTree (F-03)", () => {
  it("copies binaries through copyFile with per-entry options", async () => {
    const { deps, calls } = makeDeps();
    const result = await duplicateFolderTree(deps, "src", "dst");
    expect(result).toEqual({ copied: 3, failed: [] });
    expect(calls.copyFile).toContainEqual({ from: "root/src/image.png", to: "root/dst/image.png" });
    expect(calls.copyFile).toContainEqual({ from: "root/src/sub/deep.pdf", to: "root/dst/sub/deep.pdf" });
    expect(calls.mkdir).toContain("root/dst/sub");
  });

  it("counts a failed file and keeps copying the rest", async () => {
    const copyFile = vi.fn(async (from: string) => {
      if (from.endsWith("image.png")) throw new Error("read failed");
    });
    const { deps } = makeDeps({ copyFile });
    const result = await duplicateFolderTree(deps, "src", "dst");
    expect(result.copied).toBe(2);
    expect(result.failed).toEqual(["src/image.png"]);
  });

  it("reports full success only when nothing failed", async () => {
    const { deps } = makeDeps();
    const result = await duplicateFolderTree(deps, "src", "dst");
    expect(result.failed).toEqual([]);
    expect(result.copied).toBe(3);
  });
});
