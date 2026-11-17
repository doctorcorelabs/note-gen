// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Independent in-memory fake for the canonical SqlAdapter interface.
//
// The fake implements the canonical typed-operation surface
// (src/lib/platform/sql/ops-catalog.ts, 74 kinds) over plain Maps
// for the kinds the contract cases use. It never wraps the web or
// Tauri implementation, never runs SQL, never touches a database,
// and never touches the network. There is no persistence across
// processes.
//
// Behavior mirrors the server kind handlers
// (server/src/services/db/*.ts) for every implemented kind: unique
// constraints, tag semantics, the knowledge hash machine, canvas
// guards, transaction atomicity, optimistic guards, and
// idempotency. Cases that need a real Postgres catalog, HTTP auth,
// or a production bundle (CT-M, CT-T6, CT-S1 to CT-S4, CT-P, C-SQ-02,
// C-SQ-09) cannot run against this fake and are recorded as deferred
// in tests/contract/README.md. This fake therefore does NOT replace
// the Postgres contract required by fase1/desain-pengujian.md
// section 2.4 (R2); it proves the contract cases themselves are
// runnable and can detect violations.
//
// Fake-local decisions, each recorded here so the integrator can
// compare them with the real implementation:
// - The fake starts empty: no seeded "Idea" tag and no workspace.
//   Seeding is a server bootstrap concern, not adapter behavior.
// - Errors use the canonical SqlAdapterError taxonomy
//   (SqlErrorCode). FK-style rejections (unknown tag reference) use
//   VALIDATION with wireCode tag_not_found; guard conflicts use
//   CONFLICT; missing rows on write use NOT_FOUND. Error details
//   carry the wireCode the server would answer, so the web-column
//   shim (implementations/web-sql.ts) can rebuild the same wire
//   failure the real server sends.
// - Unknown operation kinds are rejected with VALIDATION; known
//   catalog kinds the fake does not implement answer UNAVAILABLE
//   (never fake success, never an empty list). Unknown FIELDS on an
//   operation are rejected with VALIDATION, matching the server
//   handlers and the web adapter.
// - Timestamps come from a monotonic in-fake clock so
//   "tagUpdatedAt rises" assertions are deterministic.
// - Idempotency keys never expire in the fake (CT-I3 is
//   server-level). The 50-operation transaction bound IS enforced
//   here (CT-X5, fake-only): the real web adapter chunks larger
//   calls at the transport, so the bound is not adapter-observable
//   on the web column; see EXCEPTIONS.md E13.
// - ready() reports mode "web" and migrationsCurrent true. SqlMode
//   has no "fake" value; the fake exercises the canonical surface
//   as the web column would, and no case asserts the mode value.
// - vector.replaceChunks and the wiki write kinds are implemented
//   here although the server answers 410 for them in Fase 1 (the
//   kind is server-only / Fase 2). Cases that need them are
//   fake-only; see EXCEPTIONS.md E14. Chunk validation (chunkId,
//   content, embedding as a JSON number array) is fake-local: no
//   server behavior exists to mirror yet.
// - The fake has no notes table, so tags.delete counts only mark
//   references for "in use". No case creates notes, so no case can
//   observe the difference; the Postgres column counts notes too.
// - The fake has no activity store: marks.create accepts the
//   activity payload and drops it. Activity rows are observable
//   only through activity.list, which no case uses.
// - Wiki commit semantics are fake-local (the server handler is a
//   410 stub): the guard needs an existing state whose contentHash
//   matches the revision source, a live status, and a matching
//   expectedVersion; a hit advances the version, records the
//   revision id, and sets contentHash to the revision outputHash.
//   The dirty-flag side effect on wiki_meta is not modeled.

import { randomUUID } from "node:crypto";
import { DEFAULT_CANVAS_DOCUMENT } from "../../src/types/canvas";
import type { CanvasDocument } from "../../src/types/canvas";
import {
  SQL_MAX_TRANSACTION_OPS,
  SQL_OP_KINDS,
  SQL_READ_OP_KINDS,
  SQL_WRITE_OP_KINDS,
  SqlAdapterError,
  TAG_GUARD_CONFLICT_MESSAGE,
} from "../contract/contract-types";
import type {
  DbReadOperation,
  DbWriteOperation,
  KnowledgeIndexStatus,
  KnowledgeSource,
  KnowledgeSourceType,
  SqlAdapter,
  SqlCanvasRow,
  SqlErrorCode,
  SqlHealth,
  SqlKnowledgeIndexStats,
  SqlMarkRow,
  SqlMarkType,
  SqlReadOpKind,
  SqlReadOperationByKind,
  SqlReadRow,
  SqlTagRow,
  SqlTransactionOptions,
  SqlVectorChunkInput,
  SqlVectorIndexSummary,
  SqlWikiCommitResult,
  SqlWriteOpKind,
  SqlWriteOperationByKind,
  SqlWriteResult,
  SqlWriteResultFor,
  WikiPage,
  WikiSourceState,
} from "../contract/contract-types";

const MARK_TYPES: ReadonlySet<string> = new Set([
  "scan",
  "text",
  "image",
  "link",
  "file",
  "recording",
  "todo",
]);

const KNOWLEDGE_TYPES: readonly KnowledgeSourceType[] = [
  "article",
  "record",
  "canvas",
];

const KNOWLEDGE_STATUSES: readonly KnowledgeIndexStatus[] = [
  "pending",
  "indexing",
  "ready",
  "failed",
];

// Server transition table (knowledge-update-status.ts).
const LEGAL_TRANSITIONS: Record<
  KnowledgeIndexStatus,
  readonly KnowledgeIndexStatus[]
> = {
  pending: ["pending", "indexing"],
  indexing: ["indexing", "ready", "failed", "pending"],
  ready: ["ready", "pending"],
  failed: ["failed", "pending"],
};

const CANVAS_TYPES: ReadonlySet<string> = new Set([
  "blank",
  "flowchart",
  "mindmap",
  "timeline",
  "quadrant",
  "kanban",
  "swot",
]);

const READ_KINDS = new Set<string>(SQL_READ_OP_KINDS);
const WRITE_KINDS = new Set<string>(SQL_WRITE_OP_KINDS);
const ALL_KINDS = new Set<string>(SQL_OP_KINDS);

// Kinds this fake implements. Every other catalog kind answers
// UNAVAILABLE; every non-catalog kind answers VALIDATION.
const IMPLEMENTED_READS: ReadonlySet<string> = new Set([
  "marks.list",
  "marks.get",
  "marks.listByTag",
  "tags.list",
  "tags.get",
  "knowledge.listSources",
  "knowledge.getSource",
  "knowledge.stats",
  "vector.summaries",
  "canvases.list",
  "canvases.get",
  "wiki.getSourceState",
  "wiki.listPages",
  "wiki.getPage",
]);

const IMPLEMENTED_WRITES: ReadonlySet<string> = new Set([
  "marks.create",
  "marks.update",
  "marks.softDelete",
  "marks.restore",
  "marks.deletePermanent",
  "marks.updateTags",
  "marks.saveTagIds",
  "tags.create",
  "tags.delete",
  "knowledge.upsertSource",
  "knowledge.updateStatus",
  "knowledge.removeSource",
  "vector.replaceChunks",
  "canvases.create",
  "canvases.save",
  "canvases.softDelete",
  "canvases.restore",
  "wiki.upsertSource",
  "wiki.commitRevision",
  "wiki.upsertPage",
]);

