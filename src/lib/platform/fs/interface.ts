// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * FsAdapter interface (migration wave G1, data blocker).
 *
 * Replaces the upstream plugin-fs surface used by the codebase.
 * Signatures mirror the installed upstream declarations (plugin-fs 2.x)
 * and were checked against every import site in the reference tree at
 * 4dcaa3f, including dynamic imports.
 *
 * BaseDirectory is a real enum, the single runtime value in this
 * otherwise type-only file: migrated call sites pass BaseDirectory
 * members as values, so the barrel must export the value, not only the
 * type. Numeric values match the upstream enum exactly.
 *
 * The file handle surface is read, stat, and close only: seek, write,
 * and truncate have no call sites. The create, truncate, readTextFileLines,
 * watchImmediate, and size functions and the SeekMode enum are not
 * imported anywhere and are excluded. DirEntry has exactly the four
 * upstream fields; directory entries carry no path or children.
 *
 * Merge M8 reconciliation (audit V2-40): FileInfo gains the
 * revision/version web extensions; WriteFileOptions gains
 * expectedRevision/force; RenameOptions gains rewriteLinks/
 * expectedRevision; the adapter gains readTextFileDetailed,
 * readFileDetailed, and renameWithResult with their result
 * types. FsAdapterError and its helpers moved to fs/errors.ts.
 * The seek-mode enum and the writable FileHandle shape are
 * intentionally absent: no call sites use them (G0).
 */
export enum BaseDirectory {
  Audio = 1,
  Cache = 2,
  Config = 3,
  Data = 4,
  LocalData = 5,
  Document = 6,
  Download = 7,
  Picture = 8,
  Public = 9,
  Video = 10,
  Resource = 11,
  Temp = 12,
  AppConfig = 13,
  AppData = 14,
  AppLocalData = 15,
  AppCache = 16,
  AppLog = 17,
  Desktop = 18,
  Executable = 19,
  Font = 20,
  Home = 21,
  Runtime = 22,
  Template = 23,
}

export interface FileInfo {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: Date | null;
  atime: Date | null;
  birthtime: Date | null;
  readonly: boolean;
  fileAttributes: number | null;
  dev: number | null;
  ino: number | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
  rdev: number | null;
  blksize: number | null;
  blocks: number | null;
  /** Web extension: revision string from the workspace API contract. Null for directories. */
  revision?: string | null;
  /** Web extension: index version counter. Null for directories. */
  version?: number | null;
}

export interface FsFileHandle {
  read(buffer: Uint8Array): Promise<number | null>;
  stat(): Promise<FileInfo>;
  close(): Promise<void>;
}

export interface OpenOptions {
  read?: boolean;
  write?: boolean;
  append?: boolean;
  truncate?: boolean;
  create?: boolean;
  createNew?: boolean;
  mode?: number;
  baseDir?: BaseDirectory;
}

export interface CopyFileOptions {
  fromPathBaseDir?: BaseDirectory;
  toPathBaseDir?: BaseDirectory;
}

export interface MkdirOptions {
  mode?: number;
  recursive?: boolean;
  baseDir?: BaseDirectory;
}

