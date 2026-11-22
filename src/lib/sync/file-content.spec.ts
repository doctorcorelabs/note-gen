// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for the extensionless text helpers (N-02): an
// extensionless file counts as text only on a clean fatal UTF-8
// decode without NUL bytes.
//
// Run: `pnpm vitest run --project unit src/lib/sync/file-content.spec.ts`
// from the repo root.

import { describe, expect, it } from "vitest";
import {
  decodeExtensionlessText,
  isEditorTextCandidatePath,
  isExtensionlessPath,
  reconcileTabFolderFlags,
} from "./file-content";

const encode = (text: string) => new TextEncoder().encode(text);

describe("isExtensionlessPath (N-02)", () => {
  it("detects names without any dot", () => {
    expect(isExtensionlessPath("folder/Catatan 3 (edit)")).toBe(true);
    expect(isExtensionlessPath("README")).toBe(true);
  });

  it("rejects names with an extension or a dotfile marker", () => {
    expect(isExtensionlessPath("folder/note.md")).toBe(false);
    expect(isExtensionlessPath("folder/.hidden")).toBe(false);
    expect(isExtensionlessPath("")).toBe(false);
  });
});

describe("isEditorTextCandidatePath (N-02 lanjutan)", () => {
  it("accepts extensionless files but not extensionless folders", () => {
    expect(isEditorTextCandidatePath("Folder Demo/Catatan 3 (edit)", false)).toBe(true);
    expect(isEditorTextCandidatePath("Folder Demo", true)).toBe(false);
  });

  it("accepts known text paths and rejects unknown extensions", () => {
    expect(isEditorTextCandidatePath("folder/note.md", false)).toBe(true);
    expect(isEditorTextCandidatePath("folder/data.xyz", false)).toBe(false);
    expect(isEditorTextCandidatePath("folder/photo.png", false)).toBe(false);
  });

  it("handles dotted folders and empty names", () => {
    expect(isEditorTextCandidatePath("my.folder/Catatan 3 (edit)", false)).toBe(true);
    expect(isEditorTextCandidatePath("", false)).toBe(false);
    expect(isEditorTextCandidatePath("folder/", false)).toBe(false);
  });
});

describe("decodeExtensionlessText (N-02)", () => {
  it("accepts clean UTF-8 text", () => {
    expect(decodeExtensionlessText(encode("# Judul\nisi catatan"))).toBe("# Judul\nisi catatan");
    expect(decodeExtensionlessText(encode(""))).toBe("");
  });

  it("rejects binary content", () => {
    expect(decodeExtensionlessText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBeUndefined();
    expect(decodeExtensionlessText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeUndefined();
  });

  it("rejects text containing NUL bytes", () => {
    expect(decodeExtensionlessText(encode("a\0b"))).toBeUndefined();
  });
});

describe("reconcileTabFolderFlags (PB2b)", () => {
  const treeLookup = (path: string): boolean | undefined => {
    if (path === "Folder Demo") return true;
    if (path === "Folder Demo/Catatan 3 (edit)") return false;
    if (path === "Folder Demo/Catatan 2.md") return false;
    return undefined;
  };

  it("corrects an extensionless file restored as folder before the tree loaded", () => {
    const tabs = [
      { path: "Folder Demo/Catatan 3 (edit)", isFolder: true, kind: "file" },
    ];
    const result = reconcileTabFolderFlags(tabs, treeLookup);
    expect(result.changed).toBe(true);
    expect(result.tabs[0].isFolder).toBe(false);
    expect(
      isEditorTextCandidatePath(result.tabs[0].path, result.tabs[0].isFolder),
    ).toBe(true);
  });

  it("keeps a real folder tab as folder", () => {
    const tabs = [{ path: "Folder Demo", isFolder: true, kind: "file" }];
    const result = reconcileTabFolderFlags(tabs, treeLookup);
    expect(result.changed).toBe(false);
    expect(result.tabs).toBe(tabs);
    expect(result.tabs[0].isFolder).toBe(true);
  });

  it("corrects an extensionless folder defaulted to file before the tree loaded", () => {
    const tabs = [{ path: "Folder Demo", isFolder: false, kind: "file" }];
    const result = reconcileTabFolderFlags(tabs, treeLookup);
    expect(result.changed).toBe(true);
    expect(result.tabs[0].isFolder).toBe(true);
  });

  it("leaves tabs unknown to the tree and non-file tabs untouched", () => {
    const tabs = [
      { path: "Belum Termuat/Catatan", isFolder: true, kind: "file" },
      { path: "Folder Demo/Catatan 3 (edit)", isFolder: true, kind: "record" },
    ];
    const result = reconcileTabFolderFlags(tabs, treeLookup);
    expect(result.changed).toBe(false);
    expect(result.tabs).toBe(tabs);
  });
});
