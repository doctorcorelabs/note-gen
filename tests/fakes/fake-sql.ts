// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Independent in-memory fake for the SqlAdapter interface.
//
// The fake implements the typed-operation subset from the scaffold-local
// contract types (tests/contract/contract-types.ts) over plain Maps. It
// never wraps the web or Tauri implementation, never runs SQL, never
// touches a database, and never touches the network. There is no
// persistence across processes.
//
// Behavior locked here follows fase1/desain-sql-adapter.md section 6
// (CT-K, CT-T, CT-H, CT-X, CT-I, CT-S5, CT-S6) at the adapter level only:
// unique constraints, trigger-equivalent tag semantics, the hash status
// machine, transaction atomicity, optimistic guards, and idempotency.
// Cases that need a real Postgres catalog, HTTP auth, or a production
// bundle (CT-M, CT-T6, CT-S1 to CT-S4, CT-P, C-SQ-02, C-SQ-09) cannot run
// against this fake and are recorded as deferred in
// tests/contract/README.md. This fake therefore does NOT replace the
// Postgres contract required by fase1/desain-pengujian.md section 2.4
// (R2); it proves the contract cases themselves are runnable and can
// detect violations before the Postgres-backed implementation lands.
//
// Fake-local decisions, each recorded here so the integrator can compare
// them with the real implementation:
// - The fake starts empty: no seeded "Idea" tag and no workspace. Seeding
//   is a server bootstrap concern, not an adapter behavior.
// - Error codes use the scaffold-local ContractError taxonomy. FK-style
//   rejections (unknown tag reference) use VALIDATION; guard conflicts
//   use CONFLICT; missing rows on write use NOT_FOUND. The mapping is
//   recorded in tests/contract/README.md.
// - Unknown operation kinds are rejected with VALIDATION. Extra fields
//   on an operation are ignored: strict unknown-field rejection is a
//   server TypeBox concern (CT-S3, CT-S5), not an adapter concern.
// - Timestamps come from a monotonic in-fake clock so "tagUpdatedAt
//   rises" assertions are deterministic within one process.
// - Idempotency keys never expire in the fake (CT-I3 is server-level).
// - ready() reports migrationsCurrent true: the fake has no migrations.
//   CT-M cases must run against the real migrator, never this fake.

import { randomUUID } from "node:crypto";
import { ContractError } from "../contract/contract-errors";
import {
  SQL_MAX_TRANSACTION_OPS,
  TAG_GUARD_CONFLICT_MESSAGE,
} from "../contract/contract-types";
import type {
  CanvasRow,
  DbReadOperation,
  DbWriteOperation,
  KnowledgeSourceRow,
  KnowledgeSourceType,
  KnowledgeStatsRow,
  MarkRow,
  SqlAdapter,
  SqlHealth,
  TagRow,
  VectorChunkInput,
  VectorSummary,
  WikiSourceState,
  WriteResult,
} from "../contract/contract-types";

const MARK_TYPES = new Set([
  "scan",
  "text",
  "image",
  "link",
  "file",
  "recording",
  "todo",
]);

const KNOWLEDGE_TYPES: KnowledgeSourceType[] = ["article", "record", "canvas"];

const READ_KINDS = new Set([
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
]);

