// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Keyword search port (V3-27 skeleton, Fase 1 wave 3B overlap).
//
// This module defines the port interfaces plus the shared
// matching engine and a fake implementation for tests. It
// contains no database access, no disk access, and no index
// access: the production direct port (direct.ts, W4-WIRE) loads
// real candidates and runs the shared engine, and an
// index-backed implementation may replace the loader later
// without touching the routes, which consume search only
// through KeywordSearchPort.
//
// Port contract (kontrak-api-kanonis.md section 3.9, V1-14 section 8):
// - Matching: every query term must occur (AND), case-insensitive,
//   over record desc, content, fileName, and url, and over file
//   name, relative path, and Markdown content. Containment only: no
//   partial-word substring matching in the middle of a word, no
//   stemming, no embedding, no vector, no fuzzy scoring in MVP.
// - Ranking: a title or name match weighs more than a content match,
//   a whole-phrase match earns a bonus over separate terms, and a
//   match in more fields earns a bonus. Scores are opaque: clients
//   use them only for ordering inside one response.
// - Order: score descending, then updatedAt descending, then a
//   stable key (kind, then id or path), so cursor pagination is
//   stable. The port owns the cursor encoding; a cursor is opaque to
//   clients and is only meaningful for the exact query, scope, and
//   filters that produced it (kontrak 1.4.2, V1-14 8.4). A malformed
//   cursor, or a cursor carried to a different query, answers 400
//   invalid_cursor. The limit is NOT part of the cursor binding: the
//   same cursor may be replayed with a different limit.
// - Trash: soft-deleted records and trashed files are never
//   returned. Search is a pure read: it writes no event, enqueues
//   no index work, and changes no updatedAt.
// - Snippets: at most 200 characters, centered on the first match
//   in content when content matches; snippetMatches holds offsets
//   INSIDE the snippet. When only the title matches, the snippet
//   is the start of the content (or empty when content is empty)
//   and snippetField still names the snippet source field.
// - Times use epoch milliseconds (kontrak 1.4.1, search group).
// - Workspace scoping is the implementation's job: the input
//   carries the verified session principal, and the real
//   implementation resolves the workspace from it server-side.
//   The fake serves single-workspace fixture data and performs no
//   scoping; the fake itself must never be wired into production.
//   The matching engine below IS shared with production: the
//   direct port loads real, workspace-scoped candidates and runs
//   the same engine, so route specs written against the fake pin
//   production matching behavior too.
//
// The fake implementation below mirrors the contract closely enough
// for route tests (matching, ranking order, snippet windows, cursor
// binding, trash exclusion) while staying obviously fake: its scores
// come from a fixed weighting documented in scoreCandidate, and its
// cursor is an unsigned base64url payload. The cursor format is a
// pagination encoding, never a security boundary: it carries only
// the query binding and the sort position, and the engine
// re-validates the binding on every use.

import { ApiError } from '../../plugins/envelope.js';
import type { SessionPrincipal } from '../../middleware/auth-hook.js';

export type SearchScope = 'records' | 'files' | 'all';

// Normalized keyword search input. The route validates and
// normalizes the wire query (routes/search.ts) before calling the
// port: query is trimmed to 1-200 characters, scope defaults to
// "all", and limit is clamped to the endpoint maximum. The port
// receives no raw query strings and no workspace id from the
// client; identity arrives only as the verified principal.
export interface KeywordSearchInput {
  principal: SessionPrincipal;
  query: string;
  scope: SearchScope;
  tagId: number | undefined;
  type: readonly string[] | undefined;
  cursor: string | undefined;
  limit: number;
}

export interface SearchSnippetMatch {
  start: number;
  end: number;
}

