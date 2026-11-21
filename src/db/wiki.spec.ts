// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for the wiki catalog migration (src/db/wiki.ts,
// UTANG-UJI-09): every read and write runs through typed
// `wiki.*` catalog kinds over a fake SqlAdapter. No test sends
// real HTTP and no test touches a database. The fake mirrors
// the server kind handlers for the read kinds (W1) and records
// write operations (W2 in Fase 1) so the specs prove the
// client-side mapping: kind names, payload shapes, the
// commitRevision committed flag, and the markWikiSynced
// version check. Live verification against the real handlers
// runs in the U03 rerun after this fix lands.
//
// Run: `pnpm vitest run --project unit src/db/wiki.spec.ts`
// from the repo root.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPlatformForTests,
  registerPlatformAdapter,
  type SqlAdapter,
} from "../lib/platform";
import type {
  DbReadOperation,
  DbWriteOperation,
} from "../lib/platform/sql/ops-catalog";
import type {
  WikiJob,
  WikiPage,
  WikiSegmentCache,
  WikiSourceRevision,
  WikiSourceState,
} from "@/types/wiki";
import {
  cacheWikiMarkdownDocument,
  commitWikiSourceRevision,
  findWikiRevision,
  getActiveWikiRevisions,
  getWikiMeta,
  getWikiPage,
  getWikiSegmentCache,
  getWikiSourceState,
  getWikiSyncDirty,
  getWikiUsage,
  listWikiJobs,
  listWikiPages,
  listWikiSourceStates,
  markWikiSynced,
  recordWikiUsage,
  removeWikiJob,
  removeWikiMarkdownCache,
  saveWikiSegmentCache,
  setWikiMeta,
  upsertWikiJob,
  upsertWikiPage,
  upsertWikiSourceState,
} from "./wiki";

const mocks = vi.hoisted(() => ({
  writeWikiPageFile: vi.fn(async (page: WikiPage) => page),
}));

vi.mock("@/lib/wiki/files", () => ({
  writeWikiPageFile: (page: WikiPage) => mocks.writeWikiPageFile(page),
}));

const CTX = "ctx-test";

function sourceRef(stableId: string, contentHash = "hash-1") {
  return {
    sourceKey: `article:${stableId}`,
    stableId,
    sourceType: "article" as const,
    title: stableId,
    contentHash,
    locator: { filePath: `${stableId}.md` },
    syncDomain: "library" as const,
  };
}

function makeState(partial: Partial<WikiSourceState> & { stableId: string }): WikiSourceState {
  return {
    contextId: CTX,
    sourceKey: `article:${partial.stableId}`,
    sourceType: "article",
    source: sourceRef(partial.stableId),
    contentHash: "hash-1",
    status: "ready",
    revisionId: null,
    version: 1,
    updatedAt: 1000,
    error: null,
    ...partial,
  };
}

function makePage(partial: Partial<WikiPage> & { id: string }): WikiPage {
  return {
    contextId: CTX,
    kind: "topic",
    title: partial.id,
    aliases: [],
    body: "body",
    sourceRefs: [],
    inputHash: "in-1",
    outputHash: "out-1",
    updatedAt: 1000,
    status: "ready",
    relatedPageIds: [],
    ...partial,
  };
}

function makeRevision(partial: Partial<WikiSourceRevision> & { id: string; stableId: string }): WikiSourceRevision {
  return {
    contextId: CTX,
    inputHash: "in-1",
    outputHash: "out-1",
    pipelineVersion: "v1",
    generation: 1,
    language: "en",
    source: sourceRef(partial.stableId),
    summary: "summary",
    contributions: [],
    createdAt: 1000,
    modelId: "model",
    usage: { inputTokens: 0, outputTokens: 0, estimated: false },
    ...partial,
  };
}

class FakeSqlAdapter {
  readonly mode = "web" as const;
  readonly ops: unknown[] = [];
  readonly sources = new Map<string, WikiSourceState>();
  readonly revisions = new Map<string, WikiSourceRevision>();
  readonly pages = new Map<string, WikiPage>();
  readonly jobs = new Map<string, WikiJob>();
  readonly segments = new Map<string, WikiSegmentCache>();
  readonly meta = new Map<string, unknown>();
  commitResult = true;

