// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for toWorkspaceMediaRelativePath (Fase 1, V3-23) and
// its contract with the web asset adapter: a workspace-relative
// image path must build an authenticated media URL, and funnel
// inputs that still carry desktop prefixes must not reach the
// adapter as absolute paths.
//
// Runner: Vitest, unit project (vitest run --project unit). Pure
// functions and a pure URL builder only; no DOM, no network.

import { describe, expect, it } from "vitest";

import { createWebAssetUrlAdapter } from "@/lib/platform/asset/asset.web";
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

describe("media URL contract", () => {
  const adapter = createWebAssetUrlAdapter();

  it("builds media URLs from markdown-relative image references", () => {
    const workspacePath = resolveImagePathFromMarkdown(
      "notes/meeting.md",
      "assets/diagram.png",
    );
    expect(workspacePath).toBe("notes/assets/diagram.png");
    expect(
      adapter.convertFileSrc(toWorkspaceMediaRelativePath(workspacePath, false)),
    ).toBe("/api/workspace/media/notes/assets/diagram.png");
  });

  it("round-trips upload paths through markdown-relative form", () => {
    const markdownPath = "notes/meeting.md";
    const workspaceImagePath = "notes/assets/uuid-1.png";
    const markdownRelative = toMarkdownImagePath(markdownPath, workspaceImagePath);
    expect(markdownRelative).toBe("assets/uuid-1.png");
    expect(
      adapter.convertFileSrc(
        toWorkspaceMediaRelativePath(
          resolveImagePathFromMarkdown(markdownPath, markdownRelative),
          false,
        ),
      ),
    ).toBe("/api/workspace/media/notes/assets/uuid-1.png");
  });

  it("encodes segments with spaces and keeps the URL relative", () => {
    const url = adapter.convertFileSrc(
      toWorkspaceMediaRelativePath("my notes/a b.png", false),
    );
    expect(url).toBe("/api/workspace/media/my%20notes/a%20b.png");
    expect(url.startsWith("http")).toBe(false);
  });

  it("rejects traversal instead of resolving it upward", () => {
    expect(() =>
      adapter.convertFileSrc(toWorkspaceMediaRelativePath("../secret.png", false)),
    ).toThrow();
  });
});
