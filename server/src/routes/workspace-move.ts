// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace move routes (V3-05 part 2, wave 3B overlap AD-57):
// POST /api/workspace/move and POST /api/workspace/move/repair-links.
// Both share the pure link rewriter in this file
// (rewriteMarkdownLinks) and the scan driver
// (rewriteWorkspaceLinks), so a repair replays exactly the rewrite
// behavior a move would have applied.
//
// Contract: kontrak-api-kanonis.md section 3.1 (move body
// { source, target, rewriteLinks, expectedRevision? }, 200 response
// shape V1-09 section 6.5; repair-links body { source, target },
// 200 move shape + repaired: true, no filesystem rename, V1-09
// section 6.6) and desain-workspace-api.md sections 2.7 and
// 6.1-6.7. Check order, rewrite rules, and response fields mirror
// the R1 client conformance suite
// (tests/workspace-client/move.test.mjs + mock-server.mjs), which
// is the executable form of that contract: unknown-field rejection
// (K-09), write-side path mapping (hidden 400 invalid_path,
// symlink 400 symlink_not_allowed), source-equals-target and
// folder-into-own-subtree 400 invalid_move, missing source 404,
// occupied target 409 already_exists (never overwrite), stale
// file guard 412 revision_conflict with the section 3.4 payload,
// guard ignored for folders, target parents created, and
// affectedCount counting the moved entry plus its descendants.
//
// Frozen dependencies, imported only, never reimplemented:
// validateWorkspacePath / assertNoSymlinkComponents through the
// V3-04a path port (write-adapter.ts), buildRevision through
// lib/revision.ts, body/guard/conflict helpers through
// write-guards.ts, and idempotency hashing/storage through the
// write idempotency port. Auth, CSRF, and Origin come from the
// frozen global hook (middleware/auth-hook.ts); this route only
// declares requiresAuth.
//
// Not in this slice, by design (same precedent as the read side,
// which is disk-only until V3-06): no files-index update, no
// file_events row, no WebSocket event batch, and no write-queue
// serialization. indexHookWarning is honestly null: no index hook
// exists yet to warn about. The integrator wires index, events,
// and queueing when V3-06/V3-08 land; the route shape does not
// change. Idempotency replay likewise activates only when an
// IdempotencyPort is injected (the write-ports contract: when
// absent, keys are validated for shape and otherwise ignored, and
// the revision guard remains the retry protection).
//
// Link rewriting follows desain section 6.3 as pinned by the mock:
// relative Markdown/image destinations resolving to the moved path
// (or under a moved folder) are rewritten relative to the
// referrer's new location; fenced code blocks, inline code spans,
// and HTML comments are skipped; absolute, schemed, and
// out-of-root destinations are kept. The scan covers .md files
// only (case-sensitive suffix), skips hidden segments and symlink
// components, and is bounded by desain section 6.4 (max 5000
// files, max 30 seconds); overflow is reported as pending with
// reason scan_limit and rewriteStatus partial, never as silent
// success.

import { randomBytes } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isTextFilePath } from '../lib/paths.js';
import { buildRevision, quoteETag } from '../lib/revision.js';
import { getPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import { createV304aPathPort } from '../services/workspace/write-adapter.js';
import {
  buildPreview,
  conflictDetails,
  fieldError,
  rejectUnknownFields,
  requireJsonObject,
  type ConflictState,
} from '../services/workspace/write-guards.js';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_SCOPE,
  hashBytes,
  hashIdempotencyRequest,
  stableStringify,
} from '../services/workspace/write-idempotency.js';
import type {
  IdempotencyPort,
  StoredIdempotentResponse,
  WorkspaceIdentity,
  WorkspaceIdentityResolver,
} from '../services/workspace/write-ports.js';