interface MarkInternal {
  id: number;
  tagId: number;
  type: string;
  content: string | null;
  url: string | null;
  desc: string | null;
  sourceId: string | null;
  deletedAt: number | null;
  tagUpdatedAt: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

interface KnowledgeInternal extends KnowledgeSourceRow {
  sourceType: KnowledgeSourceType;
}

interface ChunkInternal {
  chunkId: number;
  content: string;
  embedding: number[];
  updatedAt: number;
}

interface CanvasInternal {
  id: string;
  title: string;
  content: unknown;
  version: number;
  updatedAt: number;
}

function fail(
  code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE" | "UNKNOWN",
  message: string,
  details?: unknown,
): never {
  throw new ContractError(code, message, { details });
}

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function sameNumberSet(a: number[], b: number[]): boolean {
  const left = sortedUnique(a);
  const right = sortedUnique(b);
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
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

function knowledgeKey(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

function chunkKey(
  sourceType: string,
  sourceId: string,
  chunkId: number,
): string {
  return `${sourceType}:${sourceId}:${chunkId}`;
}

function wikiKey(contextId: string, sourceId: string): string {
  return `${contextId}:${sourceId}`;
}

export class FakeSqlAdapter implements SqlAdapter {
  readonly mode: "tauri" | "web" | "fake" = "fake";

  private readonly tags = new Map<number, TagRow>();
  private readonly marks = new Map<number, MarkInternal>();
  private readonly markTags = new Map<number, Set<number>>();
  private readonly knowledge = new Map<string, KnowledgeInternal>();
  private readonly chunks = new Map<string, ChunkInternal>();
  private readonly canvases = new Map<string, CanvasInternal>();
  private readonly wiki = new Map<string, WikiSourceState>();
  private readonly idempotency = new Map<
    string,
    { opsHash: string; results: WriteResult[] }
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
      wiki: this.wiki,
      idempotency: this.idempotency,
      nextTagId: this.nextTagId,
      nextMarkId: this.nextMarkId,
      lastTick: this.lastTick,
    });
  }

  private restore(snapshotValue: unknown): void {
    const state = snapshotValue as {
      tags: Map<number, TagRow>;
      marks: Map<number, MarkInternal>;
      markTags: Map<number, Set<number>>;
      knowledge: Map<string, KnowledgeInternal>;
      chunks: Map<string, ChunkInternal>;
      canvases: Map<string, CanvasInternal>;
      wiki: Map<string, WikiSourceState>;
      idempotency: Map<string, { opsHash: string; results: WriteResult[] }>;
      nextTagId: number;
      nextMarkId: number;
      lastTick: number;
    };
    this.tags.clear();
    for (const [key, value] of state.tags) this.tags.set(key, value);
    this.marks.clear();
    for (const [key, value] of state.marks) this.marks.set(key, value);
    this.markTags.clear();
    for (const [key, value] of state.markTags) this.markTags.set(key, value);
    this.knowledge.clear();
    for (const [key, value] of state.knowledge)
      this.knowledge.set(key, value);
    this.chunks.clear();
    for (const [key, value] of state.chunks) this.chunks.set(key, value);
    this.canvases.clear();
    for (const [key, value] of state.canvases) this.canvases.set(key, value);
    this.wiki.clear();
    for (const [key, value] of state.wiki) this.wiki.set(key, value);
    this.idempotency.clear();
    for (const [key, value] of state.idempotency)
      this.idempotency.set(key, value);
    this.nextTagId = state.nextTagId;
    this.nextMarkId = state.nextMarkId;
    this.lastTick = state.lastTick;
  }

  async ready(): Promise<SqlHealth> {
    return { ok: true, mode: "fake", migrationsCurrent: true };
  }

  async query<T>(op: DbReadOperation): Promise<T[]> {
    return this.applyRead(op) as T[];
  }

  async queryOne<T>(op: DbReadOperation): Promise<T | null> {
    const rows = await this.query<T>(op);
    return rows.length === 0 ? null : rows[0];
  }

  async queryMany(ops: DbReadOperation[]): Promise<unknown[][]> {
    for (const op of ops) {
      if (
        op === null ||
        typeof op !== "object" ||
        !READ_KINDS.has((op as { kind?: unknown }).kind as string)
      ) {
        fail(
          "VALIDATION",
          `Unknown read operation kind: ${String((op as { kind?: unknown } | null)?.kind)}`,
        );
      }
    }
    const results: unknown[][] = [];
    for (const op of ops) {
      results.push(this.applyRead(op));
    }
    return results;
  }

  async execute(op: DbWriteOperation): Promise<WriteResult> {
    const results = await this.transaction([op]);
    return results[0];
  }

