// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for toWorkspaceMediaRelativePath (Fase 1, V3-23).
// The helper prepares funnel inputs for the web asset adapter,
// which only accepts workspace-relative paths and builds the
// authenticated media URL from them; the adapter's own URL
// building is covered by its test file, so this suite asserts
// the normalizer output shape and the markdown round-trip only
// and never imports an adapter implementation directly.
//
// Runner: Vitest, unit project (vitest run --project unit). Pure
// functions only; no DOM, no network.

import { describe, expect, it } from "vitest";

import {
  resolveImagePathFromMarkdown,
  toMarkdownImagePath,
  toWorkspaceMediaRelativePath,
} from "./markdown-image-path";

describe("toWorkspaceMediaRelativePath", () => {
  it("leaves plain relative paths unchanged", () => {
    expect(toWorkspaceMediaRelativePath("assets/a.png", false)).toBe("assets/a.png");
    expect(toWorkspaceMediaRelativePath("notes/assets/a.png", true)).toBe(
      "notes/assets/a.png",
    );
  });

  it("normalizes separators and leading markers", () => {
    expect(toWorkspaceMediaRelativePath("notes\\assets\\a.png", false)).toBe(
      "notes/assets/a.png",
    );
    expect(toWorkspaceMediaRelativePath("./assets/a.png", false)).toBe("assets/a.png");
    expect(toWorkspaceMediaRelativePath("/assets/a.png", false)).toBe("assets/a.png");
    expect(toWorkspaceMediaRelativePath("notes//assets///a.png", false)).toBe(
      "notes/assets/a.png",
    );
    expect(toWorkspaceMediaRelativePath("  assets/a.png  ", false)).toBe("assets/a.png");
  });

  it("strips the default-workspace article prefix only for default workspaces", () => {
    expect(toWorkspaceMediaRelativePath("article/notes/a.png", false)).toBe(
      "notes/a.png",
    );
    expect(toWorkspaceMediaRelativePath("article/notes/a.png", true)).toBe(
      "article/notes/a.png",
    );
    expect(toWorkspaceMediaRelativePath("article-notes/a.png", false)).toBe(
      "article-notes/a.png",
    );
  });

  it("keeps traversal segments for the adapter to reject", () => {
    expect(toWorkspaceMediaRelativePath("../a.png", false)).toBe("../a.png");
    expect(toWorkspaceMediaRelativePath("notes/../../a.png", false)).toBe(
      "notes/../../a.png",
    );
  });
});

describe("adapter input contract", () => {
  it("produces a relative path from markdown-relative image references", () => {
    const workspacePath = resolveImagePathFromMarkdown(
      "notes/meeting.md",
      "assets/diagram.png",
    );
    expect(workspacePath).toBe("notes/assets/diagram.png");
    const normalized = toWorkspaceMediaRelativePath(workspacePath, false);
    expect(normalized).toBe("notes/assets/diagram.png");
    expect(normalized.startsWith("/")).toBe(false);
    expect(normalized.startsWith("http")).toBe(false);
  });

  it("round-trips upload paths through markdown-relative form", () => {
    const markdownPath = "notes/meeting.md";
    const workspaceImagePath = "notes/assets/uuid-1.png";
    const markdownRelative = toMarkdownImagePath(markdownPath, workspaceImagePath);
    expect(markdownRelative).toBe("assets/uuid-1.png");
    const normalized = toWorkspaceMediaRelativePath(
      resolveImagePathFromMarkdown(markdownPath, markdownRelative),
      false,
    );
    expect(normalized).toBe(workspaceImagePath);
  });

  it("keeps decoded segments for the adapter to encode", () => {
    expect(toWorkspaceMediaRelativePath("my notes/a b.png", false)).toBe(
      "my notes/a b.png",
    );
  });

  it("leaves traversal visible instead of resolving it upward", () => {
    expect(toWorkspaceMediaRelativePath("../secret.png", false)).toBe("../secret.png");
  });
});
