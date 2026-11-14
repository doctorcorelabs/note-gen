// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// FsAdapter interface (V2-11 local definition).
//
// The canonical interface definitions for all adapters are owned by V2-04
// (registry G0). This file defines the FsAdapter shape locally from the
// V1-05 inventory so the web implementation and its contract tests can land
// without waiting for that merge. The integrator reconciles this definition
// with the V2-04 canonical interface; method names and signatures follow
// the upstream `@tauri-apps/plugin-fs` surface actually used by the
// codebase, verified by grep over the reference repo at HEAD 4dcaa3f.
//
// Included (V1-05 section 1.3): exists, mkdir, readFile, writeFile,
// readTextFile, writeTextFile, readDir, remove, lstat, stat, copyFile,
// rename, open, watch, plus the BaseDirectory enum, DirEntry, WatchEvent
// and WriteFileOptions types.
//
// Deliberately excluded, each verified to have zero import lines in src/:
// create, readTextFileLines, truncate, size, watchImmediate. If a later
// migration needs one of them, it is added here first, with a web
// implementation, before any call site uses it.
//
// Extensions beyond the Tauri surface, all marked as such below, exist
// because the workspace API contract (V1-09) needs revision guards and
// conflict payloads that the Tauri functions cannot express:
// expectedRevision/force on writes, readTextFileDetailed/readFileDetailed,
// renameWithResult, and the revision/version fields on FileInfo.

/**
 * Base directories, with the numeric values of the Tauri enum
 * (`@tauri-apps/api/path`). Only AppData is used anywhere in src/ (177
 * occurrences, no other value), but the full enum is redeclared so the
 * Tauri implementation and future call sites keep working unchanged.
 */
export const BaseDirectory = {
  Audio: 1,
  Cache: 2,
  Config: 3,
  Data: 4,
  LocalData: 5,
  Document: 6,
  Download: 7,
  Picture: 8,
  Public: 9,
  Video: 10,
  Resource: 11,
  Temp: 12,
  AppConfig: 13,
  AppData: 14,
  AppLocalData: 15,
  AppCache: 16,
  AppLog: 17,
  Desktop: 18,
  Executable: 19,
  Font: 20,
  Home: 21,
  Runtime: 22,
  Template: 23,
} as const;

export type BaseDirectory =
  (typeof BaseDirectory)[keyof typeof BaseDirectory];

/** Seek origins for FileHandle.seek, matching the Tauri SeekMode enum. */
export const SeekMode = {
  Start: 0,
  Current: 1,
  End: 2,
} as const;

export type SeekMode = (typeof SeekMode)[keyof typeof SeekMode];

/**
 * File metadata, matching the Tauri FileInfo shape. Fields the workspace
 * API cannot supply are null in web mode (atime, fileAttributes, dev,
 * ino, mode, nlink, uid, gid, rdev, blksize, blocks). isSymlink is always
 * false in web mode because the server never exposes symlinks.
 *
 * revision and version are web extensions (see the header note): the
 * revision string from the V1-09 contract and the index version counter.
 * Both are null for directories and for entries whose index row is
 * missing. The Tauri implementation may leave them undefined.
 */
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
  revision?: string | null;
  version?: number | null;
}

/** One directory entry, matching the Tauri DirEntry shape. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
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

/** A filesystem change event, matching the Tauri WatchEvent shape. */
export interface WatchEvent {
  type: WatchEventKind;
  paths: string[];
  attrs: unknown;
}

export type UnwatchFn = () => void;

export interface FsReadOptions {
  baseDir?: BaseDirectory;
}

export interface FsReadDirOptions {
  baseDir?: BaseDirectory;
}

export interface FsStatOptions {
  baseDir?: BaseDirectory;
}

export interface FsExistsOptions {
  baseDir?: BaseDirectory;
}

export interface FsMkdirOptions {
  mode?: number;
  recursive?: boolean;
  baseDir?: BaseDirectory;
}

export interface FsRemoveOptions {
  recursive?: boolean;
  baseDir?: BaseDirectory;
}

export interface FsRenameOptions {
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

export interface FsCopyFileOptions {
  fromPathBaseDir?: BaseDirectory;
  toPathBaseDir?: BaseDirectory;
}

export interface FsOpenOptions {
  read?: boolean;
  write?: boolean;
  append?: boolean;
  truncate?: boolean;
  create?: boolean;
  createNew?: boolean;
  mode?: number;
  baseDir?: BaseDirectory;
}

export interface FsWriteOptions {
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

export interface FsWatchOptions {
  recursive?: boolean;
  baseDir?: BaseDirectory;
  /**
   * Debounce delay in milliseconds for delivered events. The server
   * already debounces filesystem-watcher events; this option only adds
   * client-side debouncing when a caller explicitly asks for it.
   */
  delayMs?: number;
}

/**
 * A readable file handle. Only the read-only subset is implemented in web
 * mode: both verified call sites open with `{ read: true }` and use
 * stat/read/close. Writable handles throw a PlatformCapabilityError from
 * open(); callers that need to write must use writeFile/writeTextFile.
 */
export interface FileHandle {
  read(buffer: Uint8Array): Promise<number | null>;
  seek(offset: number, whence: SeekMode): Promise<number>;
  stat(): Promise<FileInfo>;
  truncate(len?: number): Promise<void>;
  write(data: Uint8Array): Promise<number>;
  close(): Promise<void>;
}

/** Conflict payload from V1-09 section 3.4, carried on FsAdapterError. */
export interface FsConflictPayload {
  path: string;
  serverRevision: string;
  serverVersion: number | null;
  serverModifiedAt: string;
  serverSize: number;
  currentPreview: string | null;
  previewTruncated: boolean;
  suggestedCopyPath: string | null;
  actions: string[];
  failedOperation?: "append" | "patch";
}

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

/**
 * Operational filesystem error. `code` is a stable string from the V1-09
 * error catalog (section 10) when the error came from the server, or one
 * of the client-side codes below when the adapter rejected the call
 * before any request or when the response was unusable: `invalid_path`
 * (same code the server uses), `directory_not_empty`, `network_error`,
 * `invalid_response`, `not_a_file`, `invalid_state`, `invalid_argument`,
 * `unknown`. Capability failures (a feature the web mode cannot provide
 * at all) use PlatformCapabilityError instead, never this class.
 */
export class FsAdapterError extends Error {
  readonly code: string;
  readonly status: number;
  readonly path?: string;
  readonly requestId?: string;
  readonly detail?: string;
  readonly conflict?: FsConflictPayload;
  readonly retryAfterSeconds?: number;
  readonly diskWritten?: boolean;

