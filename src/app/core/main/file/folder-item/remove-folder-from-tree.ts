// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import type { DirTree } from "@/stores/article";
import { getCurrentFolder } from "@/lib/path";

// Remove a deleted folder node from the in-memory file tree.
// Extracted from delete-folder-utils.ts so the tree surgery can be
// unit-tested without the sync/platform import graph.
export function removeFolderFromTree(tree: DirTree[], folderPath: string) {
  const currentFolder = getCurrentFolder(folderPath, tree);
  if (!currentFolder) {
    return;
  }

  const parentFolder = currentFolder?.parent;

  if (parentFolder?.children) {
    const index = parentFolder.children.findIndex(child => child.name === currentFolder.name);
    if (index !== -1) {
      parentFolder.children.splice(index, 1);
    }
    return;
  }

  // F-15: the root fallback is only correct when the deleted folder
  // IS the root entry. For a nested path whose parent children are
  // unavailable, removing the root entry would hide sibling folders
  // too; leave the tree for the next reload to reconcile.
  if (folderPath.includes('/')) {
    return;
  }

  const rootName = folderPath.split("/")[0];
  const index = tree.findIndex(child => child.name === rootName);
  if (index !== -1) {
    tree.splice(index, 1);
  }
}
