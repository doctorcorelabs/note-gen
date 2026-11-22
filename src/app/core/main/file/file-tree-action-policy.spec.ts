// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Behavior specs for validateFileTreeName (F-05-13): leading-dot
// names are invalid so the client matches the server hidden-path
// rule (isHiddenWorkspacePath), edge spaces are trimmed before the
// checks, and empty or whitespace-only names report 'empty'.
//
// Run: `pnpm vitest run --project unit src/app/core/main/file/file-tree-action-policy.spec.ts`
// from the repo root.

import { describe, expect, it } from "vitest";
import { validateFileTreeName } from "./file-tree-action-policy";

describe("validateFileTreeName (F-05-13)", () => {
  it("accepts normal names", () => {
    expect(validateFileTreeName("note.md")).toBeNull();
    expect(validateFileTreeName("My Folder")).toBeNull();
    expect(validateFileTreeName("a.b.c")).toBeNull();
  });

  it("rejects leading-dot names like the server hidden-path rule", () => {
    expect(validateFileTreeName(".foo")).toBe("invalid");
    expect(validateFileTreeName("..foo")).toBe("invalid");
    expect(validateFileTreeName(".")).toBe("invalid");
    expect(validateFileTreeName("..")).toBe("invalid");
    expect(validateFileTreeName(".hidden.md")).toBe("invalid");
  });

  it("trims edge spaces before validating", () => {
    expect(validateFileTreeName("  note.md  ")).toBeNull();
    expect(validateFileTreeName("  .foo  ")).toBe("invalid");
  });

  it("reports empty and whitespace-only names as empty", () => {
    expect(validateFileTreeName("")).toBe("empty");
    expect(validateFileTreeName("   ")).toBe("empty");
  });

  it("rejects separators and control characters", () => {
    expect(validateFileTreeName("a/b")).toBe("invalid");
    expect(validateFileTreeName("a\\b")).toBe("invalid");
    expect(validateFileTreeName("a\u0001b")).toBe("invalid");
  });
});