// One record hit (V1-14 8.2). title is the record desc, falling back
// to the first 80 characters of content when desc is empty. url is
// the asset key or URL, following the record representation.
export interface SearchRecordResult {
  kind: 'record';
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

// One file hit (V1-14 8.2). path is the normalized relative path;
// title is the file name (last path segment); contentHash and
// version are the editor guards (AD-17).
export interface SearchFileResult {
  kind: 'file';
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

export type SearchResultItem = SearchRecordResult | SearchFileResult;

// One page of hits. nextCursor is null exactly on the last page,
// and hasMore is true exactly when nextCursor is not null
// (kontrak 1.4.2).
export interface SearchPage {
  results: SearchResultItem[];
  nextCursor: string | null;
  hasMore: boolean;
  // DA-2 (F-15-03): true when the backing loader skipped input
  // because of an error (unreadable file, failed version map), so
  // the page may be incomplete. The pure engine never degrades;
  // only the direct port sets this.
  degraded: boolean;
}

export interface KeywordSearchPort {
  search(input: KeywordSearchInput): Promise<SearchPage>;
}

// ---------------------------------------------------------------------------
// Fake implementation (tests only)
// ---------------------------------------------------------------------------

const SNIPPET_MAX_CHARS = 200;
const SNIPPET_LEAD_CHARS = 80;
const RECORD_TITLE_FALLBACK_CHARS = 80;
const CURSOR_PREFIX = 'srch1.';

export interface FakeSearchRecordItem {
  kind: 'record';
  id: number;
  // desc; when empty, the result title falls back to the start of content.
  title: string;
  content: string;
  fileName: string;
  type: string;
  tagIds: number[];
  url: string;
  updatedAt: number;
  createdAt: number;
  trashed?: boolean;
}

export interface FakeSearchFileItem {
  kind: 'file';
  path: string;
  content: string;
  contentHash: string;
  version: number;
  updatedAt: number;
  trashed?: boolean;
}

export type FakeSearchItem = FakeSearchRecordItem | FakeSearchFileItem;

// A position in the result order. Cursor anchors and candidates
// share this shape so "after the cursor" uses the same comparison
// as the sort itself.
interface SearchPosition {
  score: number;
  updatedAt: number;
  kind: 'record' | 'file';
  key: number | string;
}

interface ScoredCandidate extends SearchPosition {
  result: SearchResultItem;
}

function invalidCursor(): ApiError {
  return new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
}

function comparePositions(a: SearchPosition, b: SearchPosition): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.updatedAt !== b.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  if (a.kind !== b.kind) {
    return a.kind < b.kind ? -1 : 1;
  }
  if (typeof a.key === 'number' && typeof b.key === 'number') {
    return a.key - b.key;
  }
  const aKey = String(a.key);
  const bKey = String(b.key);
  if (aKey === bKey) {
    return 0;
  }
  return aKey < bKey ? -1 : 1;
}

interface CursorPayload {
  v: 1;
  q: string;
  scope: SearchScope;
  tagId: number | null;
  type: string[] | null;
  score: number;
  updatedAt: number;
  kind: 'record' | 'file';
  key: number | string;
}

function encodeSearchCursor(input: KeywordSearchInput, last: SearchPosition): string {
  const payload: CursorPayload = {
    v: 1,
    q: input.query,
    scope: input.scope,
    tagId: input.tagId ?? null,
    type: input.type === undefined ? null : [...input.type],
    score: last.score,
    updatedAt: last.updatedAt,
    kind: last.kind,
    key: last.key,
  };
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeSearchCursor(cursor: string, input: KeywordSearchInput): SearchPosition {
  let parsed: unknown;
  try {
    if (!cursor.startsWith(CURSOR_PREFIX)) {
      throw invalidCursor();
    }
    parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')) as unknown;
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    throw invalidCursor();
  }
  if (!isRecordValue(parsed)) {
    throw invalidCursor();
  }
  const scope = parsed['scope'];
  const kind = parsed['kind'];
  const key = parsed['key'];
  const tagId = parsed['tagId'];
  const type = parsed['type'];
  const score = parsed['score'];
  const updatedAt = parsed['updatedAt'];
  if (
    parsed['v'] !== 1 ||
    typeof parsed['q'] !== 'string' ||
    (scope !== 'records' && scope !== 'files' && scope !== 'all') ||
    (tagId !== null && typeof tagId !== 'number') ||
    (type !== null && (!Array.isArray(type) || type.some((entry) => typeof entry !== 'string'))) ||
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt) ||
    (kind !== 'record' && kind !== 'file') ||
    (typeof key !== 'number' && typeof key !== 'string')
  ) {
    throw invalidCursor();
  }
  if ((kind === 'record' && typeof key !== 'number') || (kind === 'file' && typeof key !== 'string')) {
    throw invalidCursor();
  }
  // Binding: the cursor is only meaningful for the query, scope, and
  // filters that produced it (V1-14 8.4). A cursor carried to a
  // different query answers invalid_cursor, per kontrak 3.9.
  const boundTagId = input.tagId ?? null;
  const boundType = input.type === undefined ? null : [...input.type];
  const sameType =
    (type === null && boundType === null) ||
    (Array.isArray(type) &&
      boundType !== null &&
      type.length === boundType.length &&
      type.every((entry, index) => entry === boundType[index]));
  if (parsed['q'] !== input.query || scope !== input.scope || tagId !== boundTagId || !sameType) {
    throw invalidCursor();
  }
  return { score, updatedAt, kind, key };
}

function buildSnippet(
  content: string,
  terms: readonly string[],
): { snippet: string; snippetField: string; snippetMatches: SearchSnippetMatch[] } {
  if (content === '') {
    return { snippet: '', snippetField: 'content', snippetMatches: [] };
  }
  const lower = content.toLowerCase();
  let firstIndex = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at !== -1 && (firstIndex === -1 || at < firstIndex)) {
      firstIndex = at;
    }
  }
  if (firstIndex === -1) {
    // Only the title matched: the snippet is the start of the
    // content, with no highlight ranges (V1-14 8.2).
    return { snippet: content.slice(0, SNIPPET_MAX_CHARS), snippetField: 'content', snippetMatches: [] };
  }
  const start = Math.max(0, Math.min(firstIndex - SNIPPET_LEAD_CHARS, content.length - SNIPPET_MAX_CHARS));
  const snippet = content.slice(start, start + SNIPPET_MAX_CHARS);
  const snippetLower = snippet.toLowerCase();
  const occurrences: SearchSnippetMatch[] = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = snippetLower.indexOf(term, from);
      if (at === -1) {
        break;
      }
      occurrences.push({ start: at, end: at + term.length });
      from = at + term.length;
    }
  }
  // Keep the earliest, longest match at each position so ranges never
  // overlap; the UI highlights offsets inside the snippet directly.
  occurrences.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const matches: SearchSnippetMatch[] = [];
  let lastEnd = 0;
  for (const occurrence of occurrences) {
    if (occurrence.start >= lastEnd) {
      matches.push(occurrence);
      lastEnd = occurrence.end;
    }
  }
  return { snippet, snippetField: 'content', snippetMatches: matches };
}

