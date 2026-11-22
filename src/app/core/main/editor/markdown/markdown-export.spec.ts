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
  renderMarkdownToHtmlDetailed,
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

describe("export file name extension (IM-3 EXP4-04)", () => {
  it("strips only one extension: notes.v2.md exports as notes.v2.html", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:test",
      revokeObjectURL: vi.fn(),
    });
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", {
      createElement: (tag: string) => (tag === "a" ? link : makeTemplate()),
      body: { appendChild: vi.fn() },
      styleSheets: [],
      baseURI: "http://localhost/",
    });

    const promise = exportMarkdownSource("html", {
      baseName: "notes.v2.md",
      markdown: "# Halo",
    });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe(true);
    expect(link.download).toBe("notes.v2.html");
    expect(link.click).toHaveBeenCalledTimes(1);
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

  it("warns that JSON export from markdown is lossy (IM-3 EXP4-11)", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:test",
      revokeObjectURL: vi.fn(),
    });
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", {
      createElement: () => link,
      body: { appendChild: vi.fn() },
      styleSheets: [],
      baseURI: "http://localhost/",
    });
    const onWarnings = vi.fn();

    await expect(
      exportMarkdownSource("json", { baseName: "catatan", markdown: "# Halo" }, { onWarnings }),
    ).resolves.toBe(true);

    expect(onWarnings).toHaveBeenCalledTimes(1);
    expect(onWarnings).toHaveBeenCalledWith([
      expect.objectContaining({ code: "unsupported-content" }),
    ]);
  });
});