export interface WorkspaceMoveRouteDeps {
  workspaceRoot: string | undefined;
  // Stable server-side workspace key for the revision formula. When
  // omitted, the resolved workspace root path is used as the key,
  // exactly like the read side and the V3-04a revision port.
  workspaceKey?: string;
  // Idempotency storage (PG adapter), injected by the integrator.
  // Absent means keys are shape-checked only; see the header note.
  idempotency?: IdempotencyPort;
  // Session-to-workspace identity for idempotency scoping. Only
  // consulted when an idempotency port is wired.
  resolveIdentity?: WorkspaceIdentityResolver;
}

// JSON body limit for move (desain section 1.7: 64 KiB for
// mkdir/move/restore/patch bodies). Fastify answers 413
// payload_too_large through the global error handler.
export const MOVE_BODY_LIMIT_BYTES = 64 * 1024;

// Rewrite scan bounds (desain section 6.4).
export const MAX_REWRITE_FILES = 5000;
export const REWRITE_SCAN_TIMEOUT_MS = 30 * 1000;

const MOVE_ROUTE_PATH = '/api/workspace/move';
const REPAIR_LINKS_ROUTE_PATH = '/api/workspace/move/repair-links';

export interface MoveRewrittenFile {
  path: string;
  oldRevision: string;
  newRevision: string;
  replacements: number;
}

export interface MoveSkippedFile {
  path: string;
  reason: string;
  detail: string;
}

export interface MoveResponseData {
  source: string;
  target: string;
  kind: 'file' | 'folder';
  rewriteLinks: boolean;
  rewriteStatus: 'complete' | 'partial' | 'skipped_only' | 'disabled';
  revision: string | null;
  rewrittenFiles: MoveRewrittenFile[];
  skipped: MoveSkippedFile[];
  pending: MoveSkippedFile[];
  affectedCount: number;
  indexHookWarning: null;
}

export interface MoveRepairResponseData extends MoveResponseData {
  repaired: true;
}

export interface RewriteWorkspaceLinksResult {
  rewrittenFiles: MoveRewrittenFile[];
  skipped: MoveSkippedFile[];
  pending: MoveSkippedFile[];
}

// --- Pure link rewriting (mirror of mock-server.mjs) ---
//
// The helpers below port the mock's rewrite subset line for line in
// behavior, including its conservative whole-line skips for HTML
// comments and its backtick-split rule for inline code. Do not
// "improve" them without updating the conformance suite: the mock
// is the pinned reference.

function splitSuffix(destination: string): { base: string; suffix: string } {
  const query = destination.indexOf('?');
  const hash = destination.indexOf('#');
  let cut = destination.length;
  if (query !== -1) cut = Math.min(cut, query);
  if (hash !== -1) cut = Math.min(cut, hash);
  return { base: destination.slice(0, cut), suffix: destination.slice(cut) };
}

