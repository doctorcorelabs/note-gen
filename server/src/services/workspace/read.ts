// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Read-only workspace service (owner V3-04a).
//
// Implements the read side of kontrak 3.1 over the workspace disk:
// list one folder, read a text file, HEAD a file, recursive .md scan,
// and stat. No method here writes disk, the index, trash, or any
// server state (kontrak: no mutation through GET).
//
// Data sources in this slice: disk only. Listing reads the directory
// on disk, not the Postgres files index, because the index builder
// belongs to V3-06 and is not available yet; the design target
// (desain section 0.3 item 2, index-backed listing) is reached when
// V3-06 lands and this service gains an index-backed reader behind
// the same route shapes. Version numbers come from the optional
// resolveVersion injection and are null until the index exists:
// stat and list honestly report version null for files whose index
// row is missing (desain section 2.10), and X-Version is omitted in
// that case.
//
// Revisions are computed from disk bytes with buildRevision, so a
// read always reflects the current bytes. For list and scan entries,
// files larger than MAX_ENTRY_REVISION_BYTES report revision null:
// hashing a very large media file on every listing is not cheap, and
// desain section 1.4 explicitly allows null revisions in listings.
// Clients fetch the revision through stat or file read before
// writing. Stat and file reads always compute the revision.
//
// Symlinks are never followed. Every path passes through
// assertNoSymlinkComponents, reads open files with O_NOFOLLOW, and
// list/scan skip symlink entries silently (desain section 8.5).
// Hidden (dot-segment) paths answer 404 not_found on reads, never
// 400, so hidden files cannot be enumerated by status code
// (desain section 8.6).
//
// Cursors are opaque base64url JSON: { v: 1, kind, anchor... }.
// A cursor that does not decode, does not parse, or has the wrong
// shape or kind answers 400 invalid_cursor. List cursors anchor on
// the last entry's sort position (folders first, then files, each
// alphabetical by name); scan cursors anchor on the last path in
// lexicographic order.

import { constants as fsConstants, lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError } from '../../plugins/envelope.js';
import {
  InvalidWorkspacePathError,
  WorkspaceRootUnavailableError,
  WorkspaceSymlinkError,
  assertNoSymlinkComponents,
  isTextFilePath,
  textContentTypeForPath,
  validateWorkspacePath,
  type ValidatedWorkspacePath,
} from '../../lib/paths.js';
import { buildRevision, ifNoneMatchMatches } from '../../lib/revision.js';

export const DEFAULT_LIST_LIMIT = 500;
export const MAX_LIST_LIMIT = 1000;
export const MAX_ENTRY_REVISION_BYTES = 8 * 1024 * 1024;

export interface WorkspaceEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number | null;
  modifiedAt: string | null;
  createdAt: string | null;
  revision: string | null;
  version: number | null;
  isLocale: true;
}

export interface ScanEntry extends WorkspaceEntry {
  relativePath: string;
}