  constructor(opts: {
    code: string;
    status: number;
    message: string;
    path?: string;
    requestId?: string;
    detail?: string;
    conflict?: FsConflictPayload;
    retryAfterSeconds?: number;
    diskWritten?: boolean;
  }) {
    super(opts.message);
    this.name = "FsAdapterError";
    this.code = opts.code;
    this.status = opts.status;
    this.path = opts.path;
    this.requestId = opts.requestId;
    this.detail = opts.detail;
    this.conflict = opts.conflict;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.diskWritten = opts.diskWritten;
  }
}

export function isFsAdapterError(err: unknown): err is FsAdapterError {
  return err instanceof FsAdapterError;
}

/**
 * True for revision conflicts from either guard location: HTTP 412
 * `revision_conflict` (If-Match) or HTTP 409 `version_conflict`
 * (expectedRevision in a JSON body). Callers must treat both the same
 * way (V1-09 section 3.3); the web implementation normalizes both to
 * code `revision_conflict`, and this helper also accepts the raw
 * `version_conflict` code for errors produced elsewhere.
 */
export function isRevisionConflictError(err: unknown): boolean {
  return (
    isFsAdapterError(err) &&
    (err.code === "revision_conflict" || err.code === "version_conflict")
  );
}

export function isNotFoundError(err: unknown): boolean {
  return isFsAdapterError(err) && err.code === "not_found";
}

/**
 * Filesystem operations over the workspace. Method shapes follow the
 * Tauri plugin-fs functions so call sites migrate by changing only the
 * import source and the receiver. Paths keep the `{ path, baseDir }`
 * form; see fs.web.ts for how baseDir and virtual prefixes resolve in
 * web mode.
 */
export interface FsAdapter {
  exists(path: string | URL, options?: FsExistsOptions): Promise<boolean>;
  mkdir(path: string | URL, options?: FsMkdirOptions): Promise<void>;
  readFile(path: string | URL, options?: FsReadOptions): Promise<Uint8Array>;
  readTextFile(path: string | URL, options?: FsReadOptions): Promise<string>;
  writeFile(
    path: string | URL,
    data: Uint8Array,
    options?: FsWriteOptions,
  ): Promise<void>;
  writeTextFile(
    path: string | URL,
    data: string,
    options?: FsWriteOptions,
  ): Promise<void>;
  readDir(path: string | URL, options?: FsReadDirOptions): Promise<DirEntry[]>;
  remove(path: string | URL, options?: FsRemoveOptions): Promise<void>;
  stat(path: string | URL, options?: FsStatOptions): Promise<FileInfo>;
  lstat(path: string | URL, options?: FsStatOptions): Promise<FileInfo>;
  copyFile(
    fromPath: string | URL,
    toPath: string | URL,
    options?: FsCopyFileOptions,
  ): Promise<void>;
  rename(
    oldPath: string | URL,
    newPath: string | URL,
    options?: FsRenameOptions,
  ): Promise<void>;
  open(path: string | URL, options?: FsOpenOptions): Promise<FileHandle>;
  watch(
    paths: string | string[] | URL | URL[],
    cb: (event: WatchEvent) => void,
    options?: FsWatchOptions,
  ): Promise<UnwatchFn>;

  /**
   * Web extension. Read text plus revision data, for the guarded-save
   * flow in V1-09 section 3.9. The Tauri implementation returns the same
   * shape with revision/version null.
   */
  readTextFileDetailed(
    path: string | URL,
    options?: FsReadOptions,
  ): Promise<FsTextFileResult>;

  /** Web extension. Binary counterpart of readTextFileDetailed. */
  readFileDetailed(
    path: string | URL,
    options?: FsReadOptions,
  ): Promise<FsBinaryFileResult>;

  /**
   * Web extension. Move plus the link-rewrite report (V1-09 section
   * 6.5). Callers that need to report partial rewrites honestly must use
   * this; rename() keeps the void Tauri shape and discards the report.
   */
  renameWithResult(
    oldPath: string | URL,
    newPath: string | URL,
    options?: FsRenameOptions,
  ): Promise<FsMoveResult>;
}