function resolveRelative(fromDir: string, destination: string): string | null {
  const parts: string[] = fromDir === '' ? [] : fromDir.split('/');
  for (const segment of destination.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

function relativePath(fromDir: string, target: string): string {
  const from = fromDir === '' ? [] : fromDir.split('/');
  const to = target.split('/');
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common += 1;
  }
  const ups = Array<string>(from.length - common).fill('..');
  return [...ups, ...to.slice(common)].join('/');
}

function decodeSegments(value: string): string {
  return value
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

function encodeSegments(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function rewriteDestination(
  destination: string,
  fromDir: string,
  source: string,
  target: string,
  isFolderMove: boolean,
): string | null {
  const { base, suffix } = splitSuffix(destination);
  if (base === '' || base.startsWith('/') || SCHEME_PATTERN.test(base)) {
    return null;
  }
  const wasEncoded = base.includes('%');
  const decoded = wasEncoded ? decodeSegments(base) : base;
  const resolved = resolveRelative(fromDir, decoded);
  if (resolved === null) return null;
  let mapped: string | null = null;
  if (resolved === source) {
    mapped = target;
  } else if (isFolderMove && resolved.startsWith(`${source}/`)) {
    mapped = target + resolved.slice(source.length);
  }
  if (mapped === null) return null;
  let next = relativePath(fromDir, mapped);
  if (wasEncoded) next = encodeSegments(next);
  return next + suffix;
}

function rewriteLine(
  line: string,
  fromDir: string,
  source: string,
  target: string,
  isFolderMove: boolean,
): { line: string; replacements: number } {
  let replacements = 0;
  // Split on inline code spans: only even segments are prose.
  const spans = line.split('`');
  for (let i = 0; i < spans.length; i += 2) {
    let segment = spans[i] as string;
    segment = segment.replace(
      /(!?\[[^\]]*\]\()([^)\s<>]+)([^)]*\))/g,
      (whole, open: string, dest: string, rest: string) => {
        const next = rewriteDestination(dest, fromDir, source, target, isFolderMove);
        if (next === null) return whole;
        replacements += 1;
        if (next.includes(' ') && !next.includes('%20')) return `${open}<${next}>${rest}`;
        return `${open}${next}${rest}`;
      },
    );
    segment = segment.replace(
      /(!?\[[^\]]*\]\(<)([^>]+)(>\))/g,
      (whole, open: string, dest: string, rest: string) => {
        const next = rewriteDestination(dest, fromDir, source, target, isFolderMove);
        if (next === null) return whole;
        replacements += 1;
        return `${open}${next}${rest}`;
      },
    );
    segment = segment.replace(
      /(<img\s+[^>]*?src=["'])([^"']+)(["'])/gi,
      (whole, open: string, dest: string, close: string) => {
        const next = rewriteDestination(dest, fromDir, source, target, isFolderMove);
        if (next === null) return whole;
        replacements += 1;
        return `${open}${next.replace(/ /g, '%20')}${close}`;
      },
    );
    spans[i] = segment;
  }
  let joined = spans.join('`');
  const defMatch = joined.match(/^(\s*\[[^\]]+\]:\s*)(<?)([^>\s]+)(>?)(.*)$/);
  if (defMatch !== null && !joined.includes('`')) {
    const next = rewriteDestination(defMatch[3] as string, fromDir, source, target, isFolderMove);
    if (next !== null) {
      replacements += 1;
      joined = `${defMatch[1]}${defMatch[2]}${next}${defMatch[4]}${defMatch[5]}`;
    }
  }
  return { line: joined, replacements };
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

// Rewrite the relative destinations in one Markdown document that
// point at the moved path. Pure: no filesystem access, so the
// repair-links endpoint and unit tests share this exact behavior.
export function rewriteMarkdownLinks(
  content: string,
  referrerPath: string,
  source: string,
  target: string,
  isFolderMove: boolean,
): { content: string; replacements: number } {
  const fromDir = parentPath(referrerPath);
  const lines = content.split('\n');
  let inFence: string | null = null;
  let inComment = false;
  let replacements = 0;
  const out = lines.map((line) => {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence !== null) {
      const fenceChar = (fence[1] as string)[0] as string;
      if (inFence === null) inFence = fenceChar;
      else if (fence[1] !== undefined && fenceChar === inFence) inFence = null;
      return line;
    }
    if (inFence !== null) return line;
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      return line;
    }
    if (line.includes('<!--') && !line.includes('-->')) {
      inComment = true;
      return line;
    }
    if (line.includes('<!--') && line.includes('-->')) return line;
    const result = rewriteLine(line, fromDir, source, target, isFolderMove);
    replacements += result.replacements;
    return result.line;
  });
  return { content: out.join('\n'), replacements };
}

// --- Filesystem helpers ---

function errnoOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function invalidMove(message: string): ApiError {
  return new ApiError(400, 'invalid_move', message);
}

