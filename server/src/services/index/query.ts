// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Files index query layer (V3-06 part 2, wave 3B overlap, AD-57).
//
// This module answers three questions over the files index, and
// nothing else:
//
// 1. Version lookup by path: the current index version for one file,
//    for write-guard conflict payloads (serverVersion) and no-op
//    appends in the write service. A missing index row means version
//    null (desain-workspace-api.md section 1.4), never version 0.
// 2. Name search: keyword search over file names and relative paths.
// 3. Content search hooks for V3-27: keyword search over name, path,
//    and file text supplied through a FileContentProvider.
//
// Version is an informational counter, not a guard
// (desain-workspace-api.md section 3.1). Guards compare revisions
// (server/src/lib/revision.ts); this module never computes, parses,
// or returns a revision. contentHash is hex SHA-256 over the content
// bytes alone and must never be substituted for a revision.
//
// Matching rules come from desain-record-search.md section 8.3: the
// query splits into terms on whitespace, ALL terms must match (AND),
// matching is case-insensitive containment, a name match outranks a
// content match, and a whole-phrase match earns a bonus. The exact
// weights below are implementation defaults, documented here, which
// V3-27 may retune without changing the contract as long as the
// relative order (name above content, phrase above separate terms)
// is preserved. No stemming, no fuzzy scoring, no embedding.
//
// Reads in this module are pure: no disk access, no SQL, no events,
// no enqueue (desain-record-search.md section 8.3). All state comes
// through the FilesIndexStore interface. The in-memory implementation
// lives in memory-store.ts (tests and the pre-DB seam). The
// Postgres-backed store is a seam, documented below; no migration is
// created here because the files and file_events tables already exist
// in the frozen 0000 migration (AD-25).
//
// Postgres seam: a production FilesIndexStore maps getEntry to one
// SELECT over files filtered by workspace_id, path, and deleted_at
// IS NULL; listEntries to the same SELECT ordered by path; recordWrite
// to the existing transaction in
// services/workspace/write-index-pg.ts (createPgWorkspaceIndex),
// which must not be duplicated; markDeleted to one transaction that
// sets deleted_at and inserts the file_events 'deleted' row. The
// query functions enumerate through listEntries, which is acceptable
// inside the tested envelope of 10,000 files
// (desain-workspace-api.md section 4.4). If enumeration ever becomes
// a bottleneck, a pushdown method (term filtering in SQL) may be
// added to the interface as a recorded amendment; the matching
// semantics in this file stay the single authority.
//
// Hidden paths (any dot segment, per server/src/lib/paths.ts) follow
// read semantics (desain-workspace-api.md section 8.6): a lookup
// answers null and search skips the entry, so queries never leak the
// existence of hidden files. Path validation itself is owned by
// validateWorkspacePath; this module writes no competing validator.
//
// No caching: every lookup reads the store, so a version obtained
// before a write is stale after it. compareFileVersion makes that
// explicit for callers that hold a version from an earlier read.
//
// Sibling seams: the scan worker (V3-06 part 1) populates rows, the
// reconcile worker (V3-06 part 3) repairs disk/index drift, and the
// search route (V3-27) merges these file results with record results
// and applies cursor pagination plus the full ordering of
// desain-record-search.md section 8.2 (score, then updatedAt, then a
// stable key). This module orders by score, then path, because the
// files table carries no updated_at column; updatedAt for search
// ordering is the V3-27 merge layer's job, not invented here.
//
// Wiring: production keeps createPgWorkspaceIndex as the
// WorkspaceIndexPort. createWorkspaceIndexPort below adapts any
// FilesIndexStore (in practice the in-memory store) to the same port
// so tests and the pre-DB seam get real versions instead of null.
// No app.ts edit is made here (AD-57); the integrator wires ports.

import { isHiddenWorkspacePath, validateWorkspacePath } from '../../lib/paths.js';
import type { IndexWriteInput, WorkspaceIndexPort } from '../workspace/write-ports.js';

// One active row of the files index, as query callers see it. The
// shape mirrors the files table (server/src/db/schema/m4-canvas-files.ts)
// except for the row id, which is server-side only, and deleted_at,
// which is NULL for every active row by definition: soft-deleted rows
// never reach callers through this interface.
export interface FilesIndexEntry {
  workspaceId: string;
  path: string;
  // Hex SHA-256 over the content bytes alone. Not a revision.
  contentHash: string;
  sizeBytes: number;
  // Starts at 1 for a new path, increments per successful write
  // (desain-workspace-api.md section 3.7 step 7).
  version: number;
  // Null for directories, which have no media type.
  mimeType: string | null;
}

