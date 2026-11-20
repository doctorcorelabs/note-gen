// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Keyword search client (Fase 1, V3-28). The single frontend path to
// the search endpoints in kontrak-api-kanonis.md section 3.9:
//
//   GET  /api/search        keyword search over records and files
//   POST /api/search/fuzzy  explicit 501 stub in MVP (Fase 2)
//
// Design sources: fase1/desain-record-search.md (V1-14) sections 8
// and 9, and fase1/kontrak-api-kanonis.md sections 3.9, 6.5, and 7.
//
// Rules enforced here:
// - Keyword search is the only search path the MVP UI uses. It never
//   calls the fuzzy endpoint, never sends a `mode` parameter, and
//   never builds a client-side index (AD-10, V1-14 8.3). The
//   matching rules (all terms, case-insensitive, containment) live
//   on the server; this module only validates the wire shape.
// - The fuzzy status block is part of every keyword response. In
//   MVP it always reads available false with reason `not_in_mvp`;
//   the UI renders the server message verbatim, so the status can
//   never be mistaken for an empty result list.
// - A 501 from the fuzzy endpoint becomes the typed
//   FuzzySearchUnavailableError through the ApiClient error mapping
//   (V1-14 9.4, contract 6.5). Nothing in this module catches that
//   error and substitutes an empty list or null. The fuzzy scoring
//   function exists as the Fase 2 preparation adapter: in MVP the
//   wire answers 501 and callers must surface the typed error.
// - No ad hoc fetch: every request goes through ApiClient (V3-30),
//   same-origin, cookie credentials, envelope parsing, no retries,
//   no logging. Query validation here is a pre-flight guard so the
//   UI never sends an invalid `q`; the server remains the authority
//   and answers 400 validation_failed for invalid requests.
// - The snippet highlight helper only renders server-provided
//   offsets inside the snippet. It is display code, not a matching
//   function, and it is deliberately not shared with the inbox list
//   `q` filter, whose matching semantics differ (contract 3.8).

import type { ApiClient } from "./api-client";
import { ApiError, createLocalApiError } from "./errors";

export const SEARCH_PATH = "/api/search";
export const FUZZY_SEARCH_PATH = "/api/search/fuzzy";

// Query bounds (V1-14 8.1 for keyword, 9.3 for fuzzy): 1-200
// characters after trimming.
export const SEARCH_MAX_QUERY_CHARS = 200;

// Pagination (V1-14 8.1): default limit 50, maximum 200. The server
// clamps a limit above the maximum; this client clamps the same way
// before sending, so the requested page size is never a surprise.
export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_LIMIT = 200;

// Reserved Fase 2 fuzzy body bounds (V1-14 9.3): 1-2000 items,
// 1-10 keys, limit default 50 and maximum 200. The server rejects a
// body limit above the maximum with 400; this client rejects it
// locally with the same coarse code, before any fetch happens.
export const FUZZY_MAX_ITEMS = 2000;
export const FUZZY_MAX_KEYS = 10;
export const FUZZY_MAX_LIMIT = 200;
export const FUZZY_DEFAULT_LIMIT = 50;

export type SearchScope = "records" | "files" | "all";

/** Dialog filter values, mapped to wire scopes by scopeForSearchFilter. */
export type SearchFilter = "all" | "record" | "article";

export interface SearchSnippetMatch {
  start: number;
  end: number;
}

// One record hit (V1-14 8.2). Mirrors the server port type in
// server/src/services/search/port.ts; the two shapes must stay in
// sync through the contract, not through a shared import, because
// the frontend bundle must not import server code.
export interface KeywordSearchRecordResult {
  kind: "record";
  id: number;
  title: string;
  snippet: string;
  snippetField: string;
  snippetMatches: SearchSnippetMatch[];
  score: number;
  type: string;
  tagIds: number[];
  url: string;
  updatedAt: number;
  createdAt: number;
}

// One file hit (V1-14 8.2). `path` is the normalized relative path;
// `title` is the file name (last path segment); `contentHash` and
// `version` are the editor guards (AD-17).
export interface KeywordSearchFileResult {
  kind: "file";
  path: string;
  title: string;
  snippet: string;
  snippetField: string;
  snippetMatches: SearchSnippetMatch[];
  score: number;
  contentHash: string;
  version: number;
  updatedAt: number;
}

export type KeywordSearchResult =
  | KeywordSearchRecordResult
  | KeywordSearchFileResult;

// The fuzzy status block of every keyword response (V1-14 8.2). In
// MVP `available` is always false with reason `not_in_mvp` and
// `degraded` on the response stays false: the absence of fuzzy
// matching is a stated status, not a degradation.
export interface KeywordSearchFuzzyStatus {
  available: boolean;
  reason: string;
  message: string;
}

