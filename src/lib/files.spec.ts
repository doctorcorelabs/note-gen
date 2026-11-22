// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for collectMarkdownFilesWithReport (F-08): unreadable
// subdirectories are reported instead of silently skipped, and
// .markdown files are collected. Platform and workspace lookups are
// mocked; no test touches a real file system.
//
// Run: `pnpm vitest run --project unit src/lib/files.spec.ts`
// from the repo root.

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readDir: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({
  platform: { fs: { readDir: mocks.readDir } },
  BaseDirectory: { AppData: 0 },
}));

vi.mock("./workspace", () => ({
  getWorkspacePath: vi.fn(async () => ({ isCustom: true, path: "/ws" })),
  getFilePathOptions: vi.fn(async (path: string) => ({ path, baseDir: undefined })),
}));

import { collectMarkdownFiles, collectMarkdownFilesWithReport } from "./files";

type Entry = { name: string; isDirectory: boolean };

function setupTree(tree: Record<string, Entry[]>, failing: string[] = []) {
  mocks.readDir.mockImplementation(async (path: string) => {
    if (failing.includes(path)) throw new Error(`cannot read ${path}`);
    const entries = tree[path];
    if (!entries) throw new Error(`unknown dir ${path}`);
    return entries;
  });
}

describe("collectMarkdownFilesWithReport (F-08)", () => {
  it("reports unreadable subdirectories and still collects the rest", async () => {
    setupTree(
      {
        root: [
          { name: "a.md", isDirectory: false },
          { name: "ok", isDirectory: true },
          { name: "bad", isDirectory: true },
        ],
        "root/ok": [{ name: "b.md", isDirectory: false }],
      },
      ["root/bad"],
    );

    const report = await collectMarkdownFilesWithReport("root");

    expect(report.files.map((file) => file.path).sort()).toEqual([
      "root/a.md",
      "root/ok/b.md",
    ]);
    expect(report.failedDirs).toEqual(["root/bad"]);
  });

  it("collects .markdown files and skips dot entries and other extensions", async () => {
    setupTree({
      root: [
        { name: "note.markdown", isDirectory: false },
        { name: "note.txt", isDirectory: false },
        { name: ".hidden", isDirectory: true },
      ],
    });

    const report = await collectMarkdownFilesWithReport("root");

    expect(report.files.map((file) => file.path)).toEqual(["root/note.markdown"]);
    expect(report.failedDirs).toEqual([]);
    expect(mocks.readDir).not.toHaveBeenCalledWith("root/.hidden");
  });

  it("wrapper keeps the old files-only contract", async () => {
    setupTree({
      root: [{ name: "a.md", isDirectory: false }],
    });

    await expect(collectMarkdownFiles("root")).resolves.toEqual([
      { path: "root/a.md", name: "a.md" },
    ]);
  });
});
