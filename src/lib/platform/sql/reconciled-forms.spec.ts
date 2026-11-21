// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Conformance specs for the reconciled SQL forms (V3-14, part 4).
//
// What is pinned here, and how:
//
// 1. Every catalog kind is expressible in the unified form. The
//    `ALL_OPERATIONS` fixture holds one literal per kind (73 catalog
//    kinds plus the ratified `messages.get`), typed as
//    `ReconciledOperation[]`. The root typecheck gate proves every
//    literal satisfies its catalog member shape; a kind missing
//    from the unified form, or a member shape that drifted, fails
//    that gate. The runtime tests below prove the fixture covers
//    exactly the catalog kinds plus `messages.get`, with no
//    duplicate and no extra kind.
// 2. No unified operation carries SQL, a table name, a column name,
//    or a workspace id. The static half is the distributive key
//    check in `reconciled-forms.ts` plus the union-text scan in
//    this file; the runtime half is the recursive key scan over
//    every fixture payload, including nested patch and input
//    objects.
// 3. Catalog membership, wave, and exposure facts the reconciliation
//    relies on: kind counts, disjointness, metadata coverage, W1/W2
//    split, and the single server-only kind. The `messages.get`
//    delta is handled the same way as `server/test/db-kinds.spec.ts`
//    handles it: both states (catalog without it, catalog with it
//    after the V3-14 amendment) pass, and any other drift fails.
//    When the amendment lands, the tripwire type check in
//    `reconciled-forms.ts` forces removal of the extra member there;
//    this file needs no edit for that step.
//
// Run: `pnpm vitest run --project unit src/lib/platform/sql/reconciled-forms.spec.ts`
// from the repo root. The file uses vitest (the `unit` project in
// vitest.config.ts), not the node:test + esbuild convention of the
// older platform specs, because the unit project already exists and
// resolves the `@/` alias.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  KnowledgeSource,
  KnowledgeSourceType,
} from "@/types/knowledge";
import type {
  WikiJob,
  WikiPage,
  WikiSegmentCache,
  WikiSourceReference,
  WikiSourceRevision,
  WikiSourceState,
} from "@/types/wiki";
import {
  SQL_OP_KINDS,
  SQL_OP_METADATA,
  SQL_READ_OP_KINDS,
  SQL_WRITE_OP_KINDS,
} from "./ops-catalog";
import type {
  ReconciledClientOperation,
  ReconciledOperation,
} from "./reconciled-forms";

// ---------------------------------------------------------------------------
// Shared fixture payloads (wiki shapes are reused across kinds)
// ---------------------------------------------------------------------------

const WIKI_SOURCE_REF: WikiSourceReference = {
  sourceKey: "record:1",
  stableId: "stable-1",
  sourceType: "record",
  title: "Source title",
  contentHash: "hash-1",
  locator: { markId: 1 },
  syncDomain: "library",
};

const WIKI_STATE: WikiSourceState = {
  contextId: "ctx-1",
  stableId: "stable-1",
  sourceKey: "record:1",
  sourceType: "record",
  source: WIKI_SOURCE_REF,
  contentHash: "hash-1",
  status: "ready",
  revisionId: null,
  version: 1,
  updatedAt: 1,
  error: null,
};

const WIKI_REVISION: WikiSourceRevision = {
  id: "rev-1",
  contextId: "ctx-1",
  inputHash: "in-1",
  outputHash: "out-1",
  pipelineVersion: "wiki-1",
  generation: 1,
  language: "en",
  source: WIKI_SOURCE_REF,
  summary: "Summary",
  contributions: [],
  createdAt: 1,
  modelId: "model-1",
  usage: { inputTokens: 1, outputTokens: 1, estimated: false },
};

const WIKI_PAGE: WikiPage = {
  id: "page-1",
  contextId: "ctx-1",
  kind: "topic",
  title: "Page title",
  aliases: [],
  body: "Body",
  sourceRefs: [WIKI_SOURCE_REF],
  inputHash: "in-1",
  outputHash: "out-1",
  updatedAt: 1,
  status: "ready",
  relatedPageIds: [],
};

const WIKI_JOB: WikiJob = {
  id: "job-1",
  contextId: "ctx-1",
  sourceKey: "record:1",
  kind: "source",
  inputHash: "in-1",
  status: "pending",
  stage: "queued",
  attempts: 0,
  readyAt: 1,
  updatedAt: 1,
  error: null,
};

const WIKI_SEGMENT: WikiSegmentCache = {
  summary: "Summary",
  contributions: [],
  usage: { inputTokens: 1, outputTokens: 1, estimated: false },
};