// Suggested copy path (desain section 3.4, mock algorithm): insert
// " (salinan)" before the extension, then " (salinan 2)", and so
// on, returning the first candidate that does not exist, or null
// after 100 attempts. Existence is checked on disk under rootReal.
async function suggestedCopyPath(rootReal: string, path: string): Promise<string | null> {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const suffix = attempt === 1 ? ' (salinan)' : ` (salinan ${attempt})`;
    const candidate = `${dir}${stem}${suffix}${ext}`;
    try {
      await lstat(join(rootReal, ...candidate.split('/')));
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') {
        return candidate;
      }
      // An uncheckable candidate is treated as taken: never suggest
      // a path whose state is unknown.
      continue;
    }
  }
  return null;
}

// Count the moved entry plus every entry below it (files, folders,
// and symlinks as entries; symlinked directories are not followed).
// Hidden entries count: they move with the subtree.
async function countSubtree(absolute: string, isDirectory: boolean): Promise<number> {
  if (!isDirectory) {
    return 1;
  }
  let count = 1;
  const stack: string[] = [absolute];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      count += 1;
      if (entry.isDirectory()) {
        stack.push(join(dir, entry.name));
      }
    }
  }
  return count;
}

// Create the target's missing parent folders (conformance: move
// creates target parent folders). A parent component that exists
// as a file makes the move impossible: 400 invalid_move.
async function ensureTargetParents(targetAbsolute: string, rootReal: string): Promise<void> {
  const parent = dirname(targetAbsolute);
  if (parent === rootReal) {
    return;
  }
  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOTDIR' || code === 'EEXIST') {
      throw invalidMove('The target parent path is not a directory.');
    }
    throw error;
  }
  const stats = await lstat(parent);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw invalidMove('The target parent path is not a directory.');
  }
}

// Collect rewrite candidates: .md files (case-sensitive suffix)
// anywhere under the root, skipping hidden segments and symlink
// entries, never following symlinked directories. Candidates are
// collected before any rewrite write, so temp files created by
// atomic writes are never rescanned.
async function collectRewriteCandidates(rootReal: string): Promise<string[]> {
  const candidates: string[] = [];
  const stack: Array<{ absolute: string; segments: string[] }> = [{ absolute: rootReal, segments: [] }];
  while (stack.length > 0) {
    const current = stack.pop() as { absolute: string; segments: string[] };
    let entries: Dirent[];
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      // A directory that vanishes mid-scan is skipped: the scan is
      // best effort after a successful rename, and per-file
      // failures surface as skipped entries below.
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const segments = [...current.segments, entry.name];
      if (entry.isDirectory()) {
        stack.push({ absolute: join(current.absolute, entry.name), segments });
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        candidates.push(segments.join('/'));
      }
    }
  }
  candidates.sort();
  return candidates;
}

