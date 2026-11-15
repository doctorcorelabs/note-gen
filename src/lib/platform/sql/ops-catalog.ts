// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import type {
  KnowledgeIndexStatus,
  KnowledgeSource,
  KnowledgeSourceType,
} from "@/types/knowledge";
import type {
  WikiJob,
  WikiPage,
  WikiSegmentCache,
  WikiSourceRevision,
  WikiSourceState,
} from "@/types/wiki";
import type { CanvasDocument, CanvasProjectType } from "@/types/canvas";

/**
 * Typed SQL operation catalog (type level only).
 *
 * This file defines every typed operation that replaces raw `getDb()`
 * access (305 call sites on upstream HEAD 4dcaa3f, 53 files). It follows
 * fase1/desain-sql-adapter.md (V1-03), sections 3.3 and 3.4. It contains
 * types and constant data only: operation kinds, per-kind parameter and
 * result types, and per-kind metadata (wave, exposure, touched tables,
 * idempotency). It contains no execution implementation, no fake, no
 * backend endpoint, no schema, and no function.
 *
 * Rules carried from the design (AD-05, AD-08):
 *
 * - No operation carries raw SQL, a table name, or a column name from
 *   the client. There is no generic kind (`raw`, `query`, `exec`) and
 *   no `sql`, `table`, `columns`, `statement`, or `query` field on any
 *   operation. Each kind maps server-side to exactly one fixed Drizzle
 *   handler. The `touchedTables` metadata below describes that
 *   server-side mapping for audit; it is never part of an operation
 *   payload and must never be sent by a client.
 * - `workspace_id` is never an operation field. The web implementation
 *   takes the workspace from the authenticated session and route; the
 *   Tauri implementation has a single local database.
 * - Filters, ordering, and pagination use fixed sets only. A filter is
 *   part of the kind name, never a free string. Cursors are opaque
 *   server-issued tokens. The server clamps `limit` to 1..200 with a
 *   default of 50. Each list operation documents its fixed order.
 * - Read and write operations are disjoint sets. The read batch path
 *   rejects write kinds and the transaction path rejects read kinds.
 * - Times are epoch milliseconds, matching upstream `createdAt` /
 *   `updatedAt` conventions. Clients never see `timestamptz`.
 * - Embeddings are never returned to clients. Memory and vector rows in
 *   this catalog carry no embedding payload. The single write that
 *   carries embeddings (`vector.replaceChunks`) is server-only.
 * - Sync columns are gone (design 1.5): no `syncId`, no
 *   `syncUpdatedAt`, no sync tables, no snapshot-replace operations.
 *   The 20 deleted tables (design 1.4) have no kinds here.
 *
 * Row shapes mirror the upstream camelCase types in `src/db/` with the
 * fork deltas from design 1.1-1.5 applied: `deleted` is a boolean
 * derived from `deleted_at`, `version` appears on guarded tables,
 * JSON-string columns are exposed as parsed JSON values, and sync
 * fields are removed. Where a fork shape differs from its upstream
 * type, the comment on the type says so. Types that already live in
 * `src/types/` without fork changes (knowledge, wiki, canvas document)
 * are imported as types only; nothing in this file imports runtime
 * code, Tauri plugins, or HTTP.
 *
 * Wave labels follow design 3.4: W1 kinds are implemented in the Fase 1
 * implementation wave; W2 kinds have their contract fixed here while
 * the handler and consumer land in Fase 2. A W2 kind called by a client
 * on the MVP answers a typed UNAVAILABLE error naming the capability
 * and phase, never a silent failure (AD-07). Wave assignments that
 * required judgment beyond the per-row notes are called out in
 * fase1/laporan-sql-ops-catalog.md for coordinator confirmation.
 *
 * The SqlAdapter interface itself (`query`, `queryOne`, `queryMany`,
 * `execute`, `transaction`, `close`) lives in `interface.ts`, owned by
 * a later wave (V3-14). That file imports the operation types from
 * here; this file does not define the adapter.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** JSON value carried by `jsonb` columns and wiki meta payloads. */
export type SqlJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly SqlJsonValue[]
  | { readonly [key: string]: SqlJsonValue };

/**
 * Cursor pagination shared by list operations. `cursor` is an opaque
 * server-issued token (last id plus direction), never an expression.
 * The server clamps `limit` to 1..200 and defaults it to 50.
 */
export interface SqlPageParams {
  cursor?: string;
  limit?: number;
}

/** Deleted-state filter for mark listings. Defaults to `active`. */
export type SqlDeletedFilter = "active" | "deleted" | "all";

/**
 * Write result shape from design 3.2. `affected` counts rows written;
 * `id` identifies the row created or written; `version` is the new
 * version after a guarded write. The interface file aliases this shape
 * as `WriteResult`; this catalog keeps its own name so the two files
 * never define the same export twice.
 */
export interface SqlWriteResult {
  affected: number;
  id?: number | string;
  version?: number;
}

/**
 * Result of `wiki.commitRevision`. A guard miss returns `committed:
 * false` with a 200 status, matching the boolean contract of upstream
 * `commitWikiSourceRevision`, instead of throwing.
 */
export interface SqlWikiCommitResult extends SqlWriteResult {
  committed: boolean;
}

// ---------------------------------------------------------------------------
// Marks (upstream `src/db/marks.ts`, design M2)
// ---------------------------------------------------------------------------

/** Record types, from upstream `Mark.type` and design M2. */
export type SqlMarkType =
  | "scan"
  | "text"
  | "image"
  | "link"
  | "file"
  | "recording"
  | "todo";

/**
 * Mark row. Fork deltas from upstream `Mark`: `deleted` is a boolean
 * derived from `deleted_at` (upstream uses `0 | 1`); `tagIds` is always
 * present as the effective set from `mark_tags` (it always includes the
 * primary tag, sorted ascending, no duplicates); `version` and
 * `updatedAt` are added for optimistic guards (design 1.1). The
 * deletion timestamp itself is not exposed; trash listings read the
 * boolean only.
 */
export interface SqlMarkRow {
  id: number;
  tagId: number;
  tagIds: number[];
  tagUpdatedAt: number;
  type: SqlMarkType;
  content?: string;
  desc?: string;
  url: string;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
  version: number;
  sourceId?: string | null;
}

/** Input for `marks.create`, without server-assigned fields. */
export interface SqlNewMark {
  tagId: number;
  type: SqlMarkType;
  content?: string;
  desc?: string;
  url: string;
  /** Omitted when the server must mint a UUID (upstream `insertMark`). */
  sourceId?: string;
}

/**
 * Activity event supplied with `marks.create`. The handler writes one
 * `record` activity event in the same transaction. When omitted, the
 * server derives title and description from the mark (desc, content,
 * or url), exactly as upstream `insertMark` does. `source`,
 * `dedupeKey`, and `createdAt` are server-derived and not settable.
 */
export interface SqlMarkCreateActivity {
  title: string;
  description?: string | null;
}

/**
 * Patch for `marks.update`. Absent fields are preserved. A `null`
 * `content` or `desc` clears the field; other fields cannot be nulled.
 * `createdAt` is not patchable: upstream `updateMark` rewrote it from
 * the passed row, but the fork preserves creation time. Changing
 * `tagId` moves the primary tag under design 1.3 rule 3: additional
 * tags survive the move.
 */
export interface SqlMarkPatch {
  tagId?: number;
  type?: SqlMarkType;
  content?: string | null;
  desc?: string | null;
  url?: string;
}

// ---------------------------------------------------------------------------
// Tags (upstream `src/db/tags.ts`, design M2)
// ---------------------------------------------------------------------------

/**
 * Tag row. Fork deltas from upstream `Tag`: `isLocked`, `isPin`, and
 * `sortOrder` are required (the fork schema gives them NOT NULL
 * defaults). `total` counts non-deleted marks in the tag subtree and
 * is set by `tags.list` only; `tags.get` leaves it undefined.
 */
export interface SqlTagRow {
  id: number;
  name: string;
  isLocked: boolean;
  isPin: boolean;
  sortOrder: number;
  total?: number;
}

