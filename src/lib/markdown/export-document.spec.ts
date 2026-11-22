// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// DA-6 EXP-02: nextFrame must resolve even when
// requestAnimationFrame never fires (hidden page, suppressed
// rendering), by racing the frame against a 250 ms timer - the
// same pattern waitForAnimationFrame already uses in
// markdown-export.ts. The abort signal still rejects.
//
// Run: `pnpm vitest run --project unit src/lib/markdown/export-document.spec.ts`

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextFrame } from "./export-document";

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
