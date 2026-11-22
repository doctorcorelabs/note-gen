// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for the DA-2 IMP-02 import copy: one bad file
// must not abort the whole folder import; failures are collected
// per file and reported by name.
//
// Run: `pnpm vitest run --project unit src/app/core/main/file/use-markdown-import.spec.ts`

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("picked files: .MD imports as markdown and skipped files are counted (DA-6 IMP-04/05)", async () => {
    mocks.exists.mockResolvedValue(false);
    const result = await copyPickedMarkdownFiles(
      [picked("Catatan.MD"), picked("lain.Md"), picked("dokumen.pdf"), picked(".hidden.md")],
      "target",
    );
    expect(result.copied).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.skipped).toBe(2);
  });

  it("recursive copy: hidden and unsupported entries count as skipped (DA-6 IMP-05)", async () => {
    mocks.readDir.mockResolvedValue([
      { name: "ok.md", isDirectory: false, isFile: true, isSymlink: false },
      { name: ".secret.md", isDirectory: false, isFile: true, isSymlink: false },
      { name: "arsip.zip", isDirectory: false, isFile: true, isSymlink: false },
    ]);
    mocks.exists.mockResolvedValue(false);
    const result = await copyMarkdownFilesRecursively("src", "target");
    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(2);
  });
});

// DA-4 (IMP-03) static pins: document conversion and Notion
// import must not reach the path-shaped dialog in web mode; the
// file-actions handlers show the explicit marker and the hook
// callbacks guard themselves as defense in depth. Runtime proof
// belongs to the post-deploy browser rerun.
describe("markdown import web gate (IMP-03)", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const HOOK = readFileSync(join(HERE, "use-markdown-import.ts"), "utf8");
  const ACTIONS = readFileSync(join(HERE, "file-actions.tsx"), "utf8");
  const EN = JSON.parse(readFileSync(join(HERE, "..", "..", "..", "..", "..", "messages", "en.json"), "utf8"));
  const ZH = JSON.parse(readFileSync(join(HERE, "..", "..", "..", "..", "..", "messages", "zh.json"), "utf8"));

  it("both hook callbacks return before the dialog in web mode", () => {
    for (const marker of ["const importNotionZip", "const convertDocumentsToMarkdown"]) {
      const start = HOOK.indexOf(marker);
      expect(start).toBeGreaterThanOrEqual(0);
      const fn = HOOK.slice(start, HOOK.indexOf("platform.dialog.open", start));
      expect(fn).toContain("if (!checkIsTauri())");
    }
  });

  it("the file-actions handlers gate with the explicit marker", () => {
    expect(ACTIONS).toContain("onConvertDocuments={handleConvertDocuments}");
    expect(ACTIONS).toContain("onImportNotion={handleImportNotion}");
    expect(ACTIONS).toContain("t('importUnavailableWeb')");
  });

  it("the marker copy exists in both catalogs", () => {
    expect(EN.article.file.toolbar.importUnavailableWeb).toBeTruthy();
    expect(EN.article.file.toolbar.importUnavailableWebDesc).toBeTruthy();
    expect(ZH.article.file.toolbar.importUnavailableWeb).toBeTruthy();
    expect(ZH.article.file.toolbar.importUnavailableWebDesc).toBeTruthy();
  });
});