  async ready() {
    return { ok: true, mode: "web" as const, migrationsCurrent: true };
  }

  async query(op: DbReadOperation): Promise<unknown[]> {
    this.ops.push(op);
    switch (op.kind) {
      case "wiki.getSourceState": {
        const row = this.sources.get(`${op.contextId}:${op.stableId}`);
        return row === undefined ? [] : [row];
      }
      case "wiki.listSourceStates":
        return [...this.sources.values()].filter((s) => s.contextId === op.contextId);
      case "wiki.getRevision": {
        const row = this.revisions.get(`${op.contextId}:${op.id}`);
        return row === undefined ? [] : [row];
      }
      case "wiki.findRevisionByInputHash":
        return [...this.revisions.values()]
          .filter((r) => r.contextId === op.contextId && r.inputHash === op.inputHash)
          .sort((a, b) => a.outputHash.localeCompare(b.outputHash))
          .slice(0, 1);
      case "wiki.getActiveRevisions": {
        const active: WikiSourceRevision[] = [];
        for (const revision of this.revisions.values()) {
          if (revision.contextId !== op.contextId) continue;
          const state = this.sources.get(`${op.contextId}:${revision.source.stableId}`);
          if (
            state !== undefined &&
            state.status === "ready" &&
            state.revisionId === revision.id &&
            state.contentHash === revision.source.contentHash
          ) {
            active.push({ ...revision, source: state.source });
          }
        }
        return active;
      }
      case "wiki.listPages":
        return [...this.pages.values()].filter((p) => p.contextId === op.contextId);
      case "wiki.getPage": {
        const row = this.pages.get(`${op.contextId}:${op.id}`);
        return row === undefined ? [] : [row];
      }
      case "wiki.listJobs":
        return [...this.jobs.values()]
          .filter((j) => j.contextId === op.contextId)
          .sort((a, b) => a.readyAt - b.readyAt);
      case "wiki.getSegment": {
        const row = this.segments.get(`${op.contextId}:${op.key}`);
        return row === undefined ? [] : [row];
      }
      case "wiki.getMeta": {
        const key = `${op.contextId}:${op.key}`;
        return this.meta.has(key) ? [this.meta.get(key)] : [];
      }
      default:
        throw new Error(`fake query kind not implemented: ${op.kind}`);
    }
  }

  async queryOne(op: DbReadOperation): Promise<unknown> {
    const rows = await this.query(op);
    return rows[0] ?? null;
  }

  async queryMany(ops: readonly DbReadOperation[]): Promise<unknown[][]> {
    const results: unknown[][] = [];
    for (const op of ops) results.push(await this.query(op));
    return results;
  }

  async execute(op: DbWriteOperation): Promise<unknown> {
    this.ops.push(op);
    switch (op.kind) {
      case "wiki.upsertSource":
        this.sources.set(`${op.state.contextId}:${op.state.stableId}`, op.state);
        this.meta.set(`${op.state.contextId}:dirty`, true);
        return { affected: 1 };
      case "wiki.commitRevision":
        return { affected: this.commitResult ? 1 : 0, committed: this.commitResult };
      case "wiki.upsertPage":
        this.pages.set(`${op.page.contextId}:${op.page.id}`, op.page);
        this.meta.set(`${op.page.contextId}:dirty`, true);
        return { affected: 1 };
      case "wiki.upsertJob":
        this.jobs.set(`${op.job.contextId}:${op.job.id}`, op.job);
        return { affected: 1 };
      case "wiki.removeJob": {
        const key = `${op.contextId}:${op.id}`;
        const current = this.jobs.get(key);
        if (op.expectedInputHash !== undefined && current?.inputHash !== op.expectedInputHash) {
          return { affected: 0 };
        }
        this.jobs.delete(key);
        return { affected: 1 };
      }
      case "wiki.putSegment":
        this.segments.set(`${op.contextId}:${op.key}`, op.value);
        return { affected: 1 };
      case "wiki.putMeta": {
        this.meta.set(`${op.contextId}:${op.key}`, op.value);
        if (op.key === "dirty" && op.value === true) {
          const versionKey = `${op.contextId}:dirty-version`;
          this.meta.set(versionKey, (this.meta.get(versionKey) as number | undefined ?? 0) + 1);
        }
        return { affected: 1 };
      }
      default:
        throw new Error(`fake execute kind not implemented: ${op.kind}`);
    }
  }