// ---------------------------------------------------------------------------
// Notes (upstream `src/db/notes.ts`, design M2)
// ---------------------------------------------------------------------------

/** Note row, verbatim from upstream `Note`. `count` stays text. */
export interface SqlNoteRow {
  id: number;
  tagId: number;
  content?: string;
  locale: string;
  count: string;
  createdAt: number;
}

/** Input for `notes.insert`. `createdAt` is server-assigned. */
export interface SqlNewNote {
  tagId: number;
  content?: string;
  locale: string;
  count: string;
}

// ---------------------------------------------------------------------------
// Activity (upstream `src/db/activity.ts`, design M2)
// ---------------------------------------------------------------------------

/** Activity sources, from upstream `ActivityEventSource`. */
export type SqlActivitySource = "record" | "chat" | "writing" | "canvas";

/** Activity event row, verbatim from upstream `ActivityEvent`. */
export interface SqlActivityEventRow {
  id: number;
  source: SqlActivitySource;
  title: string;
  description?: string | null;
  path?: string | null;
  tagId?: number | null;
  dedupeKey?: string | null;
  createdAt: number;
}

/**
 * Input for `activity.insert`, from upstream `InsertActivityEventInput`.
 * Writes use ON CONFLICT DO NOTHING on `dedupeKey`. `path` is a
 * workspace-relative path or display path, never an absolute path.
 */
export interface SqlNewActivityEvent {
  source: SqlActivitySource;
  title: string;
  description?: string | null;
  path?: string | null;
  tagId?: number | null;
  dedupeKey?: string | null;
  createdAt?: number;
}

// ---------------------------------------------------------------------------
// Conversations (upstream `src/db/conversations.ts`, design M3)
// ---------------------------------------------------------------------------

/**
 * Conversation row. Fork deltas from upstream `Conversation`:
 * `syncId` and `syncUpdatedAt` are removed (design 1.5) and `version`
 * is added for optimistic guards (design 1.1).
 */
export interface SqlConversationRow {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  isPinned: boolean;
  version: number;
}

/**
 * Patch for `conversations.update`. Covers upstream
 * `updateConversationTitle` and `toggleConversationPin` (the client
 * reads the current pin state and sends the desired value; there is no
 * toggle kind). `messageCount` and `updatedAt` are server-maintained
 * and not patchable.
 */
export interface SqlConversationPatch {
  title?: string;
  isPinned?: boolean;
}

// ---------------------------------------------------------------------------
// Messages (upstream `src/db/chats.ts`, design M3, table `chat_messages`)
// ---------------------------------------------------------------------------

/**
 * Message roles, from upstream `Chat.role`. Design assumption A4 notes
 * the role and type sets were not verified complete; this catalog
 * mirrors the upstream `Chat` type exactly and adds nothing.
 */
export type SqlChatRole = "system" | "user";

/** Message types, from upstream `ChatType`. See A4 note above. */
export type SqlChatType =
  | "chat"
  | "note"
  | "clipboard"
  | "clear"
  | "condensed"
  | "model_change";

/**
 * Quote payload stored in `quote_data`, shaped from the parse site in
 * `src/app/core/main/chat/chat-content.tsx` on HEAD 4dcaa3f.
 */
export interface SqlChatQuoteData {
  quote: string;
  fullContent: string;
  fileName: string;
  startLine: number;
  endLine: number;
  from: number;
  to: number;
  articlePath: string;
}

/**
 * Message row, derived from upstream `Chat`. Fork deltas: `syncId` and
 * `syncUpdatedAt` are removed (design 1.5); `condensedFrom` is not
 * carried (it appears only in sync code and is absent from design M3);
 * `originalTokenCount` and `originalMessageCount` are added (design M3
 * additive columns); JSON-string columns are exposed parsed:
 * `images` and `ragSources` are string arrays (evidenced by their
 * parse sites), while `imageAnalyses`, `attachments`,
 * `ragSourceDetails`, `agentHistory`, and `uiBlocks` are `SqlJsonValue`
 * because their element shapes are not locked by the design and this
 * catalog does not invent them. The interface and codemod waves lock
 * those element shapes from the consumers before S2.
 */
export interface SqlChatMessageRow {
  id: number;
  tagId?: number;
  conversationId?: number;
  content?: string;
  role: SqlChatRole;
  type: SqlChatType;
  image?: string;
  images?: string[];
  imageAnalyses?: SqlJsonValue;
  attachments?: SqlJsonValue;
  inserted: boolean;
  createdAt: number;
  ragSources?: string[];
  ragSourceDetails?: SqlJsonValue;
  agentHistory?: SqlJsonValue;
  uiBlocks?: SqlJsonValue;
  thinking?: string;
  quoteData?: SqlChatQuoteData;
  condensedContent?: string;
  condensedAt?: number;
  originalTokenCount?: number;
  originalMessageCount?: number;
}

/** Input for `messages.append`, without server-assigned fields. */
export type SqlNewChatMessage = Omit<SqlChatMessageRow, "id" | "createdAt">;

/**
 * Patch for `messages.update`. Absent fields are preserved, matching
 * the `coalesce` behavior of upstream `updateChat` for `uiBlocks`. This
 * single patch shape covers upstream `updateChat` (full row),
 * `updateChatAgentHistory`, `updateChatUiBlocks`,
 * `updateChatCondensedContent`, and `updateChatsInsertedById`.
 */
export type SqlChatMessagePatch = Partial<
  Omit<SqlChatMessageRow, "id" | "createdAt">
>;

// ---------------------------------------------------------------------------
// Conversation compactions (upstream `src/db/conversation-compactions.ts`)
// ---------------------------------------------------------------------------

/** Compaction row, verbatim from upstream `ConversationCompaction`. */
export interface SqlConversationCompactionRow {
  id: number;
  conversationId: number;
  summary: string;
  coveredThroughChatId: number;
  tailStartChatId?: number;
  sourceTokenCount: number;
  summaryTokenCount: number;
  model: string;
  promptVersion: number;
  retainedTurnCount: number;
  prunedToolResultCount: number;
  prunedToolTokenCount: number;
  revision: number;
  createdAt: number;
}

/**
 * Input for `compactions.insert`, from upstream
 * `NewConversationCompaction`. The server assigns `revision` (latest
 * plus one) and `createdAt`.
 */
export type SqlNewConversationCompaction = Omit<
  SqlConversationCompactionRow,
  "id" | "createdAt" | "revision"
>;

// ---------------------------------------------------------------------------
// Canvases (upstream `src/db/canvases.ts`, design M4)
// ---------------------------------------------------------------------------

/**
 * Canvas row, derived from upstream `CanvasProject`. Fork deltas:
 * undo/redo history is NOT stored (it stays in client memory, design
 * M4); `version` is added for the mandatory save guard; `deletedAt`
 * is a timestamp or null. `thumbnailRevision` is client-side only and
 * is not part of the row.
 */
export interface SqlCanvasRow {
  id: string;
  title: string;
  canvasType: CanvasProjectType;
  schemaVersion: number;
  document: CanvasDocument;
  thumbnailPath?: string | null;
  createdAt: number;
  updatedAt: number;
  pinnedAt?: number | null;
  deletedAt?: number | null;
  version: number;
}

/**
 * Input for `canvases.create`, from upstream `insertCanvasProject`.
 * `id` is a caller-generated UUID (design assumption A6);
 * `createdAt`, `updatedAt`, and `version` are server-assigned.
 */
export interface SqlNewCanvas {
  id: string;
  title: string;
  canvasType: CanvasProjectType;
  document?: CanvasDocument;
}

/**
 * Patch for `canvases.save`. Covers upstream `updateCanvasDocument`,
 * `renameCanvasProject`, `updateCanvasThumbnailPath`, and
 * `setCanvasPinnedAt` in one guarded write. At least one of
 * `document`, `title`, `thumbnailPath`, or `pinnedAt` must be present
 * (server validation). Absent fields are preserved; an explicit `null`
 * `thumbnailPath` or `pinnedAt` clears the field.
 */
export interface SqlCanvasPatch {
  document?: CanvasDocument;
  title?: string;
  thumbnailPath?: string | null;
  pinnedAt?: number | null;
}

