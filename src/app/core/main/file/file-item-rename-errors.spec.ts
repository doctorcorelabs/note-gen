// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Static pins for N-06/N-07: rename refusals must say why, and the
// article read path must recognize structured not-found errors.
// These paths live in React components/stores without a component
// harness in this repo; runtime proof is owed to the browser rerun.
//
// Run: `pnpm vitest run --project unit src/app/core/main/file/file-item-rename-errors.spec.ts`
// from the repo root.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const fileItem = readFileSync(new URL("./file-item.tsx", import.meta.url), "utf8");
const article = readFileSync(
  new URL("../../../../stores/article.ts", import.meta.url),
  "utf8",
);
const editorLayout = readFileSync(
  new URL("../editor/editor-layout.tsx", import.meta.url),
  "utf8",
);

describe("rename error honesty (N-07)", () => {
  it("prepare-false branches set a specific rename error", () => {
    expect(fileItem.match(/setRenameError\(t\('error\.editorBusy'\)\)/g)).toHaveLength(2);
  });

  it("busy rename no longer reports the loading label", () => {
    expect(fileItem).not.toContain("setRenameError(tCommon('loading'))");
    expect(fileItem).toContain("setRenameError(t('error.renameBusy'))");
  });
});

describe("article read guards (N-02/N-06)", () => {
  it("recognizes structured not-found errors (N-06)", () => {
    expect(article).toContain("const isFileNotFound = isNotFoundError(error) ||");
  });

  it("probes extensionless files before the binary viewer (N-02)", () => {
    expect(article).toContain("decodeExtensionlessText(bytes) !== undefined");
    expect(article).toContain("!isSyncTextPath(actualPath) && !extensionlessIsText");
  });

  it("allows saving extensionless notes opened as text (N-02)", () => {
    expect(article).toContain("!isSyncTextPath(path) && !isExtensionlessPath(path)");
  });

  it("starts the read for extensionless files on click (N-02 lanjutan, gate A)", () => {
    expect(article).toContain(
      "fileName && isEditorTextCandidatePath(nextPath, requestedTabIsFolder)",
    );
    expect(article).not.toContain("!requestedTabIsFolder && fileName && fileName.includes('.')");
  });

  it("restores extensionless tabs with a read (N-02 lanjutan)", () => {
    expect(article).toContain(
      "isEditorTextCandidatePath(nextActiveFilePath, Boolean(activeTab?.isFolder))",
    );
    expect(article).not.toContain("!activeTab?.isFolder && isLikelyFilePath(nextActiveFilePath)");
  });
});

describe("viewer selection for extensionless files (N-02 lanjutan, gate B)", () => {
  it("routes extensionless files to the markdown editor", () => {
    expect(editorLayout).toContain("if (isExtensionlessPath(path)) return 'markdown'");
    expect(editorLayout).toContain("findFolderInTree(path, fileTree)) return 'folder'");
  });

  it("takes the extension from the final path segment only", () => {
    expect(editorLayout).toContain("const name = path.split('/').pop() || ''");
    expect(editorLayout).not.toContain("const extension = path.split('.').pop()");
  });
});
