// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for buildFileRenamePlan (N-02/N-04): extensionless
// originals gain the .md suffix on rename, non-Markdown files do
// not, and the suffix check is case-insensitive.
//
// Run: `pnpm vitest run --project unit src/app/core/main/file/file-rename-plan.spec.ts`
// from the repo root.

import { describe, expect, it } from "vitest";
import { buildFileRenamePlan, hasMarkdownSuffix } from "./file-rename-plan";

const plan = (originalName: string, enteredName: string) =>
  buildFileRenamePlan({ originalName, currentPath: `folder/${originalName}`, enteredName });

describe("buildFileRenamePlan (N-02/N-04)", () => {
  it("adds .md for an extensionless original (N-02)", () => {
    expect(plan("Catatan 3 (edit)", "Baru").displayName).toBe("Baru.md");
    expect(plan("Catatan 3 (edit)", "Baru").targetRelativePath).toBe("folder/Baru.md");
  });

  it("does not add .md for a non-Markdown original", () => {
    expect(plan("data.txt", "Baru").displayName).toBe("Baru");
  });

  it("does not double the suffix when the entered name has one", () => {
    expect(plan("Note.md", "Baru.md").displayName).toBe("Baru.md");
  });

  it("treats .MD originals as Markdown (N-04)", () => {
    expect(plan("Note.MD", "Baru").displayName).toBe("Baru.md");
  });

  it("keeps an entered .MD suffix as typed (N-04)", () => {
    expect(plan("Note.md", "Baru.MD").displayName).toBe("Baru.MD");
  });

  it("keeps the create operation for new files", () => {
    const created = buildFileRenamePlan({ originalName: "", currentPath: "folder/", enteredName: "Baru" });
    expect(created.operation).toBe("create");
    expect(created.displayName).toBe("Baru.md");
  });

  it("hasMarkdownSuffix is case-insensitive", () => {
    expect(hasMarkdownSuffix("a.Md")).toBe(true);
    expect(hasMarkdownSuffix("a.markdown")).toBe(false);
  });
});
