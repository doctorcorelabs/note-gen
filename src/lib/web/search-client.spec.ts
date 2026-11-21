// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the keyword search client (search-client.ts),
 * using the repo convention (node:test with node:assert/strict).
 * Run through scripts/run-adapter-tests.mjs like the other
 * src/lib/web node:test suites. No test sends real HTTP: every
 * case uses an injected fake fetch through ApiClient.
 *
 * Coverage contract: keyword search sends exactly one shape of
 * request (GET /api/search, no mode, no workspace id), never calls
 * the fuzzy endpoint, fails closed on malformed responses instead
 * of rendering invented results, and maps the fuzzy 501 to the
 * typed FuzzySearchUnavailableError, never to an empty list.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiClient } from "./api-client";
import { ApiError, FuzzySearchUnavailableError } from "./errors";
import {
  buildKeywordSearchQuery,
  highlightSnippetSegments,
  mergeKeywordSearchPages,
  normalizeSearchQuery,
  parseKeywordSearchResponse,
  recordResultTagId,
  requestFuzzyScoring,
  scopeForSearchFilter,
  searchKeyword,
  searchResultKey,
  type FuzzyScoringRequest,
  type KeywordSearchFileResult,
  type KeywordSearchRecordResult,
  type KeywordSearchResponse,
} from "./search-client";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

type Responder = (call: CapturedCall) => Response | Promise<Response>;

function fakeResponse(status: number, body: string): Response {
  const response = {
    status,
    headers: {
      get(): string | null {
        return null;
      },
    },
    text: async (): Promise<string> => body,
    arrayBuffer: async (): Promise<ArrayBuffer> =>
      new TextEncoder().encode(body).buffer as ArrayBuffer,
  };
  return response as unknown as Response;
}

function makeFetch(responder: Responder): { fetchFn: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: CapturedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function successBody(data: unknown): string {
  return JSON.stringify({ ok: true, data });
}

function errorBody(
  code: string,
  overrides: { message?: string; retryable?: boolean } = {},
): string {
  return JSON.stringify({
    ok: false,
    error: {
      code,
      message: overrides.message ?? "Something went wrong.",
      requestId: "req-test-1",
      retryable: overrides.retryable ?? false,
      details: {},
    },
  });
}

const FUZZY_STATUS = {
  available: false,
  reason: "not_in_mvp",
  message: "Fuzzy matching is not available in this version. Results below are keyword matches only.",
};

function keywordData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: "gagal jantung",
    scope: "all",
    results: [
      {
        kind: "record",
        id: 42,
        title: "Catatan gagal jantung",
        snippet: "...tanda gagal jantung kanan...",
        snippetField: "content",
        snippetMatches: [{ start: 9, end: 24 }],
        score: 12.5,
        type: "text",
        tagIds: [3],
        url: "",
        updatedAt: 1794660000000,
        createdAt: 1794660000000,
      },
      {
        kind: "file",
        path: "kardiologi/gagal-jantung.md",
        title: "gagal-jantung.md",
        snippet: "...tatalaksana gagal jantung akut...",
        snippetField: "content",
        snippetMatches: [{ start: 14, end: 29 }],
        score: 9.0,
        contentHash: "sha256:7be1c2",
        version: 4,
        updatedAt: 1794660000000,
      },
    ],
    nextCursor: null,
    hasMore: false,
    fuzzy: { ...FUZZY_STATUS },
    degraded: false,
    ...overrides,
  };
}

function recordResult(overrides: Partial<KeywordSearchRecordResult> = {}): KeywordSearchRecordResult {
  return {
    kind: "record",
    id: 42,
    title: "Catatan gagal jantung",
    snippet: "tanda gagal jantung",
    snippetField: "content",
    snippetMatches: [],
    score: 1,
    type: "text",
    tagIds: [3, 7],
    url: "",
    updatedAt: 10,
    createdAt: 10,
    ...overrides,
  };
}