// ---------------------------------------------------------------------------
// Knowledge index (upstream `src/db/knowledge.ts`, design M5)
// ---------------------------------------------------------------------------

/**
 * Knowledge stats: counts per source type crossed with index status,
 * from upstream `getKnowledgeIndexStats`. Every cell is present, with
 * zero for empty combinations.
 */
export type SqlKnowledgeIndexStats = Record<
  KnowledgeSourceType,
  Record<KnowledgeIndexStatus, number>
>;

/**
 * Status transition for `knowledge.updateStatus`, from upstream
 * `updateKnowledgeSourceIndexState` plus the optimistic guard of
 * design 4.5. Transitions follow the hash machine of design 1.7 and
 * are enforced by the service, not by the client.
 */
export interface SqlKnowledgeStatusUpdate {
  status: KnowledgeIndexStatus;
  indexedHash?: string | null;
  error?: string | null;
  expectedStatus?: KnowledgeIndexStatus;
}

// ---------------------------------------------------------------------------
// Vector index (upstream `src/db/vector.ts`, design M5, AD-10)
// ---------------------------------------------------------------------------

/**
 * Vector index summary. Fork shape from design 3.4: `(sourceType,
 * sourceId, updatedAt)`. Upstream `VectorIndexSummary` carries a
 * `filename` (`article:` / `record:` / `canvas:` plus id); the fork
 * splits it into typed columns and the service maps back for legacy
 * readers. No embedding is ever returned.
 */
export interface SqlVectorIndexSummary {
  sourceType: KnowledgeSourceType;
  sourceId: string;
  updatedAt: number;
}

/**
 * One chunk for `vector.replaceChunks` (server worker only, W2).
 * `embedding` is a JSON string array of numbers, exactly the upstream
 * format (AD-10). `embeddingModel` and `embeddingDimensions` are the
 * per-row columns added by design M5. `updatedAt` defaults to now.
 */
export interface SqlVectorChunkInput {
  chunkId: number;
  content: string;
  embedding: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  updatedAt?: number;
}

// ---------------------------------------------------------------------------
// Memories and policy (upstream `src/db/memories.ts`, `memory-policy.ts`)
// ---------------------------------------------------------------------------

/** Memory enums, verbatim from upstream `src/db/memories.ts`. */
export type SqlMemoryCategory = "preference" | "memory";
export type SqlMemoryKind = "preference" | "fact" | "experience" | "decision";
export type SqlMemoryScopeType = "global" | "workspace";
export type SqlMemoryApplyMode = "always" | "relevant";
export type SqlMemoryStatus = "active" | "pending" | "archived";
export type SqlMemoryOrigin = "manual" | "explicit_chat" | "auto_chat";
export type SqlMemoryIndexingStatus = "ready" | "pending" | "failed";
export type SqlMemorySensitivity = "normal" | "suspected_sensitive";

/**
 * Memory row, from upstream `Memory` minus the `embedding` payload,
 * which is never returned to clients (design 3.4). Embedding model,
 * dimensions, and indexing status are metadata and are returned.
 * `id` stays text: the upstream generator was not verified to be a
 * UUID (design assumption A5).
 */