  async transaction(ops: readonly DbWriteOperation[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const op of ops) results.push(await this.execute(op));
    return results;
  }

  async close(): Promise<void> {}
}

let fakeSql: FakeSqlAdapter;

beforeEach(() => {
  fakeSql = new FakeSqlAdapter();
  mocks.writeWikiPageFile.mockClear();
  __resetPlatformForTests();
  registerPlatformAdapter("sql", fakeSql as unknown as SqlAdapter, ["web"]);
});

function opKinds(): string[] {
  return fakeSql.ops.map((op) => (op as { kind: string }).kind);
}

describe("wiki reads through catalog kinds (UTANG-UJI-09)", () => {
  it("reads pages, jobs, sources, and meta through wiki.* kinds only", async () => {
    fakeSql.pages.set(`${CTX}:p1`, makePage({ id: "p1" }));
    fakeSql.jobs.set(`${CTX}:j1`, {
      id: "j1", contextId: CTX, sourceKey: "article:a", kind: "source",
      inputHash: "in-1", status: "pending", stage: "queued", attempts: 0,
      readyAt: 5, updatedAt: 5, error: null,
    });
    fakeSql.sources.set(`${CTX}:a`, makeState({ stableId: "a" }));
    fakeSql.meta.set(`${CTX}:usage`, { inputTokens: 3, outputTokens: 4, estimated: true });

    expect(await listWikiPages(CTX)).toHaveLength(1);
    expect(await getWikiPage(CTX, "p1")).toMatchObject({ id: "p1" });
    expect(await getWikiPage(CTX, "missing")).toBeNull();
    expect(await listWikiJobs(CTX)).toHaveLength(1);
    expect(await listWikiSourceStates(CTX)).toHaveLength(1);
    expect(await getWikiSourceState(CTX, "a")).toMatchObject({ stableId: "a" });
    expect(await getWikiUsage(CTX)).toEqual({ inputTokens: 3, outputTokens: 4, estimated: true });
    expect(await getWikiMeta(CTX, "missing-key")).toBeNull();
    expect(opKinds().every((kind) => kind.startsWith("wiki."))).toBe(true);
  });

  it("getWikiUsage falls back to zeros and sync dirty to false", async () => {
    expect(await getWikiUsage(CTX)).toEqual({ inputTokens: 0, outputTokens: 0, estimated: false });
    expect(await getWikiSyncDirty(CTX)).toBe(false);
  });

  it("findWikiRevision picks the lowest outputHash and active revisions follow server rules", async () => {
    fakeSql.sources.set(`${CTX}:a`, makeState({ stableId: "a", revisionId: "r2" }));
    fakeSql.revisions.set(`${CTX}:r1`, makeRevision({ id: "r1", stableId: "a", outputHash: "out-b" }));
    fakeSql.revisions.set(`${CTX}:r2`, makeRevision({ id: "r2", stableId: "a", outputHash: "out-a" }));
    expect((await findWikiRevision(CTX, "in-1"))?.id).toBe("r2");
    const active = await getActiveWikiRevisions(CTX);
    expect(active.map((r) => r.id)).toEqual(["r2"]);
  });

  it("segment cache round-trips through getSegment/putSegment", async () => {
    const value: WikiSegmentCache = {
      summary: "s", contributions: [], usage: { inputTokens: 1, outputTokens: 2, estimated: false },
    };
    await saveWikiSegmentCache(CTX, "seg-1", value);
    expect(await getWikiSegmentCache(CTX, "seg-1")).toEqual(value);
    expect(await getWikiSegmentCache(CTX, "nope")).toBeNull();
  });
});