interface MatchField {
  // Title and name fields weigh more than content and path fields.
  weight: 'title' | 'other';
  text: string;
}

function scoreCandidate(item: FakeSearchItem, terms: readonly string[]): ScoredCandidate | null {
  const fields: MatchField[] =
    item.kind === 'record'
      ? [
          { weight: 'title', text: item.title },
          { weight: 'other', text: item.content },
          { weight: 'other', text: item.fileName },
          // Link records keep their URL only in `url` (the
          // control-link path stores the page title in desc), so
          // the URL is a matched field too (UTANG-UJI-03b).
          { weight: 'other', text: item.url },
        ]
      : [
          { weight: 'title', text: item.path.split('/').pop() ?? item.path },
          { weight: 'other', text: item.path },
          { weight: 'other', text: item.content },
        ];
  const lowered = fields.map((field) => field.text.toLowerCase());
  // AND over the union of fields: every term must occur in at least
  // one searched field (V1-14 8.3).
  for (const term of terms) {
    if (!lowered.some((text) => text.includes(term))) {
      return null;
    }
  }
  // Fixed fake weighting, in the contract order (V1-14 8.3): title
  // matches weigh more than content matches, a whole-phrase match
  // earns a bonus, and matching in more fields earns a bonus. Scores
  // are opaque and only order one response.
  let score = 0;
  let matchingFields = 0;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const text = lowered[i];
    if (field === undefined || text === undefined) {
      continue;
    }
    let fieldHits = 0;
    for (const term of terms) {
      if (text.includes(term)) {
        fieldHits += 1;
        score += field.weight === 'title' ? 10 : 1;
      }
    }
    if (fieldHits > 0) {
      matchingFields += 1;
    }
  }
  const phrase = terms.join(' ');
  if (phrase !== '' && lowered.some((text) => text.includes(phrase))) {
    score += 5;
  }
  if (matchingFields > 1) {
    score += 2 * (matchingFields - 1);
  }
  const snippet = buildSnippet(item.content, terms);
  if (item.kind === 'record') {
    const title =
      item.title !== '' ? item.title : item.content.slice(0, RECORD_TITLE_FALLBACK_CHARS);
    return {
      score,
      updatedAt: item.updatedAt,
      kind: 'record',
      key: item.id,
      result: {
        kind: 'record',
        id: item.id,
        title,
        snippet: snippet.snippet,
        snippetField: snippet.snippetField,
        snippetMatches: snippet.snippetMatches,
        score,
        type: item.type,
        tagIds: [...item.tagIds],
        url: item.url,
        updatedAt: item.updatedAt,
        createdAt: item.createdAt,
      },
    };
  }
  return {
    score,
    updatedAt: item.updatedAt,
    kind: 'file',
    key: item.path,
    result: {
      kind: 'file',
      path: item.path,
      title: item.path.split('/').pop() ?? item.path,
      snippet: snippet.snippet,
      snippetField: snippet.snippetField,
      snippetMatches: snippet.snippetMatches,
      score,
      contentHash: item.contentHash,
      version: item.version,
      updatedAt: item.updatedAt,
    },
  };
}