async function writeFileAtomic(absolute: string, content: Buffer): Promise<void> {
  const tmp = join(dirname(absolute), `.notegen-rewrite-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(tmp, content, { flag: 'wx' });
    await rename(tmp, absolute);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

// Scan the post-move tree and rewrite references to the moved path.
// Shared by POST /api/workspace/move and POST
// /api/workspace/move/repair-links: both run the same scan over the
// same tree shape. Per-file revision
// guards follow desain section 6.4 step 5: a file whose bytes
// change between scan and write is skipped with revision_changed
// instead of overwriting a concurrent edit.
export async function rewriteWorkspaceLinks(options: {
  rootReal: string;
  workspaceKey: string;
  source: string;
  target: string;
  isFolderMove: boolean;
}): Promise<RewriteWorkspaceLinksResult> {
  const { rootReal, workspaceKey, source, target, isFolderMove } = options;
  const rewrittenFiles: MoveRewrittenFile[] = [];
  const skipped: MoveSkippedFile[] = [];
  const pending: MoveSkippedFile[] = [];
  const startedAt = Date.now();
  const candidates = await collectRewriteCandidates(rootReal);
  const processable = candidates.slice(0, MAX_REWRITE_FILES);
  for (const path of candidates.slice(MAX_REWRITE_FILES)) {
    pending.push({
      path,
      reason: 'scan_limit',
      detail: 'The scan limit was reached; rerun repair-links.',
    });
  }
  for (let index = 0; index < processable.length; index += 1) {
    if (Date.now() - startedAt > REWRITE_SCAN_TIMEOUT_MS) {
      for (const path of processable.slice(index)) {
        pending.push({
          path,
          reason: 'scan_limit',
          detail: 'The scan limit was reached; rerun repair-links.',
        });
      }
      break;
    }
    const path = processable[index] as string;
    const absolute = join(rootReal, ...path.split('/'));
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch {
      skipped.push({ path, reason: 'read_error', detail: 'The file could not be read during the scan.' });
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      skipped.push({ path, reason: 'read_error', detail: 'File is not valid UTF-8 text.' });
      continue;
    }
    const oldRevision = buildRevision(workspaceKey, path, bytes);
    const result = rewriteMarkdownLinks(text, path, source, target, isFolderMove);
    if (result.replacements === 0) {
      continue;
    }
    const next = Buffer.from(result.content, 'utf8');
    let current: Buffer;
    try {
      current = await readFile(absolute);
    } catch {
      skipped.push({ path, reason: 'read_error', detail: 'The file could not be read during the scan.' });
      continue;
    }
    if (!current.equals(bytes)) {
      skipped.push({
        path,
        reason: 'revision_changed',
        detail: 'The file changed during the scan; its links were not rewritten.',
      });
      continue;
    }
    try {
      await writeFileAtomic(absolute, next);
    } catch {
      skipped.push({ path, reason: 'write_error', detail: 'The rewritten file could not be written.' });
      continue;
    }
    rewrittenFiles.push({
      path,
      oldRevision,
      newRevision: buildRevision(workspaceKey, path, next),
      replacements: result.replacements,
    });
  }
  return { rewrittenFiles, skipped, pending };
}

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers['idempotency-key'];
  if (raw === undefined) {
    return undefined;
  }
  if (Array.isArray(raw)) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'Idempotency-Key', issue: 'must appear once' }],
    });
  }
  if (raw === '' || raw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'Idempotency-Key', issue: 'must be 1 to 128 characters' }],
    });
  }
  return raw;
}

export async function registerWorkspaceMoveRoutes(
  app: FastifyInstance,
  deps: WorkspaceMoveRouteDeps,
): Promise<void> {
  const pathPort = createV304aPathPort(deps.workspaceRoot);

  app.post(
    MOVE_ROUTE_PATH,
    { config: { requiresAuth: true }, bodyLimit: MOVE_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Body shape first (kontrak K-09 + section 1.5): unknown
      // fields and wrong-typed fields are validation_failed; only
      // syntactically malformed paths reach invalid_path below.
      const body = requireJsonObject(request.body);
      rejectUnknownFields(body, ['source', 'target', 'rewriteLinks', 'expectedRevision']);
      const rawSource = body['source'];
      const rawTarget = body['target'];
      if (typeof rawSource !== 'string') {
        throw fieldError('source', 'expected a string');
      }
      if (typeof rawTarget !== 'string') {
        throw fieldError('target', 'expected a string');
      }
      const rewriteLinks = body['rewriteLinks'] === undefined ? true : body['rewriteLinks'];
      if (typeof rewriteLinks !== 'boolean') {
        throw fieldError('rewriteLinks', 'expected a boolean');
      }
      const expectedRevision = body['expectedRevision'];
      if (expectedRevision !== undefined && typeof expectedRevision !== 'string') {
        throw fieldError('expectedRevision', 'expected a string');
      }

      if (deps.workspaceRoot === undefined || deps.workspaceRoot === '') {
        throw ApiError.serviceUnavailable();
      }
      let rootReal: string;
      try {
        rootReal = await realpath(deps.workspaceRoot);
      } catch {
        throw ApiError.serviceUnavailable();
      }
      const workspaceKey = deps.workspaceKey ?? rootReal;

      // Write-side path mapping for BOTH paths, source error first
      // (frozen V3-04a port: invalid syntax or hidden segments are
      // 400 invalid_path; symlink components are 400
      // symlink_not_allowed; an unresolvable root is 503).
      const sourceResolved = await pathPort.resolveWritePath(rawSource);
      const targetResolved = await pathPort.resolveWritePath(rawTarget);
      const source = sourceResolved.normalized;
      const target = targetResolved.normalized;

      // Idempotency, checked after path validation and before any
      // move-validity check, mirroring the mock: a replayed key
      // returns the stored success even though the source is gone,
      // and a reused key with a different request answers 409
      // before the move is judged. Only successes are stored, so a
      // corrected retry after an error is always possible.
      const idempotencyKey = readIdempotencyKey(request);
      let identity: WorkspaceIdentity | null = null;
      if (deps.idempotency !== undefined) {
        const principal = getPrincipal(request);
        if (principal === undefined || deps.resolveIdentity === undefined) {
          throw ApiError.serviceUnavailable();
        }
        identity = await deps.resolveIdentity(principal);
        if (identity === null) {
          throw ApiError.serviceUnavailable();
        }
      }
      const idempotencyRequest = {
        method: 'POST',
        path: MOVE_ROUTE_PATH,
        guard: expectedRevision ?? '',
        bodyHash: hashBytes(Buffer.from(stableStringify({ source, target, rewriteLinks }), 'utf8')),
      };
      if (deps.idempotency !== undefined && idempotencyKey !== undefined && identity !== null) {
        const requestHash = hashIdempotencyRequest(idempotencyRequest);
        const lookup = await deps.idempotency.lookup({
          userId: identity.userId,
          scope: IDEMPOTENCY_SCOPE,
          key: idempotencyKey,
          requestHash,
        });
        if (lookup.outcome === 'reused') {
          throw new ApiError(
            409,
            'idempotency_key_reused',
            'The idempotency key was already used with a different request.',
          );
        }
        if (lookup.outcome === 'hit') {
          reply.code(200);
          reply.send(successEnvelope(lookup.response.data));
          return;
        }
      }

      if (source === target) {
        throw invalidMove('The source and the target are the same.');
      }

      let sourceStats: Stats;
      try {
        sourceStats = await lstat(sourceResolved.absolute);
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') {
          throw ApiError.notFound();
        }
        throw error;
      }
      if (sourceStats.isSymbolicLink()) {
        throw new ApiError(400, 'symlink_not_allowed', 'Symlinks are not allowed.');
      }
      const isFolderMove = sourceStats.isDirectory();
      if (!isFolderMove && !sourceStats.isFile()) {
        throw invalidMove('The source is not a file or a folder.');
      }
      if (isFolderMove && target.startsWith(`${source}/`)) {
        throw invalidMove('A folder cannot be moved into its own subtree.');
      }

      try {
        await lstat(targetResolved.absolute);
        throw ApiError.alreadyExists();
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }
        if (errnoOf(error) !== 'ENOENT') {
          throw error;
        }
      }

      // Revision guard: files only, and only when the caller sent
      // one. A stale guard answers 412 (amended K-03: move is a
      // 412 endpoint even though its guard arrives in the body)
      // with the section 3.4 conflict payload in details. The
      // guard is ignored for folders, whatever its value.
      if (!isFolderMove && expectedRevision !== undefined) {
        const content = await readFile(sourceResolved.absolute);
        const currentRevision = buildRevision(workspaceKey, source, content);
        if (expectedRevision !== currentRevision) {
          const preview = buildPreview(content, isTextFilePath(source));
          const state: ConflictState = {
            path: source,
            serverRevision: currentRevision,
            serverVersion: null,
            serverModifiedAt: sourceStats.mtime.toISOString(),
            serverSize: content.length,
            currentPreview: preview.currentPreview,
            previewTruncated: preview.previewTruncated,
            suggestedCopyPath: await suggestedCopyPath(rootReal, source),
          };
          throw new ApiError(412, 'revision_conflict', 'The file has changed since it was last read.', {
            details: { detail: `path: ${source}`, ...conflictDetails(state) },
          });
        }
      }

      const affectedCount = await countSubtree(sourceResolved.absolute, isFolderMove);
      await ensureTargetParents(targetResolved.absolute, rootReal);
      try {
        await rename(sourceResolved.absolute, targetResolved.absolute);
      } catch (error) {
        const code = errnoOf(error);
        if (code === 'ENOENT') {
          throw ApiError.notFound();
        }
        if (code === 'EEXIST' || code === 'ENOTEMPTY') {
          throw ApiError.alreadyExists();
        }
        if (code === 'ENOTDIR' || code === 'EISDIR') {
          throw invalidMove('The move cannot be performed at the target path.');
        }
        throw error;
      }

      // The destination revision is computed fresh from the
      // destination bytes at the DESTINATION path: a revision
      // binds its path, so the old revision never survives a move,
      // even when the bytes are identical.
      let revision: string | null = null;
      let targetModifiedAt = sourceStats.mtime;
      if (!isFolderMove) {
        const moved = await readFile(targetResolved.absolute);
        revision = buildRevision(workspaceKey, target, moved);
        targetModifiedAt = (await lstat(targetResolved.absolute)).mtime;
      }

      let rewrite: RewriteWorkspaceLinksResult = { rewrittenFiles: [], skipped: [], pending: [] };
      if (rewriteLinks) {
        rewrite = await rewriteWorkspaceLinks({
          rootReal,
          workspaceKey,
          source,
          target,
          isFolderMove,
        });
      }
      const rewriteStatus: MoveResponseData['rewriteStatus'] = !rewriteLinks
        ? 'disabled'
        : rewrite.pending.length > 0
          ? 'partial'
          : rewrite.skipped.length > 0 && rewrite.rewrittenFiles.length === 0
            ? 'skipped_only'
            : 'complete';

      const data: MoveResponseData = {
        source,
        target,
        kind: isFolderMove ? 'folder' : 'file',
        rewriteLinks,
        rewriteStatus,
        revision,
        rewrittenFiles: rewrite.rewrittenFiles,
        skipped: rewrite.skipped,
        pending: rewrite.pending,
        affectedCount,
        indexHookWarning: null,
      };

      if (deps.idempotency !== undefined && idempotencyKey !== undefined && identity !== null) {
        const stored: StoredIdempotentResponse = {
          status: 200,
          data: data as unknown as Record<string, unknown>,
          // Headers are carried for port-shape compatibility; the
          // move response itself sends no ETag/Last-Modified
          // headers, and replay returns the data only.
          headers: {
            etag: revision === null ? '' : quoteETag(revision),
            revision: revision ?? '',
            lastModified: targetModifiedAt.toUTCString(),
            version: undefined,
          },
        };
        try {
          await deps.idempotency.store({
            userId: identity.userId,
            scope: IDEMPOTENCY_SCOPE,
            key: idempotencyKey,
            requestHash: hashIdempotencyRequest(idempotencyRequest),
            response: stored,
          });
        } catch {
          // Best effort: the move already succeeded, and failing
          // the response now would lie about it. A missing key
          // record only means a later retry re-runs the guards.
        }
      }

      reply.code(200);
      reply.send(successEnvelope(data));
    },
  );

  // Repair-links (desain section 6.6): re-run the rewrite scan
  // only, with NO filesystem rename. Precondition: the target
  // exists and the source is gone; otherwise 409
  // repair_precondition_failed. The body carries source and target
  // only: rewriteLinks and expectedRevision are unknown fields
  // here. The endpoint is naturally idempotent (kontrak section
  // 3.1): a second run finds no remaining references to the source
  // and answers rewrittenFiles: [], so no Idempotency-Key storage
  // is consulted and the header is ignored. affectedCount is 0, as
  // pinned by the mock: nothing is moved, so no entry is affected
  // by a rename; rewritten files are reported in rewrittenFiles.
  app.post(
    REPAIR_LINKS_ROUTE_PATH,
    { config: { requiresAuth: true }, bodyLimit: MOVE_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = requireJsonObject(request.body);
      rejectUnknownFields(body, ['source', 'target']);
      const rawSource = body['source'];
      const rawTarget = body['target'];
      if (typeof rawSource !== 'string') {
        throw fieldError('source', 'expected a string');
      }
      if (typeof rawTarget !== 'string') {
        throw fieldError('target', 'expected a string');
      }

      if (deps.workspaceRoot === undefined || deps.workspaceRoot === '') {
        throw ApiError.serviceUnavailable();
      }
      let rootReal: string;
      try {
        rootReal = await realpath(deps.workspaceRoot);
      } catch {
        throw ApiError.serviceUnavailable();
      }
      const workspaceKey = deps.workspaceKey ?? rootReal;

      // Write-side path mapping for BOTH paths, source error first,
      // exactly as on the move route.
      const sourceResolved = await pathPort.resolveWritePath(rawSource);
      const targetResolved = await pathPort.resolveWritePath(rawTarget);
      const source = sourceResolved.normalized;
      const target = targetResolved.normalized;

      const preconditionFailed = (): ApiError =>
        new ApiError(
          409,
          'repair_precondition_failed',
          'Repair requires the target to exist and the source to be gone.',
        );

      let targetStats: Stats;
      try {
        targetStats = await lstat(targetResolved.absolute);
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') {
          throw preconditionFailed();
        }
        throw error;
      }
      if (targetStats.isSymbolicLink()) {
        throw new ApiError(400, 'symlink_not_allowed', 'Symlinks are not allowed.');
      }
      const isFolderMove = targetStats.isDirectory();
      if (!isFolderMove && !targetStats.isFile()) {
        throw preconditionFailed();
      }
      // The source must be gone. Any entry at the source path,
      // including a symlink, fails the precondition. When source
      // equals target this check fails too, since the target was
      // just shown to exist.
      try {
        await lstat(sourceResolved.absolute);
        throw preconditionFailed();
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }
        if (errnoOf(error) !== 'ENOENT') {
          throw error;
        }
      }

      const rewrite = await rewriteWorkspaceLinks({
        rootReal,
        workspaceKey,
        source,
        target,
        isFolderMove,
      });

      // The destination revision is computed fresh from the target
      // bytes AFTER the scan, so it agrees with a later read even
      // when the target file itself was rewritten. A target that
      // vanished mid-scan no longer satisfies the precondition.
      let revision: string | null = null;
      if (!isFolderMove) {
        try {
          const targetBytes = await readFile(targetResolved.absolute);
          revision = buildRevision(workspaceKey, target, targetBytes);
        } catch (error) {
          if (errnoOf(error) === 'ENOENT') {
            throw preconditionFailed();
          }
          throw error;
        }
      }

      const rewriteStatus: MoveResponseData['rewriteStatus'] =
        rewrite.pending.length > 0
          ? 'partial'
          : rewrite.skipped.length > 0 && rewrite.rewrittenFiles.length === 0
            ? 'skipped_only'
            : 'complete';

      const data: MoveRepairResponseData = {
        source,
        target,
        kind: isFolderMove ? 'folder' : 'file',
        rewriteLinks: true,
        rewriteStatus,
        revision,
        rewrittenFiles: rewrite.rewrittenFiles,
        skipped: rewrite.skipped,
        pending: rewrite.pending,
        affectedCount: 0,
        indexHookWarning: null,
        repaired: true,
      };

      reply.code(200);
      reply.send(successEnvelope(data));
    },
  );
}
