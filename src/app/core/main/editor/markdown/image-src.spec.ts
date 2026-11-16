// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for image-src.ts (Fase 1, V3-23). The web media prefix
// is a resolved source: activation must not rewrite it, and display
// URLs must never leak into saved Markdown.
//
// Runner: Vitest, unit project (vitest run --project unit). Pure
// functions only; no DOM, no network, no storage.

import { describe, expect, it } from "vitest";

import {
  shouldKeepImageSrcAsIs,
  shouldTransformImageSrcToWorkspaceAsset,
  stripDisplayImageUrlPrefix,
} from "./image-src";

describe("shouldKeepImageSrcAsIs", () => {
  it("keeps remote, data, blob, asset, tauri, and file sources as-is", () => {
    for (const src of [
      "http://example.com/a.png",
      "https://example.com/a.png",
      "asset://localhost/a.png",
      "tauri://localhost/a.png",
      "data:image/png;base64,abc",
      "blob:https://example.com/uuid",
      "file:///tmp/a.png",
    ]) {
      expect(shouldKeepImageSrcAsIs(src)).toBe(true);
    }
  });

  it("keeps web media URLs as-is", () => {
    expect(shouldKeepImageSrcAsIs("/api/workspace/media/a.png")).toBe(true);
    expect(
      shouldKeepImageSrcAsIs("/api/workspace/media/notes/assets/a%20b.png"),
    ).toBe(true);
    expect(shouldKeepImageSrcAsIs("/api/workspace/media")).toBe(true);
  });

  it("does not keep relative paths or similar-but-different prefixes", () => {
    expect(shouldKeepImageSrcAsIs("assets/a.png")).toBe(false);
    expect(shouldKeepImageSrcAsIs("./assets/a.png")).toBe(false);
    expect(shouldKeepImageSrcAsIs("../assets/a.png")).toBe(false);
    expect(shouldKeepImageSrcAsIs("/api/workspace/media-evil/a.png")).toBe(false);
    expect(shouldKeepImageSrcAsIs("")).toBe(false);
    expect(shouldKeepImageSrcAsIs(null)).toBe(false);
    expect(shouldKeepImageSrcAsIs(undefined)).toBe(false);
  });
});

describe("shouldTransformImageSrcToWorkspaceAsset", () => {
  it("transforms only unresolved relative sources", () => {
    expect(shouldTransformImageSrcToWorkspaceAsset("assets/a.png")).toBe(true);
    expect(shouldTransformImageSrcToWorkspaceAsset("../assets/a.png")).toBe(true);
    expect(
      shouldTransformImageSrcToWorkspaceAsset("/api/workspace/media/a.png"),
    ).toBe(false);
    expect(
      shouldTransformImageSrcToWorkspaceAsset("https://example.com/a.png"),
    ).toBe(false);
    expect(shouldTransformImageSrcToWorkspaceAsset("")).toBe(false);
  });
});

describe("stripDisplayImageUrlPrefix", () => {
  it("strips legacy localhost display prefixes", () => {
    expect(stripDisplayImageUrlPrefix("asset://localhost/a/b.png")).toBe("a/b.png");
    expect(stripDisplayImageUrlPrefix("tauri://localhost/a/b.png")).toBe("a/b.png");
    expect(stripDisplayImageUrlPrefix("http://localhost/a/b.png")).toBe("a/b.png");
  });

  it("strips web media URLs to the workspace path", () => {
    expect(stripDisplayImageUrlPrefix("/api/workspace/media/a/b.png")).toBe("a/b.png");
    expect(
      stripDisplayImageUrlPrefix("/api/workspace/media/a%20b/c.png"),
    ).toBe("a%20b/c.png");
    expect(
      stripDisplayImageUrlPrefix("https://notegen.example/api/workspace/media/a/b.png"),
    ).toBe("a/b.png");
    expect(
      stripDisplayImageUrlPrefix("http://localhost:3456/api/workspace/media/a/b.png"),
    ).toBe("a/b.png");
    expect(stripDisplayImageUrlPrefix("/api/workspace/media")).toBe("");
  });

  it("leaves stored forms and remote URLs unchanged", () => {
    expect(stripDisplayImageUrlPrefix("assets/a.png")).toBe("assets/a.png");
    expect(stripDisplayImageUrlPrefix("../assets/a.png")).toBe("../assets/a.png");
    expect(stripDisplayImageUrlPrefix("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
    expect(stripDisplayImageUrlPrefix("data:image/png;base64,abc")).toBe(
      "data:image/png;base64,abc",
    );
    expect(stripDisplayImageUrlPrefix("")).toBe("");
    expect(stripDisplayImageUrlPrefix(null)).toBe("");
    expect(stripDisplayImageUrlPrefix(undefined)).toBe("");
  });
});