describe("normalizeSearchQuery", () => {
  it("trims surrounding whitespace", () => {
    assert.equal(normalizeSearchQuery("  gagal jantung  "), "gagal jantung");
  });

  it("returns null for empty and whitespace-only input", () => {
    assert.equal(normalizeSearchQuery(""), null);
    assert.equal(normalizeSearchQuery("   "), null);
  });

  it("returns null for non-string input", () => {
    assert.equal(normalizeSearchQuery(undefined), null);
    assert.equal(normalizeSearchQuery(42), null);
  });

  it("accepts exactly 200 characters and rejects 201", () => {
    assert.equal(normalizeSearchQuery("a".repeat(200))?.length, 200);
    assert.equal(normalizeSearchQuery("a".repeat(201)), null);
  });
});

describe("scopeForSearchFilter", () => {
  it("maps dialog filters to wire scopes", () => {
    assert.equal(scopeForSearchFilter("all"), "all");
    assert.equal(scopeForSearchFilter("record"), "records");
    assert.equal(scopeForSearchFilter("article"), "files");
  });
});

describe("buildKeywordSearchQuery", () => {
  it("carries q, scope, and limit without mode or workspace id", () => {
    const query = buildKeywordSearchQuery({ query: "gagal", scope: "all", limit: 50 });
    assert.deepEqual(query, { q: "gagal", scope: "all", limit: 50 });
    assert.equal("mode" in query, false);
    assert.equal("workspaceId" in query, false);
  });

  it("carries a cursor only when one is passed", () => {
    const withCursor = buildKeywordSearchQuery({
      query: "gagal",
      scope: "records",
      cursor: "opaque-cursor",
      limit: 50,
    });
    assert.equal(withCursor.cursor, "opaque-cursor");
    const withoutCursor = buildKeywordSearchQuery({ query: "gagal", scope: "records", limit: 50 });
    assert.equal("cursor" in withoutCursor, false);
  });
});

