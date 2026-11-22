// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for the inline math tokenizer guard (P1-3): plain
// text amounts must not become math, while real formulas still do.
// tokenize/start are pure functions; no DOM or network involved.
//
// Run: `pnpm vitest run --project unit src/app/core/main/editor/markdown/markdown-tokenizers.spec.ts`
// from the repo root.

import { describe, expect, it } from "vitest";
import { INLINE_MATH_INPUT_RULE_RE, inlineMathTokenizer } from "./markdown-tokenizers";

const tokenize = (src: string) =>
  inlineMathTokenizer.tokenize(src, [], undefined as never);
const start = (src: string) =>
  typeof inlineMathTokenizer.start === "function"
    ? inlineMathTokenizer.start(src)
    : -1;

describe("inlineMathTokenizer guard (P1-3)", () => {
  it("does not tokenize two plain-text amounts on one line", () => {
    expect(tokenize("$5 dan $10")).toBeUndefined();
  });

  it("tokenizes a real formula", () => {
    expect(tokenize("$x+1$")?.content).toBe("x+1");
  });

  it("skips escaped dollars in start()", () => {
    expect(start("\\$5$")).toBe(3);
    expect(tokenize("$")).toBeUndefined();
  });

  it("rejects whitespace just inside the delimiters", () => {
    expect(tokenize("$ x$")).toBeUndefined();
    expect(tokenize("$x $")).toBeUndefined();
  });

  it("accepts a single closed amount as the documented residue", () => {
    const token = tokenize("$5$ dan $10");
    expect(token?.raw).toBe("$5$");
    expect(token?.content).toBe("5");
  });

  it("still tokenizes the bracket form", () => {
    expect(tokenize("\\(x+1\\)")?.content).toBe("x+1");
  });
});

describe("INLINE_MATH_INPUT_RULE_RE (P1-3)", () => {
  it("does not fire for plain-text amounts", () => {
    expect(INLINE_MATH_INPUT_RULE_RE.test("harga $5 dan $")).toBe(false);
  });

  it("fires for a real formula", () => {
    expect(INLINE_MATH_INPUT_RULE_RE.test("rumus $x+1$")).toBe(true);
  });

  it("does not fire for an escaped opener or edge whitespace", () => {
    expect(INLINE_MATH_INPUT_RULE_RE.test("a \\$x$")).toBe(false);
    expect(INLINE_MATH_INPUT_RULE_RE.test("$x $")).toBe(false);
    expect(INLINE_MATH_INPUT_RULE_RE.test("$ x$")).toBe(false);
  });
});
