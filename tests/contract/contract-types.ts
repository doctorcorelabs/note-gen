// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Scaffold-local mirrors of the platform adapter interfaces.
//
// STATUS (assumption A2, fase1/desain-pengujian.md section 0.4): at branch
// point a28fd02 the only files under src/lib/platform/ are detect.ts,
// errors.ts, poc-app-shim.ts, poc-store-shim.ts, and a registry skeleton
// that states interface definitions land with wave 2. No store, sql, or fs
// interface exists yet, so these shapes cannot be imported from
// src/lib/platform/* today. They mirror the designs instead:
//
// - StoreAdapter / StoreHandle: fase1/desain-store-adapter.md section 3.3,
//   which mirrors IStore from @tauri-apps/plugin-store 2.3.0 plus a
//   read-only path field.
// - SqlAdapter and the typed operation catalog: fase1/desain-sql-adapter.md
//   section 3.2 to 3.4, subset only (see the operation unions below).
// - FsAdapter: fase1/desain-pengujian.md section 2.2 (C-FS-01 to C-FS-11)
//   plus the plugin-fs surface named in fase1/desain-workspace-api.md
//   (readDir, readTextFile, writeTextFile).
//
// When V2-04 lands the real interfaces in src/lib/platform/store/,
// src/lib/platform/sql/, and src/lib/platform/fs/, the integrator deletes
// the mirrored shapes here, imports the real ones, and adapts the fakes
// and cases to any name or signature differences. The mapping is recorded
// in tests/contract/README.md. Only PlatformCapabilityError is imported
// from src/lib/platform/errors.ts today, because it already exists; its
// real constructor signature differs from the sketch in the store design,
// see tests/contract/EXCEPTIONS.md entry E6.

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

// Upper bound for an external file write to become visible through the
// watcher path (C-FS-10, C-EV-01). Placeholder value: the design derives
// it from the 300 ms watcher debounce plus D3 reconciliation, which the
// scaffold did not re-verify from source (assumption A5). The fake
// delivers events synchronously, so any bound passes against the fake;
// the web implementation must meet the confirmed value.
export const WATCHER_MAX_LATENCY_MS = 1000;

// Maximum operations in one SqlAdapter transaction (CT-X5).
export const SQL_MAX_TRANSACTION_OPS = 50;

// Upstream guard-conflict message that old handlers recognize (CT-X6).
// Pinned verbatim; do not reword.
export const TAG_GUARD_CONFLICT_MESSAGE =
  "Record tags changed. Reopen the tag editor and try again.";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type StoreOptions = {
  autoSave?: boolean | number;
  serializeFnName?: string;
  deserializeFnName?: string;
  createNew?: boolean;
};

export type UnlistenFn = () => void;

export interface StoreAdapter {
  load(path: string, options?: StoreOptions): Promise<StoreHandle>;
  getStore(path: string): Promise<StoreHandle | null>;
  closeAll(): Promise<void>;
}

