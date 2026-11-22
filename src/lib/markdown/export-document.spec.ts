// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// DA-6 EXP-02: nextFrame must resolve even when
// requestAnimationFrame never fires (hidden page, suppressed
// rendering), by racing the frame against a 250 ms timer - the
// same pattern waitForAnimationFrame already uses in
// markdown-export.ts. The abort signal still rejects.
//
// Run: `pnpm vitest run --project unit src/lib/markdown/export-document.spec.ts`

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MERMAID_DIAGRAM_TIMEOUT_MS, nextFrame, renderMermaidCodeBlocks } from "./export-document";

let rafCallback: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  rafCallback = null;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    rafCallback = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    rafCallback = null;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("nextFrame (DA-6 EXP-02)", () => {
  it("resolves on the timer when the frame never fires", async () => {
    const promise = nextFrame();
    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves on the frame when it fires first", async () => {
    const promise = nextFrame();
    rafCallback?.();
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects when the signal aborts before either fires", async () => {
    const controller = new AbortController();
    const promise = nextFrame(controller.signal);
    const assertion = expect(promise).rejects.toThrow(/cancelled/i);
    controller.abort();
    await assertion;
  });
});

describe("renderMermaidCodeBlocks (PB3 BUG2-02)", () => {
  interface FakeFigure { className: string; innerHTML: string }
  let figures: FakeFigure[] = [];

  function makeBlock(language: string, lines: string[]) {
    const code = {
      children: lines.map((text) => ({ textContent: text })),
      textContent: lines.join(""),
    };
    return {
      getAttribute: (name: string) => (name === "data-language" ? language : null),
      querySelector: (selector: string) => (selector === "code" ? code : null),
      replaceWith: vi.fn(),
    };
  }

  function makeRoot(blocks: ReturnType<typeof makeBlock>[]) {
    return { querySelectorAll: () => blocks } as never;
  }

  beforeEach(() => {
    figures = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const figure: FakeFigure = { className: "", innerHTML: "" };
        figures.push(figure);
        return figure;
      },
    });
  });

  it("replaces a mermaid code block with the rendered SVG", async () => {
    const block = makeBlock("mermaid", ["flowchart TD", "  A --> B"]);
    const renderDiagram = vi.fn(async () => "<svg>ok</svg>");

    const counts = await renderMermaidCodeBlocks(makeRoot([block]), renderDiagram);

    expect(counts).toEqual({ rendered: 1, failed: 0 });
    expect(renderDiagram).toHaveBeenCalledWith("flowchart TD\n  A --> B", undefined);
    expect(block.replaceWith).toHaveBeenCalledTimes(1);
    expect(figures[0].innerHTML).toBe("<svg>ok</svg>");
    expect(figures[0].className).toBe("notegen-export-mermaid");
  });

  it("keeps the code block when the renderer returns null", async () => {
    const block = makeBlock("mermaid", ["flowchart TD"]);
    const counts = await renderMermaidCodeBlocks(makeRoot([block]), async () => null);
    expect(counts).toEqual({ rendered: 0, failed: 1 });
    expect(block.replaceWith).not.toHaveBeenCalled();
  });

  it("keeps the code block when the renderer rejects", async () => {
    const block = makeBlock("mermaid", ["flowchart TD"]);
    const counts = await renderMermaidCodeBlocks(makeRoot([block]), async () => {
      throw new Error("render failed");
    });
    expect(counts).toEqual({ rendered: 0, failed: 1 });
    expect(block.replaceWith).not.toHaveBeenCalled();
  });

  it("times out a hung renderer instead of stalling", async () => {
    const block = makeBlock("mermaid", ["flowchart TD"]);
    const promise = renderMermaidCodeBlocks(
      makeRoot([block]),
      () => new Promise<never>(() => {}),
    );
    await vi.advanceTimersByTimeAsync(MERMAID_DIAGRAM_TIMEOUT_MS);
    await expect(promise).resolves.toEqual({ rendered: 0, failed: 1 });
    expect(block.replaceWith).not.toHaveBeenCalled();
  });

  it("ignores non-mermaid blocks and counts empty mermaid blocks as failed", async () => {
    const other = makeBlock("ts", ["const x = 1"]);
    const empty = makeBlock("mermaid", []);
    const renderDiagram = vi.fn(async () => "<svg>ok</svg>");
    const counts = await renderMermaidCodeBlocks(makeRoot([other, empty]), renderDiagram);
    expect(counts).toEqual({ rendered: 0, failed: 1 });
    expect(renderDiagram).not.toHaveBeenCalled();
  });
});

// EXP4-12 (AD-1050) static pin: resolveExportImages resolves
// with bounded concurrency in phase 1 and applies in document
// order in phase 2. Runtime proof belongs to the post-deploy
// browser rerun; this pin keeps the two-phase shape from
// regressing to the sequential loop silently.
describe("advanced export image resolution (EXP4-12)", () => {
  it("keeps the bounded-concurrency resolve phase ahead of the apply loop", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "export-document.ts"),
      "utf8",
    );
    expect(source).toContain("EXPORT_IMAGE_RESOLVE_CONCURRENCY = 4");
    const phaseOne = source.indexOf("Phase 1: fill the resolved cache");
    const applyLoop = source.indexOf("const dataUrl = source.startsWith('data:')");
    expect(phaseOne).toBeGreaterThan(-1);
    expect(applyLoop).toBeGreaterThan(phaseOne);
  });
});