const KNOWLEDGE_SOURCE: KnowledgeSource = {
  sourceKey: "record:1",
  sourceType: "record",
  sourceId: "1",
  title: "Source title",
  contentHash: "hash-1",
  updatedAt: 1,
  locator: { markId: 1 },
  status: "pending",
};

const VECTOR_SOURCE_TYPE: KnowledgeSourceType = "record";

// ---------------------------------------------------------------------------
// One expressible literal per unified kind (74: 73 catalog + messages.get)
// ---------------------------------------------------------------------------

const ALL_OPERATIONS: ReconciledOperation[] = [
  // Reads (34).
  { kind: "marks.list", deleted: "deleted", cursor: "c-1", limit: 5 },
  { kind: "marks.get", id: 1 },
  { kind: "marks.listByTag", tagId: 2, deleted: "all", limit: 5 },
  { kind: "tags.list" },
  { kind: "tags.get", id: 3 },
  { kind: "notes.latestByTag", tagId: 2 },
  { kind: "conversations.list", limit: 5 },
  { kind: "conversations.get", id: 1 },
  { kind: "messages.listByConversation", conversationId: 1, limit: 5 },
  { kind: "messages.listByTag", tagId: 2 },
  { kind: "messages.get", id: 7 },
  { kind: "compactions.listByConversation", conversationId: 1, limit: 1 },
  { kind: "canvases.list", includeDeleted: true },
  { kind: "canvases.get", id: "canvas-1" },
  { kind: "activity.list", source: "chat", limit: 5 },
  {
    kind: "knowledge.listSources",
    sourceTypes: ["record"],
    statuses: ["ready"],
  },
  { kind: "knowledge.getSource", sourceKey: "record:1" },
  { kind: "knowledge.stats" },
  { kind: "vector.summaries" },
  { kind: "wiki.getSourceState", contextId: "ctx-1", stableId: "stable-1" },
  { kind: "wiki.listSourceStates", contextId: "ctx-1" },
  { kind: "wiki.getRevision", contextId: "ctx-1", id: "rev-1" },
  {
    kind: "wiki.findRevisionByInputHash",
    contextId: "ctx-1",
    inputHash: "in-1",
  },
  { kind: "wiki.getActiveRevisions", contextId: "ctx-1" },
  { kind: "wiki.listPages", contextId: "ctx-1" },
  { kind: "wiki.getPage", contextId: "ctx-1", id: "page-1" },
  { kind: "wiki.listJobs", contextId: "ctx-1" },
  { kind: "wiki.getSegment", contextId: "ctx-1", key: "seg-1" },
  { kind: "wiki.getMeta", contextId: "ctx-1", key: "dirty" },
  { kind: "memories.list", status: "active" },
  { kind: "memories.get", id: "mem-1" },
  { kind: "memories.stats" },
  { kind: "policy.get" },
  { kind: "imageCache.get", cacheKey: "cache-1" },
  // Writes (40).
  {
    kind: "marks.create",
    mark: { tagId: 1, type: "text", url: "" },
    tagIds: [1],
    activity: { title: "Created" },
  },
  {
    kind: "marks.update",
    id: 1,
    patch: { content: "updated" },
    expected: { version: 2 },
  },
  { kind: "marks.softDelete", id: 1 },
  { kind: "marks.restore", id: 1 },
  { kind: "marks.deletePermanent", id: 1 },
  { kind: "marks.emptyTrash" },
  {
    kind: "marks.updateTags",
    id: 1,
    tagIds: [1, 2],
    expected: { tagIds: [1], primaryTagId: 1 },
  },
  { kind: "marks.saveTagIds", id: 1, tagId: 1, tagIds: [1] },
  { kind: "tags.create", name: "tag-name" },
  { kind: "tags.rename", id: 1, name: "new-name", isPin: true },
  { kind: "tags.reorder", order: [{ id: 1, sortOrder: 0 }] },
  { kind: "tags.delete", id: 1, reassignTo: 2 },
  {
    kind: "notes.insert",
    note: { tagId: 1, locale: "en", count: "1" },
  },
  { kind: "conversations.create", title: "Conversation" },
  {
    kind: "conversations.update",
    id: 1,
    patch: { title: "Renamed", isPinned: true },
  },
  { kind: "conversations.delete", id: 1 },
  {
    kind: "messages.append",
    message: { role: "user", type: "chat", inserted: false },
  },
  {
    kind: "messages.update",
    id: 1,
    patch: { content: "edited" },
    expectedAgentHistory: null,
  },
  { kind: "messages.delete", id: 1 },
  {
    kind: "compactions.insert",
    compaction: {
      conversationId: 1,
      summary: "Summary",
      coveredThroughChatId: 5,
      sourceTokenCount: 10,
      summaryTokenCount: 2,
      model: "model-1",
      promptVersion: 1,
      retainedTurnCount: 2,
      prunedToolResultCount: 0,
      prunedToolTokenCount: 0,
    },
  },
  {
    kind: "canvases.create",
    canvas: { id: "canvas-1", title: "Canvas", canvasType: "blank" },
  },
  {
    kind: "canvases.save",
    id: "canvas-1",
    patch: { title: "Renamed" },
    expected: { version: 1 },
  },
  { kind: "canvases.softDelete", id: "canvas-1" },
  { kind: "canvases.restore", id: "canvas-1" },
  {
    kind: "activity.insert",
    event: { source: "record", title: "Activity" },
  },
  { kind: "knowledge.upsertSource", source: KNOWLEDGE_SOURCE },
  {
    kind: "knowledge.updateStatus",
    sourceKey: "record:1",
    update: { status: "ready" },
  },
  { kind: "knowledge.removeSource", sourceKey: "record:1" },
  { kind: "vector.clear" },
  {
    kind: "vector.replaceChunks",
    sourceType: VECTOR_SOURCE_TYPE,
    sourceId: "1",
    chunks: [{ chunkId: 1, content: "chunk", embedding: "[0.1]" }],
  },
  { kind: "wiki.upsertSource", state: WIKI_STATE },
  {
    kind: "wiki.commitRevision",
    revision: WIKI_REVISION,
    pages: [WIKI_PAGE],
  },
  { kind: "wiki.upsertPage", page: WIKI_PAGE },
  { kind: "wiki.upsertJob", job: WIKI_JOB },
  {
    kind: "wiki.removeJob",
    contextId: "ctx-1",
    id: "job-1",
    expectedInputHash: "in-1",
  },
  {
    kind: "wiki.putSegment",
    contextId: "ctx-1",
    key: "seg-1",
    value: WIKI_SEGMENT,
  },
  { kind: "wiki.putMeta", contextId: "ctx-1", key: "dirty", value: true },
  { kind: "memories.create", input: { content: "memory content" } },
  {
    kind: "memories.update",
    id: "mem-1",
    updates: { status: "archived" },
  },
  { kind: "memories.delete", id: "mem-1" },
  { kind: "policy.put", policy: { generateMemories: true } },
  {
    kind: "imageCache.put",
    entry: { cacheKey: "cache-1", imageHash: "h-1", queryHash: "q-1" },
  },
];

