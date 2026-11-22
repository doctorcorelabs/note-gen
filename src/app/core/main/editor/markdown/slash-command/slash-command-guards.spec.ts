// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for DA-5 (A07-02/A07-03): block slash commands must
// surface a toast when the chain reports failure instead of failing
// silently after the slash text is deleted, and the slash menu must
// not trigger inside code blocks or table cells. Platform and toast
// are mocked; the editor is a minimal chain stub (same pattern as
// file-command.spec.ts).
//
// Run: `pnpm vitest run --project unit src/app/core/main/editor/markdown/slash-command/slash-command-guards.spec.ts`

import React from "react";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// suggestion.tsx carries JSX without a React import (Next uses the
// automatic runtime); the unit transform emits React.createElement,
// so expose React globally before the module loads.
(globalThis as Record<string, unknown>).React = React;

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  checkIsTauri: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({
  platform: {
    dialog: { open: vi.fn(), openFiles: vi.fn() },
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
let findSlashMatch: typeof import("./suggestion").findSlashMatch;

beforeAll(async () => {
  const mod = await import("./suggestion");
  suggestionItems = mod.suggestionItems;
  findSlashMatch = mod.findSlashMatch;
});

beforeEach(() => {
  mocks.toast.mockClear();
  mocks.checkIsTauri.mockReturnValue(false);
});

function stubEditor(runResult: boolean) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const method of [
    "focus", "deleteRange", "setNode", "toggleBulletList",
    "toggleOrderedList", "toggleTaskList", "insertTable",
    "toggleBlockquote", "toggleCodeBlock", "setHorizontalRule",
  ]) {
    chain[method] = vi.fn(self);
  }
  chain.run = vi.fn(() => runResult);
  return { chain: () => chain };
}

describe("block command failure toast (A07-02)", () => {
  it("toasts the generic failure title when run() returns false", () => {
    const items = suggestionItems();
    const heading1 = items.find((item) => item.title === "Heading 1");
    expect(heading1).toBeDefined();

    heading1?.command({
      editor: stubEditor(false) as never,
      range: { from: 1, to: 4 },
    });

    expect(mocks.toast).toHaveBeenCalledWith({
      title: "Failed to run command",
      variant: "destructive",
    });
  });

  it("stays silent when run() returns true", () => {
    const items = suggestionItems();
    const table = items.find((item) => item.title === "Table");
    expect(table).toBeDefined();

    table?.command({
      editor: stubEditor(true) as never,
      range: { from: 1, to: 4 },
    });

    expect(mocks.toast).not.toHaveBeenCalled();
  });
});

function fakePosition(options: {
  parentName: string;
  text: string;
  ancestors?: string[];
}) {
  const ancestors = options.ancestors ?? ["doc", options.parentName];
  const parent = {
    isTextblock: true,
    type: { name: options.parentName },
    textBetween: () => options.text,
  };
  return {
    parent,
    parentOffset: options.text.length,
    depth: ancestors.length - 1,
    node: (depth: number) => ({ type: { name: ancestors[depth] ?? "doc" } }),
    start: () => 1,
    pos: 1 + options.text.length,
  };
}

const config = (position: unknown) => ({
  char: "/",
  allowSpaces: false,
  allowedPrefixes: null,
  startOfLine: false,
  $position: position,
});

describe("findSlashMatch contexts (A07-03)", () => {
  it("matches in a plain paragraph", () => {
    const match = findSlashMatch(config(fakePosition({ parentName: "paragraph", text: "/he" })));
    expect(match?.query).toBe("he");
  });

  it("does not match inside a code block", () => {
    expect(findSlashMatch(config(fakePosition({ parentName: "codeBlock", text: "/he" })))).toBeNull();
  });

  it("does not match inside a table cell", () => {
    const position = fakePosition({
      parentName: "paragraph",
      text: "/he",
      ancestors: ["doc", "table", "tableRow", "tableCell", "paragraph"],
    });
    expect(findSlashMatch(config(position))).toBeNull();
  });

  it("keeps the old non-matches: path text and markdown link target", () => {
    expect(findSlashMatch(config(fakePosition({ parentName: "paragraph", text: "a/b" })))).toBeNull();
    expect(findSlashMatch(config(fakePosition({ parentName: "paragraph", text: "[x](a/b" })))).toBeNull();
  });
});

describe("static pins (A07-05/A07-06/P2-1)", () => {
  const read = (relative: string) =>
    readFileSync(new URL(relative, import.meta.url), "utf8");

  it("reportFailure uses the generic title, not the image title (A07-05)", () => {
    const source = read("./slash-menu.tsx");
    expect(source).not.toContain("title: translations.imageUpload.failed");
    expect(source).toContain("title: translations.commandFailed");
  });

  it("onSelectItem branches are throw-safe (A07-06)", () => {
    const menu = read("./slash-menu.tsx");
    expect(menu).toContain("try {\n            onSelectItem(item)");
    const portal = read("./slash-command-portal.tsx");
    expect(portal).toContain("} finally {\n                    hideMenu()");
  });

  it("table paste goes through the markdown parser (P2-1)", () => {
    const editor = read("../tiptap-editor.tsx");
    expect(editor).not.toContain("editor.commands.insertContent(table)");
    expect(editor).toContain("if (parseStandaloneMarkdownTable(text)) {\n              editor.commands.insertContent(text, { contentType: 'markdown' })");
  });

  it("both catalogs carry the commandFailed key (A07-05)", () => {
    for (const name of ["en.json", "zh.json"]) {
      const catalog = JSON.parse(read(`../../../../../../../messages/${name}`));
      expect(catalog.editor.slashCommand.commandFailed).toBeTruthy();
    }
  });
});