export interface SqlMemoryRow {
  id: string;
  content: string;
  category: SqlMemoryCategory;
  kind: SqlMemoryKind;
  scopeType: SqlMemoryScopeType;
  scopeId?: string;
  applyMode: SqlMemoryApplyMode;
  status: SqlMemoryStatus;
  origin: SqlMemoryOrigin;
  confidence: number;
  conflictKey?: string;
  replacedId?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  indexingStatus: SqlMemoryIndexingStatus;
  sensitivity: SqlMemorySensitivity;
  accessCount: number;
  lastAccessedAt: number;
  lastRecallReason?: string;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Input for `memories.create`, from upstream `MemoryWriteInput`.
 * `embedding` is an optional JSON-string vector supplied by the
 * worker path; the MVP has no embedding worker, so callers omit it.
 */
export interface SqlMemoryWriteInput {
  content: string;
  embedding?: string;
  category?: SqlMemoryCategory;
  kind?: SqlMemoryKind;
  scopeType?: SqlMemoryScopeType;
  scopeId?: string;
  applyMode?: SqlMemoryApplyMode;
  status?: SqlMemoryStatus;
  origin?: SqlMemoryOrigin;
  confidence?: number;
  conflictKey?: string;
  sensitivity?: SqlMemorySensitivity;
}

/**
 * Input for `memories.update`, from upstream `MemoryUpdateInput`. All
 * fields optional; absent fields are preserved. Status transitions go
 * through this shape: archive, restore, and approve are status
 * updates, not separate kinds.
 */
export interface SqlMemoryUpdateInput {
  content?: string;
  category?: SqlMemoryCategory;
  kind?: SqlMemoryKind;
  scopeType?: SqlMemoryScopeType;
  scopeId?: string;
  applyMode?: SqlMemoryApplyMode;
  status?: SqlMemoryStatus;
  origin?: SqlMemoryOrigin;
  confidence?: number;
  conflictKey?: string;
  sensitivity?: SqlMemorySensitivity;
  embedding?: string;
}

/**
 * Memory stats, from upstream `getMemoryStats`. `total` counts active
 * plus pending; `preferences` and `memories` count active rows only,
 * split by kind.
 */
export interface SqlMemoryStats {
  total: number;
  preferences: number;
  memories: number;
  pending: number;
  archived: number;
  totalAccessCount: number;
}

/** Memory policy row, verbatim from upstream `MemoryPolicy`. */
export interface SqlMemoryPolicyRow {
  useMemories: boolean;
  generateMemories: boolean;
  excludeExternalContext: boolean;
  generationStartedAt: number;
  updatedAt: number;
}

/**
 * Input for `policy.put`. Partial update; absent fields are preserved
 * and `updatedAt` is server-assigned. Upstream `updateMemoryPolicy`
 * honored only `generateMemories` and forced the other flags true;
 * the fork stores what is sent.
 */
export interface SqlMemoryPolicyInput {
  useMemories?: boolean;
  generateMemories?: boolean;
  excludeExternalContext?: boolean;
  generationStartedAt?: number;
}

// ---------------------------------------------------------------------------
// Image analysis cache (upstream `src/db/image-analysis-cache.ts`)
// ---------------------------------------------------------------------------

/**
 * Image analysis cache row. Fork delta from upstream
 * `ImageAnalysisCacheEntry`: `expiresAt` is added (design M4). Expired
 * rows are treated as a miss by `imageCache.get` and never returned.
 */
export interface SqlImageAnalysisCacheRow {
  cacheKey: string;
  imageHash: string;
  queryHash: string;
  ocrText?: string;
  visualAnalysis?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  updatedAt: number;
  expiresAt?: number;
}

/**
 * Input for `imageCache.put`. `updatedAt` is server-assigned;
 * `expiresAt` defaults to the handler TTL policy when omitted.
 */
export interface SqlImageAnalysisCacheInput {
  cacheKey: string;
  imageHash: string;
  queryHash: string;
  ocrText?: string;
  visualAnalysis?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  expiresAt?: number;
}

// ---------------------------------------------------------------------------
// Operation kinds (design 3.4; arrays kept verbatim from the V2-24
// skeleton commit so kind membership never drifts silently)
// ---------------------------------------------------------------------------

/** Read operation kinds from V1-03 section 3.4. */
export const SQL_READ_OP_KINDS = [
  "marks.list",
  "marks.get",
  "marks.listByTag",
  "tags.list",
  "tags.get",
  "notes.latestByTag",
  "conversations.list",
  "conversations.get",
  "messages.listByConversation",
  "messages.listByTag",
  "messages.get",
  "compactions.listByConversation",
  "canvases.list",
  "canvases.get",
  "activity.list",
  "knowledge.listSources",
  "knowledge.getSource",
  "knowledge.stats",
  "vector.summaries",
  "wiki.getSourceState",
  "wiki.listSourceStates",
  "wiki.getRevision",
  "wiki.findRevisionByInputHash",
  "wiki.getActiveRevisions",
  "wiki.listPages",
  "wiki.getPage",
  "wiki.listJobs",
  "wiki.getSegment",
  "wiki.getMeta",
  "memories.list",
  "memories.get",
  "memories.stats",
  "policy.get",
  "imageCache.get",
] as const;

/** Write operation kinds from V1-03 section 3.4. */
export const SQL_WRITE_OP_KINDS = [
  "marks.create",
  "marks.update",
  "marks.softDelete",
  "marks.restore",
  "marks.deletePermanent",
  "marks.updateTags",
  "marks.saveTagIds",
  "tags.create",
  "tags.rename",
  "tags.reorder",
  "tags.delete",
  "notes.insert",
  "conversations.create",
  "conversations.update",
  "conversations.delete",
  "messages.append",
  "messages.update",
  "messages.delete",
  "compactions.insert",
  "canvases.create",
  "canvases.save",
  "canvases.softDelete",
  "canvases.restore",
  "activity.insert",
  "knowledge.upsertSource",
  "knowledge.updateStatus",
  "knowledge.removeSource",
  "vector.replaceChunks",
  "wiki.upsertSource",
  "wiki.commitRevision",
  "wiki.upsertPage",
  "wiki.upsertJob",
  "wiki.removeJob",
  "wiki.putSegment",
  "wiki.putMeta",
  "memories.create",
  "memories.update",
  "memories.delete",
  "policy.put",
  "imageCache.put",
] as const;

export type SqlReadOpKind = (typeof SQL_READ_OP_KINDS)[number];
export type SqlWriteOpKind = (typeof SQL_WRITE_OP_KINDS)[number];
export type SqlOpKind = SqlReadOpKind | SqlWriteOpKind;

/** All operation kinds, reads first, then writes. */
export const SQL_OP_KINDS: readonly SqlOpKind[] = [
  ...SQL_READ_OP_KINDS,
  ...SQL_WRITE_OP_KINDS,
];

// ---------------------------------------------------------------------------
// Read operations (design 3.3: discriminated union on `kind`)
// ---------------------------------------------------------------------------

/**
 * Typed read operations. Every member is a plain data object: a `kind`
 * discriminator plus validated scalar, enum, or nested-data fields.
 * No member carries SQL, a table name, a column name, or a workspace
 * identifier. List operations return rows in the fixed order stated
 * in their comment; `queryOne` returns the first row or null.
 */
export type DbReadOperation =
  // Marks. Order: createdAt descending. `marks.list` has no tag
  // filter: tag filtering lives only in `marks.listByTag`, so there
  // is exactly one way to filter by tag (design 3.3). Rows carry full
  // content; the 500-character truncation of upstream preview
  // functions is a presentation concern, not a catalog shape.
  | { kind: "marks.list"; deleted?: SqlDeletedFilter; cursor?: string; limit?: number }
  | { kind: "marks.get"; id: number }
  // Tag membership filter, including descendant tags and virtual
  // `tagPaths` rules, computed server-side over `mark_tags`
  // (upstream `getMarks` / `recordMatchesTag`).
  | { kind: "marks.listByTag"; tagId: number; deleted?: SqlDeletedFilter; cursor?: string; limit?: number }
  // Tags. Order: sortOrder, then id.
  | { kind: "tags.list" }
  | { kind: "tags.get"; id: number }
  // Newest note per tag (upstream `getNoteByTagId`).
  | { kind: "notes.latestByTag"; tagId: number }
  // Conversations. Order: pinned first, then updatedAt descending.
  | { kind: "conversations.list"; cursor?: string; limit?: number }
  | { kind: "conversations.get"; id: number }
  // Messages. `listByConversation` orders by id ascending with a
  // cursor over id; `listByTag` is the legacy path (upstream
  // `getChats`, ordered by createdAt) kept while callers remain.
  // `messages.get` reads one message by id (upstream `getChatById`,
  // kind 74 ratified by AD-44); `queryOne` returns the row or null.
  | { kind: "messages.listByConversation"; conversationId: number; cursor?: string; limit?: number }
  | { kind: "messages.listByTag"; tagId: number; cursor?: string; limit?: number }
  | { kind: "messages.get"; id: number }
  // Compactions. Order: revision descending.
  | { kind: "compactions.listByConversation"; conversationId: number; cursor?: string; limit?: number }
  // Canvases. Order: updatedAt descending. History stacks are never
  // returned (design M4).
  | { kind: "canvases.list"; includeDeleted?: boolean; cursor?: string; limit?: number }
  | { kind: "canvases.get"; id: string }
  // Activity. Order: createdAt descending, cursor over id. `source`
  // is an optional filter from the fixed `SqlActivitySource` enum.
  | { kind: "activity.list"; source?: SqlActivitySource; cursor?: string; limit?: number }
  // Knowledge. Order: updatedAt descending. Filters use fixed enums.
  | { kind: "knowledge.listSources"; sourceTypes?: KnowledgeSourceType[]; statuses?: KnowledgeIndexStatus[]; cursor?: string; limit?: number }
  | { kind: "knowledge.getSource"; sourceKey: string }
  | { kind: "knowledge.stats" }
  // Vector summaries only; embeddings are never returned.
  | { kind: "vector.summaries" }
  // Wiki. Payloads are the `src/types/wiki.ts` shapes stored as
  // `jsonb`. `contextId` is an opaque context key (design A13).
  | { kind: "wiki.getSourceState"; contextId: string; stableId: string }
  | { kind: "wiki.listSourceStates"; contextId: string }
  | { kind: "wiki.getRevision"; contextId: string; id: string }
  | { kind: "wiki.findRevisionByInputHash"; contextId: string; inputHash: string }
  | { kind: "wiki.getActiveRevisions"; contextId: string }
  | { kind: "wiki.listPages"; contextId: string }
  | { kind: "wiki.getPage"; contextId: string; id: string }
  | { kind: "wiki.listJobs"; contextId: string }
  | { kind: "wiki.getSegment"; contextId: string; key: string }
  // Meta values are untyped JSON at this level (upstream
  // `getWikiMeta<T>` is generic): callers narrow the result. Known
  // keys include `usage` (token totals), `dirty` (boolean), and
  // `dirty-version` (number).
  | { kind: "wiki.getMeta"; contextId: string; key: string }
  // Memories. Default listing is active plus pending (upstream
  // `getAllMemories` default); `status` narrows to one status and
  // `includeInactive` lifts the default filter. No embedding is
  // returned.
  | { kind: "memories.list"; status?: SqlMemoryStatus; category?: SqlMemoryCategory; includeInactive?: boolean; cursor?: string; limit?: number }
  | { kind: "memories.get"; id: string }
  | { kind: "memories.stats" }
  // Policy read returns defaults when no row exists yet (design 3.4).
  | { kind: "policy.get" }
  // Expired rows are treated as a miss and never returned.
  | { kind: "imageCache.get"; cacheKey: string };

// ---------------------------------------------------------------------------
// Write operations (design 3.3 and section 4)
// ---------------------------------------------------------------------------

/**
 * Typed write operations. Each member is executed by one fixed
 * server-side handler inside a transaction (`execute` runs a single
 * operation; `transaction` runs several all-or-nothing). Guards use
 * `expected` clauses stating the state the caller observed, never row
 * counts. No member carries SQL, a table name, a column name, a file
 * path, or a workspace identifier.
 */
export type DbWriteOperation =
  // Marks. One transaction: mark row, `mark_tags` rows, and one
  // activity event. `tagIds` defaults to `[mark.tagId]` when omitted;
  // the primary tag is always present in the stored set. A sent
  // `sourceId` that already exists returns the existing row
  // (first-write-wins idempotency of `insertExternalMark`).
  | { kind: "marks.create"; mark: SqlNewMark; tagIds?: number[]; activity?: SqlMarkCreateActivity }
  // Per-field update with an optional optimistic guard; a successful
  // write bumps `version`. Changing `tagId` moves the primary tag
  // under design 1.3 rule 3.
  | { kind: "marks.update"; id: number; patch: SqlMarkPatch; expected?: { version: number } }
  // Soft delete sets `deleted_at`; `mark_tags` rows are preserved so
  // restore returns the full tag set.
  | { kind: "marks.softDelete"; id: number }
  | { kind: "marks.restore"; id: number }
  // Permanent delete removes the row; `mark_tags` rows cascade. An
  // audit event is written in the same transaction.
  | { kind: "marks.deletePermanent"; id: number }
  // Full contract in design 4.4. `tagIds` is the desired set after
  // the operation, including the primary tag; unknown ids are
  // ignored unless the filtered set becomes empty (400). `newNames`
  // (max 10, each max 100 chars) are created in the same
  // transaction. `expected` activates the optimistic guard. The
  // primary tag never changes through this operation.
  | { kind: "marks.updateTags"; id: number; tagIds: number[]; newNames?: string[]; expected?: { tagIds: number[]; primaryTagId: number } }
  // Replaces the tag set; `tagIds: undefined` is a preserve no-op
  // (upstream `saveMarkTagIds`). `tagId` is the primary tag and is
  // always included in the stored set.
  | { kind: "marks.saveTagIds"; id: number; tagId: number; tagIds?: number[] }
  // Tags. `create` uses ON CONFLICT DO NOTHING on the per-workspace
  // name and returns the existing tag id when the name is taken.
  | { kind: "tags.create"; name: string }
  // Rename, including descendant path renames (upstream `updateTag`).
  // `isPin` and `sortOrder` apply to the renamed tag itself only.
  // The locked default tag cannot be renamed (handler rule).
  | { kind: "tags.rename"; id: number; name: string; isPin?: boolean; sortOrder?: number }
  | { kind: "tags.reorder"; order: Array<{ id: number; sortOrder: number }> }
  // Delete refuses when the tag is still in use and `reassignTo` is
  // absent (409 `tag_in_use` with the mark count). With `reassignTo`,
  // primaries move and the tag's `mark_tags` rows are removed in the
  // same transaction. Deleting a tag NEVER marks records deleted.
  | { kind: "tags.delete"; id: number; reassignTo?: number }
  // Pure insert, as upstream `insertNote`. No upsert and no unique
  // constraint on (workspace, tag): readers take the newest row.
  | { kind: "notes.insert"; note: SqlNewNote }
  // Conversations. `create` starts with messageCount 0. `delete`
  // removes the row; messages and compactions cascade, and an audit
  // event is written. There is no conversation soft delete.
  | { kind: "conversations.create"; title: string }
  | { kind: "conversations.update"; id: number; patch: SqlConversationPatch; expected?: { version: number } }
  | { kind: "conversations.delete"; id: number }
  // Messages. `append` is one transaction: insert the message, bump
  // the conversation messageCount, updatedAt, and version, with an
  // optional conversation-version guard. Unlike upstream
  // `insertChat`, append does NOT write an activity event; callers
  // that need one send `activity.insert` in the same transaction.
  | { kind: "messages.append"; message: SqlNewChatMessage; expectedConversationVersion?: number }
  // Patch update. `expectedAgentHistory`, when present, guards only
  // the agent-history field (upstream `updateChatAgentHistory`): a
  // mismatch writes nothing and reports `affected: 0` instead of
  // throwing. The handler invalidates compactions for the affected
  // conversation, as upstream `updateChat` does.
  | { kind: "messages.update"; id: number; patch: SqlChatMessagePatch; expectedAgentHistory?: SqlJsonValue | null }
  // Delete decrements the conversation messageCount in the same
  // transaction and invalidates compactions.
  | { kind: "messages.delete"; id: number }
  // Compaction insert. The server assigns the revision; duplicate
  // revisions per conversation are rejected by the service guard.
  | { kind: "compactions.insert"; compaction: SqlNewConversationCompaction }
  // Canvases. `save` requires the version guard; a guard miss
  // answers 409 plus the current snapshot. `force: true` overwrites
  // despite a stale version and is recorded in `audit_events` as a
  // force save.
  | { kind: "canvases.create"; canvas: SqlNewCanvas }
  | { kind: "canvases.save"; id: string; patch: SqlCanvasPatch; expected: { version: number }; force?: boolean }
  | { kind: "canvases.softDelete"; id: string }
  | { kind: "canvases.restore"; id: string }
  // Activity insert with dedupe-key conflict ignore (above).
  | { kind: "activity.insert"; event: SqlNewActivityEvent }
  // Knowledge. `upsertSource` applies the hash machine (design 1.7):
  // an unchanged contentHash on a ready source is a no-op; a changed
  // hash resets status to pending while keeping the old indexedHash.
  | { kind: "knowledge.upsertSource"; source: KnowledgeSource }
  | { kind: "knowledge.updateStatus"; sourceKey: string; update: SqlKnowledgeStatusUpdate }
  // Removes the source row only. Chunk cleanup is the index job's
  // work, not this operation's (design M5: no foreign key from
  // chunks to sources).
  | { kind: "knowledge.removeSource"; sourceKey: string }
  // SERVER ONLY (W2): chunk replacement for the server worker. Never
  // exposed to the web SqlAdapter and never called from a browser
  // client. Replaces ALL chunks of one source in one transaction;
  // an empty `chunks` array deletes all chunks of the source.
  | { kind: "vector.replaceChunks"; sourceType: KnowledgeSourceType; sourceId: string; chunks: SqlVectorChunkInput[] }
  // Wiki (W2 handlers). `upsertSource`, `commitRevision`, and
  // `upsertPage` also set the dirty flag in `wiki_meta` in the same
  // transaction. Markdown files are persisted through the file
  // adapter BEFORE the transaction, per the upstream "persist
  // Markdown first" order.
  | { kind: "wiki.upsertSource"; state: WikiSourceState }
  // Guard: current state exists, contentHash matches, status is not
  // deleted/excluded/unavailable, and `expectedVersion` (when given)
  // matches. A guard miss returns `committed: false`, never a throw.
  | { kind: "wiki.commitRevision"; revision: WikiSourceRevision; pages: WikiPage[]; expectedVersion?: number }
  | { kind: "wiki.upsertPage"; page: WikiPage }
  | { kind: "wiki.upsertJob"; job: WikiJob }
  // Guarded removal: with `expectedInputHash`, a mismatch is a
  // silent no-op (upstream `removeWikiJob`).
  | { kind: "wiki.removeJob"; contextId: string; id: string; expectedInputHash?: string }
  | { kind: "wiki.putSegment"; contextId: string; key: string; value: WikiSegmentCache }
  // Meta upsert. Key `dirty` with value `true` also advances the
  // `dirty-version` counter (upstream `dirtyStatement`).
  | { kind: "wiki.putMeta"; contextId: string; key: string; value: SqlJsonValue }
  // Memories (W2). `create` follows upstream `upsertMemory`: the
  // same normalized content in the same scope returns the existing
  // memory instead of inserting a duplicate. `delete` is a hard
  // delete (`permanentlyDeleteMemory`); archiving goes through
  // `memories.update` with `status: "archived"`, matching upstream
  // `deleteMemory`, which archives. Snapshot sync replacement has
  // no kind: the sync protocol is deleted (design 1.4).
  | { kind: "memories.create"; input: SqlMemoryWriteInput }
  | { kind: "memories.update"; id: string; updates: SqlMemoryUpdateInput }
  | { kind: "memories.delete"; id: string }
  | { kind: "policy.put"; policy: SqlMemoryPolicyInput }
  // Cache upsert keyed by (workspace, cacheKey), plus expiry.
  | { kind: "imageCache.put"; entry: SqlImageAnalysisCacheInput };

/** Any catalog operation, read or write. */
export type DbOperation = DbReadOperation | DbWriteOperation;

/** The operation object for one read kind. */
export type SqlReadOperationByKind<K extends SqlReadOpKind> = Extract<
  DbReadOperation,
  { kind: K }
>;

/** The operation object for one write kind. */
export type SqlWriteOperationByKind<K extends SqlWriteOpKind> = Extract<
  DbWriteOperation,
  { kind: K }
>;

// ---------------------------------------------------------------------------
// Result types by kind
// ---------------------------------------------------------------------------

/**
 * Row type per read kind. List and get kinds yield rows of this type:
 * `query` returns an array of them and `queryOne` returns one row or
 * null. The two stats kinds yield exactly one stats object
 * (`queryOne` semantics; `query` returns a one-element array).
 */
export interface SqlReadRowByKind {
  "marks.list": SqlMarkRow;
  "marks.get": SqlMarkRow;
  "marks.listByTag": SqlMarkRow;
  "tags.list": SqlTagRow;
  "tags.get": SqlTagRow;
  "notes.latestByTag": SqlNoteRow;
  "conversations.list": SqlConversationRow;
  "conversations.get": SqlConversationRow;
  "messages.listByConversation": SqlChatMessageRow;
  "messages.listByTag": SqlChatMessageRow;
  "messages.get": SqlChatMessageRow;
  "compactions.listByConversation": SqlConversationCompactionRow;
  "canvases.list": SqlCanvasRow;
  "canvases.get": SqlCanvasRow;
  "activity.list": SqlActivityEventRow;
  "knowledge.listSources": KnowledgeSource;
  "knowledge.getSource": KnowledgeSource;
  "knowledge.stats": SqlKnowledgeIndexStats;
  "vector.summaries": SqlVectorIndexSummary;
  "wiki.getSourceState": WikiSourceState;
  "wiki.listSourceStates": WikiSourceState;
  "wiki.getRevision": WikiSourceRevision;
  "wiki.findRevisionByInputHash": WikiSourceRevision;
  "wiki.getActiveRevisions": WikiSourceRevision;
  "wiki.listPages": WikiPage;
  "wiki.getPage": WikiPage;
  "wiki.listJobs": WikiJob;
  "wiki.getSegment": WikiSegmentCache;
  "wiki.getMeta": SqlJsonValue;
  "memories.list": SqlMemoryRow;
  "memories.get": SqlMemoryRow;
  "memories.stats": SqlMemoryStats;
  "policy.get": SqlMemoryPolicyRow;
  "imageCache.get": SqlImageAnalysisCacheRow;
}

/** Row type for one read kind. */
export type SqlReadRow<K extends SqlReadOpKind> = SqlReadRowByKind[K];

/**
 * Write result per write kind. Every write returns `SqlWriteResult`
 * except `wiki.commitRevision`, which additionally reports whether
 * the guarded commit landed.
 */
export interface SqlWriteResultByKind {
  "marks.create": SqlWriteResult;
  "marks.update": SqlWriteResult;
  "marks.softDelete": SqlWriteResult;
  "marks.restore": SqlWriteResult;
  "marks.deletePermanent": SqlWriteResult;
  "marks.updateTags": SqlWriteResult;
  "marks.saveTagIds": SqlWriteResult;
  "tags.create": SqlWriteResult;
  "tags.rename": SqlWriteResult;
  "tags.reorder": SqlWriteResult;
  "tags.delete": SqlWriteResult;
  "notes.insert": SqlWriteResult;
  "conversations.create": SqlWriteResult;
  "conversations.update": SqlWriteResult;
  "conversations.delete": SqlWriteResult;
  "messages.append": SqlWriteResult;
  "messages.update": SqlWriteResult;
  "messages.delete": SqlWriteResult;
  "compactions.insert": SqlWriteResult;
  "canvases.create": SqlWriteResult;
  "canvases.save": SqlWriteResult;
  "canvases.softDelete": SqlWriteResult;
  "canvases.restore": SqlWriteResult;
  "activity.insert": SqlWriteResult;
  "knowledge.upsertSource": SqlWriteResult;
  "knowledge.updateStatus": SqlWriteResult;
  "knowledge.removeSource": SqlWriteResult;
  "vector.replaceChunks": SqlWriteResult;
  "wiki.upsertSource": SqlWriteResult;
  "wiki.commitRevision": SqlWikiCommitResult;
  "wiki.upsertPage": SqlWriteResult;
  "wiki.upsertJob": SqlWriteResult;
  "wiki.removeJob": SqlWriteResult;
  "wiki.putSegment": SqlWriteResult;
  "wiki.putMeta": SqlWriteResult;
  "memories.create": SqlWriteResult;
  "memories.update": SqlWriteResult;
  "memories.delete": SqlWriteResult;
  "policy.put": SqlWriteResult;
  "imageCache.put": SqlWriteResult;
}

/** Write result for one write kind. */
export type SqlWriteResultFor<K extends SqlWriteOpKind> =
  SqlWriteResultByKind[K];

// ---------------------------------------------------------------------------
// Per-kind metadata: wave, exposure, touched tables, idempotency
// ---------------------------------------------------------------------------

/** Implementation wave from design 3.4 (see the file header). */
export type SqlOpWave = "W1" | "W2";

/**
 * Who may call the kind. `client` kinds are reachable through the
 * SqlAdapter; `server-only` kinds run inside the server worker and
 * are never exposed to browser clients.
 */
export type SqlOpExposure = "client" | "server-only";

/**
 * Replay behavior of one operation executed twice with identical
 * parameters, judged on observable domain state (rows and fields
 * callers read), ignoring `updatedAt` refreshes but counting version
 * bumps, guard failures, new rows, and counter changes as observable.
 * This is operation-level replay only: transaction-level replay
 * protection via the `Idempotency-Key` header (design 4.3 rule 6)
 * applies to all write batches regardless of this label.
 */
export type SqlOpIdempotency = "idempotent" | "conditional" | "not-idempotent";

/**
 * Tables a handler may read or write, using the Postgres snake_case
 * names from design 1.2 plus `audit_events` (design 4.3 rule 9).
 * "May" matters: a conditional write (guard miss, preserve no-op,
 * conflict ignore) may touch a subset. This list exists for audit
 * and for the server handler mapping; it is never sent by clients.
 */
export type SqlTouchedTable =
  | "tags"
  | "marks"
  | "mark_tags"
  | "notes"
  | "activity_events"
  | "conversations"
  | "chat_messages"
  | "conversation_compactions"
  | "canvases"
  | "image_analysis_cache"
  | "knowledge_sources"
  | "vector_chunks"
  | "wiki_sources"
  | "wiki_revisions"
  | "wiki_pages"
  | "wiki_jobs"
  | "wiki_segments"
  | "wiki_meta"
  | "memories"
  | "memory_jobs"
  | "memory_policies"
  | "audit_events";

/**
 * Audit metadata for one kind. `upstream` names the upstream function
 * or functions the kind replaces (or notes that the kind is new);
 * `note` carries wave or behavior remarks that do not fit the other
 * fields.
 */
export interface SqlOpMetadata {
  wave: SqlOpWave;
  exposure: SqlOpExposure;
  touchedTables: readonly SqlTouchedTable[];
  idempotency: SqlOpIdempotency;
  idempotencyNote: string;
  upstream: string;
  note?: string;
}

/**
 * Metadata for every kind, keyed exhaustively: adding a kind to the
 * arrays above without an entry here fails the typecheck. Reads are
 * idempotent by construction (no state change). Write notes state
 * the exact replay semantics; where the design fixes behavior
 * (sourceId first-write-wins, dedupe-key ignore, hash machine), the
 * note names it.
 */
export const SQL_OP_METADATA: Record<SqlOpKind, SqlOpMetadata> = {
  "marks.list": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["marks", "mark_tags"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getAllMarks",
  },
  "marks.get": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["marks", "mark_tags"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getMarkById",
  },
  "marks.listByTag": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["marks", "mark_tags", "tags"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getMarks / recordMatchesTag filter in JS",
  },
  "tags.list": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["tags", "marks", "mark_tags"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getTags",
  },
  "tags.get": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["tags"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "(new) single-tag read; upstream callers filter getTags",
    note: "No getTagById/getAllTags function exists on HEAD 4dcaa3f; the design 3.4 citation is loose.",
  },
  "notes.latestByTag": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["notes"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getNoteByTagId",
  },
  "conversations.list": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["conversations"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getAllConversations",
  },
  "conversations.get": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["conversations"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getConversation",
  },
  "messages.listByConversation": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["chat_messages"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getChatsByConversation",
  },
  "messages.listByTag": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["chat_messages"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getChats (legacy path)",
  },
  "messages.get": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["chat_messages"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getChatById",
    note: "Kind 74, ratified by AD-44 (AMD-O10-01); single-message read for callers that hold only a chat id.",
  },
  "compactions.listByConversation": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["conversation_compactions"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getLatestConversationCompaction (upstream exposes latest only; full list is new)",
  },
  "canvases.list": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["canvases"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getCanvasProjects",
  },
  "canvases.get": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["canvases"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getCanvasProject",
  },
  "activity.list": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["activity_events"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getAllActivityEvents",
  },
  "knowledge.listSources": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["knowledge_sources"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getKnowledgeSources",
  },
  "knowledge.getSource": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["knowledge_sources"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getKnowledgeSource",
  },
  "knowledge.stats": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["knowledge_sources"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getKnowledgeIndexStats",
  },
  "vector.summaries": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["vector_chunks"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getVectorIndexSummaries",
  },
  "wiki.getSourceState": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["wiki_sources"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getWikiSourceState",
  },
  "wiki.listSourceStates": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["wiki_sources"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "listWikiSourceStates",
  },
  "wiki.getRevision": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["wiki_revisions"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getWikiRevision",
  },
  "wiki.findRevisionByInputHash": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["wiki_revisions"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "findWikiRevision",
  },
  "wiki.getActiveRevisions": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["wiki_revisions", "wiki_sources"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getActiveWikiRevisions",
  },
  "wiki.listPages": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["wiki_pages"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "listWikiPages",
  },
  "wiki.getPage": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["wiki_pages"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getWikiPage",
  },
  "wiki.listJobs": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["wiki_jobs"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "listWikiJobs",
  },
  "wiki.getSegment": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["wiki_segments"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getWikiSegmentCache",
  },
  "wiki.getMeta": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["wiki_meta"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getWikiMeta",
  },
  "memories.list": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["memories"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getAllMemories / getMemoriesByCategory",
    note: "W1 for the reads needed by init steps 8-10; writes are W2.",
  },
  "memories.get": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["memories"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getMemoryById",
  },
  "memories.stats": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["memories"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getMemoryStats",
  },
  "policy.get": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["memory_policies"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getMemoryPolicy",
    note: "Read is W1 and returns defaults when no row exists; the write (policy.put) is W2.",
  },
  "imageCache.get": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["image_analysis_cache"],
    idempotency: "idempotent",
    idempotencyNote: "Read-only; no state change.",
    upstream: "getImageAnalysisCache",
  },
  "marks.create": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["marks", "mark_tags", "activity_events"],
    idempotency: "conditional",
    idempotencyNote:
      "Same sourceId returns the existing row (first-write-wins); without sourceId each execution creates a new row. Retries must use a transaction Idempotency-Key.",
    upstream: "insertMark + saveMarkTagIds + insertActivityEvent",
  },
  "marks.update": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["marks", "mark_tags"],
    idempotency: "not-idempotent",
    idempotencyNote:
      "Each execution bumps version, even with identical patch values; a guarded replay with a stale version fails 409.",
    upstream: "updateMark / updateMarkTag",
  },
  "marks.softDelete": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["marks"],
    idempotency: "idempotent",
    idempotencyNote:
      "Repeated execution leaves the same deleted state; mark_tags rows are preserved.",
    upstream: "delMark",
  },
  "marks.restore": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["marks"],
    idempotency: "idempotent",
    idempotencyNote:
      "Repeated execution leaves the same restored state with the full tag set.",
    upstream: "restoreMark",
  },
  "marks.deletePermanent": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["marks", "mark_tags", "audit_events"],
    idempotency: "not-idempotent",
    idempotencyNote:
      "A second execution finds no row; ids are never reused, so no duplicate can appear.",
    upstream: "delMarkForever",
  },
  "marks.updateTags": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["marks", "mark_tags", "tags"],
    idempotency: "conditional",
    idempotencyNote:
      "The same tag set re-applied yields the same set, but bumps version and tagUpdatedAt on every execution; a guarded replay with stale expected state fails 409.",
    upstream: "updateRecordTags via executeRecordTransaction",
  },
  "marks.saveTagIds": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["marks", "mark_tags"],
    idempotency: "conditional",
    idempotencyNote:
      "The same set re-applied yields the same set but refreshes tagUpdatedAt; undefined tagIds is a preserve no-op.",
    upstream: "saveMarkTagIds",
  },
  "tags.create": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["tags"],
    idempotency: "conditional",
    idempotencyNote:
      "The same name returns the existing tag (ON CONFLICT DO NOTHING); a different name creates a different tag.",
    upstream: "insertTag",
  },
  "tags.rename": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["tags"],
    idempotency: "idempotent",
    idempotencyNote:
      "Re-applying the same rename leaves the same names, pin, and order, including descendants.",
    upstream: "updateTag",
  },
  "tags.reorder": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["tags"],
    idempotency: "idempotent",
    idempotencyNote: "Re-applying the same order leaves the same sortOrder values.",
    upstream: "updateTagsOrder",
  },
  "tags.delete": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["tags", "mark_tags", "marks", "audit_events"],
    idempotency: "not-idempotent",
    idempotencyNote:
      "A second execution finds no tag; reassignment cannot be undone by replay.",
    upstream: "delTag (trash-record trigger behavior rejected by design)",
  },
  "notes.insert": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["notes"],
    idempotency: "not-idempotent",
    idempotencyNote:
      "Each execution inserts a new row; readers take the latest row per tag.",
    upstream: "insertNote",
  },
  "conversations.create": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["conversations"],
    idempotency: "not-idempotent",
    idempotencyNote: "Each execution creates a new conversation.",
    upstream: "createConversation",
  },
  "conversations.update": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["conversations"],
    idempotency: "not-idempotent",
    idempotencyNote:
      "Each execution bumps version; a guarded replay with a stale version fails 409.",
    upstream: "updateConversationTitle / toggleConversationPin",
  },
  "conversations.delete": {
    wave: "W1",
    exposure: "client",
    touchedTables: [
      "conversations",
      "chat_messages",
      "conversation_compactions",
      "memory_jobs",
      "audit_events",
    ],
    idempotency: "not-idempotent",
    idempotencyNote:
      "A second execution observes no conversation; cascaded rows are not recreated.",
    upstream: "deleteConversation",
  },
  "messages.append": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["chat_messages", "conversations"],
    idempotency: "not-idempotent",
    idempotencyNote:
      "Each execution appends a new message and bumps messageCount and version. Retries must use a transaction Idempotency-Key.",
    upstream: "insertChat (without its activity-event side effect)",
  },
  "messages.update": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["chat_messages", "conversation_compactions"],
    idempotency: "not-idempotent",
    idempotencyNote:
      "Re-applying the same patch rewrites the same values, but compaction invalidation is not reversible: a replay after new compactions were written can drop them.",
    upstream:
      "updateChat / updateChatAgentHistory / updateChatUiBlocks / updateChatCondensedContent / updateChatsInsertedById",
  },
  "messages.delete": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["chat_messages", "conversations", "conversation_compactions"],
    idempotency: "not-idempotent",
    idempotencyNote:
      "A second execution finds no message; messageCount is decremented once.",
    upstream: "deleteChat",
  },
  "compactions.insert": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["conversation_compactions"],
    idempotency: "not-idempotent",
    idempotencyNote:
      "Each execution assigns a fresh revision; duplicates are rejected by the service guard, not deduplicated.",
    upstream: "insertConversationCompaction",
  },
  "canvases.create": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["canvases"],
    idempotency: "conditional",
    idempotencyNote:
      "Re-creating with the same id conflicts on the primary key instead of duplicating; a new id creates a new canvas.",
    upstream: "insertCanvasProject",
  },
  "canvases.save": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["canvases", "audit_events"],
    idempotency: "conditional",
    idempotencyNote:
      "The same document re-saved with a fresh expected version succeeds; replaying with the original expected version fails 409 after the first save bumps the version. Force saves write audit_events.",
    upstream:
      "updateCanvasDocument / renameCanvasProject / updateCanvasThumbnailPath / setCanvasPinnedAt",
  },
  "canvases.softDelete": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["canvases"],
    idempotency: "conditional",
    idempotencyNote:
      "Repeated execution leaves the canvas deleted but refreshes the exposed deletedAt timestamp.",
    upstream: "softDeleteCanvasProject",
  },
  "canvases.restore": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["canvases"],
    idempotency: "conditional",
    idempotencyNote:
      "Repeated execution leaves the canvas restored; each execution refreshes updatedAt and clears deletedAt.",
    upstream: "restoreCanvasProject",
  },
  "activity.insert": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["activity_events"],
    idempotency: "conditional",
    idempotencyNote:
      "The same dedupeKey is ignored (ON CONFLICT DO NOTHING); without dedupeKey each execution inserts a new row.",
    upstream: "insertActivityEvent",
  },
  "knowledge.upsertSource": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["knowledge_sources"],
    idempotency: "conditional",
    idempotencyNote:
      "The same contentHash on a ready source is a no-op; a changed contentHash resets status to pending (hash machine, design 1.7).",
    upstream: "upsertKnowledgeSource / registerDocument",
  },
  "knowledge.updateStatus": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["knowledge_sources"],
    idempotency: "conditional",
    idempotencyNote:
      "A guarded replay after the transition fails 409; without a guard, re-applying the same status overwrites the same fields.",
    upstream: "updateKnowledgeSourceIndexState",
    note: "Transitions are worker-driven in Fase 2, but the handler contract is fixed in Fase 1 per the design 3.4 row (no W2 marker).",
  },
  "knowledge.removeSource": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["knowledge_sources"],
    idempotency: "idempotent",
    idempotencyNote:
      "Removing an absent source leaves the same state (affected 0). Chunk cleanup is a separate index-job concern.",
    upstream: "deleteKnowledgeSource",
  },
  "vector.replaceChunks": {
    wave: "W2",
    exposure: "server-only",
    touchedTables: ["vector_chunks"],
    idempotency: "idempotent",
    idempotencyNote:
      "Replacing the same chunk set yields the same chunks for the source (full replacement per source).",
    upstream: "replaceVectorDocumentsByFilename / replaceAllVectorDocuments",
    note: "Server worker only; never exposed to the web SqlAdapter. W2: handler and consumer land in Fase 2.",
  },
  "wiki.upsertSource": {
    wave: "W2",
    exposure: "client",
    touchedTables: ["wiki_sources", "wiki_meta"],
    idempotency: "conditional",
    idempotencyNote:
      "The same state re-applied overwrites the same payload, but the dirty flag bookkeeping in wiki_meta advances.",
    upstream: "upsertWikiSourceState",
    note: "W2: handler and consumer land in Fase 2 (wiki engine); MVP calls answer UNAVAILABLE.",
  },
  "wiki.commitRevision": {
    wave: "W2",
    exposure: "client",
    touchedTables: ["wiki_sources", "wiki_revisions", "wiki_pages", "wiki_meta"],
    idempotency: "conditional",
    idempotencyNote:
      "A replay with the same expectedVersion fails the guard (the version already advanced) and returns committed false; it never double-commits.",
    upstream: "commitWikiSourceRevision",
    note: "W2: handler and consumer land in Fase 2 (wiki engine); MVP calls answer UNAVAILABLE.",
  },
  "wiki.upsertPage": {
    wave: "W2",
    exposure: "client",
    touchedTables: ["wiki_pages", "wiki_meta"],
    idempotency: "conditional",
    idempotencyNote:
      "The same page re-applied overwrites the same payload, but the dirty flag bookkeeping in wiki_meta advances.",
    upstream: "upsertWikiPage",
    note: "W2: handler and consumer land in Fase 2 (wiki engine); MVP calls answer UNAVAILABLE.",
  },
  "wiki.upsertJob": {
    wave: "W2",
    exposure: "client",
    touchedTables: ["wiki_jobs"],
    idempotency: "idempotent",
    idempotencyNote: "The same job re-applied overwrites the same payload.",
    upstream: "upsertWikiJob",
    note: "W2: handler and consumer land in Fase 2 (wiki engine); MVP calls answer UNAVAILABLE.",
  },
  "wiki.removeJob": {
    wave: "W2",
    exposure: "client",
    touchedTables: ["wiki_jobs"],
    idempotency: "idempotent",
    idempotencyNote:
      "Removing twice observes no row the second time; guarded replays with a stale expectedInputHash are no-ops.",
    upstream: "removeWikiJob",
    note: "W2: handler and consumer land in Fase 2 (wiki engine); MVP calls answer UNAVAILABLE.",
  },
  "wiki.putSegment": {
    wave: "W2",
    exposure: "client",
    touchedTables: ["wiki_segments"],
    idempotency: "idempotent",
    idempotencyNote: "The same key and value re-applied overwrite the same payload.",
    upstream: "saveWikiSegmentCache",
    note: "W2: handler and consumer land in Fase 2 (wiki engine); MVP calls answer UNAVAILABLE.",
  },
  "wiki.putMeta": {
    wave: "W2",
    exposure: "client",
    touchedTables: ["wiki_meta"],
    idempotency: "conditional",
    idempotencyNote:
      "The same key and value re-applied overwrite the same value, except key 'dirty' with true, which also advances dirty-version.",
    upstream: "setWikiMeta",
    note: "W2: handler and consumer land in Fase 2 (wiki engine); MVP calls answer UNAVAILABLE.",
  },
  "memories.create": {
    wave: "W2",
    exposure: "client",
    touchedTables: ["memories"],
    idempotency: "conditional",
    idempotencyNote:
      "The same normalized content in the same scope returns the existing memory (upsertMemory dedupe); different content creates a new memory.",
    upstream: "upsertMemory",
  },
  "memories.update": {
    wave: "W2",
    exposure: "client",
    touchedTables: ["memories"],
    idempotency: "idempotent",
    idempotencyNote: "The same updates re-applied set the same values.",
    upstream: "updateMemory (plus archive/restore/approve via status)",
  },
  "memories.delete": {
    wave: "W2",
    exposure: "client",
    touchedTables: ["memories"],
    idempotency: "not-idempotent",
    idempotencyNote: "A second execution finds no memory.",
    upstream: "permanentlyDeleteMemory (deleteMemory archives; archiving uses memories.update)",
  },
  "policy.put": {
    wave: "W2",
    exposure: "client",
    touchedTables: ["memory_policies"],
    idempotency: "idempotent",
    idempotencyNote: "The same policy re-applied stores the same values.",
    upstream: "updateMemoryPolicy / replaceMemoryPolicy",
  },
  "imageCache.put": {
    wave: "W1",
    exposure: "client",
    touchedTables: ["image_analysis_cache"],
    idempotency: "idempotent",
    idempotencyNote:
      "The same entry re-applied overwrites the same cache row (upsert per cache key).",
    upstream: "saveImageAnalysisCache",
  },
};