// The store contract behind every query in this file. All methods
// are workspace-scoped: a row from another workspace is invisible,
// and a lookup for it answers null, never an error that leaks
// existence. Implementations return fresh objects; callers may
// mutate results without affecting stored state.
export interface FilesIndexStore {
  // The active row for one exact normalized path, or null when no
  // active row exists (never created, soft-deleted, or another
  // workspace). Implementations do no path validation: callers pass
  // validated normalized paths, and lookupFileEntry is the
  // validating entry point.
  getEntry(workspaceId: string, path: string): Promise<FilesIndexEntry | null>;
  // Every active row in one workspace, ordered by path ascending.
  // Hidden rows, if any were ever stored, are filtered by the query
  // functions, not here, so the store stays a plain row source.
  listEntries(workspaceId: string): Promise<FilesIndexEntry[]>;
  // The write-path upsert (desain-workspace-api.md section 3.7 steps
  // 7-8): version 1 for a path with no active row, otherwise the
  // previous version plus 1, with the file_events row written
  // atomically with the files row. Mirrors the Postgres
  // implementation in write-index-pg.ts exactly, including the rule
  // that a soft-deleted path restarts at version 1. Bulk scan
  // seeding must not use this method: it bumps versions and journals
  // events, which is write-path behavior, not scan behavior.
  recordWrite(input: IndexWriteInput): Promise<{ version: number }>;
  // Soft-deletes the active row for one path. Returns true when a
  // row was active and is now deleted, false when no active row
  // existed. The row is retained so a later file at the same path
  // can be indexed without a clash.
  markDeleted(workspaceId: string, path: string): Promise<boolean>;
}

// Supplies file text for content search. The files index stores no
// content, so V3-27 provides an implementation that reads text from
// disk under the workspace root (after path validation and symlink
// checks by the read service) or from another text source. Returning
// null means the text is unavailable (binary file, missing file,
// unreadable file): the file can still match on name or path, but
// never on content. A throw is treated the same as null; one
// unreadable file never fails a whole search. Implementations must
// cap what they return (the enforced single text file limit is
// 2 MiB, desain-workspace-api.md section 4.4) and must never return
// secrets or absolute paths; this module only searches the text and
// copies at most one snippet window out of it.
export interface FileContentProvider {
  readText(workspaceId: string, path: string): Promise<string | null>;
}

// Thrown for a malformed search query (empty, overlong, or not a
// string) and for malformed search options (a non-integer or
// non-positive limit or snippet length). V3-27 maps this to
// validation_failed (query) or invalid_limit (limit) on the wire;
// this module knows no HTTP status codes.
export class InvalidIndexQueryError extends Error {
  constructor(message = 'The index query is not valid.') {
    super(message);
    this.name = 'InvalidIndexQueryError';
  }
}

// Search bounds from desain-record-search.md sections 1.2 and 8.1
// and kontrak-api-kanonis.md section 3.9: query 1-200 characters,
// default limit 50, maximum limit 200, snippet at most 200
// characters.
export const MAX_QUERY_CHARS = 200;
export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 200;
export const MAX_SNIPPET_CHARS = 200;

// Scoring weights (implementation defaults, see the header). A term
// in the file name scores more than the same term in the directory
// portion of the path, which scores more than the same term in the
// content. A whole-phrase match in a field earns a bonus on top of
// the per-term score. Terms matched in more than one field earn a
// small bonus per additional field.
const NAME_TERM_SCORE = 10;
const PATH_TERM_SCORE = 4;
const CONTENT_TERM_SCORE = 2;
const NAME_PHRASE_BONUS = 8;
const PATH_PHRASE_BONUS = 3;
const CONTENT_PHRASE_BONUS = 5;
const EXTRA_FIELD_BONUS = 2;

function fileNameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

interface ParsedQuery {
  terms: string[];
  phrase: string;
}

function parseQuery(query: unknown): ParsedQuery {
  if (typeof query !== 'string') {
    throw new InvalidIndexQueryError('The search query must be a string.');
  }
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new InvalidIndexQueryError('The search query must not be empty.');
  }
  if (trimmed.length > MAX_QUERY_CHARS) {
    throw new InvalidIndexQueryError('The search query is too long.');
  }
  const phrase = trimmed.toLowerCase();
  const terms = trimmed
    .split(/\s+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 0);
  return { terms, phrase };
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_SEARCH_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidIndexQueryError('The search limit must be a positive integer.');
  }
  return Math.min(limit, MAX_SEARCH_LIMIT);
}

