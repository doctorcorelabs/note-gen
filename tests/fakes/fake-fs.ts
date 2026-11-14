// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Independent in-memory fake for the FsAdapter interface.
//
// The fake keeps a workspace tree in a Map, keyed by normalized relative
// paths. It never touches the real filesystem and never wraps the web or
// Tauri implementation. Writes are single assignments, which is the
// in-memory equivalent of the atomic write contract (temp file plus
// rename) the server must provide; readers therefore only ever observe
// the old or the new content, never a mixture.
//
// Behavior locked here follows fase1/desain-pengujian.md section 2.2
// (C-FS-01 to C-FS-11) as reconciled by AD-17: rename rewrites Markdown
// links and image references by default, dot segments are filtered on
// every observation path, and paths escaping the root are rejected with
// a typed error. Watcher events are simulated explicitly through
// simulateExternalWrite; the fake has no OS watcher.

import { ContractError } from "../contract/contract-errors";
import type {
  DirEntry,
  FsAdapter,
  FsEvent,
  RenameResult,
  UnlistenFn,
} from "../contract/contract-types";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dirnameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function isHiddenPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

// Relative path from directory `fromDir` to `target`, POSIX style.
// Both arguments are normalized workspace-relative paths.
export function relativePath(fromDir: string, target: string): string {
  const fromParts = fromDir === "" ? [] : fromDir.split("/");
  const targetParts = target.split("/");
  let common = 0;
  while (
    common < fromParts.length &&
    common < targetParts.length &&
    fromParts[common] === targetParts[common]
  ) {
    common += 1;
  }
  const ups = fromParts.length - common;
  const parts = [...Array(ups).fill(".."), ...targetParts.slice(common)];
  return parts.join("/");
}