export interface StoreHandle {
  readonly path: string;
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  reset(): Promise<void>;
  keys(): Promise<string[]>;
  values<T>(): Promise<T[]>;
  entries<T>(): Promise<Array<[string, T]>>;
  length(): Promise<number>;
  reload(): Promise<void>;
  save(): Promise<void>;
  onKeyChange<T>(
    key: string,
    cb: (value: T | undefined) => void,
  ): Promise<UnlistenFn>;
  onChange<T>(
    cb: (key: string, value: T | undefined) => void,
  ): Promise<UnlistenFn>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export type FsEventType = "created" | "changed" | "deleted" | "moved";

export interface FsEvent {
  type: FsEventType;
  path: string;
  previousPath?: string;
  seq: number;
}

export interface RenameResult {
  // Markdown files whose link or image references were rewritten.
  rewrittenFiles: string[];
}

export interface FsAdapter {
  listDir(path: string, recursive?: boolean): Promise<DirEntry[]>;
  scanMarkdown(): Promise<string[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rename(
    oldPath: string,
    newPath: string,
    options?: { rewriteLinks?: boolean },
  ): Promise<RenameResult>;
  removeToTrash(path: string): Promise<void>;
  restoreFromTrash(path: string): Promise<void>;
  purgeFromTrash(path: string): Promise<void>;
  listTrash(): Promise<string[]>;
  // Returns null when the reference is not a local workspace media path
  // (absolute path, slash-led path, URL, or a reference escaping the root).
  resolveImage(markdownPath: string, imageRef: string): Promise<string | null>;
  onEvent(cb: (event: FsEvent) => void): Promise<UnlistenFn>;
}

// ---------------------------------------------------------------------------
// SQL (typed operations, subset of the MVP catalog)
// ---------------------------------------------------------------------------

export type KnowledgeSourceType = "article" | "record" | "canvas";

export type KnowledgeStatus = "pending" | "indexing" | "ready" | "failed";

export interface MarkRow {
  id: number;
  tagId: number;
  tagIds: number[];
  type: string;
  content: string | null;
  url: string | null;
  desc: string | null;
  sourceId: string | null;
  deleted: boolean;
  tagUpdatedAt: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface TagRow {
  id: number;
  name: string;
  isLocked: boolean;
  isPin: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeSourceRow {
  sourceType: KnowledgeSourceType;
  sourceId: string;
  title: string | null;
  contentHash: string;
  indexedHash: string | null;
  status: KnowledgeStatus;
  error: string | null;
  updatedAt: number;
}

export interface KnowledgeStatsRow {
  sourceType: string;
  status: string;
  count: number;
}

// Summaries never carry embeddings (CT-S6).
export interface VectorSummary {
  sourceType: string;
  sourceId: string;
  updatedAt: number;
}

export interface VectorChunkInput {
  chunkId: number;
  content: string;
  embedding: number[];
}

export interface CanvasRow {
  id: string;
  title: string;
  content: unknown;
  version: number;
  updatedAt: number;
}

export interface WikiSourceState {
  contextId: string;
  sourceId: string;
  version: number;
  dirty: boolean;
  contentHash: string;
}

export interface NewMarkInput {
  tagId: number;
  type: string;
  content?: string | null;
  url?: string | null;
  desc?: string | null;
  sourceId?: string | null;
}

export type DbReadOperation =
  | {
      kind: "marks.list";
      tagId?: number;
      includeDeleted?: boolean;
      limit?: number;
    }
  | { kind: "marks.get"; id: number }
  | { kind: "marks.listByTag"; tagId: number }
  | { kind: "tags.list" }
  | { kind: "tags.get"; id: number }
  | {
      kind: "knowledge.listSources";
      sourceTypes?: string[];
      statuses?: string[];
    }
  | {
      kind: "knowledge.getSource";
      sourceType: string;
      sourceId: string;
    }
  | { kind: "knowledge.stats" }
  | { kind: "vector.summaries" }
  | { kind: "canvases.list" }
  | { kind: "canvases.get"; id: string }
  | {
      kind: "wiki.getSourceState";
      contextId: string;
      sourceId: string;
    };

export type DbWriteOperation =
  | { kind: "marks.create"; mark: NewMarkInput; tagIds: number[] }
  | {
      kind: "marks.update";
      id: number;
      patch: Partial<NewMarkInput>;
      expectedVersion?: number;
    }
  | { kind: "marks.softDelete"; id: number }
  | { kind: "marks.restore"; id: number }
  | { kind: "marks.deletePermanent"; id: number }
  | {
      kind: "marks.updateTags";
      id: number;
      tagIds: number[];
      newNames?: string[];
      expected?: { tagIds: number[]; primaryTagId: number };
    }
  | { kind: "marks.saveTagIds"; id: number; tagIds?: number[] }
  | { kind: "tags.create"; name: string }
  | { kind: "tags.delete"; id: number; reassignTo?: number }
  | {
      kind: "knowledge.registerSource";
      sourceType: string;
      sourceId: string;
      contentHash: string;
      title?: string;
    }
  | {
      kind: "knowledge.claimSource";
      sourceType: string;
      sourceId: string;
    }
  | {
      kind: "knowledge.completeSource";
      sourceType: string;
      sourceId: string;
      chunks: VectorChunkInput[];
    }
  | {
      kind: "knowledge.failSource";
      sourceType: string;
      sourceId: string;
      error: string;
    }
  | {
      kind: "knowledge.retrySource";
      sourceType: string;
      sourceId: string;
    }
  | {
      kind: "vector.insertChunk";
      sourceType: string;
      sourceId: string;
      chunk: VectorChunkInput;
    }
  | {
      kind: "vector.replaceChunks";
      sourceType: string;
      sourceId: string;
      chunks: VectorChunkInput[];
    }
  | {
      kind: "canvases.save";
      id?: string;
      title: string;
      content: unknown;
      expectedVersion?: number;
      force?: boolean;
    }
  | {
      kind: "wiki.commitRevision";
      contextId: string;
      sourceId: string;
      expectedVersion: number;
      contentHash: string;
    };

export interface WriteResult {
  affected: number;
  id?: number | string;
  version?: number;
  // marks.create with an already-known sourceId: no new row was made.
  duplicate?: boolean;
  // wiki.commitRevision with a stale expectedVersion: no commit happened.
  committed?: boolean;
}

// The "fake" mode value is scaffold-only: it lets the in-memory fake
// identify itself in ready() without pretending to be a real backend.
// Production interfaces (V2-04) keep only "tauri" | "web"; the
// integrator removes "fake" from the production type and keeps it only
// on the fake class if the real SqlAdapter type does not allow it.
export interface SqlHealth {
  ok: boolean;
  mode: "tauri" | "web" | "fake";
  migrationsCurrent: boolean;
}

export interface SqlAdapter {
  readonly mode: "tauri" | "web" | "fake";
  ready(): Promise<SqlHealth>;
  query<T>(op: DbReadOperation): Promise<T[]>;
  queryOne<T>(op: DbReadOperation): Promise<T | null>;
  queryMany(ops: DbReadOperation[]): Promise<unknown[][]>;
  execute(op: DbWriteOperation): Promise<WriteResult>;
  transaction(
    ops: DbWriteOperation[],
    opts?: { idempotencyKey?: string },
  ): Promise<WriteResult[]>;
  close(): Promise<void>;
}
