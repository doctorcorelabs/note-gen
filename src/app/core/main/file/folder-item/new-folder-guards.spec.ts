// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Static pins for F-11/F-13: new-folder placeholder insertion must
// not crash on unloaded children, refresh merges must keep editing
// placeholders, and the create-folder confirm path must not write
// through a -1 index. These paths live in React components/stores
// without a component harness in this repo; runtime proof is owed
// to the browser rerun.
//
// Run: `pnpm vitest run --project unit src/app/core/main/file/folder-item/new-folder-guards.spec.ts`
// from the repo root.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const folderItem = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const newFolder = readFileSync(new URL("./new-folder.tsx", import.meta.url), "utf8");
const article = readFileSync(
  new URL("../../../../../stores/article.ts", import.meta.url),
  "utf8",
);

describe("new folder guards (F-11/F-13)", () => {
  it("initializes children before unshifting placeholders (F-11)", () => {
    expect(folderItem).toContain("currentFolder.children ??= []");
    expect(article).toContain("currentFolder.children ??= []");
  });

  it("expands the folder before inserting the placeholder (F-11)", () => {
    expect(newFolder).toContain("await setCollapsibleList(path, true)");
  });

  it("preserves editing placeholders across refresh merges (F-11)", () => {
    expect(article).toContain("entry.isLocale && entry.isEditing && entry.name === ''");
  });

  it("guards the create-folder index before writing children (F-13)", () => {
    const start = folderItem.indexOf("F-13: guard index -1");
    expect(start).toBeGreaterThan(-1);
    const region = folderItem.slice(start, start + 1200);
    expect(region.match(/index !== undefined && index !== -1/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