export interface ListResult {
  path: string;
  entries: WorkspaceEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ScanResult {
  folder: string;
  entries: ScanEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ReadFileResult {
  notModified: boolean;
  text: string | null;
  contentType: string;
  revision: string;
  version: number | null;
  size: number;
  modifiedAt: Date;
}

export interface HeadFileResult {
  contentType: string;
  revision: string;
  version: number | null;
  size: number;
  modifiedAt: Date;
}

export interface StatResult {
  entry: WorkspaceEntry;
  revision: string | null;
  modifiedAt: Date | null;
}

export interface WorkspaceReaderDeps {
  workspaceRoot: string | undefined;
  // Stable server-side workspace key for the revision formula. When
  // omitted, the resolved workspace root path is used as the key: it
  // is stable for a deployment and never leaves the server. The
  // workspace UUID (desain assumption A1) replaces it once V3-06
  // wires the index; the formula itself does not change.
  workspaceKey?: string;
  // Index version lookup, injected by V3-06. Absent means no index
  // is available and every version is null.
  resolveVersion?: (path: string) => Promise<number | null>;
}

export interface PaginationQuery {
  cursor?: unknown;
  limit?: unknown;
  includeMetadata?: unknown;
}

interface ListCursor {
  v: 1;
  kind: 'list';
  afterName: string;
  afterIsDirectory: boolean;
  afterPath: string;
}

interface ScanCursor {
  v: 1;
  kind: 'scan';
  afterPath: string;
}

function invalidCursor(): ApiError {
  return new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
}

function invalidLimit(): ApiError {
  return new ApiError(400, 'invalid_limit', 'The pagination limit is not valid.');
}

function invalidQuery(): ApiError {
  return new ApiError(400, 'invalid_query', 'The query string is not valid.');
}

function notADirectory(): ApiError {
  return new ApiError(400, 'not_a_directory', 'The path is not a directory.');
}

function notTextFile(): ApiError {
  return new ApiError(415, 'not_text_file', 'The file is not a text file. Use the media endpoint.');
}

function invalidTextEncoding(): ApiError {
  return new ApiError(422, 'invalid_text_encoding', 'The file is not valid UTF-8 text.');
}

// Map path-layer errors to read-side HTTP errors. Write-side mapping
// differs (hidden and symlink paths are 400 there); that mapping
// lives in the write service owned by V3-04b, not here.
function mapPathError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof InvalidWorkspacePathError) {
    return ApiError.invalidPath();
  }
  if (error instanceof WorkspaceSymlinkError) {
    return ApiError.notFound();
  }
  if (error instanceof WorkspaceRootUnavailableError) {
    return ApiError.serviceUnavailable();
  }
  throw error;
}

export function parseLimit(raw: unknown, defaultLimit: number, maxLimit: number): number {
  if (raw === undefined) {
    return defaultLimit;
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw invalidLimit();
  }
  // Compare as BigInt so a digit string far beyond the safe-integer
  // range still clamps to the maximum instead of erroring: the
  // contract clamps any limit above the maximum (kontrak 1.4).
  const value = BigInt(raw);
  if (value < BigInt(1)) {
    throw invalidLimit();
  }
  if (value > BigInt(maxLimit)) {
    return maxLimit;
  }
  return Number(value);
}

export function parseIncludeMetadata(raw: unknown, defaultValue: boolean): boolean {
  if (raw === undefined) {
    return defaultValue;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw invalidQuery();
}

function encodeCursor(cursor: ListCursor | ScanCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: unknown, kind: 'list'): ListCursor | null;
function decodeCursor(raw: unknown, kind: 'scan'): ScanCursor | null;
function decodeCursor(raw: unknown, kind: 'list' | 'scan'): ListCursor | ScanCursor | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor();
  }
  const record = parsed as Record<string, unknown>;
  if (record['v'] !== 1 || record['kind'] !== kind) {
    throw invalidCursor();
  }
  if (kind === 'list') {
    const keys = Object.keys(record).sort();
    if (
      keys.join(',') !== 'afterIsDirectory,afterName,afterPath,kind,v' ||
      typeof record['afterName'] !== 'string' ||
      typeof record['afterIsDirectory'] !== 'boolean' ||
      typeof record['afterPath'] !== 'string'
    ) {
      throw invalidCursor();
    }
    return record as unknown as ListCursor;
  }
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'afterPath,kind,v' || typeof record['afterPath'] !== 'string') {
    throw invalidCursor();
  }
  return record as unknown as ScanCursor;
}

// Code-unit comparison, case sensitive, no locale (desain 1.6).
function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function isoOrNull(date: Date): string | null {
  const ms = date.getTime();
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  return date.toISOString();
}

