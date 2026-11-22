// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// PB3 BUG2-02: renderMermaid used to wait for requestAnimationFrame
// with no timer race, so a frame that never fires (hidden page,
// suppressed rendering in automation) stalled the serialized
// render queue forever - the UTANG-UJI-07 hang pattern. The wait
// is now raced against a 250 ms timer, mirroring nextFrame in
// export-document.ts (DA-6 EXP-02).
//
// Run: `pnpm vitest run --project unit src/app/core/main/editor/markdown/mermaid-extension.spec.ts`

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: "<svg>mock</svg>" })),
  },
}));

import { renderMermaid } from "./mermaid-extension";

let rafMode: "never" | "always" = "always";

beforeEach(() => {
  vi.useFakeTimers();
  rafMode = "always";
  vi.stubGlobal("window", {
    requestAnimationFrame: (callback: () => void) => {
      if (rafMode === "always") callback();
      return 1;
    },
    cancelAnimationFrame: () => {},
    setTimeout: (fn: (...args: unknown[]) => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("renderMermaid frame wait (PB3 BUG2-02)", () => {
  it("resolves on the timer when the frame never fires", async () => {
    rafMode = "never";
    const promise = renderMermaid("flowchart TD\n  A --> B", () => true);
    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).resolves.toBe("<svg>mock</svg>");
  });

  it("resolves on the frame when it fires first", async () => {
    const promise = renderMermaid("flowchart TD\n  A --> B", () => true);
    await expect(promise).resolves.toBe("<svg>mock</svg>");
  });

  it("returns null when shouldRender turns false during the wait", async () => {
    rafMode = "never";
    const promise = renderMermaid("flowchart TD\n  A --> B", () => false);
    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).resolves.toBeNull();
  });
});
