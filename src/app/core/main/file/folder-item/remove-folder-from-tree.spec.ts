// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for removeFolderFromTree (F-15): the root fallback
// must only fire when the deleted folder IS the root entry. For a
// nested path whose parent children are unavailable, the old
// fallback removed the whole root subtree (siblings included) from
// the UI until the next reload.
//
// Run: `pnpm vitest run --project unit src/app/core/main/file/folder-item/remove-folder-from-tree.spec.ts`
// from the repo root.

import { describe, expect, it } from "vitest";
import type { DirTree } from "@/stores/article";
import { removeFolderFromTree } from "./remove-folder-from-tree";

function folder(
  name: string,
  children?: DirTree[],
  parent?: DirTree,
): DirTree {
  return {
    name,
    isFile: false,
    isDirectory: true,
    isSymlink: false,
    isLocale: true,
    children,
    parent,
  } as unknown as DirTree;
}

describe("removeFolderFromTree", () => {
  it("nested path with unavailable parent children leaves the tree unchanged (F-15)", () => {
    const staleParent = folder("a", undefined);
    const b = folder("b", [], staleParent);
    const c = folder("c", []);
    const a = folder("a", [b, c]);
    c.parent = a;
    const tree = [a];

    removeFolderFromTree(tree, "a/b");

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("a");
    expect(tree[0].children?.map((child) => child.name)).toEqual(["b", "c"]);
  });

  it("root path removes the root entry (F-15)", () => {
    const a = folder("a", []);
    const other = folder("other", []);
    const tree = [a, other];

    removeFolderFromTree(tree, "a");

    expect(tree.map((child) => child.name)).toEqual(["other"]);
  });

  it("normal nested path removes only the target, siblings stay (F-15)", () => {
    const a = folder("a", []);
    const b = folder("b", [], a);
    const c = folder("c", [], a);
    a.children = [b, c];
    const tree = [a];

    removeFolderFromTree(tree, "a/b");

    expect(tree).toHaveLength(1);
    expect(tree[0].children?.map((child) => child.name)).toEqual(["c"]);
  });

  it("unknown path is a no-op", () => {
    const a = folder("a", []);
    const tree = [a];

    removeFolderFromTree(tree, "missing/deep");

    expect(tree).toHaveLength(1);
  });
});