export interface KeywordSearchResponse {
  query: string;
  scope: SearchScope;
  results: KeywordSearchResult[];
  nextCursor: string | null;
  hasMore: boolean;
  fuzzy: KeywordSearchFuzzyStatus;
  degraded: boolean;
}

export interface KeywordSearchParams {
  /** Raw user input; trimmed and bounded by normalizeSearchQuery. */
  query: string;
  scope?: SearchScope;
  /** Opaque cursor from a previous page of the same query. */
  cursor?: string;
  /** Page size; defaults to 50 and clamps to 200. */
  limit?: number;
}

// Reserved Fase 2 fuzzy scoring shapes (V1-14 9.3, contract 3.9).
// The endpoint scores items the caller sends; it never reads the
// database. These types exist so the preparation adapter and its
// tests can speak the reserved shape without inventing one.
export interface FuzzyScoringItem {
  id: string;
  keys: Record<string, string>;
}

export interface FuzzyScoringRequest {
  query: string;
  items: FuzzyScoringItem[];
  keys: string[];
  threshold?: number;
  limit?: number;
}

export interface FuzzyScoringRange {
  key: string;
  start: number;
  end: number;
}

export interface FuzzyScoringResultItem {
  id: string;
  score: number;
  ranges: FuzzyScoringRange[];
}

export interface FuzzyScoringResponse {
  query: string;
  results: FuzzyScoringResultItem[];
  degraded: boolean;
}

export interface SearchRequestOptions {
  /** Caller abort signal. Aborting produces a TIMEOUT ApiError. */
  signal?: AbortSignal;
}

/**
 * Normalize raw search input to the wire query: trimmed, 1-200
 * characters. Returns null when the input cannot be sent (empty,
 * whitespace-only, overlong, or not a string). The UI treats null
 * as "no search", never as a search for an empty string, and the
 * search inputs carry maxLength 200 so typing can never produce an
 * overlong query.
 */
export function normalizeSearchQuery(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > SEARCH_MAX_QUERY_CHARS) {
    return null;
  }
  return trimmed;
}

/** Map a dialog filter value to the wire scope it requests. */
export function scopeForSearchFilter(filter: SearchFilter): SearchScope {
  if (filter === "record") {
    return "records";
  }
  if (filter === "article") {
    return "files";
  }
  return "all";
}

/**
 * Build the query string parameters for GET /api/search. The result
 * never contains `mode` (rejected 400 by the server, V1-14 8.1),
 * never contains a workspace identifier (contract 1.1), and only
 * carries a cursor when the caller passes one from the same query.
 */
export function buildKeywordSearchQuery(params: {
  query: string;
  scope: SearchScope;
  cursor?: string;
  limit: number;
}): Record<string, string | number> {
  const query: Record<string, string | number> = {
    q: params.query,
    scope: params.scope,
    limit: params.limit,
  };
  if (params.cursor !== undefined && params.cursor !== "") {
    query.cursor = params.cursor;
  }
  return query;
}

/** Stable React key and identity for one search result. */
export function searchResultKey(result: KeywordSearchResult): string {
  return result.kind === "record" ? `record:${result.id}` : `file:${result.path}`;
}

/**
 * Merge one cursor page into the accumulated search response
 * (DA11-02 / S-P0-05). Results accumulate in server order with
 * duplicates dropped by searchResultKey (first page wins), so a
 * repeated or overlapping page can never duplicate a row. The
 * cursor, hasMore flag, fuzzy block, and degraded flag come from
 * the newest page. A page for a different query or scope is
 * returned unchanged instead of merged: pages from two searches
 * must never be combined.
 */
export function mergeKeywordSearchPages(
  previous: KeywordSearchResponse,
  page: KeywordSearchResponse,
): KeywordSearchResponse {
  if (page.query !== previous.query || page.scope !== previous.scope) {
    return page;
  }
  const seen = new Set(previous.results.map((result) => searchResultKey(result)));
  const results = [...previous.results];
  for (const result of page.results) {
    const key = searchResultKey(result);
    if (!seen.has(key)) {
      seen.add(key);
      results.push(result);
    }
  }
  return {
    query: page.query,
    scope: page.scope,
    results,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    fuzzy: page.fuzzy,
    degraded: page.degraded,
  };
}

/**
 * First tag id of a record result, or undefined when the record has
 * no tags. The server returns a tag id array; the legacy inbox
 * navigation takes a single current tag, so the first entry is the
 * navigation hint only and never a claim about the record's tags.
 */
