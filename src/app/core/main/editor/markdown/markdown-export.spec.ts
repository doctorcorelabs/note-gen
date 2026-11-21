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

vi.mock("@/lib/markdown/export-document", () => ({
  renderMarkdownExportFragment: async () => ({ html: "<p>halo</p>" }),
}));

import { exportMarkdownSource } from "./markdown-export";

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