function resolveSnippetLength(maxLength: number | undefined): number {
  if (maxLength === undefined) {
    return MAX_SNIPPET_CHARS;
  }
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new InvalidIndexQueryError('The snippet length must be a positive integer.');
  }
  return Math.min(maxLength, MAX_SNIPPET_CHARS);
}

// Validates a caller-supplied path and returns the normalized path
// to look up, or null when the path must answer as a miss without
// leaking existence (hidden paths). Syntactically invalid paths
// throw InvalidWorkspacePathError from the frozen validator; the
// caller maps that to its own status code.
function lookupPath(inputPath: unknown): string | null {
  const validated = validateWorkspacePath(inputPath);
  if (validated.hidden || validated.isRoot) {
    return null;
  }
  return validated.path;
}

// The active index row for one path, or null when no active row
// exists. Hidden paths answer null. Invalid paths throw.
export async function lookupFileEntry(
  store: FilesIndexStore,
  workspaceId: string,
  inputPath: unknown,
): Promise<FilesIndexEntry | null> {
  const path = lookupPath(inputPath);
  if (path === null) {
    return null;
  }
  return store.getEntry(workspaceId, path);
}

// The current index version for one path, or null when no active
// index row exists. This is the value the write service reports as
// `version` and as serverVersion in conflict payloads; null is the
// honest answer for a file the index has never seen, including a
// file written outside the API before reconciliation.
export async function lookupFileVersion(
  store: FilesIndexStore,
  workspaceId: string,
  inputPath: unknown,
): Promise<number | null> {
  const entry = await lookupFileEntry(store, workspaceId, inputPath);
  return entry === null ? null : entry.version;
}

export type FileVersionComparison = 'current' | 'stale' | 'missing';

// Compares a version a caller holds from an earlier read against the
// current index version: 'current' when they match, 'stale' when the
// row exists with a different version (a write landed in between),
// 'missing' when no active row exists. 'missing' is not proof the
// file is absent from disk, only that the index has no active row
// for it. A caller that sees 'stale' must re-read; it must never
// assume the held version will become current again.
export async function compareFileVersion(
  store: FilesIndexStore,
  workspaceId: string,
  inputPath: unknown,
  expectedVersion: number,
): Promise<FileVersionComparison> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new InvalidIndexQueryError('The expected version must be a positive integer.');
  }
  const entry = await lookupFileEntry(store, workspaceId, inputPath);
  if (entry === null) {
    return 'missing';
  }
  return entry.version === expectedVersion ? 'current' : 'stale';
}

// Adapts any FilesIndexStore to the write service's index port, so
// code running against the in-memory store gets real versions
// instead of null. currentVersion uses exact-match store semantics,
// identical to the Postgres implementation: no path validation here,
// because the write service only calls it with paths its path port
// already validated. recordWrite delegates to the store, which
// journals the file event atomically with the row.
export function createWorkspaceIndexPort(store: FilesIndexStore): WorkspaceIndexPort {
  return {
    async currentVersion(workspaceId: string, path: string): Promise<number | null> {
      const entry = await store.getEntry(workspaceId, path);
      return entry === null ? null : entry.version;
    },
    async recordWrite(input: IndexWriteInput): Promise<{ version: number }> {
      return store.recordWrite(input);
    },
  };
}

export interface FileNameSearchResult {
  path: string;
  // File name: the last path segment (desain-record-search.md 8.2).
  title: string;
  contentHash: string;
  version: number;
  sizeBytes: number;
  mimeType: string | null;
  // Opaque relevance score: larger means more relevant, only
  // comparable within one response (desain-record-search.md 8.2).
  score: number;
}

export interface FileNameSearchOptions {
  limit?: number;
}

interface FieldScores {
  matchesAll: boolean;
  score: number;
}

// Scores one entry against the parsed query over name and directory
// fields. Every term must appear in the name or the full path (AND).
// The directory portion is scored separately from the name so a
// name match is not counted twice through the full path.
function scoreNameAndPath(
  terms: readonly string[],
  phrase: string,
  nameLower: string,
  dirLower: string,
  pathLower: string,
): FieldScores {
  let score = 0;
  let nameHit = false;
  let dirHit = false;
  for (const term of terms) {
    const inName = nameLower.includes(term);
    const inDir = dirLower.includes(term);
    if (!inName && !inDir) {
      return { matchesAll: false, score: 0 };
    }
    if (inName) {
      score += NAME_TERM_SCORE;
      nameHit = true;
    }
    if (inDir) {
      score += PATH_TERM_SCORE;
      dirHit = true;
    }
  }
  if (nameLower.includes(phrase)) {
    score += NAME_PHRASE_BONUS;
  } else if (pathLower.includes(phrase)) {
    score += PATH_PHRASE_BONUS;
  }
  if (nameHit && dirHit) {
    score += EXTRA_FIELD_BONUS;
  }
  return { matchesAll: true, score };
}