describe("wiki writes through catalog kinds (UTANG-UJI-09)", () => {
  it("setWikiMeta dirty=true advances dirty-version server-side", async () => {
    await setWikiMeta(CTX, "dirty", true);
    expect(await getWikiSyncDirty(CTX)).toBe(true);
    expect(await getWikiMeta<number>(CTX, "dirty-version")).toBe(1);
    await setWikiMeta(CTX, "dirty", true);
    expect(await getWikiMeta<number>(CTX, "dirty-version")).toBe(2);
  });

  it("markWikiSynced clears dirty only when the version still matches", async () => {
    await setWikiMeta(CTX, "dirty", true);
    await markWikiSynced(CTX, 99);
    expect(await getWikiSyncDirty(CTX)).toBe(true);
    await markWikiSynced(CTX, 1);
    expect(await getWikiSyncDirty(CTX)).toBe(false);
  });

  it("upsertWikiSourceState and upsertWikiPage dispatch their kinds", async () => {
    await upsertWikiSourceState(makeState({ stableId: "a" }));
    await upsertWikiPage(makePage({ id: "p1" }));
    expect(mocks.writeWikiPageFile).toHaveBeenCalledTimes(1);
    expect(opKinds()).toContain("wiki.upsertSource");
    expect(opKinds()).toContain("wiki.upsertPage");
  });

  it("removeWikiJob honors the expectedInputHash guard", async () => {
    await upsertWikiJob({
      id: "j1", contextId: CTX, sourceKey: "article:a", kind: "source",
      inputHash: "in-9", status: "pending", stage: "queued", attempts: 0,
      readyAt: 5, updatedAt: 5, error: null,
    });
    await removeWikiJob(CTX, "j1", "in-other");
    expect(await listWikiJobs(CTX)).toHaveLength(1);
    await removeWikiJob(CTX, "j1", "in-9");
    expect(await listWikiJobs(CTX)).toHaveLength(0);
  });

  it("commitWikiSourceRevision persists files first and returns the committed flag", async () => {
    const revision = makeRevision({ id: "r1", stableId: "a" });
    fakeSql.commitResult = true;
    expect(await commitWikiSourceRevision(revision, [makePage({ id: "p1" })], 1)).toBe(true);
    fakeSql.commitResult = false;
    expect(await commitWikiSourceRevision(revision, [makePage({ id: "p1" })], 1)).toBe(false);
    expect(mocks.writeWikiPageFile).toHaveBeenCalledTimes(2);
    expect(opKinds().filter((kind) => kind === "wiki.commitRevision")).toHaveLength(2);
  });

  it("recordWikiUsage accumulates through meta", async () => {
    await recordWikiUsage(CTX, { inputTokens: 2, outputTokens: 3, estimated: false });
    await recordWikiUsage(CTX, { inputTokens: 1, outputTokens: 1, estimated: true });
    expect(await getWikiUsage(CTX)).toEqual({ inputTokens: 3, outputTokens: 4, estimated: true });
  });
});

describe("wiki cache composite ops (UTANG-UJI-09)", () => {
  it("cacheWikiMarkdownDocument upserts a changed page and skips an unchanged one", async () => {
    const page = makePage({ id: "p1" });
    await cacheWikiMarkdownDocument(page);
    expect(fakeSql.pages.get(`${CTX}:p1`)).toMatchObject({ id: "p1" });
    const before = fakeSql.ops.length;
    await cacheWikiMarkdownDocument(page);
    expect(fakeSql.ops.length).toBeGreaterThan(before); // reads still happen
    expect(opKinds().filter((kind) => kind === "wiki.upsertPage")).toHaveLength(1);
  });

  it("removeWikiMarkdownCache marks sources unavailable and keeps newer work", async () => {
    fakeSql.pages.set(`${CTX}:src-page`, makePage({
      id: "src-page", kind: "source", sourceRefs: [sourceRef("a")],
    }));
    fakeSql.sources.set(`${CTX}:a`, makeState({ stableId: "a", status: "ready", revisionId: "r1" }));
    await removeWikiMarkdownCache(CTX, "src-page", "in-1");
    const state = await getWikiSourceState(CTX, "a");
    expect(state?.status).toBe("unavailable");
    expect(state?.revisionId).toBeNull();
    expect(state?.version).toBe(2);
  });
});