async function readFileNoFollow(fsPath: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(fsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
        return null;
      }
    }
    throw error;
  }
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export function createWorkspaceReader(deps: WorkspaceReaderDeps) {
  const resolveVersion = deps.resolveVersion;

  async function requireRoot(): Promise<string> {
    if (deps.workspaceRoot === undefined || deps.workspaceRoot === '') {
      throw ApiError.serviceUnavailable();
    }
    let rootReal: string;
    try {
      rootReal = await realpath(deps.workspaceRoot);
    } catch {
      throw ApiError.serviceUnavailable();
    }
    let rootStats;
    try {
      rootStats = await stat(rootReal);
    } catch {
      throw ApiError.serviceUnavailable();
    }
    if (!rootStats.isDirectory()) {
      throw ApiError.serviceUnavailable();
    }
    return rootReal;
  }

  // Resolve a validated path to an absolute path under the root,
  // rejecting symlink components. Path-layer errors become read-side
  // HTTP errors here.
  async function resolveChecked(
    validated: ValidatedWorkspacePath,
    rootReal: string,
  ): Promise<string> {
    try {
      return await assertNoSymlinkComponents(rootReal, validated);
    } catch (error) {
      throw mapPathError(error);
    }
  }

  async function entryFor(
    rootReal: string,
    workspaceKey: string,
    relativePath: string,
    includeMetadata: boolean,
    revisionMode: 'capped' | 'always' = 'capped',
  ): Promise<WorkspaceEntry | null> {
    const fsPath = relativePath === '' ? rootReal : join(rootReal, ...relativePath.split('/'));
    let stats;
    try {
      stats = await lstat(fsPath);
    } catch {
      return null;
    }
    if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
      return null;
    }
    const isDirectory = stats.isDirectory();
    const name = relativePath === '' ? '' : (relativePath.split('/').pop() as string);
    let revision: string | null = null;
    if (!isDirectory && (revisionMode === 'always' || stats.size <= MAX_ENTRY_REVISION_BYTES)) {
      const bytes = await readFileNoFollow(fsPath);
      if (bytes !== null) {
        revision = buildRevision(workspaceKey, relativePath, bytes);
      }
    }
    const version = isDirectory || resolveVersion === undefined ? null : await resolveVersion(relativePath);
    return {
      name,
      path: relativePath,
      isDirectory,
      isFile: !isDirectory,
      size: includeMetadata ? (isDirectory ? null : stats.size) : null,
      modifiedAt: includeMetadata ? isoOrNull(stats.mtime) : null,
      createdAt: includeMetadata ? isoOrNull(stats.birthtime) : null,
      revision,
      version,
      isLocale: true,
    };
  }

  async function list(pathInput: unknown, query: PaginationQuery): Promise<ListResult> {
    const limit = parseLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const includeMetadata = parseIncludeMetadata(query.includeMetadata, true);
    const cursor = decodeCursor(query.cursor, 'list');
    let validated: ValidatedWorkspacePath;
    try {
      // An absent path parameter means the root, same as an empty one.
      validated = validateWorkspacePath(pathInput === undefined ? '' : pathInput, {
        allowEmptyAsRoot: true,
      });
    } catch (error) {
      throw mapPathError(error);
    }
    if (validated.hidden) {
      throw ApiError.notFound();
    }
    const rootReal = await requireRoot();
    const workspaceKey = deps.workspaceKey ?? rootReal;
    const fsPath = await resolveChecked(validated, rootReal);
    let dirStats;
    try {
      dirStats = await lstat(fsPath);
    } catch {
      throw ApiError.notFound();
    }
    if (dirStats.isSymbolicLink()) {
      throw ApiError.notFound();
    }
    if (!dirStats.isDirectory()) {
      throw notADirectory();
    }
    const dirents = await readdir(fsPath, { withFileTypes: true });
    const entries: WorkspaceEntry[] = [];
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) {
        continue;
      }
      const childPath = validated.path === '' ? dirent.name : `${validated.path}/${dirent.name}`;
      const entry = await entryFor(rootReal, workspaceKey, childPath, includeMetadata);
      if (entry !== null) {
        entries.push(entry);
      }
    }
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return compareStrings(a.name, b.name);
    });
    let start = 0;
    if (cursor !== null) {
      start = entries.findIndex((entry) => {
        if (entry.isDirectory !== cursor.afterIsDirectory) {
          return entry.isDirectory === false && cursor.afterIsDirectory === true;
        }
        const byName = compareStrings(entry.name, cursor.afterName);
        if (byName !== 0) {
          return byName > 0;
        }
        return compareStrings(entry.path, cursor.afterPath) > 0;
      });
      if (start === -1) {
        start = entries.length;
      }
    }
    const page = entries.slice(start, start + limit);
    const hasMore = start + page.length < entries.length;
    const last = page[page.length - 1];
    return {
      path: validated.path,
      entries: page,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({
              v: 1,
              kind: 'list',
              afterName: last.name,
              afterIsDirectory: last.isDirectory,
              afterPath: last.path,
            })
          : null,
      hasMore,
    };
  }

  async function scan(folderInput: unknown, query: PaginationQuery): Promise<ScanResult> {
    const limit = parseLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const includeMetadata = parseIncludeMetadata(query.includeMetadata, false);
    const cursor = decodeCursor(query.cursor, 'scan');
    let validated: ValidatedWorkspacePath;
    try {
      // An absent folder parameter means the root, same as an empty one.
      validated = validateWorkspacePath(folderInput === undefined ? '' : folderInput, {
        allowEmptyAsRoot: true,
      });
    } catch (error) {
      throw mapPathError(error);
    }
    if (validated.hidden) {
      throw ApiError.notFound();
    }
    const rootReal = await requireRoot();
    const workspaceKey = deps.workspaceKey ?? rootReal;
    const fsPath = await resolveChecked(validated, rootReal);
    let dirStats;
    try {
      dirStats = await lstat(fsPath);
    } catch {
      throw ApiError.notFound();
    }
    if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
      throw ApiError.notFound();
    }
    const found: string[] = [];
    const stack: string[] = [validated.path];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      const currentFs = current === '' ? rootReal : join(rootReal, ...current.split('/'));
      const dirents = await readdir(currentFs, { withFileTypes: true });
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) {
          continue;
        }
        const childPath = current === '' ? dirent.name : `${current}/${dirent.name}`;
        const childFs = join(currentFs, dirent.name);
        let childStats;
        try {
          childStats = await lstat(childFs);
        } catch {
          continue;
        }
        if (childStats.isSymbolicLink()) {
          continue;
        }
        if (childStats.isDirectory()) {
          stack.push(childPath);
        } else if (childStats.isFile() && childPath.endsWith('.md')) {
          found.push(childPath);
        }
      }
    }
    found.sort(compareStrings);
    let start = 0;
    if (cursor !== null) {
      start = found.findIndex((path) => compareStrings(path, cursor.afterPath) > 0);
      if (start === -1) {
        start = found.length;
      }
    }
    const pagePaths = found.slice(start, start + limit);
    const entries: ScanEntry[] = [];
    for (const path of pagePaths) {
      const entry = await entryFor(rootReal, workspaceKey, path, includeMetadata);
      if (entry === null) {
        continue;
      }
      const relativePath =
        validated.path === '' ? path : path.slice(validated.path.length + 1);
      entries.push({ ...entry, relativePath });
    }
    const hasMore = start + pagePaths.length < found.length;
    const lastPath = pagePaths[pagePaths.length - 1];
    return {
      folder: validated.path,
      entries,
      nextCursor:
        hasMore && lastPath !== undefined
          ? encodeCursor({ v: 1, kind: 'scan', afterPath: lastPath })
          : null,
      hasMore,
    };
  }

  async function statEntry(pathInput: unknown): Promise<StatResult> {
    let validated: ValidatedWorkspacePath;
    try {
      validated = validateWorkspacePath(pathInput, {});
    } catch (error) {
      throw mapPathError(error);
    }
    if (validated.hidden) {
      throw ApiError.notFound();
    }
    const rootReal = await requireRoot();
    const workspaceKey = deps.workspaceKey ?? rootReal;
    const fsPath = await resolveChecked(validated, rootReal);
    let stats;
    try {
      stats = await lstat(fsPath);
    } catch {
      throw ApiError.notFound();
    }
    if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
      throw ApiError.notFound();
    }
    const entry = await entryFor(rootReal, workspaceKey, validated.path, true, 'always');
    if (entry === null) {
      throw ApiError.notFound();
    }
    return {
      entry,
      revision: entry.isFile ? entry.revision : null,
      modifiedAt: entry.isFile ? stats.mtime : null,
    };
  }

  async function readFile(
    pathInput: unknown,
    ifNoneMatch: string | string[] | undefined,
  ): Promise<ReadFileResult> {
    let validated: ValidatedWorkspacePath;
    try {
      validated = validateWorkspacePath(pathInput, {});
    } catch (error) {
      throw mapPathError(error);
    }
    if (validated.hidden) {
      throw ApiError.notFound();
    }
    const rootReal = await requireRoot();
    const workspaceKey = deps.workspaceKey ?? rootReal;
    const fsPath = await resolveChecked(validated, rootReal);
    let stats;
    try {
      stats = await lstat(fsPath);
    } catch {
      throw ApiError.notFound();
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw ApiError.notFound();
    }
    if (!isTextFilePath(validated.path)) {
      throw notTextFile();
    }
    const bytes = await readFileNoFollow(fsPath);
    if (bytes === null) {
      throw ApiError.notFound();
    }
    const revision = buildRevision(workspaceKey, validated.path, bytes);
    const version = resolveVersion === undefined ? null : await resolveVersion(validated.path);
    const contentType = textContentTypeForPath(validated.path) as string;
    if (ifNoneMatchMatches(ifNoneMatch, revision)) {
      return {
        notModified: true,
        text: null,
        contentType,
        revision,
        version,
        size: bytes.length,
        modifiedAt: stats.mtime,
      };
    }
    let text: string;
    try {
      // ignoreBOM keeps a leading byte order mark as U+FEFF in the
      // text, so re-encoding the text reproduces the stored bytes
      // exactly and the revision stays stable across read and write.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw invalidTextEncoding();
    }
    return {
      notModified: false,
      text,
      contentType,
      revision,
      version,
      size: bytes.length,
      modifiedAt: stats.mtime,
    };
  }

  async function headFile(pathInput: unknown): Promise<HeadFileResult> {
    let validated: ValidatedWorkspacePath;
    try {
      validated = validateWorkspacePath(pathInput, {});
    } catch (error) {
      throw mapPathError(error);
    }
    if (validated.hidden) {
      throw ApiError.notFound();
    }
    const rootReal = await requireRoot();
    const workspaceKey = deps.workspaceKey ?? rootReal;
    const fsPath = await resolveChecked(validated, rootReal);
    let stats;
    try {
      stats = await lstat(fsPath);
    } catch {
      throw ApiError.notFound();
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw ApiError.notFound();
    }
    // HEAD answers 200 for non-text and invalid-UTF-8 files: 415 and
    // 422 do not apply to HEAD (kontrak 3.1). The revision is still
    // computed from the raw bytes.
    const bytes = await readFileNoFollow(fsPath);
    if (bytes === null) {
      throw ApiError.notFound();
    }
    const revision = buildRevision(workspaceKey, validated.path, bytes);
    const version = resolveVersion === undefined ? null : await resolveVersion(validated.path);
    return {
      contentType: textContentTypeForPath(validated.path) ?? 'application/octet-stream',
      revision,
      version,
      size: bytes.length,
      modifiedAt: stats.mtime,
    };
  }

  return { list, scan, stat: statEntry, readFile, headFile };
}

export type WorkspaceReader = ReturnType<typeof createWorkspaceReader>;
