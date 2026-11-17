// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Vitest-style suite for the tag input helpers (tag-inputs.ts).
// Runs in the Vitest leg of `pnpm test:unit` and is listed in
// VITEST_SPECS in scripts/run-adapter-tests.mjs.

import { describe, expect, it } from "vitest";

import {
  normalizeTagName,
  sameTagSet,
  setPrimaryTag,
  tagSelectionChanged,
  validateTagName,
} from "./tag-inputs";

describe("normalizeTagName", () => {
  it("trims leading and trailing space", () => {
    expect(normalizeTagName("  Riset  ")).toBe("Riset");
  });

  it("keeps inner space as typed", () => {
    expect(normalizeTagName("My  Ideas")).toBe("My  Ideas");
  });
});

describe("validateTagName", () => {
  it("accepts a plain name and returns the trimmed form", () => {
    expect(validateTagName("  Riset ")).toEqual({ ok: true, name: "Riset" });
  });

  it("rejects an empty name and a whitespace-only name", () => {
    expect(validateTagName("")).toEqual({ ok: false, reason: "empty" });
    expect(validateTagName("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("accepts exactly 100 characters", () => {
    expect(validateTagName("a".repeat(100))).toEqual({
      ok: true,
      name: "a".repeat(100),
    });
  });

  it("rejects 101 characters", () => {
    expect(validateTagName("a".repeat(101))).toEqual({
      ok: false,
      reason: "tooLong",
    });
  });

  it("counts one astral character as one character", () => {
    expect(validateTagName("🧠".repeat(100)).ok).toBe(true);
    expect(validateTagName("🧠".repeat(101))).toEqual({
      ok: false,
      reason: "tooLong",
    });
  });

  it("rejects control characters inside the name", () => {
    expect(validateTagName("a\u0007b")).toEqual({
      ok: false,
      reason: "controlChars",
    });
    expect(validateTagName("a\nb")).toEqual({
      ok: false,
      reason: "controlChars",
    });
    expect(validateTagName("a\u007fb")).toEqual({
      ok: false,
      reason: "controlChars",
    });
  });

  it("reports control characters before length", () => {
    expect(validateTagName(`a\u0007${"b".repeat(100)}`)).toEqual({
      ok: false,
      reason: "controlChars",
    });
  });

  it("measures length after trimming", () => {
    expect(validateTagName(`  ${"a".repeat(100)}  `).ok).toBe(true);
  });
});

describe("sameTagSet", () => {
  it("ignores order", () => {
    expect(sameTagSet([3, 7, 9], [9, 3, 7])).toBe(true);
  });

  it("rejects different ids and different lengths", () => {
    expect(sameTagSet([3, 7], [3, 8])).toBe(false);
    expect(sameTagSet([3, 7], [3])).toBe(false);
    expect(sameTagSet([3], [3, 7])).toBe(false);
  });

  it("treats two empty sets as equal", () => {
    expect(sameTagSet([], [])).toBe(true);
  });
});

describe("tagSelectionChanged", () => {
  it("is false for an identical selection", () => {
    expect(tagSelectionChanged([3, 7, 9], [3, 7, 9])).toBe(false);
    expect(tagSelectionChanged([], [])).toBe(false);
  });

  it("is true when only the order changes", () => {
    expect(tagSelectionChanged([3, 7, 9], [7, 3, 9])).toBe(true);
  });

  it("is true when tags are added or removed", () => {
    expect(tagSelectionChanged([3, 7], [3, 7, 9])).toBe(true);
    expect(tagSelectionChanged([3, 7, 9], [3, 7])).toBe(true);
    expect(tagSelectionChanged([3, 7], [3, 8])).toBe(true);
  });
});

describe("setPrimaryTag", () => {
  it("moves the tag to the front and keeps the rest in order", () => {
    expect(setPrimaryTag([3, 7, 9], 9)).toEqual([9, 3, 7]);
    expect(setPrimaryTag([3, 7, 9], 7)).toEqual([7, 3, 9]);
  });

  it("leaves an already-primary tag in place", () => {
    expect(setPrimaryTag([3, 7, 9], 3)).toEqual([3, 7, 9]);
  });

  it("returns an unchanged copy for a tag outside the list", () => {
    const input = [3, 7];
    const result = setPrimaryTag(input, 9);
    expect(result).toEqual([3, 7]);
    expect(result).not.toBe(input);
  });

  it("handles a single-element list", () => {
    expect(setPrimaryTag([3], 3)).toEqual([3]);
  });
});