// The server-only kind is a unified operation but never a client one:
// the same fixture list minus that kind must satisfy the client type.
const CLIENT_OPERATIONS: ReconciledClientOperation[] =
  ALL_OPERATIONS.filter(
    (op): op is ReconciledClientOperation =>
      op.kind !== "vector.replaceChunks",
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set([
  "sql",
  "query",
  "statement",
  "table",
  "columns",
  "raw",
  "workspaceId",
  "workspace_id",
]);

function collectKeys(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectKeys(entry, found);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      collectKeys(child, found);
    }
  }
}

function readSibling(relativePath: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, relativePath), "utf8");
}

function stripLineComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const index = line.indexOf("//");
      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Catalog membership, wave, and exposure facts
// ---------------------------------------------------------------------------

describe("reconciled catalog membership", () => {
  it("covers 73 catalog kinds plus the ratified messages.get delta", () => {
    const catalogHasMessagesGet = (
      SQL_READ_OP_KINDS as readonly string[]
    ).includes("messages.get");
    expect(SQL_READ_OP_KINDS.length).toBe(
      catalogHasMessagesGet ? 34 : 33,
    );
    expect(SQL_WRITE_OP_KINDS.length).toBe(42);
    expect(SQL_OP_KINDS.length).toBe(catalogHasMessagesGet ? 76 : 75);
    expect(new Set(SQL_OP_KINDS).size).toBe(SQL_OP_KINDS.length);
    const readSet = new Set<string>(SQL_READ_OP_KINDS);
    for (const kind of SQL_WRITE_OP_KINDS) {
      expect(readSet.has(kind)).toBe(false);
    }
    const metadataKinds = Object.keys(SQL_OP_METADATA);
    expect(new Set(metadataKinds).size).toBe(SQL_OP_KINDS.length);
    expect(metadataKinds.sort()).toEqual([...SQL_OP_KINDS].sort());
  });

  it("keeps the locked W1/W2 split and the single server-only kind", () => {
    const catalogHasMessagesGet = (
      SQL_READ_OP_KINDS as readonly string[]
    ).includes("messages.get");
    const entries = Object.values(SQL_OP_METADATA);
    const w1 = entries.filter((entry) => entry.wave === "W1").length;
    const w2 = entries.filter((entry) => entry.wave === "W2").length;
    expect(w1).toBe(catalogHasMessagesGet ? 64 : 63);
    expect(w2).toBe(12);
    const serverOnly = Object.entries(SQL_OP_METADATA)
      .filter(([, entry]) => entry.exposure === "server-only")
      .map(([kind]) => kind);
    expect(serverOnly).toEqual(["vector.replaceChunks"]);
  });
});

