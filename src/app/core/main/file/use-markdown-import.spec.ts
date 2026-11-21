// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for the DA-2 IMP-02 import copy: one bad file
// must not abort the whole folder import; failures are collected
// per file and reported by name.
//
// Run: `pnpm vitest run --project unit src/app/core/main/file/use-markdown-import.spec.ts`

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readDir: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  copyFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({
  platform: {
    fs: {
      readDir: mocks.readDir,
      exists: mocks.exists,
      mkdir: mocks.mkdir,
      copyFile: mocks.copyFile,
      writeFile: mocks.writeFile,
    },
    path: {
      join: async (...parts: string[]) => parts.join("/"),
    },
  },
}));

vi.mock("@/stores/article", () => ({
  default: () => ({ loadFileTree: vi.fn() }),
}));

import {
  copyMarkdownFilesRecursively,
  copyPickedMarkdownFiles,
} from "./use-markdown-import";
import type { DialogPickedFile } from "@/lib/platform";

function picked(name: string): DialogPickedFile {
  return {
    name,
    relativePath: name,
    size: 3,
    type: "text/markdown",
    file: {
      arrayBuffer: async () => new ArrayBuffer(3),
    } as File,
  };
}

describe("markdown import copy (IMP-02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exists.mockResolvedValue(false);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
  });

  it("picked files: a bad file in the middle does not abort the import", async () => {
    mocks.writeFile.mockImplementation(async (path: string) => {
      if (path.includes("bad.md")) {
        throw new Error("invalid_text_encoding");
      }
    });
    const result = await copyPickedMarkdownFiles(
      [picked("good-1.md"), picked("bad.md"), picked("good-2.md")],
      "target",
    );
    expect(result.copied).toBe(2);
    expect(result.failures).toEqual(["bad.md"]);
  });

  it("picked files: all files failing reports copied 0 with every name", async () => {
    mocks.writeFile.mockRejectedValue(new Error("too large"));
    const result = await copyPickedMarkdownFiles(
      [picked("a.md"), picked("b.md")],
      "target",
    );
    expect(result.copied).toBe(0);
    expect(result.failures).toEqual(["a.md", "b.md"]);
  });

  it("recursive copy: a failing file in a subdir keeps siblings copying", async () => {
    mocks.readDir.mockImplementation(async (dir: string) => {
      if (dir === "src") {
        return [
          { name: "top.md", isDirectory: false, isFile: true, isSymlink: false },
          { name: "sub", isDirectory: true, isFile: false, isSymlink: false },
        ];
      }
      if (dir === "src/sub") {
        return [
          { name: "bad.md", isDirectory: false, isFile: true, isSymlink: false },
          { name: "ok.md", isDirectory: false, isFile: true, isSymlink: false },
        ];
      }
      throw new Error(`unexpected dir ${dir}`);
    });
    mocks.copyFile.mockImplementation(async (from: string) => {
      if (from.includes("bad.md")) throw new Error("read failed");
    });
    const result = await copyMarkdownFilesRecursively("src", "target");
    expect(result.copied).toBe(2);
    expect(result.failures).toEqual(["bad.md"]);
  });
});