const WIKI_DEAD_STATUSES: ReadonlySet<string> = new Set([
  "deleted",
  "excluded",
  "unavailable",
]);

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const TAG_NAME_MAX_LENGTH = 100;

interface MarkInternal {
  id: number;
  tagId: number;
  type: string;
  content: string | null;
  url: string;
  desc: string | null;
  sourceId: string;
  deletedAt: number | null;
  tagUpdatedAt: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

interface ChunkInternal {
  chunkId: number;
  content: string;
  embedding: string;
  updatedAt: number;
}

type InternalWriteResult = SqlWriteResult & { committed?: boolean };

function fail(
  code: SqlErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new SqlAdapterError(code, message, {
    retryable: false,
    details: details ?? {},
  });
}

function validation(
  message: string,
  wireCode = "validation_failed",
  extra: Record<string, unknown> = {},
): never {
  return fail("VALIDATION", message, { wireCode, ...extra });
}

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function sameNumberSet(a: number[], b: number[]): boolean {
  const left = sortedUnique(a);
  const right = sortedUnique(b);
  return (
    left.length === right.length &&
    left.every((value, i) => value === right[i])
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      validation(`${label} has unknown field "${key}"`);
    }
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!isPositiveInteger(value)) {
    validation(`${field} must be a positive integer`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    validation(`${field} must be a string`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    validation(`${field} must be a non-empty string`);
  }
  return value;
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    validation(`${field} must be a UUID`);
  }
  return value;
}

// Normalize a tag name exactly like the server handler
// (tags-create.ts): trim, drop one leading `#`, trim each `/`
// segment, rejoin. Returns null when the name is empty after
// normalization or any segment is empty.
function normalizeTagName(value: string): string | null {
  const name = value
    .trim()
    .replace(/^#/, "")
    .split("/")
    .map((part) => part.trim())
    .join("/");
  if (name === "" || name.split("/").some((part) => part === "")) {
    return null;
  }
  return name;
}

function validateTagName(value: unknown): string {
  if (typeof value !== "string") {
    validation("name must be a string");
  }
  if (CONTROL_CHARS.test(value)) {
    validation("name must not contain control characters");
  }
  const normalized = normalizeTagName(value);
  if (normalized === null) {
    validation("name must have non-empty segments");
  }
  if (normalized.length > TAG_NAME_MAX_LENGTH) {
    validation(`name must be at most ${TAG_NAME_MAX_LENGTH} characters`);
  }
  return normalized;
}

function tagPathMatches(childName: string, baseName: string): boolean {
  return childName === baseName || childName.startsWith(`${baseName}/`);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    validation("limit must be a positive integer", "invalid_limit");
  }
  return Math.min(limit, 200);
}

function parseMarkCursor(cursor: string): { createdAtMs: number; id: number } {
  const match = /^(\d+):(\d+)$/.exec(cursor);
  if (match === null) {
    validation("cursor is not valid", "invalid_cursor");
  }
  const createdAtMs = Number(match[1]);
  const id = Number(match[2]);
  if (!Number.isSafeInteger(createdAtMs) || !Number.isSafeInteger(id)) {
    validation("cursor is not valid", "invalid_cursor");
  }
  return { createdAtMs, id };
}

function parseCanvasCursor(cursor: string): { updatedAtMs: number; id: string } {
  const separator = cursor.indexOf(":");
  if (separator <= 0) {
    validation("cursor is not valid", "invalid_cursor");
  }
  const updatedAtMs = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (!Number.isSafeInteger(updatedAtMs) || id === "") {
    validation("cursor is not valid", "invalid_cursor");
  }
  return { updatedAtMs, id };
}

function parseKnowledgeCursor(cursor: string): {
  updatedAtMs: number;
  sourceKey: string;
} {
  const separator = cursor.indexOf(":");
  if (separator <= 0) {
    validation("cursor is not valid", "invalid_cursor");
  }
  const updatedAtMs = Number(cursor.slice(0, separator));
  const sourceKey = cursor.slice(separator + 1);
  if (!Number.isSafeInteger(updatedAtMs) || sourceKey === "") {
    validation("cursor is not valid", "invalid_cursor");
  }
  return { updatedAtMs, sourceKey };
}

function chunkKey(sourceType: string, sourceId: string, chunkId: number): string {
  return `${sourceType}:${sourceId}:${chunkId}`;
}

function wikiStateKey(contextId: string, stableId: string): string {
  return `${contextId}:${stableId}`;
}

function wikiPageKey(contextId: string, id: string): string {
  return `${contextId}:${id}`;
}

export class FakeSqlAdapter implements SqlAdapter {
  readonly mode = "web" as const;

  private readonly tags = new Map<number, SqlTagRow>();
  private readonly marks = new Map<number, MarkInternal>();
  private readonly markTags = new Map<number, Set<number>>();
  private readonly knowledge = new Map<string, KnowledgeSource>();
  private readonly chunks = new Map<string, ChunkInternal>();
  private readonly canvases = new Map<string, SqlCanvasRow>();
  private readonly wikiStates = new Map<string, WikiSourceState>();
  private readonly wikiPages = new Map<string, WikiPage>();
  private readonly idempotency = new Map<
    string,
    { opsHash: string; results: InternalWriteResult[] }
  >();
  private nextTagId = 1;
  private nextMarkId = 1;
  private lastTick = 0;

  private tick(): number {
    const now = Date.now();
    this.lastTick = Math.max(now, this.lastTick + 1);
    return this.lastTick;
  }

  private snapshot(): unknown {
    return structuredClone({
      tags: this.tags,
      marks: this.marks,
      markTags: this.markTags,
      knowledge: this.knowledge,
      chunks: this.chunks,
      canvases: this.canvases,
      wikiStates: this.wikiStates,
      wikiPages: this.wikiPages,
      idempotency: this.idempotency,
      nextTagId: this.nextTagId,
      nextMarkId: this.nextMarkId,
      lastTick: this.lastTick,
    });
  }

  private restore(snapshotValue: unknown): void {
    const state = snapshotValue as {
      tags: Map<number, SqlTagRow>;
      marks: Map<number, MarkInternal>;
      markTags: Map<number, Set<number>>;
      knowledge: Map<string, KnowledgeSource>;
      chunks: Map<string, ChunkInternal>;
      canvases: Map<string, SqlCanvasRow>;
      wikiStates: Map<string, WikiSourceState>;
      wikiPages: Map<string, WikiPage>;
      idempotency: Map<
        string,
        { opsHash: string; results: InternalWriteResult[] }
      >;
      nextTagId: number;
      nextMarkId: number;
      lastTick: number;
    };
    const reload = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    };
    reload(this.tags, state.tags);
    reload(this.marks, state.marks);
    reload(this.markTags, state.markTags);
    reload(this.knowledge, state.knowledge);
    reload(this.chunks, state.chunks);
    reload(this.canvases, state.canvases);
    reload(this.wikiStates, state.wikiStates);
    reload(this.wikiPages, state.wikiPages);
    reload(this.idempotency, state.idempotency);
    this.nextTagId = state.nextTagId;
    this.nextMarkId = state.nextMarkId;
    this.lastTick = state.lastTick;
  }

  async ready(): Promise<SqlHealth> {
    return { ok: true, mode: "web", migrationsCurrent: true };
  }

  async query<K extends SqlReadOpKind>(
    op: SqlReadOperationByKind<K>,
  ): Promise<SqlReadRow<K>[]> {
    return this.applyRead(op) as SqlReadRow<K>[];
  }