  async transaction(
    ops: DbWriteOperation[],
    opts?: { idempotencyKey?: string },
  ): Promise<WriteResult[]> {
    if (ops.length > SQL_MAX_TRANSACTION_OPS) {
      fail(
        "VALIDATION",
        `Transaction exceeds the maximum of ${SQL_MAX_TRANSACTION_OPS} operations`,
      );
    }
    const opsHash = stableStringify(ops);
    if (opts?.idempotencyKey !== undefined) {
      const stored = this.idempotency.get(opts.idempotencyKey);
      if (stored !== undefined) {
        if (stored.opsHash !== opsHash) {
          fail(
            "CONFLICT",
            "Idempotency key was reused with a different request body",
          );
        }
        return clone(stored.results);
      }
    }
    const before = this.snapshot();
    const results: WriteResult[] = [];
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

  private toMarkRow(mark: MarkInternal): MarkRow {
    return {
      id: mark.id,
      tagId: mark.tagId,
      tagIds: sortedUnique([...(this.markTags.get(mark.id) ?? new Set())]),
      type: mark.type,
      content: mark.content,
      url: mark.url,
      desc: mark.desc,
      sourceId: mark.sourceId,
      deleted: mark.deletedAt !== null,
      tagUpdatedAt: mark.tagUpdatedAt,
      version: mark.version,
      createdAt: mark.createdAt,
      updatedAt: mark.updatedAt,
    };
  }

  private listMarks(
    tagId: number | undefined,
    includeDeleted: boolean,
    limit: number | undefined,
  ): MarkRow[] {
    const clamped =
      limit === undefined ? 50 : Math.max(1, Math.min(200, Math.floor(limit)));
    const rows: MarkRow[] = [];
    for (const mark of [...this.marks.values()].sort((a, b) => a.id - b.id)) {
      if (!includeDeleted && mark.deletedAt !== null) {
        continue;
      }
      if (
        tagId !== undefined &&
        !(this.markTags.get(mark.id) ?? new Set()).has(tagId)
      ) {
        continue;
      }
      rows.push(this.toMarkRow(mark));
    }
    return rows.slice(0, clamped);
  }

  private applyRead(op: DbReadOperation): unknown[] {
    if (op === null || typeof op !== "object") {
      fail("VALIDATION", "Read operation must be an object");
    }
    switch (op.kind) {
      case "marks.list":
        return this.listMarks(op.tagId, op.includeDeleted ?? false, op.limit);
      case "marks.get": {
        const mark = this.marks.get(op.id);
        return mark === undefined ? [] : [this.toMarkRow(mark)];
      }
      case "marks.listByTag":
        return this.listMarks(op.tagId, false, undefined);
      case "tags.list":
        return [...this.tags.values()]
          .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
          .map((tag) => clone(tag));
      case "tags.get": {
        const tag = this.tags.get(op.id);
        return tag === undefined ? [] : [clone(tag)];
      }
      case "knowledge.listSources": {
        const rows = [...this.knowledge.values()]
          .filter(
            (row) =>
              (op.sourceTypes === undefined ||
                op.sourceTypes.includes(row.sourceType)) &&
              (op.statuses === undefined ||
                op.statuses.includes(row.status)),
          )
          .sort((a, b) =>
            a.sourceType === b.sourceType
              ? a.sourceId < b.sourceId
                ? -1
                : 1
              : a.sourceType < b.sourceType
                ? -1
                : 1,
          );
        return rows.map((row) => clone(row));
      }
      case "knowledge.getSource": {
        const row = this.knowledge.get(
          knowledgeKey(op.sourceType, op.sourceId),
        );
        return row === undefined ? [] : [clone(row)];
      }
      case "knowledge.stats": {
        const counts = new Map<string, KnowledgeStatsRow>();
        for (const row of this.knowledge.values()) {
          const key = `${row.sourceType}:${row.status}`;
          const existing = counts.get(key);
          if (existing === undefined) {
            counts.set(key, {
              sourceType: row.sourceType,
              status: row.status,
              count: 1,
            });
          } else {
            existing.count += 1;
          }
        }
        return [...counts.values()].sort((a, b) =>
          a.sourceType === b.sourceType
            ? a.status < b.status
              ? -1
              : 1
            : a.sourceType < b.sourceType
              ? -1
              : 1,
        );
      }
      case "vector.summaries": {
        const latest = new Map<string, VectorSummary>();
        for (const [key, chunk] of this.chunks) {
          const parts = key.split(":");
          const sourceType = parts[0];
          const sourceId = parts.slice(1, -1).join(":");
          const summaryKey = `${sourceType}:${sourceId}`;
          const existing = latest.get(summaryKey);
          if (
            existing === undefined ||
            chunk.updatedAt > existing.updatedAt
          ) {
            latest.set(summaryKey, {
              sourceType,
              sourceId,
              updatedAt: chunk.updatedAt,
            });
          }
        }
        return [...latest.values()].sort((a, b) =>
          a.sourceType === b.sourceType
            ? a.sourceId < b.sourceId
              ? -1
              : 1
            : a.sourceType < b.sourceType
              ? -1
              : 1,
        );
      }
      case "canvases.list":
        return [...this.canvases.values()]
          .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
          .map((row) => clone(row) as CanvasRow);
      case "canvases.get": {
        const row = this.canvases.get(op.id);
        return row === undefined ? [] : [clone(row) as CanvasRow];
      }
      case "wiki.getSourceState": {
        const row = this.wiki.get(wikiKey(op.contextId, op.sourceId));
        return row === undefined ? [] : [clone(row)];
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
      fail("NOT_FOUND", `Mark not found: ${id}`);
    }
    return mark as MarkInternal;
  }

  private requireTag(id: number): TagRow {
    const tag = this.tags.get(id);
    if (tag === undefined) {
      fail("VALIDATION", `Tag does not exist: ${id}`);
    }
    return tag as TagRow;
  }

  private createTag(name: string): TagRow {
    if (typeof name !== "string" || name.trim() === "") {
      fail("VALIDATION", "Tag name must be a non-empty string");
    }
    for (const tag of this.tags.values()) {
      if (tag.name === name) {
        fail("CONFLICT", `Tag name already exists: "${name}"`);
      }
    }
    const sortOrder =
      this.tags.size === 0
        ? 0
        : Math.max(...[...this.tags.values()].map((tag) => tag.sortOrder)) + 1;
    const now = this.tick();
    const tag: TagRow = {
      id: this.nextTagId,
      name,
      isLocked: false,
      isPin: false,
      sortOrder,
      createdAt: now,
      updatedAt: now,
    };
    this.nextTagId += 1;
    this.tags.set(tag.id, tag);
    return tag;
  }

  private validateChunk(chunk: VectorChunkInput): void {
    if (
      chunk === null ||
      typeof chunk !== "object" ||
      !Number.isInteger(chunk.chunkId) ||
      chunk.chunkId < 0 ||
      typeof chunk.content !== "string" ||
      chunk.content === "" ||
      !Array.isArray(chunk.embedding) ||
      chunk.embedding.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      )
    ) {
      fail("VALIDATION", "Vector chunk is invalid");
    }
  }

  private validateChunks(chunks: VectorChunkInput[]): void {
    const seen = new Set<number>();
    for (const chunk of chunks) {
      this.validateChunk(chunk);
      if (seen.has(chunk.chunkId)) {
        fail("VALIDATION", "Vector chunks contain a duplicate chunkId");
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

  private requireKnowledge(
    sourceType: string,
    sourceId: string,
  ): KnowledgeInternal {
    const row = this.knowledge.get(knowledgeKey(sourceType, sourceId));
    if (row === undefined) {
      fail(
        "NOT_FOUND",
        `Knowledge source not found: ${sourceType}:${sourceId}`,
      );
    }
    return row as KnowledgeInternal;
  }

  private applyWrite(op: DbWriteOperation): WriteResult {
    if (op === null || typeof op !== "object") {
      fail("VALIDATION", "Write operation must be an object");
    }
    switch (op.kind) {
      case "marks.create": {
        const mark = op.mark;
        if (
          mark === null ||
          typeof mark !== "object" ||
          !Number.isInteger(mark.tagId)
        ) {
          fail("VALIDATION", "marks.create requires a valid mark payload");
        }
        if (!MARK_TYPES.has(mark.type)) {
          fail("VALIDATION", `Unknown mark type: "${mark.type}"`);
        }
        this.requireTag(mark.tagId);
        for (const tagId of op.tagIds) {
          this.requireTag(tagId);
        }
        if (mark.sourceId !== undefined && mark.sourceId !== null) {
          for (const existing of this.marks.values()) {
            if (existing.sourceId === mark.sourceId) {
              return {
                affected: 0,
                id: existing.id,
                version: existing.version,
                duplicate: true,
              };
            }
          }
        }
        const now = this.tick();
        const id = this.nextMarkId;
        this.nextMarkId += 1;
        const created: MarkInternal = {
          id,
          tagId: mark.tagId,
          type: mark.type,
          content: mark.content ?? null,
          url: mark.url ?? null,
          desc: mark.desc ?? null,
          // A null sourceId stays null on read, matching the partial
          // unique index semantics: nulls never collide with each
          // other and each null row stays independent by id.
          sourceId: mark.sourceId ?? null,
          deletedAt: null,
          tagUpdatedAt: now,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.marks.set(id, created);
        this.markTags.set(
          id,
          new Set(sortedUnique([...op.tagIds, mark.tagId])),
        );
        return { affected: 1, id, version: 1, duplicate: false };
      }
      case "marks.update": {
        const mark = this.requireMark(op.id);
        if (
          op.expectedVersion !== undefined &&
          op.expectedVersion !== mark.version
        ) {
          fail("CONFLICT", "Mark version is stale", {
            currentVersion: mark.version,
          });
        }
        const patch = op.patch;
        let tagChanged = false;
        if (patch.tagId !== undefined && patch.tagId !== mark.tagId) {
          this.requireTag(patch.tagId);
          mark.tagId = patch.tagId;
          const set = this.markTags.get(mark.id) ?? new Set<number>();
          set.add(patch.tagId);
          this.markTags.set(mark.id, set);
          tagChanged = true;
        }
        if (patch.type !== undefined) {
          if (!MARK_TYPES.has(patch.type)) {
            fail("VALIDATION", `Unknown mark type: "${patch.type}"`);
          }
          mark.type = patch.type;
        }
        if (patch.sourceId !== undefined && patch.sourceId !== mark.sourceId) {
          if (patch.sourceId !== null) {
            for (const other of this.marks.values()) {
              if (other.id !== mark.id && other.sourceId === patch.sourceId) {
                fail("CONFLICT", "sourceId is already used by another mark");
              }
            }
          }
          mark.sourceId = patch.sourceId;
        }
        if (patch.content !== undefined) mark.content = patch.content;
        if (patch.url !== undefined) mark.url = patch.url;
        if (patch.desc !== undefined) mark.desc = patch.desc;
        const now = this.tick();
        mark.version += 1;
        mark.updatedAt = now;
        if (tagChanged) {
          mark.tagUpdatedAt = now;
        }
        return { affected: 1, id: mark.id, version: mark.version };
      }
      case "marks.softDelete": {
        const mark = this.requireMark(op.id);
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
        const mark = this.requireMark(op.id);
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
        this.requireMark(op.id);
        this.marks.delete(op.id);
        this.markTags.delete(op.id);
        return { affected: 1, id: op.id };
      }
      case "marks.updateTags": {
        const mark = this.requireMark(op.id);
        for (const tagId of op.tagIds) {
          this.requireTag(tagId);
        }
        const createdIds: number[] = [];
        for (const name of op.newNames ?? []) {
          const existing = [...this.tags.values()].find(
            (tag) => tag.name === name,
          );
          if (existing !== undefined) {
            createdIds.push(existing.id);
          } else {
            createdIds.push(this.createTag(name).id);
          }
        }
        if (op.expected !== undefined) {
          const current = sortedUnique([
            ...(this.markTags.get(mark.id) ?? new Set()),
          ]);
          if (
            !sameNumberSet(current, op.expected.tagIds) ||
            mark.tagId !== op.expected.primaryTagId
          ) {
            fail("CONFLICT", TAG_GUARD_CONFLICT_MESSAGE, {
              currentTagIds: current,
              currentPrimaryTagId: mark.tagId,
            });
          }
        }
        const next = sortedUnique([
          ...op.tagIds,
          ...createdIds,
          mark.tagId,
        ]);
        this.markTags.set(mark.id, new Set(next));
        const now = this.tick();
        mark.tagUpdatedAt = now;
        mark.version += 1;
        mark.updatedAt = now;
        return { affected: 1, id: mark.id, version: mark.version };
      }
      case "marks.saveTagIds": {
        const mark = this.requireMark(op.id);
        if (op.tagIds === undefined) {
          return { affected: 0, id: mark.id, version: mark.version };
        }
        for (const tagId of op.tagIds) {
          this.requireTag(tagId);
        }
        const next = sortedUnique([...op.tagIds, mark.tagId]);
        const current = sortedUnique([
          ...(this.markTags.get(mark.id) ?? new Set()),
        ]);
        if (sameNumberSet(current, next)) {
          return { affected: 0, id: mark.id, version: mark.version };
        }
        this.markTags.set(mark.id, new Set(next));
        const now = this.tick();
        mark.tagUpdatedAt = now;
        mark.version += 1;
        mark.updatedAt = now;
        return { affected: 1, id: mark.id, version: mark.version };
      }
      case "tags.create": {
        const tag = this.createTag(op.name);
        return { affected: 1, id: tag.id };
      }
      case "tags.delete": {
        this.requireTag(op.id);
        const usedBy: MarkInternal[] = [];
        for (const mark of this.marks.values()) {
          if ((this.markTags.get(mark.id) ?? new Set()).has(op.id)) {
            usedBy.push(mark);
          }
        }
        if (usedBy.length > 0 && op.reassignTo === undefined) {
          fail("CONFLICT", "Tag is in use", {
            markIds: usedBy.map((mark) => mark.id),
          });
        }
        if (op.reassignTo !== undefined) {
          if (op.reassignTo === op.id) {
            fail("VALIDATION", "reassignTo must differ from the deleted tag");
          }
          this.requireTag(op.reassignTo);
          for (const mark of usedBy) {
            const set = this.markTags.get(mark.id) ?? new Set<number>();
            set.delete(op.id);
            if (mark.tagId === op.id) {
              mark.tagId = op.reassignTo;
            }
            set.add(op.reassignTo);
            this.markTags.set(mark.id, set);
            const now = this.tick();
            mark.tagUpdatedAt = now;
            mark.version += 1;
            mark.updatedAt = now;
          }
        }
        this.tags.delete(op.id);
        return { affected: 1, id: op.id };
      }
      case "knowledge.registerSource": {
        if (
          !KNOWLEDGE_TYPES.includes(op.sourceType as KnowledgeSourceType) ||
          typeof op.contentHash !== "string" ||
          op.contentHash === ""
        ) {
          fail("VALIDATION", "knowledge.registerSource payload is invalid");
        }
        const key = knowledgeKey(op.sourceType, op.sourceId);
        const existing = this.knowledge.get(key);
        if (existing !== undefined) {
          if (existing.contentHash === op.contentHash) {
            return { affected: 0, id: key };
          }
          existing.contentHash = op.contentHash;
          if (op.title !== undefined) {
            existing.title = op.title;
          }
          existing.status = "pending";
          existing.error = null;
          existing.updatedAt = this.tick();
          return { affected: 1, id: key };
        }
        const created: KnowledgeInternal = {
          sourceType: op.sourceType as KnowledgeSourceType,
          sourceId: op.sourceId,
          title: op.title ?? null,
          contentHash: op.contentHash,
          indexedHash: null,
          status: "pending",
          error: null,
          updatedAt: this.tick(),
        };
        this.knowledge.set(key, created);
        return { affected: 1, id: key };
      }
      case "knowledge.claimSource": {
        const row = this.requireKnowledge(op.sourceType, op.sourceId);
        if (row.status !== "pending") {
          fail("CONFLICT", "Knowledge source is not pending and cannot be claimed");
        }
        row.status = "indexing";
        row.updatedAt = this.tick();
        return { affected: 1, id: knowledgeKey(op.sourceType, op.sourceId) };
      }
      case "knowledge.completeSource": {
        const row = this.requireKnowledge(op.sourceType, op.sourceId);
        if (row.status !== "indexing") {
          fail(
            "CONFLICT",
            "Knowledge source must be indexing before it can complete",
          );
        }
        this.validateChunks(op.chunks);
        this.deleteChunksFor(op.sourceType, op.sourceId);
        const now = this.tick();
        for (const chunk of op.chunks) {
          this.chunks.set(chunkKey(op.sourceType, op.sourceId, chunk.chunkId), {
            chunkId: chunk.chunkId,
            content: chunk.content,
            embedding: [...chunk.embedding],
            updatedAt: now,
          });
        }
        row.status = "ready";
        row.indexedHash = row.contentHash;
        row.error = null;
        row.updatedAt = now;
        return { affected: 1, id: knowledgeKey(op.sourceType, op.sourceId) };
      }
      case "knowledge.failSource": {
        const row = this.requireKnowledge(op.sourceType, op.sourceId);
        if (row.status !== "indexing") {
          fail("CONFLICT", "Only an indexing source can fail");
        }
        if (typeof op.error !== "string" || op.error === "") {
          fail("VALIDATION", "knowledge.failSource requires an error message");
        }
        row.status = "failed";
        row.error = op.error;
        row.updatedAt = this.tick();
        return { affected: 1, id: knowledgeKey(op.sourceType, op.sourceId) };
      }
      case "knowledge.retrySource": {
        const row = this.requireKnowledge(op.sourceType, op.sourceId);
        if (row.status !== "failed") {
          fail("CONFLICT", "Only a failed source can be retried");
        }
        row.status = "pending";
        row.error = null;
        row.updatedAt = this.tick();
        return { affected: 1, id: knowledgeKey(op.sourceType, op.sourceId) };
      }
      case "vector.insertChunk": {
        this.validateChunk(op.chunk);
        const key = chunkKey(op.sourceType, op.sourceId, op.chunk.chunkId);
        if (this.chunks.has(key)) {
          fail("CONFLICT", "Vector chunk already exists for this chunkId");
        }
        this.chunks.set(key, {
          chunkId: op.chunk.chunkId,
          content: op.chunk.content,
          embedding: [...op.chunk.embedding],
          updatedAt: this.tick(),
        });
        return { affected: 1, id: key };
      }
      case "vector.replaceChunks": {
        this.validateChunks(op.chunks);
        this.deleteChunksFor(op.sourceType, op.sourceId);
        const now = this.tick();
        for (const chunk of op.chunks) {
          this.chunks.set(chunkKey(op.sourceType, op.sourceId, chunk.chunkId), {
            chunkId: chunk.chunkId,
            content: chunk.content,
            embedding: [...chunk.embedding],
            updatedAt: now,
          });
        }
        return { affected: op.chunks.length, id: knowledgeKey(op.sourceType, op.sourceId) };
      }
      case "canvases.save": {
        if (typeof op.title !== "string" || op.title === "") {
          fail("VALIDATION", "Canvas title must be a non-empty string");
        }
        if (op.id !== undefined) {
          const existing = this.canvases.get(op.id);
          if (existing !== undefined) {
            if (
              op.expectedVersion !== undefined &&
              op.force !== true &&
              op.expectedVersion !== existing.version
            ) {
              fail("CONFLICT", "Canvas version is stale", {
                currentVersion: existing.version,
                current: clone(existing),
              });
            }
            existing.title = op.title;
            existing.content = clone(op.content);
            existing.version += 1;
            existing.updatedAt = this.tick();
            return { affected: 1, id: existing.id, version: existing.version };
          }
        }
        const id = op.id ?? randomUUID();
        const created: CanvasInternal = {
          id,
          title: op.title,
          content: clone(op.content),
          version: 1,
          updatedAt: this.tick(),
        };
        this.canvases.set(id, created);
        return { affected: 1, id, version: 1 };
      }
      case "wiki.commitRevision": {
        const key = wikiKey(op.contextId, op.sourceId);
        const existing = this.wiki.get(key);
        const currentVersion = existing?.version ?? 0;
        if (op.expectedVersion !== currentVersion) {
          return {
            affected: 0,
            id: key,
            version: currentVersion,
            committed: false,
          };
        }
        const nextVersion = currentVersion + 1;
        this.wiki.set(key, {
          contextId: op.contextId,
          sourceId: op.sourceId,
          version: nextVersion,
          dirty: true,
          contentHash: op.contentHash,
        });
        return {
          affected: 1,
          id: key,
          version: nextVersion,
          committed: true,
        };
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