export function recordResultTagId(
  result: KeywordSearchRecordResult,
): number | undefined {
  return result.tagIds[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseSnippetMatches(value: unknown): SearchSnippetMatch[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const matches: SearchSnippetMatch[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isFiniteNumber(entry.start) ||
      !isFiniteNumber(entry.end)
    ) {
      return null;
    }
    matches.push({ start: entry.start, end: entry.end });
  }
  return matches;
}

function parseSearchResult(value: unknown): KeywordSearchResult | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value.kind;
  if (kind !== "record" && kind !== "file") {
    return null;
  }
  if (
    typeof value.title !== "string" ||
    typeof value.snippet !== "string" ||
    typeof value.snippetField !== "string" ||
    !isFiniteNumber(value.score) ||
    !isFiniteNumber(value.updatedAt)
  ) {
    return null;
  }
  const snippetMatches = parseSnippetMatches(value.snippetMatches);
  if (snippetMatches === null) {
    return null;
  }
  if (kind === "record") {
    if (
      !isFiniteNumber(value.id) ||
      !Number.isSafeInteger(value.id) ||
      typeof value.type !== "string" ||
      !Array.isArray(value.tagIds) ||
      value.tagIds.some((tagId) => !isFiniteNumber(tagId)) ||
      typeof value.url !== "string" ||
      !isFiniteNumber(value.createdAt)
    ) {
      return null;
    }
    return {
      kind: "record",
      id: value.id,
      title: value.title,
      snippet: value.snippet,
      snippetField: value.snippetField,
      snippetMatches,
      score: value.score,
      type: value.type,
      tagIds: [...(value.tagIds as number[])],
      url: value.url,
      updatedAt: value.updatedAt,
      createdAt: value.createdAt,
    };
  }
  if (
    typeof value.path !== "string" ||
    typeof value.contentHash !== "string" ||
    !isFiniteNumber(value.version)
  ) {
    return null;
  }
  return {
    kind: "file",
    path: value.path,
    title: value.title,
    snippet: value.snippet,
    snippetField: value.snippetField,
    snippetMatches,
    score: value.score,
    contentHash: value.contentHash,
    version: value.version,
    updatedAt: value.updatedAt,
  };
}

/**
 * Validate an envelope `data` value as a keyword search response.
 * Unknown extra fields pass through untouched (forward compatible),
 * but a missing or mistyped required field fails closed with a
 * local SERVER_ERROR: the UI must never render invented results,
 * and a missing fuzzy block must never read as "fuzzy available".
 */
export function parseKeywordSearchResponse(
  data: unknown,
): KeywordSearchResponse {
  if (!isRecord(data)) {
    throw createLocalApiError("SERVER_ERROR");
  }
  const scope = data.scope;
  if (
    typeof data.query !== "string" ||
    (scope !== "records" && scope !== "files" && scope !== "all") ||
    !Array.isArray(data.results) ||
    (data.nextCursor !== null && typeof data.nextCursor !== "string") ||
    typeof data.hasMore !== "boolean" ||
    typeof data.degraded !== "boolean" ||
    !isRecord(data.fuzzy) ||
    typeof data.fuzzy.available !== "boolean" ||
    typeof data.fuzzy.reason !== "string" ||
    typeof data.fuzzy.message !== "string"
  ) {
    throw createLocalApiError("SERVER_ERROR");
  }
  const results: KeywordSearchResult[] = [];
  for (const entry of data.results) {
    const parsed = parseSearchResult(entry);
    if (parsed === null) {
      throw createLocalApiError("SERVER_ERROR");
    }
    results.push(parsed);
  }
  return {
    query: data.query,
    scope,
    results,
    nextCursor: data.nextCursor,
    hasMore: data.hasMore,
    fuzzy: {
      available: data.fuzzy.available,
      reason: data.fuzzy.reason,
      message: data.fuzzy.message,
    },
    degraded: data.degraded,
  };
}

function normalizeKeywordLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return SEARCH_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  return Math.min(limit, SEARCH_MAX_LIMIT);
}

/**
 * Run one keyword search through the centralized client. An empty
 * or overlong query throws a local VALIDATION_ERROR before any
 * fetch happens; a wire failure throws the ApiError from the
 * envelope mapping, never an empty result list. The caller owns
 * cancellation through `signal` and must not retry on its own.
 */
export async function searchKeyword(
  client: ApiClient,
  params: KeywordSearchParams,
  options: SearchRequestOptions = {},
): Promise<KeywordSearchResponse> {
  const query = normalizeSearchQuery(params.query);
  if (query === null) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  const scope = params.scope ?? "all";
  if (scope !== "records" && scope !== "files" && scope !== "all") {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  const limit = normalizeKeywordLimit(params.limit);
  const data = await client.getJson<unknown>(SEARCH_PATH, {
    query: buildKeywordSearchQuery({ query, scope, cursor: params.cursor, limit }),
    signal: options.signal,
  });
  return parseKeywordSearchResponse(data);
}

function validateFuzzyScoringRequest(request: FuzzyScoringRequest): void {
  if (normalizeSearchQuery(request.query) === null) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  if (
    !Array.isArray(request.items) ||
    request.items.length < 1 ||
    request.items.length > FUZZY_MAX_ITEMS
  ) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  for (const item of request.items) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id.trim() === "" ||
      !isRecord(item.keys) ||
      Object.values(item.keys).some((entry) => typeof entry !== "string")
    ) {
      throw createLocalApiError("VALIDATION_ERROR");
    }
  }
  if (
    !Array.isArray(request.keys) ||
    request.keys.length < 1 ||
    request.keys.length > FUZZY_MAX_KEYS ||
    request.keys.some((key) => typeof key !== "string" || key.trim() === "")
  ) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  if (
    request.threshold !== undefined &&
    (typeof request.threshold !== "number" || !Number.isFinite(request.threshold))
  ) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  if (
    request.limit !== undefined &&
    (!Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > FUZZY_MAX_LIMIT)
  ) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
}