  async queryOne<K extends SqlReadOpKind>(
    op: SqlReadOperationByKind<K>,
  ): Promise<SqlReadRow<K> | null> {
    const rows = await this.query(op);
    return rows.length === 0 ? null : rows[0];
  }

  async queryMany(ops: readonly DbReadOperation[]): Promise<unknown[][]> {
    for (const op of ops) {
      const kind = (op as { kind?: unknown } | null)?.kind;
      if (
        op === null ||
        typeof op !== "object" ||
        typeof kind !== "string" ||
        !READ_KINDS.has(kind)
      ) {
        validation(`Unknown read operation kind: ${String(kind)}`);
      }
      if (!IMPLEMENTED_READS.has(kind)) {
        fail("UNAVAILABLE", `Read kind is not implemented by the fake: ${kind}`, {
          wireCode: "capability_unavailable",
          capability: kind,
          phase: "fake",
        });
      }
    }
    const results: unknown[][] = [];
    for (const op of ops) {
      results.push(this.applyRead(op));
    }
    return results;
  }

  async execute<K extends SqlWriteOpKind>(
    op: SqlWriteOperationByKind<K>,
  ): Promise<SqlWriteResultFor<K>> {
    const results = await this.transaction([op]);
    return results[0] as SqlWriteResultFor<K>;
  }

  async transaction(
    ops: readonly DbWriteOperation[],
    opts?: SqlTransactionOptions,
  ): Promise<SqlWriteResult[]> {
    if (ops.length > SQL_MAX_TRANSACTION_OPS) {
      validation(
        `Transaction exceeds the maximum of ${SQL_MAX_TRANSACTION_OPS} operations`,
      );
    }
    const opsHash = stableStringify(ops);
    if (opts?.idempotencyKey !== undefined) {
      const stored = this.idempotency.get(opts.idempotencyKey);
      if (stored !== undefined) {
        if (stored.opsHash !== opsHash) {
          fail("CONFLICT", "Idempotency key was reused with a different request body", {
            wireCode: "idempotency_key_reused",
          });
        }
        return clone(stored.results);
      }
    }
    const before = this.snapshot();
    const results: InternalWriteResult[] = [];
    try {
      for (const op of ops) {
        results.push(this.applyWrite(op));
      }
    } catch (error) {
      this.restore(before);
      throw error;
    }
    if (opts?.idempotencyKey !== undefined) {
      this.idempotency.set(opts.idempotencyKey, {
        opsHash,
        results: clone(results),
      });
    }
    return results;
  }

