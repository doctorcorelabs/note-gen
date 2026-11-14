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
}