// ---------------------------------------------------------------------------
// Every kind expressible in the unified form
// ---------------------------------------------------------------------------

describe("unified operation expressibility", () => {
  it("holds one fixture per unified kind, no duplicates, no extras", () => {
    expect(ALL_OPERATIONS.length).toBe(76);
    const kinds = ALL_OPERATIONS.map((op) => op.kind);
    expect(new Set(kinds).size).toBe(76);
    const expected = new Set<string>([
      ...SQL_OP_KINDS,
      "messages.get",
    ]);
    expect(new Set(kinds)).toEqual(expected);
  });

  it("excludes the server-only kind from the client subset", () => {
    expect(CLIENT_OPERATIONS.length).toBe(75);
    for (const op of CLIENT_OPERATIONS) {
      expect(op.kind).not.toBe("vector.replaceChunks");
    }
  });

  it("rejects a ghost kind as a unified operation", () => {
    // Type-level pin: the single-line assignment below must not
    // typecheck (kept on one line so the error lands on the line the
    // directive covers).
    // @ts-expect-error ghost kinds have no unified operation (D/G 6.3).
    const ghost: ReconciledOperation = { kind: "knowledge.claimSource", sourceType: "record", sourceId: "1" };
    expect(ghost).toBeDefined();
  });

  it("rejects an operation carrying a SQL field", () => {
    // Type-level pin: excess-property checking must refuse the
    // field (kept on one line so the error lands on the line the
    // directive covers).
    // @ts-expect-error no unified operation carries a SQL field (AD-26).
    const smuggled: ReconciledOperation = { kind: "marks.get", id: 1, sql: "select 1" };
    expect(smuggled).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// No SQL, table, column, or workspace identifiers: runtime + static
// ---------------------------------------------------------------------------

describe("no SQL reaches the client", () => {
  it("finds no forbidden key in any fixture payload, nested included", () => {
    const found = new Set<string>();
    for (const op of ALL_OPERATIONS) {
      collectKeys(op, found);
    }
    const forbidden = [...found].filter((key) => FORBIDDEN_KEYS.has(key));
    expect(forbidden).toEqual([]);
  });

  it("finds no forbidden field in the catalog union text", () => {
    const text = stripLineComments(readSibling("./ops-catalog.ts"));
    const readStart = text.indexOf("export type DbReadOperation");
    const writeStart = text.indexOf("export type DbWriteOperation");
    const writeEnd = text.indexOf("export type DbOperation");
    expect(readStart).toBeGreaterThan(-1);
    expect(writeStart).toBeGreaterThan(readStart);
    expect(writeEnd).toBeGreaterThan(writeStart);
    const unions = text.slice(readStart, writeEnd);
    const pattern =
      /\b(sql|query|statement|table|columns|raw|workspaceId|workspace_id)\s*\?:/g;
    expect([...unions.matchAll(pattern)]).toEqual([]);
  });

  it("keeps the reconciled file free of G0 code, em dashes, and values", () => {
    const text = readSibling("./reconciled-forms.ts");
    expect(text).toContain("ReconciledSqlAdapter");
    expect(text).toContain("messages.get");
    // Comment mentions of the banned names are the established
    // convention (the AD-26 stub names them while forbidding them);
    // what must never return is a declaration or a type use.
    expect(text).not.toMatch(
      /\b(interface|type|class|enum)\s+(SqlDatabase|QueryResult)\b/,
    );
    expect(text).not.toMatch(/\b(SqlDatabase|QueryResult)\s*[<(]/);
    expect(text).not.toMatch(/:\s*(SqlDatabase|QueryResult)\b/);
    expect(text).not.toMatch(/extends\s+(SqlDatabase|QueryResult)\b/);
    expect(text).not.toContain("\u2014");
    expect(text).not.toMatch(/export const /);
    expect(text).not.toMatch(/export function /);
    expect(text).not.toMatch(/export class /);
    expect(text).not.toMatch(/export default /);
  });

  it("finds no em dash in the catalog or the mirror at this base", () => {
    expect(readSibling("./ops-catalog.ts")).not.toContain("\u2014");
    expect(
      readSibling("../../../../tests/contract/contract-types.ts"),
    ).not.toContain("\u2014");
  });
});