// ---------------------------------------------------------------------------
// Exhaustiveness checks (type level only; a mismatch fails typecheck)
// ---------------------------------------------------------------------------

type SqlTypesEqual<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

type SqlAssertTrue<T extends true> = T;

type SqlReadKindsCheck = SqlAssertTrue<
  SqlTypesEqual<DbReadOperation["kind"], SqlReadOpKind>
>;
type SqlWriteKindsCheck = SqlAssertTrue<
  SqlTypesEqual<DbWriteOperation["kind"], SqlWriteOpKind>
>;
type SqlReadRowsCheck = SqlAssertTrue<
  SqlTypesEqual<keyof SqlReadRowByKind, SqlReadOpKind>
>;
type SqlWriteResultsCheck = SqlAssertTrue<
  SqlTypesEqual<keyof SqlWriteResultByKind, SqlWriteOpKind>
>;
type SqlKindsDisjointCheck = SqlAssertTrue<
  SqlTypesEqual<Extract<SqlReadOpKind, SqlWriteOpKind>, never>
>;

/**
 * Combined exhaustiveness proof: the read union, the write union, and
 * both result maps cover exactly the kinds in the arrays above, and
 * the read and write kind sets do not overlap. Referenced so the
 * checks above participate in typechecking.
 */
export type SqlCatalogExhaustivenessChecks =
  | SqlReadKindsCheck
  | SqlWriteKindsCheck
  | SqlReadRowsCheck
  | SqlWriteResultsCheck
  | SqlKindsDisjointCheck;
