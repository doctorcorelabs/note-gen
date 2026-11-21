// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-12): empty Organize output cleanup. Partial
// content is kept; cleanup failures never throw.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { describe, expect, it, vi } from "vitest";

import { cleanupEmptyOrganizeOutput } from "./organize-cleanup";

describe("SET-12 cleanupEmptyOrganizeOutput", () => {
  it("removes a whitespace-only output file once", async () => {
    const removeFile = vi.fn(async () => {});
    const removed = await cleanupEmptyOrganizeOutput({
      readTextFile: async () => "  \n",
      removeFile,
    });
    expect(removed).toBe(true);
    expect(removeFile).toHaveBeenCalledTimes(1);
  });

  it("keeps partial content", async () => {
    const removeFile = vi.fn(async () => {});
    const removed = await cleanupEmptyOrganizeOutput({
      readTextFile: async () => "# Draft\npartial text",
      removeFile,
    });
    expect(removed).toBe(false);
    expect(removeFile).not.toHaveBeenCalled();
  });

  it("swallows a read failure without removing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const removeFile = vi.fn(async () => {});
    const removed = await cleanupEmptyOrganizeOutput({
      readTextFile: async () => { throw new Error("gone"); },
      removeFile,
    });
    expect(removed).toBe(false);
    expect(removeFile).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("swallows a remove failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const removed = await cleanupEmptyOrganizeOutput({
      readTextFile: async () => "",
      removeFile: async () => { throw new Error("locked"); },
    });
    expect(removed).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