export interface ReadDirOptions {
  baseDir?: BaseDirectory;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface ReadFileOptions {
  baseDir?: BaseDirectory;
}

export interface RemoveOptions {
  recursive?: boolean;
  baseDir?: BaseDirectory;
}

export interface RenameOptions {
  oldPathBaseDir?: BaseDirectory;
  newPathBaseDir?: BaseDirectory;
  /**
   * Web extension. When true (the default), the server rewrites Markdown
   * links that point at the moved path (V1-09 section 6). Ignored by the
   * Tauri implementation.
   */
  rewriteLinks?: boolean;
  /**
   * Web extension. Revision guard for the move source (V1-09 section
   * 2.7). When set and stale, the move fails with a revision_conflict
   * error and nothing is renamed. Ignored by the Tauri implementation.
   */
  expectedRevision?: string;
}

export interface StatOptions {
  baseDir?: BaseDirectory;
}

export interface WriteFileOptions {
  append?: boolean;
  create?: boolean;
  createNew?: boolean;
  mode?: number;
  baseDir?: BaseDirectory;
  /**
   * Web extension. Revision the file must still have for the write to
   * proceed (V1-09 section 3). When omitted, the web implementation
   * reads the current revision first and guards the write with it, so
   * plain call sites still get guarded writes. When set, no extra read
   * happens and a stale revision fails with a revision_conflict error.
   */
  expectedRevision?: string;
  /**
   * Web extension. Force overwrite regardless of the current revision
   * (If-Match: *). Only for explicit user choice through the conflict
   * dialog (V1-09 section 3.5). Never a default.
   */
  force?: boolean;
}

export interface ExistsOptions {
  baseDir?: BaseDirectory;
}

export interface WatchOptions {
  recursive?: boolean;
  baseDir?: BaseDirectory;
}

export interface DebouncedWatchOptions extends WatchOptions {
  delayMs?: number;
}

export type WatchEventKindAccess =
  | { kind: "any" }
  | { kind: "close"; mode: "any" | "execute" | "read" | "write" | "other" }
  | { kind: "open"; mode: "any" | "execute" | "read" | "write" | "other" }
  | { kind: "other" };

export type WatchEventKindCreate =
  | { kind: "any" }
  | { kind: "file" }
  | { kind: "folder" }
  | { kind: "other" };

export type WatchEventKindModify =
  | { kind: "any" }
  | { kind: "data"; mode: "any" | "size" | "content" | "other" }
  | {
      kind: "metadata";
      mode:
        | "any"
        | "access-time"
        | "write-time"
        | "permissions"
        | "ownership"
        | "extended"
        | "other";
    }
  | { kind: "rename"; mode: "any" | "to" | "from" | "both" | "other" }
  | { kind: "other" };

export type WatchEventKindRemove =
  | { kind: "any" }
  | { kind: "file" }
  | { kind: "folder" }
  | { kind: "other" };

export type WatchEventKind =
  | "any"
  | { access: WatchEventKindAccess }
  | { create: WatchEventKindCreate }
  | { modify: WatchEventKindModify }
  | { remove: WatchEventKindRemove }
  | "other";

export interface WatchEvent {
  type: WatchEventKind;
  paths: string[];
  attrs: unknown;
}

export type UnwatchFn = () => void;

/** Result of a move, mirroring the V1-09 section 6.5 response body. */
export interface FsMoveResult {
  source: string;
  target: string;
  kind: "file" | "folder";
  rewriteLinks: boolean;
  rewriteStatus: "complete" | "partial" | "skipped_only" | "disabled";
  revision: string | null;
  rewrittenFiles: Array<{
    path: string;
    oldRevision: string;
    newRevision: string;
    replacements: number;
  }>;
  skipped: Array<{ path: string; reason: string; detail: string }>;
  pending: Array<{ path: string; reason: string; detail: string }>;
  affectedCount: number;
  indexHookWarning: string | null;
}

/** Text read plus the revision guard data a later save needs. */
export interface FsTextFileResult {
  content: string;
  revision: string | null;
  version: number | null;
  size: number | null;
  modifiedAt: string | null;
}

/** Binary read plus the revision guard data a later save needs. */
export interface FsBinaryFileResult {
  data: Uint8Array;
  revision: string | null;
  version: number | null;
  size: number | null;
  modifiedAt: string | null;
}

export interface FsAdapter {
  exists(path: string | URL, options?: ExistsOptions): Promise<boolean>;
  mkdir(path: string | URL, options?: MkdirOptions): Promise<void>;
  readFile(
    path: string | URL,
    options?: ReadFileOptions,
  ): Promise<Uint8Array>;
  writeFile(
    path: string | URL,
    data: Uint8Array | ReadableStream<Uint8Array>,
    options?: WriteFileOptions,
  ): Promise<void>;
  readTextFile(path: string | URL, options?: ReadFileOptions): Promise<string>;
  writeTextFile(
    path: string | URL,
    data: string,
    options?: WriteFileOptions,
  ): Promise<void>;
  readDir(path: string | URL, options?: ReadDirOptions): Promise<DirEntry[]>;
  remove(path: string | URL, options?: RemoveOptions): Promise<void>;
  lstat(path: string | URL, options?: StatOptions): Promise<FileInfo>;
  stat(path: string | URL, options?: StatOptions): Promise<FileInfo>;
  copyFile(
    fromPath: string | URL,
    toPath: string | URL,
    options?: CopyFileOptions,
  ): Promise<void>;
  rename(
    oldPath: string | URL,
    newPath: string | URL,
    options?: RenameOptions,
  ): Promise<void>;
  open(path: string | URL, options?: OpenOptions): Promise<FsFileHandle>;
  watch(
    paths: string | string[] | URL | URL[],
    cb: (event: WatchEvent) => void,
    options?: DebouncedWatchOptions,
  ): Promise<UnwatchFn>;

  /**
   * Web extension. Read text plus revision data, for the guarded-save
   * flow in V1-09 section 3.9. The Tauri implementation returns the same
   * shape with revision/version null.
   */
  readTextFileDetailed(
    path: string | URL,
    options?: ReadFileOptions,
  ): Promise<FsTextFileResult>;

  /** Web extension. Binary counterpart of readTextFileDetailed. */
  readFileDetailed(
    path: string | URL,
    options?: ReadFileOptions,
  ): Promise<FsBinaryFileResult>;

  /**
   * Web extension. Move plus the link-rewrite report (V1-09 section
   * 6.5). Callers that need to report partial rewrites honestly must use
   * this; rename() keeps the void Tauri shape and discards the report.
   */
  renameWithResult(
    oldPath: string | URL,
    newPath: string | URL,
    options?: RenameOptions,
  ): Promise<FsMoveResult>;
}