describe("searchKeyword", () => {
  it("sends one GET to /api/search and parses records and files", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse(200, successBody(keywordData())));
    const client = new ApiClient({ fetchFn });
    const response = await searchKeyword(client, { query: "  gagal jantung " });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init.method, "GET");
    const url = new URL(calls[0]?.url ?? "", "http://localhost");
    assert.equal(url.pathname, "/api/search");
    assert.equal(url.searchParams.get("q"), "gagal jantung");
    assert.equal(url.searchParams.get("scope"), "all");
    assert.equal(url.searchParams.get("limit"), "50");
    assert.equal(url.searchParams.has("mode"), false);
    assert.equal(response.results.length, 2);
    assert.equal(response.results[0]?.kind, "record");
    assert.equal(response.results[1]?.kind, "file");
    assert.deepEqual(response.fuzzy, FUZZY_STATUS);
    assert.equal(response.degraded, false);
  });

  it("parses a degraded true flag from the wire (F-15-03)", async () => {
    const { fetchFn } = makeFetch(() =>
      fakeResponse(200, successBody(keywordData({ degraded: true }))),
    );
    const client = new ApiClient({ fetchFn });
    const response = await searchKeyword(client, { query: "gagal jantung", scope: "all" });
    assert.equal(response.degraded, true);
  });

  it("maps scope and cursor onto the request", async () => {
    const { fetchFn, calls } = makeFetch(() =>
      fakeResponse(200, successBody(keywordData({ scope: "files", results: [] }))),
    );
    const client = new ApiClient({ fetchFn });
    await searchKeyword(client, { query: "gagal", scope: "files", cursor: "c1", limit: 10 });
    const url = new URL(calls[0]?.url ?? "", "http://localhost");
    assert.equal(url.searchParams.get("scope"), "files");
    assert.equal(url.searchParams.get("cursor"), "c1");
    assert.equal(url.searchParams.get("limit"), "10");
  });

  it("clamps a limit above 200 to 200", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse(200, successBody(keywordData())));
    const client = new ApiClient({ fetchFn });
    await searchKeyword(client, { query: "gagal", limit: 500 });
    const url = new URL(calls[0]?.url ?? "", "http://localhost");
    assert.equal(url.searchParams.get("limit"), "200");
  });

  it("rejects an invalid limit before any fetch", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse(200, successBody(keywordData())));
    const client = new ApiClient({ fetchFn });
    await assert.rejects(searchKeyword(client, { query: "gagal", limit: 0 }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.localCode, "VALIDATION_ERROR");
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("rejects an empty query before any fetch", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse(200, successBody(keywordData())));
    const client = new ApiClient({ fetchFn });
    await assert.rejects(searchKeyword(client, { query: "   " }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.localCode, "VALIDATION_ERROR");
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("rejects an overlong query before any fetch", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse(200, successBody(keywordData())));
    const client = new ApiClient({ fetchFn });
    await assert.rejects(searchKeyword(client, { query: "a".repeat(201) }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.localCode, "VALIDATION_ERROR");
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("throws the wire validation error instead of an empty list", async () => {
    const { fetchFn, calls } = makeFetch(() =>
      fakeResponse(400, errorBody("validation_failed")),
    );
    const client = new ApiClient({ fetchFn });
    await assert.rejects(searchKeyword(client, { query: "gagal" }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.localCode, "VALIDATION_ERROR");
      assert.equal(error.status, 400);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("never calls the fuzzy endpoint", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse(200, successBody(keywordData())));
    const client = new ApiClient({ fetchFn });
    await searchKeyword(client, { query: "gagal" });
    await searchKeyword(client, { query: "jantung", scope: "records" });
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(call.url.split("?")[0], "/api/search");
    }
  });

  it("returns an empty results array only for a valid empty page", async () => {
    const { fetchFn } = makeFetch(() =>
      fakeResponse(200, successBody(keywordData({ results: [], hasMore: false }))),
    );
    const client = new ApiClient({ fetchFn });
    const response: KeywordSearchResponse = await searchKeyword(client, { query: "zzz-no-match" });
    assert.deepEqual(response.results, []);
    assert.equal(response.hasMore, false);
    assert.equal(response.fuzzy.available, false);
  });
});

describe("parseKeywordSearchResponse", () => {
  it("fails closed when results is not an array", () => {
    assert.throws(() => parseKeywordSearchResponse(keywordData({ results: "nope" })), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.localCode, "SERVER_ERROR");
      return true;
    });
  });

  it("fails closed when the fuzzy block is missing", () => {
    const data = keywordData();
    delete data.fuzzy;
    assert.throws(() => parseKeywordSearchResponse(data), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.localCode, "SERVER_ERROR");
      return true;
    });
  });

  it("fails closed on an unknown result kind", () => {
    const bad = keywordData({
      results: [{ kind: "canvas", id: "c1", title: "Canvas", snippet: "", snippetField: "content", snippetMatches: [], score: 1, updatedAt: 1 }],
    });
    assert.throws(() => parseKeywordSearchResponse(bad), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      return true;
    });
  });

  it("fails closed when a record result misses a required field", () => {
    const bad = keywordData({
      results: [{ kind: "record", title: "x", snippet: "", snippetField: "content", snippetMatches: [], score: 1, type: "text", tagIds: [], url: "", updatedAt: 1, createdAt: 1 }],
    });
    assert.throws(() => parseKeywordSearchResponse(bad), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      return true;
    });
  });

  it("passes a future fuzzy-available block through unchanged", () => {
    const response = parseKeywordSearchResponse(
      keywordData({ fuzzy: { available: true, reason: "ready", message: "Fuzzy matching is available." } }),
    );
    assert.equal(response.fuzzy.available, true);
    assert.equal(response.fuzzy.reason, "ready");
  });
});