describe("main-path image deferral (PB2 BUG2-01/02, PERF-01)", () => {
  interface FakeImage {
    getAttribute: (name: string) => string | null;
    setAttribute: (name: string, value: string) => void;
    removeAttribute: (name: string) => void;
  }

  function makeFakeImage(attrs: Record<string, string>): FakeImage {
    const store = new Map(Object.entries(attrs));
    return {
      getAttribute: (name) => store.get(name) ?? null,
      setAttribute: (name, value) => { store.set(name, value); },
      removeAttribute: (name) => { store.delete(name); },
    };
  }

  class FakeFileReader {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    error: unknown = null;
    result: string | null = null;
    readAsDataURL() {
      this.result = "data:image/png;base64,AAAA";
      this.onload?.();
    }
  }

  let fakeImages: FakeImage[] = [];
  let activeFetches = 0;
  let maxActiveFetches = 0;

  beforeEach(() => {
    vi.useRealTimers();
    fakeImages = [];
    activeFetches = 0;
    maxActiveFetches = 0;
    vi.stubGlobal("document", {
      createElement: (tag: string) => tag === "template"
        ? {
            innerHTML: "",
            content: {
              querySelectorAll: (selector: string) => selector === "img" ? fakeImages : [],
            },
          }
        : makeTemplate(),
      body: { appendChild: vi.fn() },
      styleSheets: [],
      baseURI: "http://localhost/",
    });
    vi.stubGlobal("FileReader", FakeFileReader);
    vi.stubGlobal("fetch", vi.fn(async () => {
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeFetches -= 1;
      return { ok: true, blob: async () => new Blob(["x"]) };
    }));
  });

  it("embeds a deferred workspace image instead of leaving blocked text", async () => {
    fakeImages = [makeFakeImage({
      alt: "Klasifikasi",
      "data-notegen-export-src": "cover-klasifikasi.png",
    })];
    renderMocks.renderMarkdownExportFragment.mockResolvedValueOnce({
      html: '<img alt="Klasifikasi" data-notegen-export-src="cover-klasifikasi.png">',
      highlightFallback: false,
    });

    const { warnings } = await renderMarkdownToHtmlDetailed("![Klasifikasi](cover-klasifikasi.png)");

    expect(renderMocks.renderMarkdownExportFragment).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deferImages: true }),
    );
    expect(fakeImages[0].getAttribute("src")).toMatch(/^data:/);
    expect(fakeImages[0].getAttribute("data-notegen-export-src")).toBeNull();
    expect(warnings.filter((warning) => warning.code === "asset-not-embedded")).toHaveLength(0);
  });

  it("embeds images with bounded concurrency and keeps document order", async () => {
    fakeImages = Array.from({ length: 6 }, (_, index) => makeFakeImage({
      alt: `img-${index}`,
      "data-notegen-export-src": `img-${index}.png`,
    }));
    renderMocks.renderMarkdownExportFragment.mockResolvedValueOnce({
      html: "<p>gambar</p>",
      highlightFallback: false,
    });

    const { warnings } = await renderMarkdownToHtmlDetailed("enam gambar");

    expect(maxActiveFetches).toBeGreaterThan(1);
    expect(maxActiveFetches).toBeLessThanOrEqual(4);
    for (const image of fakeImages) {
      expect(image.getAttribute("src")).toMatch(/^data:/);
    }
    expect(warnings).toHaveLength(0);
  });

  it("warns that mermaid diagrams are preserved as code blocks when rendering fails", async () => {
    renderMocks.renderMarkdownExportFragment.mockResolvedValueOnce({
      html: "<p>diagram</p>",
      highlightFallback: false,
      mermaidRendered: 0,
      mermaidFailed: 1,
    } as never);

    const { warnings } = await renderMarkdownToHtmlDetailed(
      "```mermaid\nflowchart TD\n  A --> B\n```",
    );

    expect(warnings).toContainEqual(expect.objectContaining({ code: "unsupported-content" }));
  });

  it("does not warn when every mermaid diagram rendered to SVG", async () => {
    renderMocks.renderMarkdownExportFragment.mockResolvedValueOnce({
      html: "<p>diagram</p>",
      highlightFallback: false,
      mermaidRendered: 1,
      mermaidFailed: 0,
    } as never);

    const { warnings } = await renderMarkdownToHtmlDetailed(
      "```mermaid\nflowchart TD\n  A --> B\n```",
    );

    expect(warnings.filter((warning) => warning.code === "unsupported-content")).toHaveLength(0);
  });

  it("does not start image fetches after the caller signal aborted (IM-3 EXP4-05)", async () => {
    fakeImages = [0, 1].map((index) => makeFakeImage({
      alt: `img-${index}`,
      "data-notegen-export-src": `img-${index}.png`,
    }));
    renderMocks.renderMarkdownExportFragment.mockResolvedValueOnce({
      html: "<p>gambar</p>",
      highlightFallback: false,
    });
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["x"]) }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    const { warnings } = await renderMarkdownToHtmlDetailed("dua gambar", undefined, controller.signal);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings.filter((warning) => warning.code === "asset-not-embedded")).toHaveLength(2);
    expect(fakeImages[0].getAttribute("src")).toBe("img-0.png");
    expect(fakeImages[1].getAttribute("src")).toBe("img-1.png");
  });

  it("forwards an abort signal to image fetches (IM-3 EXP4-05)", async () => {
    fakeImages = [makeFakeImage({
      alt: "img",
      "data-notegen-export-src": "img.png",
    })];
    renderMocks.renderMarkdownExportFragment.mockResolvedValueOnce({
      html: "<p>gambar</p>",
      highlightFallback: false,
    });
    let seenSignal: unknown;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { signal?: unknown }) => {
      seenSignal = init?.signal;
      return { ok: true, blob: async () => new Blob(["x"]) };
    }));
    const controller = new AbortController();

    await renderMarkdownToHtmlDetailed("satu gambar", undefined, controller.signal);

    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("counts data: image bytes against the embed limits (IM-3 EXP4-06)", async () => {
    const small = "data:image/png;base64,AAAA";
    // 3 MiB of base64 decodes to about 2.25 MiB, over the 2 MiB
    // per-image limit.
    const oversized = `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`;
    fakeImages = [
      makeFakeImage({ alt: "small", "data-notegen-export-src": small }),
      makeFakeImage({ alt: "big", "data-notegen-export-src": oversized }),
    ];
    renderMocks.renderMarkdownExportFragment.mockResolvedValueOnce({
      html: "<p>gambar</p>",
      highlightFallback: false,
    });

    const { warnings } = await renderMarkdownToHtmlDetailed("dua gambar data");

    expect(fakeImages[0].getAttribute("src")).toBe(small);
    expect(fakeImages[1].getAttribute("src")).toBe(oversized);
    expect(warnings).toEqual([
      expect.objectContaining({
        code: "asset-not-embedded",
        message: expect.stringContaining("too large"),
      }),
    ]);
  });

  it("embeds blob: images through the fetch path (IM-3 EXP4-06)", async () => {
    fakeImages = [makeFakeImage({
      alt: "blob",
      "data-notegen-export-src": "blob:http://localhost/abc",
    })];
    renderMocks.renderMarkdownExportFragment.mockResolvedValueOnce({
      html: "<p>gambar</p>",
      highlightFallback: false,
    });

    const { warnings } = await renderMarkdownToHtmlDetailed("gambar blob");

    expect(fakeImages[0].getAttribute("src")).toMatch(/^data:/);
    expect(warnings.filter((warning) => warning.code === "asset-not-embedded")).toHaveLength(0);
  });
});