function compareResults(a: FileNameSearchResult, b: FileNameSearchResult): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.path === b.path) {
    return 0;
  }
  return a.path < b.path ? -1 : 1;
}

// Lists the entries a search may consider: active rows whose stored
// path is valid and not hidden. A stored row with an invalid path
// (corrupt index data) is skipped rather than failing the search;
// repairing it belongs to reconciliation, not to querying.
async function searchableEntries(
  store: FilesIndexStore,
  workspaceId: string,
): Promise<FilesIndexEntry[]> {
  const entries = await store.listEntries(workspaceId);
  const kept: FilesIndexEntry[] = [];
  for (const entry of entries) {
    if (isHiddenWorkspacePath(entry.path)) {
      continue;
    }
    try {
      validateWorkspacePath(entry.path);
    } catch {
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

// Keyword search over file names and relative paths. No content
// provider is needed: only the index rows are read. Results are
// ordered by score descending, then path ascending, and truncated
// to the limit after ranking.
export async function searchFilesByName(
  store: FilesIndexStore,
  workspaceId: string,
  query: unknown,
  options: FileNameSearchOptions = {},
): Promise<FileNameSearchResult[]> {
  const { terms, phrase } = parseQuery(query);
  const limit = resolveLimit(options.limit);
  const results: FileNameSearchResult[] = [];
  for (const entry of await searchableEntries(store, workspaceId)) {
    const nameLower = fileNameOf(entry.path).toLowerCase();
    const dirLower = directoryOf(entry.path).toLowerCase();
    const pathLower = entry.path.toLowerCase();
    const scored = scoreNameAndPath(terms, phrase, nameLower, dirLower, pathLower);
    if (!scored.matchesAll) {
      continue;
    }
    results.push({
      path: entry.path,
      title: fileNameOf(entry.path),
      contentHash: entry.contentHash,
      version: entry.version,
      sizeBytes: entry.sizeBytes,
      mimeType: entry.mimeType,
      score: scored.score,
    });
  }
  results.sort(compareResults);
  return results.slice(0, limit);
}

// One match range inside a snippet, as character offsets within the
// snippet string itself, so UI highlighting needs no recomputation
// (desain-record-search.md section 8.2).
export interface SnippetMatch {
  start: number;
  end: number;
}

// Which field the snippet text was drawn from. When content exists,
// the snippet always comes from content, even when the match was in
// the name; 'name' and 'path' only occur when no content text is
// available and the snippet is empty.
export type FileSnippetField = 'content' | 'name' | 'path';

export interface FileContentSearchResult extends FileNameSearchResult {
  // At most MAX_SNIPPET_CHARS characters, a raw window without
  // ellipsis markers; the UI adds those if it wants them.
  snippet: string;
  snippetField: FileSnippetField;
  snippetMatches: SnippetMatch[];
}

export interface FileContentSearchOptions {
  limit?: number;
  maxSnippetLength?: number;
}

// Finds every non-overlapping occurrence of any term in the given
// text, scanning the original text so offsets stay valid in it.
// At each position the longest matching term wins, which keeps
// overlapping terms from producing overlapping ranges.
function findTermMatches(text: string, termsLower: readonly string[]): SnippetMatch[] {
  const terms = termsLower
    .filter((term) => term.length > 0)
    .sort((a, b) => b.length - a.length);
  const matches: SnippetMatch[] = [];
  let index = 0;
  while (index < text.length) {
    let hitLength = 0;
    for (const term of terms) {
      if (text.slice(index, index + term.length).toLowerCase() === term) {
        hitLength = term.length;
        break;
      }
    }
    if (hitLength > 0) {
      matches.push({ start: index, end: index + hitLength });
      index += hitLength;
    } else {
      index += 1;
    }
  }
  return matches;
}

// Builds one snippet window from file text: centered on the first
// term match when one exists, otherwise the head of the text.
// Matches are offsets inside the returned snippet. When the text is
// empty or no term occurs in it, the snippet carries no matches.
// Exported so V3-27 can reuse the exact snippet rule for record
// content without duplicating it.
export function buildContentSnippet(
  content: string,
  terms: readonly string[],
  maxLength: number = MAX_SNIPPET_CHARS,
): { snippet: string; matches: SnippetMatch[] } {
  const capped = resolveSnippetLength(maxLength);
  const termsLower = terms.map((term) => term.toLowerCase()).filter((term) => term.length > 0);
  if (content.length === 0 || termsLower.length === 0) {
    return { snippet: content.slice(0, capped), matches: [] };
  }
  const lower = content.toLowerCase();
  let firstIndex = -1;
  let firstLength = 0;
  for (const term of termsLower) {
    const found = lower.indexOf(term);
    if (found !== -1 && (firstIndex === -1 || found < firstIndex)) {
      firstIndex = found;
      firstLength = term.length;
    }
  }
  if (firstIndex === -1) {
    return { snippet: content.slice(0, capped), matches: [] };
  }
  let start = firstIndex - Math.floor(capped / 2);
  if (start + capped < firstIndex + firstLength) {
    start = firstIndex + firstLength - capped;
  }
  if (start < 0) {
    start = 0;
  }
  if (start + capped > content.length) {
    start = Math.max(0, content.length - capped);
  }
  const snippet = content.slice(start, start + capped);
  return { snippet, matches: findTermMatches(snippet, termsLower) };
}

async function readContentOrNull(
  provider: FileContentProvider,
  workspaceId: string,
  path: string,
): Promise<string | null> {
  try {
    return await provider.readText(workspaceId, path);
  } catch {
    return null;
  }
}

// Keyword search over file names, relative paths, and file text.
// Every term must appear in at least one of the three fields (AND).
// Name matches outrank path matches, which outrank content matches;
// a whole-phrase match in any field earns a bonus. The provider is
// called at most once per searchable entry. Results are ordered by
// score descending, then path ascending, and truncated to the limit
// after ranking. This is the hook V3-27 calls for the files half of
// GET /api/search (scope files or all); the route layer owns query
// parameter validation for scope, cursor, and tag/type combinations.
export async function searchFilesByContent(
  store: FilesIndexStore,
  provider: FileContentProvider,
  workspaceId: string,
  query: unknown,
  options: FileContentSearchOptions = {},
): Promise<FileContentSearchResult[]> {
  const { terms, phrase } = parseQuery(query);
  const limit = resolveLimit(options.limit);
  const snippetLength = resolveSnippetLength(options.maxSnippetLength);
  const results: FileContentSearchResult[] = [];
  for (const entry of await searchableEntries(store, workspaceId)) {
    const nameLower = fileNameOf(entry.path).toLowerCase();
    const dirLower = directoryOf(entry.path).toLowerCase();
    const content = await readContentOrNull(provider, workspaceId, entry.path);
    const contentLower = content === null ? '' : content.toLowerCase();
    let score = 0;
    let nameHit = false;
    let dirHit = false;
    let contentHit = false;
    let matchesAll = true;
    for (const term of terms) {
      const inName = nameLower.includes(term);
      const inDir = dirLower.includes(term);
      const inContent = content !== null && contentLower.includes(term);
      if (!inName && !inDir && !inContent) {
        matchesAll = false;
        break;
      }
      if (inName) {
        score += NAME_TERM_SCORE;
        nameHit = true;
      }
      if (inDir) {
        score += PATH_TERM_SCORE;
        dirHit = true;
      }
      if (inContent) {
        score += CONTENT_TERM_SCORE;
        contentHit = true;
      }
    }
    if (!matchesAll) {
      continue;
    }
    if (nameLower.includes(phrase)) {
      score += NAME_PHRASE_BONUS;
    } else if (entry.path.toLowerCase().includes(phrase)) {
      score += PATH_PHRASE_BONUS;
    }
    if (content !== null && contentLower.includes(phrase)) {
      score += CONTENT_PHRASE_BONUS;
    }
    const fieldsHit = (nameHit ? 1 : 0) + (dirHit ? 1 : 0) + (contentHit ? 1 : 0);
    if (fieldsHit > 1) {
      score += (fieldsHit - 1) * EXTRA_FIELD_BONUS;
    }
    let snippet = '';
    let snippetField: FileSnippetField = nameHit ? 'name' : 'path';
    let snippetMatches: SnippetMatch[] = [];
    if (content !== null && content.length > 0) {
      const built = buildContentSnippet(content, terms, snippetLength);
      snippet = built.snippet;
      snippetField = 'content';
      snippetMatches = built.matches;
    }
    results.push({
      path: entry.path,
      title: fileNameOf(entry.path),
      contentHash: entry.contentHash,
      version: entry.version,
      sizeBytes: entry.sizeBytes,
      mimeType: entry.mimeType,
      score,
      snippet,
      snippetField,
      snippetMatches,
    });
  }
  results.sort(compareResults);
  return results.slice(0, limit);
}