describe("requestFuzzyScoring", () => {
  const request: FuzzyScoringRequest = {
    query: "ggl jnt",
    items: [{ id: "record:42", keys: { title: "Catatan gagal jantung" } }],
    keys: ["title"],
    limit: 20,
  };

  it("maps the MVP 501 to FuzzySearchUnavailableError, never an empty list", async () => {
    const { fetchFn, calls } = makeFetch(() =>
      fakeResponse(501, errorBody("fuzzy_search_unavailable", { message: "Fuzzy search is not available yet. Keyword search still works.", retryable: false })),
    );
    const client = new ApiClient({ fetchFn });
    await assert.rejects(requestFuzzyScoring(client, request), (error: unknown) => {
      assert.ok(error instanceof FuzzySearchUnavailableError);
      assert.equal(error.status, 501);
      assert.equal(error.wireCode, "fuzzy_search_unavailable");
      assert.equal(error.retryable, false);
      assert.equal(Array.isArray(error), false);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "/api/search/fuzzy");
    assert.equal(calls[0]?.init.method, "POST");
  });

  it("sends the reserved Fase 2 body shape", async () => {
    const { fetchFn, calls } = makeFetch(() =>
      fakeResponse(200, successBody({ query: "ggl jnt", results: [{ id: "record:42", score: 87, ranges: [{ key: "title", start: 8, end: 21 }] }], degraded: false })),
    );
    const client = new ApiClient({ fetchFn });
    const response = await requestFuzzyScoring(client, request);
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    assert.equal(sent.query, "ggl jnt");
    assert.deepEqual(sent.keys, ["title"]);
    assert.equal(sent.limit, 20);
    assert.equal("workspaceId" in sent, false);
    assert.equal(response.results[0]?.id, "record:42");
    assert.equal(response.results[0]?.ranges[0]?.start, 8);
  });

  it("rejects an empty items array before any fetch", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse(501, errorBody("fuzzy_search_unavailable")));
    const client = new ApiClient({ fetchFn });
    await assert.rejects(requestFuzzyScoring(client, { ...request, items: [] }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.localCode, "VALIDATION_ERROR");
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("rejects an empty keys array before any fetch", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse(501, errorBody("fuzzy_search_unavailable")));
    const client = new ApiClient({ fetchFn });
    await assert.rejects(requestFuzzyScoring(client, { ...request, keys: [] }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("rejects a body limit above 200 before any fetch", async () => {
    const { fetchFn, calls } = makeFetch(() => fakeResponse(501, errorBody("fuzzy_search_unavailable")));
    const client = new ApiClient({ fetchFn });
    await assert.rejects(requestFuzzyScoring(client, { ...request, limit: 201 }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("fails closed on a malformed scoring response", async () => {
    const { fetchFn } = makeFetch(() =>
      fakeResponse(200, successBody({ query: "ggl jnt", results: [{ id: "record:42" }], degraded: false })),
    );
    const client = new ApiClient({ fetchFn });
    await assert.rejects(requestFuzzyScoring(client, request), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.localCode, "SERVER_ERROR");
      return true;
    });
  });
});

describe("search result helpers", () => {
  it("builds stable keys per kind", () => {
    assert.equal(searchResultKey(recordResult()), "record:42");
    assert.equal(
      searchResultKey({
        kind: "file",
        path: "a/b.md",
        title: "b.md",
        snippet: "",
        snippetField: "content",
        snippetMatches: [],
        score: 1,
        contentHash: "sha256:x",
        version: 1,
        updatedAt: 1,
      }),
      "file:a/b.md",
    );
  });

  it("takes the first tag id as the navigation hint", () => {
    assert.equal(recordResultTagId(recordResult()), 3);
    assert.equal(recordResultTagId(recordResult({ tagIds: [] })), undefined);
  });
});

describe("highlightSnippetSegments", () => {
  it("returns one plain segment when there are no matches", () => {
    assert.deepEqual(highlightSnippetSegments("hello world", []), [
      { text: "hello world", highlighted: false },
    ]);
  });

  it("highlights server offsets inside the snippet", () => {
    assert.deepEqual(highlightSnippetSegments("tanda gagal jantung", [{ start: 6, end: 11 }]), [
      { text: "tanda ", highlighted: false },
      { text: "gagal", highlighted: true },
      { text: " jantung", highlighted: false },
    ]);
  });

  it("handles multiple matches in order", () => {
    assert.deepEqual(
      highlightSnippetSegments("aa bb aa", [
        { start: 6, end: 8 },
        { start: 0, end: 2 },
      ]),
      [
        { text: "aa", highlighted: true },
        { text: " bb ", highlighted: false },
        { text: "aa", highlighted: true },
      ],
    );
  });

  it("drops overlapping and out-of-range matches", () => {
    const segments = highlightSnippetSegments("abcdef", [
      { start: 1, end: 4 },
      { start: 2, end: 5 },
      { start: 10, end: 12 },
      { start: 4, end: 4 },
    ]);
    assert.deepEqual(segments, [
      { text: "a", highlighted: false },
      { text: "bcd", highlighted: true },
      { text: "ef", highlighted: false },
    ]);
  });

  it("clamps matches to the snippet bounds", () => {
    assert.deepEqual(highlightSnippetSegments("abc", [{ start: -5, end: 99 }]), [
      { text: "abc", highlighted: true },
    ]);
  });

  it("returns an empty plain segment for an empty snippet", () => {
    assert.deepEqual(highlightSnippetSegments("", [{ start: 0, end: 1 }]), [
      { text: "", highlighted: false },
    ]);
  });
});

describe("mergeKeywordSearchPages", () => {
  function recordHit(id: number, title?: string): KeywordSearchRecordResult {
    return {
      kind: "record",
      id,
      title: title ?? `Record ${id}`,
      snippet: "snippet",
      snippetField: "content",
      snippetMatches: [],
      score: 1,
      type: "text",
      tagIds: [],
      url: "",
      updatedAt: 1,
      createdAt: 1,
    };
  }

  function fileHit(path: string): KeywordSearchFileResult {
    return {
      kind: "file",
      path,
      title: path,
      snippet: "snippet",
      snippetField: "content",
      snippetMatches: [],
      score: 1,
      contentHash: "hash",
      version: 1,
      updatedAt: 1,
    };
  }

  function pageResponse(
    results: KeywordSearchResponse["results"],
    nextCursor: string | null,
    hasMore: boolean,
    query = "alpha",
    scope: KeywordSearchResponse["scope"] = "all",
  ): KeywordSearchResponse {
    return {
      query,
      scope,
      results,
      nextCursor,
      hasMore,
      fuzzy: {
        available: false,
        reason: "not_in_mvp",
        message: "Fuzzy search is not available in this build.",
      },
      degraded: false,
    };
  }

  it("appends the next page and adopts its cursor and hasMore", () => {
    const merged = mergeKeywordSearchPages(
      pageResponse([recordHit(1)], "c1", true),
      pageResponse([recordHit(2), fileHit("notes/b.md")], null, false),
    );
    assert.deepEqual(
      merged.results.map((result) => searchResultKey(result)),
      ["record:1", "record:2", "file:notes/b.md"],
    );
    assert.equal(merged.nextCursor, null);
    assert.equal(merged.degraded, false);
  });

  it("keeps the merged result degraded when either page was degraded (F-15-03)", () => {
    const degradedPrevious = { ...pageResponse([recordHit(1)], "c1", true), degraded: true };
    const fromPrevious = mergeKeywordSearchPages(
      degradedPrevious,
      pageResponse([recordHit(2)], null, false),
    );
    assert.equal(fromPrevious.degraded, true);
    const degradedPage = { ...pageResponse([recordHit(3)], null, false), degraded: true };
    const merged = mergeKeywordSearchPages(fromPrevious, degradedPage);
    assert.equal(merged.degraded, true);
    assert.equal(merged.hasMore, false);
  });

  it("drops duplicates from an overlapping page, first page wins", () => {
    const merged = mergeKeywordSearchPages(
      pageResponse([recordHit(1, "First")], "c1", true),
      pageResponse([recordHit(1, "Second"), recordHit(2)], null, false),
    );
    assert.equal(merged.results.length, 2);
    assert.equal(merged.results[0]?.title, "First");
  });

  it("keeps accumulated results when the next page is empty", () => {
    const merged = mergeKeywordSearchPages(
      pageResponse([recordHit(1)], "c1", true),
      pageResponse([], null, false),
    );
    assert.equal(merged.results.length, 1);
    assert.equal(merged.hasMore, false);
  });

  it("returns the new page unchanged when query or scope differs", () => {
    const previous = pageResponse([recordHit(1)], "c1", true);
    const otherQuery = pageResponse([recordHit(2)], null, false, "beta");
    assert.equal(mergeKeywordSearchPages(previous, otherQuery), otherQuery);
    const otherScope = pageResponse([recordHit(3)], null, false, "alpha", "records");
    assert.equal(mergeKeywordSearchPages(previous, otherScope), otherScope);
  });
});
