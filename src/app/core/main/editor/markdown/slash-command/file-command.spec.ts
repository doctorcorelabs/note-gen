// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for DA-4 (A07-01): the slash File command must
// show the disabled marker in web mode instead of calling the
// path-shaped dialog that always rejects there; the desktop path
// is unchanged. Platform, check, and toast are mocked; the
// editor is a minimal chain stub.
//
// Run: `pnpm vitest run --project unit src/app/core/main/editor/markdown/slash-command/file-command.spec.ts`

import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// suggestion.tsx carries JSX without a React import (Next uses the
// automatic runtime); the unit transform emits React.createElement,
// so expose React globally before the module loads.
(globalThis as Record<string, unknown>).React = React;

const mocks = vi.hoisted(() => ({
  dialogOpen: vi.fn(),
  toast: vi.fn(),
  checkIsTauri: vi.fn(),
  dispatchEvent: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({
  platform: {
    dialog: { open: mocks.dialogOpen, openFiles: vi.fn() },
    fs: { readFile: vi.fn() },
  },
}));

vi.mock("@/lib/check", () => ({
  checkIsTauri: mocks.checkIsTauri,
  isMobileDevice: vi.fn(() => false),
}));

vi.mock("@/hooks/use-toast", () => ({ toast: mocks.toast }));

vi.mock("@/lib/image-handler", () => ({ handleImageUpload: vi.fn() }));

vi.mock("@/stores/article", () => ({
  default: { getState: () => ({ activeFilePath: "note.md" }) },
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspacePath: vi.fn(async () => ""),
  isAbsoluteFsPath: vi.fn(() => false),
}));

vi.mock("@/lib/image-picker", () => ({
  pickImagesFromPhotoLibrary: vi.fn(async () => []),
}));

vi.mock("../async-editor-operations", () => ({
  createUploadPlaceholder: vi.fn(),
}));

let suggestionItems: typeof import("./suggestion").suggestionItems;

beforeAll(async () => {
  ({ suggestionItems } = await import("./suggestion"));
});

function fileItem() {
  const item = suggestionItems().find((candidate) => candidate.searchTerms?.includes("attachment"));
  if (!item) throw new Error("File slash item not found");
  return item;
}

function editorStub() {
  const run = vi.fn();
  const editor = {
    chain: () => ({ focus: () => ({ deleteRange: () => ({ run }) }) }),
  };
  return { editor: editor as never, run };
}

describe("slash File command (A07-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("document", { dispatchEvent: mocks.dispatchEvent });
    vi.stubGlobal("CustomEvent", class {
      type: string;
      constructor(type: string) { this.type = type; }
    });
  });

  it("web mode: shows the marker, never calls the dialog", async () => {
    mocks.checkIsTauri.mockReturnValue(false);
    const { editor, run } = editorStub();
    await fileItem().command({ editor, range: { from: 5, to: 10 } as never });
    expect(run).toHaveBeenCalled();
    expect(mocks.dialogOpen).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "File link insertion is not available",
    }));
    expect(mocks.dispatchEvent).toHaveBeenCalled();
  });

  it("desktop mode: keeps the dialog path", async () => {
    mocks.checkIsTauri.mockReturnValue(true);
    mocks.dialogOpen.mockResolvedValue(null);
    const { editor } = editorStub();
    await fileItem().command({ editor, range: { from: 5, to: 10 } as never });
    expect(mocks.dialogOpen).toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