  async close(): Promise<void> {
    // No connection is held; closing is a no-op.
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private toMarkRow(mark: MarkInternal): SqlMarkRow {
    return {
      id: mark.id,
      tagId: mark.tagId,
      tagIds: sortedUnique([
        mark.tagId,
        ...(this.markTags.get(mark.id) ?? new Set()),
      ]),
      tagUpdatedAt: mark.tagUpdatedAt,
      type: mark.type as SqlMarkType,
      ...(mark.content === null ? {} : { content: mark.content }),
      ...(mark.desc === null ? {} : { desc: mark.desc }),
      url: mark.url,
      deleted: mark.deletedAt !== null,
      createdAt: mark.createdAt,
      updatedAt: mark.updatedAt,
      version: mark.version,
      sourceId: mark.sourceId,
    };
  }

  private tagTotal(tagId: number): number {
    const base = this.tags.get(tagId);
    if (base === undefined) return 0;
    const subtree = new Set<number>();
    for (const tag of this.tags.values()) {
      if (tagPathMatches(tag.name, base.name)) {
        subtree.add(tag.id);
      }
    }
    let total = 0;
    for (const mark of this.marks.values()) {
      if (mark.deletedAt !== null) continue;
      // The stored set always includes the primary tag, so one
      // membership test covers primaries and extra tags alike.
      const set = this.markTags.get(mark.id) ?? new Set<number>();
      if ([...set].some((id) => subtree.has(id))) {
        total += 1;
      }
    }
    return total;
  }

  private listMarks(
    tagId: number | undefined,
    deleted: "active" | "deleted" | "all",
    cursor: string | undefined,
    limit: number | undefined,
  ): SqlMarkRow[] {
    const clamped = clampLimit(limit);
    const position = cursor === undefined ? null : parseMarkCursor(cursor);
    let descendantIds: Set<number> | null = null;
    if (tagId !== undefined) {
      const base = this.tags.get(tagId);
      descendantIds = new Set<number>();
      if (base !== undefined) {
        for (const tag of this.tags.values()) {
          if (tagPathMatches(tag.name, base.name)) {
            descendantIds.add(tag.id);
          }
        }
      }
    }
    const rows: SqlMarkRow[] = [];
    const ordered = [...this.marks.values()].sort(
      (a, b) => b.createdAt - a.createdAt || b.id - a.id,
    );
    for (const mark of ordered) {
      if (deleted === "active" && mark.deletedAt !== null) continue;
      if (deleted === "deleted" && mark.deletedAt === null) continue;
      if (position !== null) {
        if (mark.createdAt > position.createdAtMs) continue;
        if (
          mark.createdAt === position.createdAtMs &&
          mark.id >= position.id
        ) {
          continue;
        }
      }
      if (descendantIds !== null) {
        const set = this.markTags.get(mark.id) ?? new Set<number>();
        const members = new Set([...set, mark.tagId]);
        if (![...members].some((id) => descendantIds!.has(id))) continue;
      }
      rows.push(this.toMarkRow(mark));
    }
    return rows.slice(0, clamped);
  }

  private applyRead(op: DbReadOperation): unknown[] {
    if (op === null || typeof op !== "object") {
      validation("Read operation must be an object");
    }
    const kind = (op as { kind?: unknown }).kind;
    if (typeof kind !== "string" || !ALL_KINDS.has(kind)) {
      validation(`Unknown read operation kind: ${String(kind)}`);
    }
    if (WRITE_KINDS.has(kind)) {
      validation(`Write kind used as a read: ${kind}`, "invalid_operation");
    }
    if (!IMPLEMENTED_READS.has(kind)) {
      fail("UNAVAILABLE", `Read kind is not implemented by the fake: ${kind}`, {
        wireCode: "capability_unavailable",
        capability: kind,
        phase: "fake",
      });
    }
    switch (op.kind) {
      case "marks.list": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "deleted", "cursor", "limit"], "marks.list");
        if (
          op.deleted !== undefined &&
          op.deleted !== "active" &&
          op.deleted !== "deleted" &&
          op.deleted !== "all"
        ) {
          validation("deleted must be active, deleted, or all");
        }
        if (op.cursor !== undefined) requireString(op.cursor, "cursor");
        return this.listMarks(undefined, op.deleted ?? "active", op.cursor, op.limit);
      }
      case "marks.get": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id"], "marks.get");
        const id = requirePositiveInteger(op.id, "id");
        const mark = this.marks.get(id);
        return mark === undefined ? [] : [this.toMarkRow(mark)];
      }
      case "marks.listByTag": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "tagId", "deleted", "cursor", "limit"], "marks.listByTag");
        const tagId = requirePositiveInteger(op.tagId, "tagId");
        if (
          op.deleted !== undefined &&
          op.deleted !== "active" &&
          op.deleted !== "deleted" &&
          op.deleted !== "all"
        ) {
          validation("deleted must be active, deleted, or all");
        }
        if (op.cursor !== undefined) requireString(op.cursor, "cursor");
        return this.listMarks(tagId, op.deleted ?? "active", op.cursor, op.limit);
      }
      case "tags.list": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind"], "tags.list");
        return [...this.tags.values()]
          .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
          .map((tag) => ({ ...clone(tag), total: this.tagTotal(tag.id) }));
      }
      case "tags.get": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id"], "tags.get");
        const id = requirePositiveInteger(op.id, "id");
        const tag = this.tags.get(id);
        if (tag === undefined) return [];
        const { total: _dropped, ...row } = clone(tag);
        void _dropped;
        return [row];
      }
      case "knowledge.listSources": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "sourceTypes", "statuses", "cursor", "limit"], "knowledge.listSources");
        if (op.sourceTypes !== undefined) {
          if (
            !Array.isArray(op.sourceTypes) ||
            op.sourceTypes.some((type) => !KNOWLEDGE_TYPES.includes(type as KnowledgeSourceType))
          ) {
            validation("sourceTypes must be known knowledge source types");
          }
        }
        if (op.statuses !== undefined) {
          if (
            !Array.isArray(op.statuses) ||
            op.statuses.some((status) => !KNOWLEDGE_STATUSES.includes(status as KnowledgeIndexStatus))
          ) {
            validation("statuses must be known knowledge statuses");
          }
        }
        const clamped = clampLimit(op.limit);
        const position =
          op.cursor === undefined ? null : parseKnowledgeCursor(op.cursor);
        const rows = [...this.knowledge.values()]
          .filter(
            (row) =>
              (op.sourceTypes === undefined ||
                (op.sourceTypes as string[]).includes(row.sourceType)) &&
              (op.statuses === undefined ||
                (op.statuses as string[]).includes(row.status)),
          )
          .sort(
            (a, b) =>
              b.updatedAt - a.updatedAt || a.sourceKey.localeCompare(b.sourceKey),
          )
          .filter((row) => {
            if (position === null) return true;
            if (row.updatedAt > position.updatedAtMs) return false;
            if (row.updatedAt === position.updatedAtMs) {
              return row.sourceKey.localeCompare(position.sourceKey) > 0;
            }
            return true;
          });
        return rows.slice(0, clamped).map((row) => clone(row));
      }
      case "knowledge.getSource": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "sourceKey"], "knowledge.getSource");
        const sourceKey = requireNonEmptyString(op.sourceKey, "sourceKey");
        const row = this.knowledge.get(sourceKey);
        return row === undefined ? [] : [clone(row)];
      }
      case "knowledge.stats": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind"], "knowledge.stats");
        const stats: SqlKnowledgeIndexStats = {
          article: { pending: 0, indexing: 0, ready: 0, failed: 0 },
          record: { pending: 0, indexing: 0, ready: 0, failed: 0 },
          canvas: { pending: 0, indexing: 0, ready: 0, failed: 0 },
        };
        for (const row of this.knowledge.values()) {
          stats[row.sourceType][row.status] += 1;
        }
        return [stats];
      }
      case "vector.summaries": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind"], "vector.summaries");
        const latest = new Map<string, SqlVectorIndexSummary>();
        for (const [key, chunk] of this.chunks) {
          const parts = key.split(":");
          const sourceType = parts[0] as KnowledgeSourceType;
          const sourceId = parts.slice(1, -1).join(":");
          const summaryKey = `${sourceType}:${sourceId}`;
          const existing = latest.get(summaryKey);
          if (existing === undefined || chunk.updatedAt > existing.updatedAt) {
            latest.set(summaryKey, {
              sourceType,
              sourceId,
              updatedAt: chunk.updatedAt,
            });
          }
        }
        return [...latest.values()].sort((a, b) =>
          a.sourceType === b.sourceType
            ? a.sourceId.localeCompare(b.sourceId)
            : a.sourceType.localeCompare(b.sourceType),
        );
      }
      case "canvases.list": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "includeDeleted", "cursor", "limit"], "canvases.list");
        const clamped = clampLimit(op.limit);
        const position =
          op.cursor === undefined ? null : parseCanvasCursor(op.cursor);
        const rows = [...this.canvases.values()]
          .filter((row) => op.includeDeleted === true || row.deletedAt === null)
          .sort(
            (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
          )
          .filter((row) => {
            if (position === null) return true;
            if (row.updatedAt > position.updatedAtMs) return false;
            if (row.updatedAt === position.updatedAtMs) {
              return row.id.localeCompare(position.id) < 0;
            }
            return true;
          });
        return rows.slice(0, clamped).map((row) => clone(row));
      }
      case "canvases.get": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id"], "canvases.get");
        const id = requireUuid(op.id, "id");
        const row = this.canvases.get(id);
        return row === undefined ? [] : [clone(row)];
      }
      case "wiki.getSourceState": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "contextId", "stableId"], "wiki.getSourceState");
        const contextId = requireNonEmptyString(op.contextId, "contextId");
        const stableId = requireNonEmptyString(op.stableId, "stableId");
        const row = this.wikiStates.get(wikiStateKey(contextId, stableId));
        return row === undefined ? [] : [clone(row)];
      }
      case "wiki.listPages": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "contextId"], "wiki.listPages");
        const contextId = requireNonEmptyString(op.contextId, "contextId");
        return [...this.wikiPages.values()]
          .filter((page) => page.contextId === contextId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((page) => clone(page));
      }
      case "wiki.getPage": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "contextId", "id"], "wiki.getPage");
        const contextId = requireNonEmptyString(op.contextId, "contextId");
        const id = requireNonEmptyString(op.id, "id");
        const page = this.wikiPages.get(wikiPageKey(contextId, id));
        return page === undefined ? [] : [clone(page)];
      }
      default:
        return fail(
          "VALIDATION",
          `Unknown read operation kind: ${String((op as { kind?: unknown }).kind)}`,
        );
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  private requireMark(id: number): MarkInternal {
    const mark = this.marks.get(id);
    if (mark === undefined) {
      fail("NOT_FOUND", `Mark not found: ${id}`, { wireCode: "not_found" });
    }
    return mark as MarkInternal;
  }

  private requireTag(id: number): SqlTagRow {
    const tag = this.tags.get(id);
    if (tag === undefined) {
      fail("NOT_FOUND", `Tag not found: ${id}`, { wireCode: "not_found" });
    }
    return tag as SqlTagRow;
  }

  private tagMustExist(id: number): void {
    if (!this.tags.has(id)) {
      fail("VALIDATION", `Tag does not exist: ${id}`, {
        wireCode: "tag_not_found",
        tagId: id,
      });
    }
  }

  private createOrReuseTag(name: string): SqlTagRow {
    for (const tag of this.tags.values()) {
      if (tag.name === name) {
        return tag;
      }
    }
    const sortOrder =
      this.tags.size === 0
        ? 0
        : Math.max(...[...this.tags.values()].map((tag) => tag.sortOrder)) + 1;
    const tag: SqlTagRow = {
      id: this.nextTagId,
      name,
      isLocked: false,
      isPin: false,
      sortOrder,
    };
    this.nextTagId += 1;
    this.tags.set(tag.id, tag);
    return tag;
  }

  private validateChunk(chunk: SqlVectorChunkInput): void {
    if (
      chunk === null ||
      typeof chunk !== "object" ||
      !Number.isInteger(chunk.chunkId) ||
      chunk.chunkId < 0 ||
      typeof chunk.content !== "string" ||
      chunk.content === "" ||
      typeof chunk.embedding !== "string"
    ) {
      validation("Vector chunk is invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk.embedding);
    } catch {
      validation("Vector chunk embedding must be a JSON number array");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      validation("Vector chunk embedding must be a JSON number array");
    }
  }

  private validateChunks(chunks: SqlVectorChunkInput[]): void {
    const seen = new Set<number>();
    for (const chunk of chunks) {
      this.validateChunk(chunk);
      if (seen.has(chunk.chunkId)) {
        validation("Vector chunks contain a duplicate chunkId");
      }
      seen.add(chunk.chunkId);
    }
  }

  private deleteChunksFor(sourceType: string, sourceId: string): void {
    const prefix = `${sourceType}:${sourceId}:`;
    for (const key of [...this.chunks.keys()]) {
      if (key.startsWith(prefix)) {
        this.chunks.delete(key);
      }
    }
  }

  private applyWrite(op: DbWriteOperation): InternalWriteResult {
    if (op === null || typeof op !== "object") {
      validation("Write operation must be an object");
    }
    const kind = (op as { kind?: unknown }).kind;
    if (typeof kind !== "string" || !ALL_KINDS.has(kind)) {
      validation(`Unknown write operation kind: ${String(kind)}`);
    }
    if (READ_KINDS.has(kind)) {
      validation(`Read kind used as a write: ${kind}`, "invalid_operation");
    }
    if (!IMPLEMENTED_WRITES.has(kind)) {
      fail("UNAVAILABLE", `Write kind is not implemented by the fake: ${kind}`, {
        wireCode: "capability_unavailable",
        capability: kind,
        phase: "fake",
      });
    }
    switch (op.kind) {
      case "marks.create": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "mark", "tagIds", "activity"], "marks.create");
        const mark = op.mark as unknown;
        if (!isRecord(mark)) {
          validation("marks.create requires a mark payload");
        }
        checkKeys(mark, ["tagId", "type", "content", "desc", "url", "sourceId"], "marks.create mark");
        const tagId = requirePositiveInteger(mark.tagId, "mark.tagId");
        if (typeof mark.type !== "string" || !MARK_TYPES.has(mark.type)) {
          validation(`Unknown mark type: "${String(mark.type)}"`);
        }
        if (mark.content !== undefined && typeof mark.content !== "string") {
          validation("mark.content must be a string");
        }
        if (mark.desc !== undefined && typeof mark.desc !== "string") {
          validation("mark.desc must be a string");
        }
        const url = requireString(mark.url, "mark.url");
        if (
          mark.sourceId !== undefined &&
          (typeof mark.sourceId !== "string" || mark.sourceId === "")
        ) {
          validation("mark.sourceId must be a non-empty string");
        }
        if (op.activity !== undefined) {
          if (!isRecord(op.activity)) {
            validation("activity must be an object");
          }
          checkKeys(op.activity as Record<string, unknown>, ["title", "description"], "marks.create activity");
          requireNonEmptyString(
            (op.activity as Record<string, unknown>).title,
            "activity.title",
          );
        }
        const tagIds = op.tagIds ?? [];
        if (
          !Array.isArray(tagIds) ||
          tagIds.some((id) => !Number.isInteger(id))
        ) {
          validation("tagIds must be an array of integers");
        }
        const effective = sortedUnique([tagId, ...tagIds]);
        for (const id of effective) {
          this.tagMustExist(id);
        }
        if (mark.sourceId !== undefined) {
          for (const existing of this.marks.values()) {
            if (existing.sourceId === mark.sourceId) {
              return {
                affected: 0,
                id: existing.id,
                version: existing.version,
              };
            }
          }
        }
        const now = this.tick();
        const id = this.nextMarkId;
        this.nextMarkId += 1;
        const created: MarkInternal = {
          id,
          tagId,
          type: mark.type,
          content: (mark.content as string | undefined) ?? null,
          url,
          desc: (mark.desc as string | undefined) ?? null,
          sourceId: (mark.sourceId as string | undefined) ?? randomUUID(),
          deletedAt: null,
          tagUpdatedAt: now,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.marks.set(id, created);
        this.markTags.set(id, new Set(effective));
        return { affected: 1, id, version: 1 };
      }
      case "marks.update": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id", "patch", "expected"], "marks.update");
        const id = requirePositiveInteger(op.id, "id");
        const mark = this.requireMark(id);
        if (mark.deletedAt !== null) {
          fail("NOT_FOUND", `Mark not found: ${id}`, { wireCode: "not_found" });
        }
        const patch = op.patch as unknown;
        if (!isRecord(patch)) {
          validation("marks.update requires a patch payload");
        }
        checkKeys(patch, ["tagId", "type", "content", "desc", "url"], "marks.update patch");
        if (patch.tagId !== undefined) {
          requirePositiveInteger(patch.tagId, "patch.tagId");
        }
        if (patch.type !== undefined) {
          if (typeof patch.type !== "string" || !MARK_TYPES.has(patch.type)) {
            validation(`Unknown mark type: "${String(patch.type)}"`);
          }
        }
        if (
          patch.content !== undefined &&
          patch.content !== null &&
          typeof patch.content !== "string"
        ) {
          validation("patch.content must be a string or null");
        }
        if (
          patch.desc !== undefined &&
          patch.desc !== null &&
          typeof patch.desc !== "string"
        ) {
          validation("patch.desc must be a string or null");
        }
        if (patch.url !== undefined && typeof patch.url !== "string") {
          validation("patch.url must be a string");
        }
        if (op.expected !== undefined) {
          if (!isRecord(op.expected)) {
            validation("expected must be an object");
          }
          checkKeys(op.expected as Record<string, unknown>, ["version"], "marks.update expected");
          const expectedVersion = (op.expected as Record<string, unknown>).version;
          if (
            typeof expectedVersion !== "number" ||
            !Number.isInteger(expectedVersion)
          ) {
            validation("expected.version must be an integer");
          }
          if (expectedVersion !== mark.version) {
            fail("CONFLICT", "Mark version is stale", {
              wireCode: "revision_conflict",
              currentVersion: mark.version,
            });
          }
        }
        const movesPrimary =
          patch.tagId !== undefined && patch.tagId !== mark.tagId;
        if (movesPrimary) {
          this.tagMustExist(patch.tagId as number);
        }
        const hasChange =
          patch.tagId !== undefined ||
          patch.type !== undefined ||
          patch.content !== undefined ||
          patch.desc !== undefined ||
          patch.url !== undefined;
        if (!hasChange) {
          return { affected: 0, id: mark.id, version: mark.version };
        }
        const now = this.tick();
        if (movesPrimary) {
          mark.tagId = patch.tagId as number;
          const set = this.markTags.get(mark.id) ?? new Set<number>();
          set.add(patch.tagId as number);
          this.markTags.set(mark.id, set);
          mark.tagUpdatedAt = now;
        }
        if (patch.type !== undefined) mark.type = patch.type as string;
        if (patch.content !== undefined) {
          mark.content = patch.content as string | null;
        }
        if (patch.desc !== undefined) mark.desc = patch.desc as string | null;
        if (patch.url !== undefined) mark.url = patch.url as string;
        mark.version += 1;
        mark.updatedAt = now;
        return { affected: 1, id: mark.id, version: mark.version };
      }
      case "marks.softDelete": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id"], "marks.softDelete");
        const mark = this.requireMark(requirePositiveInteger(op.id, "id"));
        if (mark.deletedAt !== null) {
          return { affected: 0, id: mark.id, version: mark.version };
        }
        const now = this.tick();
        mark.deletedAt = now;
        mark.version += 1;
        mark.updatedAt = now;
        return { affected: 1, id: mark.id, version: mark.version };
      }
      case "marks.restore": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id"], "marks.restore");
        const mark = this.requireMark(requirePositiveInteger(op.id, "id"));
        if (mark.deletedAt === null) {
          return { affected: 0, id: mark.id, version: mark.version };
        }
        const now = this.tick();
        mark.deletedAt = null;
        mark.version += 1;
        mark.updatedAt = now;
        return { affected: 1, id: mark.id, version: mark.version };
      }
      case "marks.deletePermanent": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id"], "marks.deletePermanent");
        const id = requirePositiveInteger(op.id, "id");
        this.requireMark(id);
        this.marks.delete(id);
        this.markTags.delete(id);
        return { affected: 1, id };
      }
      case "marks.updateTags": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id", "tagIds", "newNames", "expected"], "marks.updateTags");
        const id = requirePositiveInteger(op.id, "id");
        const mark = this.requireMark(id);
        if (
          !Array.isArray(op.tagIds) ||
          op.tagIds.some((tagId) => !Number.isInteger(tagId))
        ) {
          validation("tagIds must be an array of integers");
        }
        if (op.newNames !== undefined) {
          if (
            !Array.isArray(op.newNames) ||
            op.newNames.some((name) => typeof name !== "string")
          ) {
            validation("newNames must be an array of strings");
          }
          if (op.newNames.length > 10) {
            validation("newNames must contain at most 10 names");
          }
        }
        if (op.expected !== undefined) {
          if (!isRecord(op.expected)) {
            validation("expected must be an object");
          }
          checkKeys(op.expected as Record<string, unknown>, ["tagIds", "primaryTagId"], "marks.updateTags expected");
          const expectedTagIds = (op.expected as Record<string, unknown>).tagIds;
          const expectedPrimary = (op.expected as Record<string, unknown>).primaryTagId;
          if (
            !Array.isArray(expectedTagIds) ||
            expectedTagIds.some((tagId) => !Number.isInteger(tagId)) ||
            !isPositiveInteger(expectedPrimary)
          ) {
            validation("expected must carry tagIds and primaryTagId");
          }
          const current = sortedUnique([
            ...(this.markTags.get(mark.id) ?? new Set()),
          ]);
          if (
            !sameNumberSet(current, expectedTagIds as number[]) ||
            mark.tagId !== expectedPrimary
          ) {
            fail("CONFLICT", TAG_GUARD_CONFLICT_MESSAGE, {
              wireCode: "record_tags_changed",
              currentTagIds: current,
              currentPrimaryTagId: mark.tagId,
              currentVersion: mark.version,
            });
          }
        }
        const filtered = sortedUnique(
          (op.tagIds as number[]).filter((tagId) => this.tags.has(tagId)),
        );
        const wantedNames: string[] = [];
        for (const raw of op.newNames ?? []) {
          const normalized = normalizeTagName(raw);
          if (normalized !== null && !wantedNames.includes(normalized)) {
            wantedNames.push(normalized);
          }
        }
        const newTagIds = wantedNames.map(
          (name) => this.createOrReuseTag(name).id,
        );
        if (filtered.length === 0 && newTagIds.length === 0) {
          validation("tagIds must name at least one existing tag");
        }
        const next = sortedUnique([...filtered, ...newTagIds, mark.tagId]);
        this.markTags.set(mark.id, new Set(next));
        const now = this.tick();
        mark.tagUpdatedAt = now;
        mark.version += 1;
        mark.updatedAt = now;
        return { affected: 1, id: mark.id, version: mark.version };
      }
      case "marks.saveTagIds": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id", "tagId", "tagIds"], "marks.saveTagIds");
        const id = requirePositiveInteger(op.id, "id");
        const mark = this.requireMark(id);
        const tagId = requirePositiveInteger(op.tagId, "tagId");
        if (op.tagIds === undefined) {
          return { affected: 0, id: mark.id, version: mark.version };
        }
        if (
          !Array.isArray(op.tagIds) ||
          op.tagIds.some((tag) => !Number.isInteger(tag))
        ) {
          validation("tagIds must be an array of integers");
        }
        const wanted = sortedUnique([tagId, ...(op.tagIds as number[])]);
        for (const wantedId of wanted) {
          this.tagMustExist(wantedId);
        }
        const now = this.tick();
        this.markTags.set(mark.id, new Set(wanted));
        mark.tagId = tagId;
        mark.tagUpdatedAt = now;
        mark.updatedAt = now;
        return { affected: 1, id: mark.id, version: mark.version };
      }
      case "tags.create": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "name"], "tags.create");
        const name = validateTagName(op.name);
        const before = this.tags.size;
        const tag = this.createOrReuseTag(name);
        return {
          affected: this.tags.size > before ? 1 : 0,
          id: tag.id,
        };
      }
      case "tags.delete": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id", "reassignTo"], "tags.delete");
        const id = requirePositiveInteger(op.id, "id");
        const tag = this.requireTag(id);
        if (tag.isLocked) {
          fail("CONFLICT", "Locked tags cannot be deleted", {
            wireCode: "tag_locked",
          });
        }
        const usedBy: MarkInternal[] = [];
        for (const mark of this.marks.values()) {
          if ((this.markTags.get(mark.id) ?? new Set()).has(id)) {
            usedBy.push(mark);
          }
        }
        if (usedBy.length > 0 && op.reassignTo === undefined) {
          fail("CONFLICT", "Tag is in use", {
            wireCode: "tag_in_use",
            recordCount: usedBy.length,
          });
        }
        if (op.reassignTo !== undefined) {
          const reassignTo = requirePositiveInteger(op.reassignTo, "reassignTo");
          if (reassignTo === id) {
            validation("reassignTo must differ from the deleted tag");
          }
          if (!this.tags.has(reassignTo)) {
            fail("VALIDATION", "The referenced tag was not found", {
              wireCode: "tag_not_found",
              tagId: reassignTo,
            });
          }
          const now = this.tick();
          for (const mark of usedBy) {
            const set = this.markTags.get(mark.id) ?? new Set<number>();
            set.delete(id);
            set.add(reassignTo);
            this.markTags.set(mark.id, set);
            if (mark.tagId === id) {
              mark.tagId = reassignTo;
              mark.tagUpdatedAt = now;
              mark.updatedAt = now;
            }
          }
        }
        this.tags.delete(id);
        return { affected: 1, id };
      }
      case "knowledge.upsertSource": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "source"], "knowledge.upsertSource");
        const source = op.source as unknown;
        if (!isRecord(source)) {
          validation("knowledge.upsertSource requires a source payload");
        }
        checkKeys(
          source,
          ["sourceKey", "sourceType", "sourceId", "title", "contentHash", "indexedHash", "updatedAt", "locator", "status", "error"],
          "knowledge.upsertSource source",
        );
        const sourceKey = requireNonEmptyString(source.sourceKey, "source.sourceKey");
        if (
          typeof source.sourceType !== "string" ||
          !KNOWLEDGE_TYPES.includes(source.sourceType as KnowledgeSourceType)
        ) {
          validation("source.sourceType must be a known knowledge source type");
        }
        requireString(source.sourceId, "source.sourceId");
        requireString(source.title, "source.title");
        requireNonEmptyString(source.contentHash, "source.contentHash");
        if (
          source.indexedHash !== undefined &&
          source.indexedHash !== null &&
          typeof source.indexedHash !== "string"
        ) {
          validation("source.indexedHash must be a string or null");
        }
        if (typeof source.updatedAt !== "number" || !Number.isFinite(source.updatedAt)) {
          validation("source.updatedAt must be a number");
        }
        if (!isRecord(source.locator)) {
          validation("source.locator must be an object");
        }
        if (
          typeof source.status !== "string" ||
          !KNOWLEDGE_STATUSES.includes(source.status as KnowledgeIndexStatus)
        ) {
          validation("source.status must be a known knowledge status");
        }
        if (
          source.error !== undefined &&
          source.error !== null &&
          typeof source.error !== "string"
        ) {
          validation("source.error must be a string or null");
        }
        const incoming = clone(source) as unknown as KnowledgeSource;
        const existing = this.knowledge.get(sourceKey);
        if (existing !== undefined) {
          if (
            existing.contentHash === incoming.contentHash &&
            existing.status === "ready"
          ) {
            return { affected: 0, id: sourceKey };
          }
          const hashChanged = existing.contentHash !== incoming.contentHash;
          const next: KnowledgeSource = {
            ...incoming,
            indexedHash: hashChanged
              ? existing.indexedHash
              : (incoming.indexedHash ?? null),
            status: hashChanged ? "pending" : incoming.status,
            error: incoming.error ?? null,
          };
          this.knowledge.set(sourceKey, next);
          return { affected: 1, id: sourceKey };
        }
        this.knowledge.set(sourceKey, {
          ...incoming,
          indexedHash: incoming.indexedHash ?? null,
          error: incoming.error ?? null,
        });
        return { affected: 1, id: sourceKey };
      }
      case "knowledge.updateStatus": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "sourceKey", "update"], "knowledge.updateStatus");
        const sourceKey = requireNonEmptyString(op.sourceKey, "sourceKey");
        const update = op.update as unknown;
        if (!isRecord(update)) {
          validation("knowledge.updateStatus requires an update payload");
        }
        checkKeys(update, ["status", "indexedHash", "error", "expectedStatus"], "knowledge.updateStatus update");
        if (
          typeof update.status !== "string" ||
          !KNOWLEDGE_STATUSES.includes(update.status as KnowledgeIndexStatus)
        ) {
          validation("update.status must be a known knowledge status");
        }
        if (
          update.indexedHash !== undefined &&
          update.indexedHash !== null &&
          typeof update.indexedHash !== "string"
        ) {
          validation("update.indexedHash must be a string or null");
        }
        if (
          update.error !== undefined &&
          update.error !== null &&
          typeof update.error !== "string"
        ) {
          validation("update.error must be a string or null");
        }
        if (
          update.expectedStatus !== undefined &&
          !KNOWLEDGE_STATUSES.includes(update.expectedStatus as KnowledgeIndexStatus)
        ) {
          validation("update.expectedStatus must be a known knowledge status");
        }
        const existing = this.knowledge.get(sourceKey);
        if (existing === undefined) {
          return { affected: 0, id: sourceKey };
        }
        const currentStatus = existing.status;
        if (
          update.expectedStatus !== undefined &&
          update.expectedStatus !== currentStatus
        ) {
          fail("CONFLICT", "Knowledge source status changed", {
            wireCode: "revision_conflict",
            currentStatus,
          });
        }
        if (
          !LEGAL_TRANSITIONS[currentStatus].includes(
            update.status as KnowledgeIndexStatus,
          )
        ) {
          fail("CONFLICT", "Illegal knowledge status transition", {
            wireCode: "revision_conflict",
            currentStatus,
            status: update.status,
          });
        }
        this.knowledge.set(sourceKey, {
          ...existing,
          status: update.status as KnowledgeIndexStatus,
          indexedHash: (update.indexedHash as string | null | undefined) ?? null,
          error: (update.error as string | null | undefined) ?? null,
        });
        return { affected: 1, id: sourceKey };
      }
      case "knowledge.removeSource": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "sourceKey"], "knowledge.removeSource");
        const sourceKey = requireNonEmptyString(op.sourceKey, "sourceKey");
        const deleted = this.knowledge.delete(sourceKey);
        return { affected: deleted ? 1 : 0, id: sourceKey };
      }
      case "vector.replaceChunks": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "sourceType", "sourceId", "chunks"], "vector.replaceChunks");
        if (
          typeof op.sourceType !== "string" ||
          !KNOWLEDGE_TYPES.includes(op.sourceType as KnowledgeSourceType)
        ) {
          validation("sourceType must be a known knowledge source type");
        }
        const sourceId = requireString(op.sourceId, "sourceId");
        if (!Array.isArray(op.chunks)) {
          validation("chunks must be an array");
        }
        this.validateChunks(op.chunks as SqlVectorChunkInput[]);
        this.deleteChunksFor(op.sourceType as string, sourceId);
        const now = this.tick();
        for (const chunk of op.chunks as SqlVectorChunkInput[]) {
          this.chunks.set(chunkKey(op.sourceType as string, sourceId, chunk.chunkId), {
            chunkId: chunk.chunkId,
            content: chunk.content,
            embedding: chunk.embedding,
            updatedAt: now,
          });
        }
        return {
          affected: (op.chunks as SqlVectorChunkInput[]).length,
          id: `${op.sourceType as string}:${sourceId}`,
        };
      }
      case "canvases.create": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "canvas"], "canvases.create");
        const canvas = op.canvas as unknown;
        if (!isRecord(canvas)) {
          validation("canvases.create requires a canvas payload");
        }
        checkKeys(canvas, ["id", "title", "canvasType", "document"], "canvases.create canvas");
        const id = requireUuid(canvas.id, "canvas.id");
        const title = requireNonEmptyString(canvas.title, "canvas.title");
        if (
          typeof canvas.canvasType !== "string" ||
          !CANVAS_TYPES.has(canvas.canvasType)
        ) {
          validation("canvas.canvasType must be a known canvas type");
        }
        if (canvas.document !== undefined && !isRecord(canvas.document)) {
          validation("canvas.document must be an object");
        }
        if (this.canvases.has(id)) {
          fail("CONFLICT", "Canvas already exists", {
            wireCode: "already_exists",
          });
        }
        const document = (
          canvas.document === undefined
            ? clone(DEFAULT_CANVAS_DOCUMENT)
            : clone(canvas.document)
        ) as CanvasDocument;
        const now = this.tick();
        const row: SqlCanvasRow = {
          id,
          title,
          canvasType: canvas.canvasType as SqlCanvasRow["canvasType"],
          schemaVersion:
            typeof document.schemaVersion === "number" ? document.schemaVersion : 1,
          document,
          thumbnailPath: null,
          createdAt: now,
          updatedAt: now,
          pinnedAt: null,
          deletedAt: null,
          version: 1,
        };
        this.canvases.set(id, row);
        return { affected: 1, id, version: 1 };
      }
      case "canvases.save": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id", "patch", "expected", "force"], "canvases.save");
        const id = requireUuid(op.id, "id");
        const current = this.canvases.get(id);
        if (current === undefined) {
          fail("NOT_FOUND", `Canvas not found: ${id}`, { wireCode: "not_found" });
        }
        const patch = op.patch as unknown;
        if (!isRecord(patch)) {
          validation("canvases.save requires a patch payload");
        }
        checkKeys(patch, ["document", "title", "thumbnailPath", "pinnedAt"], "canvases.save patch");
        if (
          patch.document === undefined &&
          patch.title === undefined &&
          patch.thumbnailPath === undefined &&
          patch.pinnedAt === undefined
        ) {
          validation("canvases.save patch must change at least one field");
        }
        if (patch.document !== undefined && !isRecord(patch.document)) {
          validation("patch.document must be an object");
        }
        if (patch.title !== undefined && typeof patch.title !== "string") {
          validation("patch.title must be a string");
        }
        if (
          patch.thumbnailPath !== undefined &&
          patch.thumbnailPath !== null &&
          typeof patch.thumbnailPath !== "string"
        ) {
          validation("patch.thumbnailPath must be a string or null");
        }
        if (
          patch.pinnedAt !== undefined &&
          patch.pinnedAt !== null &&
          typeof patch.pinnedAt !== "number"
        ) {
          validation("patch.pinnedAt must be a number or null");
        }
        if (!isRecord(op.expected)) {
          validation("canvases.save requires an expected version");
        }
        checkKeys(op.expected as Record<string, unknown>, ["version"], "canvases.save expected");
        const expectedVersion = (op.expected as Record<string, unknown>).version;
        if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) {
          validation("expected.version must be an integer");
        }
        if (expectedVersion !== current.version && op.force !== true) {
          fail("CONFLICT", "Canvas version is stale", {
            wireCode: "revision_conflict",
            currentVersion: current.version,
            snapshot: {
              document: clone(current.document),
              version: current.version,
              updatedAt: current.updatedAt,
            },
          });
        }
        const nextVersion = current.version + 1;
        const now = this.tick();
        const next: SqlCanvasRow = {
          ...clone(current),
          ...(patch.document === undefined
            ? {}
            : {
                document: clone(patch.document) as unknown as CanvasDocument,
                ...((patch.document as Record<string, unknown>).schemaVersion !== undefined &&
                typeof (patch.document as Record<string, unknown>).schemaVersion === "number"
                  ? {
                      schemaVersion: (patch.document as Record<string, unknown>)
                        .schemaVersion as number,
                    }
                  : {}),
              }),
          ...(patch.title === undefined ? {} : { title: patch.title as string }),
          ...(patch.thumbnailPath === undefined
            ? {}
            : { thumbnailPath: patch.thumbnailPath as string | null }),
          ...(patch.pinnedAt === undefined
            ? {}
            : { pinnedAt: patch.pinnedAt as number | null }),
          version: nextVersion,
          updatedAt: now,
        };
        this.canvases.set(id, next);
        return { affected: 1, id, version: nextVersion };
      }
      case "canvases.softDelete": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id"], "canvases.softDelete");
        const id = requireUuid(op.id, "id");
        const current = this.canvases.get(id);
        if (current === undefined) {
          fail("NOT_FOUND", `Canvas not found: ${id}`, { wireCode: "not_found" });
        }
        const now = this.tick();
        const nextVersion = current.version + 1;
        this.canvases.set(id, {
          ...clone(current),
          deletedAt: now,
          updatedAt: now,
          version: nextVersion,
        });
        return { affected: 1, id, version: nextVersion };
      }
      case "canvases.restore": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "id"], "canvases.restore");
        const id = requireUuid(op.id, "id");
        const current = this.canvases.get(id);
        if (current === undefined) {
          fail("NOT_FOUND", `Canvas not found: ${id}`, { wireCode: "not_found" });
        }
        const nextVersion = current.version + 1;
        this.canvases.set(id, {
          ...clone(current),
          deletedAt: null,
          updatedAt: this.tick(),
          version: nextVersion,
        });
        return { affected: 1, id, version: nextVersion };
      }
      case "wiki.upsertSource": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "state"], "wiki.upsertSource");
        const state = op.state as unknown;
        if (!isRecord(state)) {
          validation("wiki.upsertSource requires a state payload");
        }
        const contextId = requireNonEmptyString(state.contextId, "state.contextId");
        const stableId = requireNonEmptyString(state.stableId, "state.stableId");
        requireNonEmptyString(state.sourceKey, "state.sourceKey");
        this.wikiStates.set(
          wikiStateKey(contextId, stableId),
          clone(state) as unknown as WikiSourceState,
        );
        return { affected: 1, id: wikiStateKey(contextId, stableId) };
      }
      case "wiki.commitRevision": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "revision", "pages", "expectedVersion"], "wiki.commitRevision");
        const revision = op.revision as unknown;
        if (!isRecord(revision)) {
          validation("wiki.commitRevision requires a revision payload");
        }
        const contextId = requireNonEmptyString(revision.contextId, "revision.contextId");
        const revisionId = requireNonEmptyString(revision.id, "revision.id");
        const outputHash = requireNonEmptyString(revision.outputHash, "revision.outputHash");
        if (!isRecord(revision.source)) {
          validation("revision.source must be an object");
        }
        const source = revision.source as Record<string, unknown>;
        const stableId = requireNonEmptyString(source.stableId, "revision.source.stableId");
        const sourceHash = requireNonEmptyString(source.contentHash, "revision.source.contentHash");
        if (!Array.isArray(op.pages)) {
          validation("pages must be an array");
        }
        if (
          op.expectedVersion !== undefined &&
          (typeof op.expectedVersion !== "number" ||
            !Number.isInteger(op.expectedVersion))
        ) {
          validation("expectedVersion must be an integer");
        }
        const key = wikiStateKey(contextId, stableId);
        const current = this.wikiStates.get(key);
        const noCommit = (version: number): SqlWikiCommitResult => ({
          affected: 0,
          id: key,
          version,
          committed: false,
        });
        if (current === undefined) {
          return noCommit(0);
        }
        const guardMiss =
          WIKI_DEAD_STATUSES.has(current.status) ||
          current.contentHash !== sourceHash ||
          (op.expectedVersion !== undefined && op.expectedVersion !== current.version);
        if (guardMiss) {
          return noCommit(current.version);
        }
        const nextVersion = current.version + 1;
        this.wikiStates.set(key, {
          ...clone(current),
          revisionId,
          version: nextVersion,
          contentHash: outputHash,
          updatedAt: this.tick(),
        });
        for (const page of op.pages as WikiPage[]) {
          if (isRecord(page) && typeof page.id === "string") {
            this.wikiPages.set(
              wikiPageKey(contextId, page.id as string),
              clone(page),
            );
          }
        }
        return {
          affected: 1,
          id: key,
          version: nextVersion,
          committed: true,
        };
      }
      case "wiki.upsertPage": {
        checkKeys(op as unknown as Record<string, unknown>, ["kind", "page"], "wiki.upsertPage");
        const page = op.page as unknown;
        if (!isRecord(page)) {
          validation("wiki.upsertPage requires a page payload");
        }
        const contextId = requireNonEmptyString(page.contextId, "page.contextId");
        const id = requireNonEmptyString(page.id, "page.id");
        this.wikiPages.set(
          wikiPageKey(contextId, id),
          clone(page) as unknown as WikiPage,
        );
        return { affected: 1, id };
      }
      default:
        return fail(
          "VALIDATION",
          `Unknown write operation kind: ${String((op as { kind?: unknown }).kind)}`,
        );
    }
  }
}

export function createFakeSqlAdapter(): FakeSqlAdapter {
  return new FakeSqlAdapter();
}
