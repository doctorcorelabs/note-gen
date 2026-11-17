// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// FOLD (F6, wave 4, 17 Nov 2026): the SQL mirror is folded into
// re-exports of the canonical surface; see the SQL section at the
// bottom of this file. The Store and Filesystem mirrors below
// remain scaffold-local until their own remapping lands.
//
// Scaffold-local mirrors of the platform adapter interfaces.
//
// STATUS (assumption A2, fase1/desain-pengujian.md section 0.4): at branch
// point a28fd02 the only files under src/lib/platform/ are detect.ts,
// errors.ts, poc-app-shim.ts, poc-store-shim.ts, and a registry skeleton
// that states interface definitions land with wave 2. No store, sql, or fs
// interface exists yet on THIS branch, so these shapes cannot be imported
// from src/lib/platform/* today. They mirror the designs instead:
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
// RECONCILIATION WITH V2-04 (branch web-registry-g0, commit 76e1660):
// the canonical shim interfaces now exist, and they do NOT match these
// mirrors. That is expected, not a defect to fix by deleting the mirrors:
// the canonical interfaces fix the narrow upstream shim surface, while
// these mirrors fix the observable workspace-level behavior the contract
// cases lock (link rewriting, trash, dot filtering, typed SQL operations).
// The per-adapter mapping, including which mirror members have no
// canonical counterpart, is recorded in tests/contract/README.md and in
// tests/contract/EXCEPTIONS.md entry E9. The integrator remaps the cases
// to the canonical interfaces plus the workspace layer; the mirrors stay
// until that remapping lands, so the suite keeps running in the meantime.
// Only PlatformCapabilityError is imported from src/lib/platform/errors.ts
// today, because it already exists; its real constructor signature differs
// from the sketch in the store design, see tests/contract/EXCEPTIONS.md
// entry E6.

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
// SQL (canonical surface; mirror folded at integration, F6 wave 4)
// ---------------------------------------------------------------------------

// The 30-kind scaffold mirror that used to live here (12 reads +
// 18 writes, with its own SqlAdapter, row shapes, and WriteResult)
// is folded: this section re-exports the canonical catalog surface
// (desain-sql-adapter section 3; reconciled-forms.ts verdict 2).
// The six ghost kinds (knowledge.registerSource, knowledge.
// claimSource, knowledge.completeSource, knowledge.failSource,
// knowledge.retrySource, vector.insertChunk) and the divergent
// member shapes died with the mirror; the knowledge status machine
// uses knowledge.upsertSource / knowledge.updateStatus /
// knowledge.removeSource, and chunk work uses vector.replaceChunks
// (server only). The two scaffold-owned constants stay at the top
// of this file (Kelas J): SQL_MAX_TRANSACTION_OPS and
// TAG_GUARD_CONFLICT_MESSAGE (the message itself is pinned by
// server/test/db-handlers-records-tags.spec.ts; the
// adapter-observable contract is the CONFLICT code plus the guard
// details, see CT-X6 in sql-cases.ts).
//
// The Store and Filesystem mirrors above are untouched by this
// fold; they still await their own remapping.

export { SqlAdapterError } from "../../src/lib/platform/sql/interface";
export type {
  SqlAdapter,
  SqlErrorCode,
  SqlHealth,
  SqlMode,
  SqlTransactionOptions,
  WriteResult,
} from "../../src/lib/platform/sql/interface";
export {
  SQL_OP_KINDS,
  SQL_READ_OP_KINDS,
  SQL_WRITE_OP_KINDS,
} from "../../src/lib/platform/sql/ops-catalog";
export type {
  DbOperation,
  DbReadOperation,
  DbWriteOperation,
  SqlCanvasPatch,
  SqlCanvasRow,
  SqlDeletedFilter,
  SqlKnowledgeIndexStats,
  SqlKnowledgeStatusUpdate,
  SqlMarkPatch,
  SqlMarkRow,
  SqlMarkType,
  SqlNewCanvas,
  SqlNewMark,
  SqlOpKind,
  SqlReadOpKind,
  SqlReadOperationByKind,
  SqlReadRow,
  SqlReadRowByKind,
  SqlTagRow,
  SqlVectorChunkInput,
  SqlVectorIndexSummary,
  SqlWikiCommitResult,
  SqlWriteOpKind,
  SqlWriteOperationByKind,
  SqlWriteResult,
  SqlWriteResultByKind,
  SqlWriteResultFor,
} from "../../src/lib/platform/sql/ops-catalog";
export type {
  KnowledgeIndexStatus,
  KnowledgeLocator,
  KnowledgeSource,
  KnowledgeSourceType,
} from "../../src/types/knowledge";
export type {
  WikiPage,
  WikiSourceReference,
  WikiSourceRevision,
  WikiSourceState,
  WikiSourceStatus,
} from "../../src/types/wiki";
export type {
  CanvasDocument,
  CanvasProjectType,
} from "../../src/types/canvas";