export function normalizeWorkspacePath(rawPath: string): string {
  const unified = rawPath.replace(/\\/g, "/");
  if (
    unified.startsWith("/") ||
    /^[A-Za-z]:/.test(unified) ||
    unified.includes("\0")
  ) {
    throw new ContractError(
      "VALIDATION",
      `Path "${rawPath}" is not a workspace-relative path`,
    );
  }
  const out: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (out.length === 0) {
        throw new ContractError(
          "VALIDATION",
          `Path "${rawPath}" escapes the workspace root`,
        );
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

export class FakeFsAdapter implements FsAdapter {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>([""]);
  private readonly trash = new Map<string, string>();
  private readonly listeners = new Set<(event: FsEvent) => void>();
  private seq = 0;

  private emit(
    type: FsEvent["type"],
    path: string,
    previousPath?: string,
  ): void {
    // Dot-segment paths are filtered on every observation path (C-FS-03),
    // including the watcher path: no event is emitted for them.
    if (isHiddenPath(path)) {
      return;
    }
    this.seq += 1;
    const event: FsEvent = { type, path, seq: this.seq };
    if (previousPath !== undefined) {
      event.previousPath = previousPath;
    }
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  private ensureParents(path: string): void {
    const dir = dirnameOf(path);
    if (dir === "") {
      return;
    }
    const parts = dir.split("/");
    let current = "";
    for (const part of parts) {
      current = current === "" ? part : `${current}/${part}`;
      this.dirs.add(current);
    }
  }

  private assertIsFile(path: string): void {
    if (!this.files.has(path)) {
      throw new ContractError("NOT_FOUND", `File not found: "${path}"`);
    }
  }

  async listDir(path: string, recursive = false): Promise<DirEntry[]> {
    const root = normalizeWorkspacePath(path);
    const entries: DirEntry[] = [];
    const seenDirs = new Set<string>();
    const collect = (candidate: string, isDirectory: boolean): void => {
      if (isHiddenPath(candidate)) {
        return;
      }
      if (recursive) {
        if (root === "" || candidate.startsWith(`${root}/`)) {
          entries.push({
            name: candidate.slice(candidate.lastIndexOf("/") + 1),
            path: candidate,
            isDirectory,
          });
        }
        return;
      }
      if (dirnameOf(candidate) === root) {
        entries.push({
          name: candidate.slice(candidate.lastIndexOf("/") + 1),
          path: candidate,
          isDirectory,
        });
      }
    };
    for (const filePath of this.files.keys()) {
      collect(filePath, false);
    }
    for (const dirPath of this.dirs) {
      if (dirPath === "" || dirPath === root) {
        continue;
      }
      if (!seenDirs.has(dirPath)) {
        seenDirs.add(dirPath);
        collect(dirPath, true);
      }
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  }

  async scanMarkdown(): Promise<string[]> {
    const result: string[] = [];
    for (const filePath of this.files.keys()) {
      if (filePath.endsWith(".md") && !isHiddenPath(filePath)) {
        result.push(filePath);
      }
    }
    result.sort();
    return result;
  }

  async readText(path: string): Promise<string> {
    const normalized = normalizeWorkspacePath(path);
    this.assertIsFile(normalized);
    return this.files.get(normalized) as string;
  }

  async writeText(path: string, content: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    const isNew = !this.files.has(normalized);
    this.ensureParents(normalized);
    // Single assignment: atomic from every reader's point of view.
    this.files.set(normalized, content);
    this.emit(isNew ? "created" : "changed", normalized);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizeWorkspacePath(path);
    return this.files.has(normalized) || this.dirs.has(normalized);
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    this.ensureParents(`${normalized}/placeholder`);
    this.dirs.add(normalized);
  }

  async rename(
    oldPath: string,
    newPath: string,
    options: { rewriteLinks?: boolean } = {},
  ): Promise<RenameResult> {
    const oldNormalized = normalizeWorkspacePath(oldPath);
    const newNormalized = normalizeWorkspacePath(newPath);
    this.assertIsFile(oldNormalized);
    if (this.files.has(newNormalized) || this.dirs.has(newNormalized)) {
      throw new ContractError(
        "CONFLICT",
        `Rename target already exists: "${newPath}"`,
      );
    }
    const rewriteLinks = options.rewriteLinks ?? true;
    const content = this.files.get(oldNormalized) as string;
    this.files.delete(oldNormalized);
    this.ensureParents(newNormalized);
    this.files.set(newNormalized, content);
    this.emit("moved", newNormalized, oldNormalized);

    const rewrittenFiles: string[] = [];
    if (rewriteLinks) {
      for (const [filePath, fileContent] of [...this.files.entries()]) {
        if (!fileContent || !filePath.endsWith(".md")) {
          continue;
        }
        const dir = dirnameOf(filePath);
        const oldRef = relativePath(dir, oldNormalized);
        const newRef = relativePath(dir, newNormalized);
        const variants = oldRef.startsWith(".")
          ? [oldRef]
          : [oldRef, `./${oldRef}`];
        let updated = fileContent;
        for (const variant of variants) {
          const escaped = escapeRegExp(variant);
          // Plain link or image: ](ref). Titled link: ](ref "title").
          updated = updated.replace(
            new RegExp(`\\]\\(${escaped}\\)`, "g"),
            `](${newRef})`,
          );
          updated = updated.replace(
            new RegExp(`\\]\\(${escaped} `, "g"),
            `](${newRef} `,
          );
        }
        if (updated !== fileContent) {
          this.files.set(filePath, updated);
          rewrittenFiles.push(filePath);
          this.emit("changed", filePath);
        }
      }
      rewrittenFiles.sort();
    }
    return { rewrittenFiles };
  }

  async removeToTrash(path: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    this.assertIsFile(normalized);
    const content = this.files.get(normalized) as string;
    this.files.delete(normalized);
    this.trash.set(normalized, content);
    this.emit("deleted", normalized);
  }

  async restoreFromTrash(path: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    if (!this.trash.has(normalized)) {
      throw new ContractError("NOT_FOUND", `Not in trash: "${path}"`);
    }
    if (this.files.has(normalized)) {
      throw new ContractError(
        "CONFLICT",
        `Restore target already exists: "${path}"`,
      );
    }
    const content = this.trash.get(normalized) as string;
    this.trash.delete(normalized);
    this.ensureParents(normalized);
    this.files.set(normalized, content);
    this.emit("created", normalized);
  }

  async purgeFromTrash(path: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    if (!this.trash.delete(normalized)) {
      throw new ContractError("NOT_FOUND", `Not in trash: "${path}"`);
    }
  }

  async listTrash(): Promise<string[]> {
    return [...this.trash.keys()].sort();
  }

  async resolveImage(
    markdownPath: string,
    imageRef: string,
  ): Promise<string | null> {
    if (
      imageRef.startsWith("/") ||
      /^[A-Za-z]:/.test(imageRef) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(imageRef) ||
      imageRef.startsWith("data:")
    ) {
      return null;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(imageRef);
    } catch {
      return null;
    }
    const base = dirnameOf(normalizeWorkspacePath(markdownPath));
    const joined = base === "" ? decoded : `${base}/${decoded}`;
    try {
      return normalizeWorkspacePath(joined);
    } catch {
      return null;
    }
  }

  async onEvent(cb: (event: FsEvent) => void): Promise<UnlistenFn> {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // Fake-only: simulate an outside process writing atomically into the
  // workspace, so watcher cases can observe the event path (C-FS-10).
  async simulateExternalWrite(path: string, content: string): Promise<void> {
    await this.writeText(path, content);
  }
}

export function createFakeFsAdapter(): FakeFsAdapter {
  return new FakeFsAdapter();
}
