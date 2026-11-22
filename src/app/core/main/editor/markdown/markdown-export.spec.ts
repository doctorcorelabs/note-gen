// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Behavior specs for the web PDF export branch (UTANG-UJI-07
// putaran 2): both requestAnimationFrame waits used to sit
// outside the 75 s deadline, so a frame that never fires (hidden
// page, suppressed rendering in automation) hung the export
// forever after the "Preparing PDF" toast. The waits are now
// raced against a short timer and the deadline covers the whole
// branch until just before print().
//
// Run: `pnpm vitest run --project unit src/app/core/main/editor/markdown/markdown-export.spec.ts`
// from the repo root.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/check", () => ({
  checkIsTauri: () => false,
}));

const renderMocks = vi.hoisted(() => ({
  renderMarkdownExportFragment: vi.fn(async () => ({ html: "<p>halo</p>", highlightFallback: false })),
}));

vi.mock("@/lib/markdown/export-document", () => ({
  renderMarkdownExportFragment: renderMocks.renderMarkdownExportFragment,
}));

const exportFileMocks = vi.hoisted(() => ({
  readTextFile: vi.fn(),
}));

vi.mock("@/lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace")>();
  return {
    ...actual,
    getFilePathOptions: async (filePath: string) => ({ path: filePath }),
  };
});

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return {
    ...actual,
    platform: {
      fs: {
        readTextFile: exportFileMocks.readTextFile,
        writeTextFile: async () => {},
      },
      dialog: { save: async () => null },
      event: { once: async () => () => {} },
      os: { platform: async () => "web" },
      store: { load: async () => ({ get: async () => null }) },
      window: { createWebviewWindow: async () => ({}) },
    },
  };
});

import {
  exportMarkdownFile,
  exportMarkdownSource,
  isDangerousExportUrl,
  parseMarkdownToJson,
} from "./markdown-export";

type RafCallback = () => void;

let rafMode: "never" | "once" | "always" = "always";
let rafCalls = 0;
let printMock: ReturnType<typeof vi.fn>;

function makeTemplate() {
  return {
    innerHTML: "",
    content: {
      querySelectorAll: () => [],
    },
  };
}