function parseFuzzyScoringResponse(data: unknown): FuzzyScoringResponse {
  if (!isRecord(data) || typeof data.query !== "string") {
    throw createLocalApiError("SERVER_ERROR");
  }
  if (!Array.isArray(data.results) || typeof data.degraded !== "boolean") {
    throw createLocalApiError("SERVER_ERROR");
  }
  const results: FuzzyScoringResultItem[] = [];
  for (const entry of data.results) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !isFiniteNumber(entry.score) ||
      !Array.isArray(entry.ranges)
    ) {
      throw createLocalApiError("SERVER_ERROR");
    }
    const ranges: FuzzyScoringRange[] = [];
    for (const range of entry.ranges) {
      if (
        !isRecord(range) ||
        typeof range.key !== "string" ||
        !isFiniteNumber(range.start) ||
        !isFiniteNumber(range.end)
      ) {
        throw createLocalApiError("SERVER_ERROR");
      }
      ranges.push({ key: range.key, start: range.start, end: range.end });
    }
    results.push({ id: entry.id, score: entry.score, ranges });
  }
  return { query: data.query, results, degraded: data.degraded };
}

/**
 * Fase 2 preparation adapter for fuzzy scoring (V1-14 9.4). In MVP
 * the endpoint answers 501 `fuzzy_search_unavailable` after auth,
 * and the ApiClient mapping turns that envelope into
 * FuzzySearchUnavailableError. This function deliberately does not
 * catch that error: callers must surface it as an explicit
 * unavailable status, never as an empty list. The keyword search
 * UI never calls this function; it exists for the Fase 2 callers
 * (RAG retrieval and the invoke router alias) that will share the
 * one server implementation.
 */
export async function requestFuzzyScoring(
  client: ApiClient,
  request: FuzzyScoringRequest,
  options: SearchRequestOptions = {},
): Promise<FuzzyScoringResponse> {
  validateFuzzyScoringRequest(request);
  const body: Record<string, unknown> = {
    query: request.query.trim(),
    items: request.items,
    keys: request.keys,
  };
  if (request.threshold !== undefined) {
    body.threshold = request.threshold;
  }
  if (request.limit !== undefined) {
    body.limit = request.limit;
  }
  const data = await client.postJson<unknown>(FUZZY_SEARCH_PATH, body, {
    signal: options.signal,
  });
  return parseFuzzyScoringResponse(data);
}

export interface SnippetSegment {
  text: string;
  highlighted: boolean;
}

/**
 * Split a server snippet into plain and highlighted segments from
 * the server-provided `snippetMatches` offsets (offsets INSIDE the
 * snippet, V1-14 8.2). Matches are clamped to the snippet, sorted,
 * and de-overlapped (earliest wins); invalid ranges are dropped.
 * An empty snippet or no valid matches yields one plain segment,
 * so callers never need a fallback highlight of their own.
 */
export function highlightSnippetSegments(
  snippet: string,
  matches: readonly SearchSnippetMatch[],
): SnippetSegment[] {
  if (snippet === "") {
    return [{ text: "", highlighted: false }];
  }
  const valid = matches
    .map((match) => ({
      start: Math.max(0, Math.floor(match.start)),
      end: Math.min(snippet.length, Math.floor(match.end)),
    }))
    .filter((match) => match.start < match.end)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const segments: SnippetSegment[] = [];
  let cursor = 0;
  for (const match of valid) {
    if (match.start < cursor) {
      continue;
    }
    if (match.start > cursor) {
      segments.push({ text: snippet.slice(cursor, match.start), highlighted: false });
    }
    segments.push({ text: snippet.slice(match.start, match.end), highlighted: true });
    cursor = match.end;
  }
  if (cursor < snippet.length) {
    segments.push({ text: snippet.slice(cursor), highlighted: false });
  }
  return segments.length > 0
    ? segments
    : [{ text: snippet, highlighted: false }];
}

/** Re-exported so callers can narrow wire failures without a second import. */
export { ApiError };