// Shared matching, ranking, snippet, and cursor-pagination
// engine (W4-WIRE). The fake port below and the production
// direct port (direct.ts) both run this engine over candidate
// items; only the loading and scoping differ. The engine is
// pure and synchronous: it reads no database, no disk, and no
// clock. Scores, snippet windows, cursor binding, and trash
// exclusion are exactly the fake behavior the route specs
// already pin; extracting them here changes no outcome.
export function executeKeywordSearch(
  items: readonly FakeSearchItem[],
  input: KeywordSearchInput,
): SearchPage {
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '');
  const anchor = input.cursor === undefined ? undefined : decodeSearchCursor(input.cursor, input);
  const matched: ScoredCandidate[] = [];
  for (const item of items) {
    if (item.trashed === true) {
      continue;
    }
    if (input.scope === 'records' && item.kind !== 'record') {
      continue;
    }
    if (input.scope === 'files' && item.kind !== 'file') {
      continue;
    }
    const candidate = scoreCandidate(item, terms);
    if (candidate === null) {
      continue;
    }
    // tagId and type filter record hits only; file hits are
    // never filtered by tag or record type (V1-14 8.1).
    if (item.kind === 'record') {
      if (input.tagId !== undefined && !item.tagIds.includes(input.tagId)) {
        continue;
      }
      if (input.type !== undefined && !input.type.includes(item.type)) {
        continue;
      }
    }
    matched.push(candidate);
  }
  matched.sort(comparePositions);
  const after = anchor === undefined ? matched : matched.filter((candidate) => comparePositions(candidate, anchor) > 0);
  const page = after.slice(0, input.limit);
  const hasMore = after.length > input.limit;
  const last = page[page.length - 1];
  return {
    results: page.map((candidate) => candidate.result),
    nextCursor: hasMore && last !== undefined ? encodeSearchCursor(input, last) : null,
    hasMore,
    degraded: false,
  };
}

// Build a fake port over fixed fixture items. The fixture is copied
// at construction; later mutation of the caller's array cannot
// change search results. Trashed items are always excluded, matching
// the contract rule that search never returns trash.
export function createFakeKeywordSearchPort(items: readonly FakeSearchItem[]): KeywordSearchPort {
  const snapshot = [...items];
  return {
    async search(input: KeywordSearchInput): Promise<SearchPage> {
      return executeKeywordSearch(snapshot, input);
    },
  };
}