function makeIframe() {
  const frameDocument = {
    open: vi.fn(),
    write: vi.fn(),
    close: vi.fn(),
    images: [],
    fonts: { ready: Promise.resolve() },
  };
  printMock = vi.fn();
  return {
    setAttribute: vi.fn(),
    tabIndex: 0,
    style: {} as Record<string, string>,
    contentDocument: frameDocument,
    contentWindow: {
      print: printMock,
      focus: vi.fn(),
      addEventListener: vi.fn(),
    },
    remove: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  rafMode = "always";
  rafCalls = 0;

  const windowStub = {
    requestAnimationFrame: (callback: RafCallback) => {
      rafCalls += 1;
      if (rafMode === "always" || (rafMode === "once" && rafCalls === 1)) {
        callback();
      }
      return rafCalls;
    },
    setTimeout: (fn: (...args: unknown[]) => void, ms?: number) =>
      setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("document", {
    createElement: (tag: string) =>
      tag === "iframe" ? makeIframe() : makeTemplate(),
    body: { appendChild: vi.fn() },
    styleSheets: [],
    baseURI: "http://localhost/",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const source = { baseName: "catatan", markdown: "# Halo" };

describe("web PDF export (UTANG-UJI-07 putaran 2)", () => {
  it("completes and prints when requestAnimationFrame never fires", async () => {
    rafMode = "never";
    const onPdfRenderStart = vi.fn();

    const promise = exportMarkdownSource("pdf", source, { onPdfRenderStart });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe(true);
    expect(onPdfRenderStart).toHaveBeenCalledTimes(1);
    expect(printMock).toHaveBeenCalledTimes(1);
  });

  it("completes and prints when requestAnimationFrame fires only once", async () => {
    rafMode = "once";

    const promise = exportMarkdownSource("pdf", source);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe(true);
    expect(printMock).toHaveBeenCalledTimes(1);
  });

  it("control: completes and prints with a healthy animation frame", async () => {
    rafMode = "always";

    const promise = exportMarkdownSource("pdf", source);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe(true);
    expect(printMock).toHaveBeenCalledTimes(1);
  });
});

describe("file-tree export flush guard (EXP-04)", () => {
  it("aborts before reading disk when the pending-save flush fails", async () => {
    exportFileMocks.readTextFile.mockResolvedValue("# Halo");
    const flushPendingSave = vi.fn(async () => false);
    await expect(
      exportMarkdownFile("markdown", "note.md", { flushPendingSave }),
    ).rejects.toThrow("UNSAVED_CHANGES");
    expect(flushPendingSave).toHaveBeenCalledTimes(1);
    expect(exportFileMocks.readTextFile).not.toHaveBeenCalled();
  });

  it("flushes before reading disk when the flush succeeds", async () => {
    exportFileMocks.readTextFile.mockResolvedValue("# Halo");
    const order: string[] = [];
    const flushPendingSave = vi.fn(async () => {
      order.push("flush");
      return true;
    });
    exportFileMocks.readTextFile.mockImplementation(async () => {
      order.push("read");
      return "# Halo";
    });
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", {
      createElement: () => link,
      body: { appendChild: vi.fn() },
      styleSheets: [],
      baseURI: "http://localhost/",
    });
    await expect(
      exportMarkdownFile("markdown", "note.md", { flushPendingSave }),
    ).resolves.toBe(true);
    expect(order).toEqual(["flush", "read"]);
    expect(link.click).toHaveBeenCalledTimes(1);
  });
});

describe("HTML export deadline (DA-6 EXP-01/04)", () => {
  it("rejects with a timeout when the render never settles", async () => {
    renderMocks.renderMarkdownExportFragment.mockImplementationOnce(
      () => new Promise<never>(() => {}),
    );
    const promise = exportMarkdownSource("html", source);
    const assertion = expect(promise).rejects.toThrow("HTML export timed out");
    await vi.advanceTimersByTimeAsync(75000);
    await assertion;
  });
});

describe("sanitize scheme guard (DA-6 EXP-06)", () => {
  it("flags javascript: and data:text/html URLs, including obfuscated ones", () => {
    expect(isDangerousExportUrl("javascript:alert(1)")).toBe(true);
    expect(isDangerousExportUrl("JaVaScRiPt:alert(1)")).toBe(true);
    expect(isDangerousExportUrl("java\tscript:alert(1)")).toBe(true);
    expect(isDangerousExportUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(true);
  });

  it("allows ordinary URLs", () => {
    expect(isDangerousExportUrl("https://example.com/x")).toBe(false);
    expect(isDangerousExportUrl("nested/deep-note.md")).toBe(false);
    expect(isDangerousExportUrl("data:image/png;base64,AAAA")).toBe(false);
  });
});

describe("JSON export single basis (DA-6 EXP-03 area 12)", () => {
  it("parses editor nodes for tables, math, mermaid, images, and tasks", () => {
    const markdown = [
      "# Judul",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Rumus $x^2$ dan blok:",
      "",
      "$$",
      "y = x + 1",
      "$$",
      "",
      "```mermaid",
      "graph TD",
      "  A --> B",
      "```",
      "",
      "![alt](gambar.png)",
      "",
      "- [x] selesai",
    ].join("\n");
    const json = parseMarkdownToJson(markdown);
    const types = new Set<string>();
    const walk = (node: { type?: string; content?: unknown[] }) => {
      if (node.type) types.add(node.type);
      for (const child of node.content ?? []) {
        walk(child as { type?: string; content?: unknown[] });
      }
    };
    walk(json as { type?: string; content?: unknown[] });
    expect(types.has("table")).toBe(true);
    expect(types.has("inlineMath")).toBe(true);
    expect(types.has("blockMath")).toBe(true);
    expect(types.has("mermaidDiagram")).toBe(true);
    expect(types.has("image")).toBe(true);
    expect(types.has("taskItem")).toBe(true);
  });

  it("ignores a caller-provided json and always parses from markdown", async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        return "blob:test";
      },
      revokeObjectURL: vi.fn(),
    });
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", {
      createElement: () => link,
      body: { appendChild: vi.fn() },
      styleSheets: [],
      baseURI: "http://localhost/",
    });
    await expect(
      exportMarkdownSource("json", {
        baseName: "catatan",
        markdown: "# Halo",
        json: { type: "doc", content: [] },
      }),
    ).resolves.toBe(true);
    expect(blobs).toHaveLength(1);
    const parsed = JSON.parse(await blobs[0].text()) as { content?: Array<{ type?: string }> };
    expect(parsed.content?.[0]?.type).toBe("heading");
  });
});
