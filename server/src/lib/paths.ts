// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace path validation (frozen shared shape, owner V3-04a).
//
// This module is the single authority for workspace-relative paths on
// the server. Every workspace endpoint, read or write, validates its
// path through validateWorkspacePath before touching disk or the
// index (desain-workspace-api.md section 8). V3-04b, V3-05, V3-06,
// and V3-07 import this module; they must not write a competing
// validator. Changes to this shape need a recorded amendment.
//
// Rules (strict form, per the V3-04a brief and the R1 client
// conformance suite in tests/workspace-client/):
// - Input must be a string. Anything else is invalid.
// - The empty string means the workspace root only on endpoints that
//   say so (list, scan folder); elsewhere it is invalid.
// - Absolute paths, drive-letter paths, backslashes, empty segments
//   (double slashes, trailing slash), and "." or ".." segments are
//   rejected. Backslashes are never normalized into slashes and ".."
//   is never resolved as "go up one level": both are classic
//   traversal bypass sources. This is stricter than the
//   normalization sketch in desain-workspace-api.md section 8.2
//   step 3, which the brief and the strict-segment conformance cases
//   override: malformed segment forms are errors, not spellings to
//   repair silently.
// - NUL and control characters (U+0000 to U+001F, U+007F) are
//   rejected. Percent sequences are literal file-name characters:
//   the framework already decoded the query string once, and this
//   module never decodes again (no double decode, desain 8.2).
// - Length is at most 1024 UTF-8 bytes and at most 50 segments
//   (desain section 1.7).
// - A segment starting with "." makes the path hidden. Hiddenness is
//   reported on the result, not rejected here, because reads and
//   writes answer differently: reads answer 404 not_found (no
//   enumeration leak), writes answer 400 invalid_path
//   (desain section 8.6). Callers map the hidden flag to the right
//   status for their operation.
// - Symlinks are never followed (desain section 8.5).
//   assertNoSymlinkComponents walks the path with lstat and throws
//   WorkspaceSymlinkError when any existing component is a symlink.
//   Callers map that to 404 for reads and 400 symlink_not_allowed
//   for writes. The same walk verifies containment of the longest
//   existing prefix inside the resolved workspace root.
//
// Trash lives outside the workspace root (AD-17). Paths validated
// here never name trash entries; trash ids are a separate namespace
// owned by V3-05.

import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

export const MAX_WORKSPACE_PATH_BYTES = 1024;
export const MAX_WORKSPACE_PATH_SEGMENTS = 50;

// Thrown when a path is syntactically invalid. Route handlers map
// this to 400 invalid_path.
export class InvalidWorkspacePathError extends Error {
  constructor(message = 'The path is not valid.') {
    super(message);
    this.name = 'InvalidWorkspacePathError';
  }
}

// Thrown when an existing path component is a symlink. Route handlers
// map this to 404 not_found for reads and 400 symlink_not_allowed for
// writes (desain section 8.5).
export class WorkspaceSymlinkError extends Error {
  constructor(message = 'Symlinks are not allowed in the workspace.') {
    super(message);
    this.name = 'WorkspaceSymlinkError';
  }
}

// Thrown when the workspace root itself cannot be resolved (missing
// or unreadable). Route handlers map this to 503
// service_unavailable: the deployment is not ready, not the request.
export class WorkspaceRootUnavailableError extends Error {
  constructor(message = 'The workspace is not available.') {
    super(message);
    this.name = 'WorkspaceRootUnavailableError';
  }
}

export interface ValidatedWorkspacePath {
  // Normalized relative path, POSIX style, no leading or trailing
  // slash. Empty string only for the root.
  readonly path: string;
  readonly segments: readonly string[];
  // True when any segment starts with "." (dotfiles and dot
  // directories, including .notegen and .git). Callers decide the
  // status code: 404 for reads, 400 for writes.
  readonly hidden: boolean;
  readonly isRoot: boolean;
}

export interface ValidateWorkspacePathOptions {
  // When true, the empty string validates as the root. List and scan
  // use this; file, stat, and write endpoints do not.
  allowEmptyAsRoot?: boolean;
}

const DRIVE_LETTER_PATTERN = /^[A-Za-z]:/;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function isHiddenWorkspacePath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

export function validateWorkspacePath(
  input: unknown,
  options: ValidateWorkspacePathOptions = {},
): ValidatedWorkspacePath {
  if (typeof input !== 'string') {
    throw new InvalidWorkspacePathError();
  }
  if (input === '') {
    if (options.allowEmptyAsRoot === true) {
      return { path: '', segments: [], hidden: false, isRoot: true };
    }
    throw new InvalidWorkspacePathError();
  }
  if (input.startsWith('/') || DRIVE_LETTER_PATTERN.test(input)) {
    throw new InvalidWorkspacePathError();
  }
  if (input.includes('\\') || hasControlCharacter(input)) {
    throw new InvalidWorkspacePathError();
  }
  if (Buffer.byteLength(input, 'utf8') > MAX_WORKSPACE_PATH_BYTES) {
    throw new InvalidWorkspacePathError();
  }
  const segments = input.split('/');
  if (segments.length > MAX_WORKSPACE_PATH_SEGMENTS) {
    throw new InvalidWorkspacePathError();
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new InvalidWorkspacePathError();
    }
  }
  return {
    path: input,
    segments,
    hidden: isHiddenWorkspacePath(input),
    isRoot: false,
  };
}

// Pure join of a validated path under a workspace root. This does no
// filesystem access and no symlink check; use
// assertNoSymlinkComponents when the result will be opened.
export function workspaceFsPath(workspaceRoot: string, validated: ValidatedWorkspacePath): string {
  if (validated.isRoot) {
    return workspaceRoot;
  }
  return join(workspaceRoot, ...validated.segments);
}

function isWithinRoot(rootReal: string, candidate: string): boolean {
  return candidate === rootReal || candidate.startsWith(rootReal + sep);
}

// Walk the path from the resolved root, rejecting symlink components
// and verifying containment. Returns the absolute filesystem path to
// use for the operation (under the resolved root, so a symlinked
// root itself is still fine). A missing tail is allowed: the walk
// stops at the first missing component and returns the joined path,
// leaving existence checks to the caller.
export async function assertNoSymlinkComponents(
  workspaceRoot: string,
  validated: ValidatedWorkspacePath,
): Promise<string> {
  let rootReal: string;
  try {
    rootReal = await realpath(workspaceRoot);
  } catch {
    throw new WorkspaceRootUnavailableError();
  }
  let current = rootReal;
  let existingPrefix = rootReal;
  for (const segment of validated.segments) {
    const next = join(current, segment);
    let stats;
    try {
      stats = await lstat(next);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        break;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new WorkspaceSymlinkError();
    }
    current = next;
    existingPrefix = next;
  }
  let prefixReal: string;
  try {
    prefixReal = await realpath(existingPrefix);
  } catch {
    throw new WorkspaceRootUnavailableError();
  }
  if (!isWithinRoot(rootReal, prefixReal)) {
    throw new InvalidWorkspacePathError();
  }
  return workspaceFsPath(rootReal, validated);
}

// Text file extensions for GET /api/workspace/file (kontrak 3.1,
// desain section 2.2). This is deliberately narrower than upstream
// isSyncTextPath, which also accepts csv, svg, tex, and others: the
// canonical contract fixes the read endpoint to .md and .txt, and
// assumption A5 (verifying the upstream list) does not widen the
// wire contract without an amendment. Other extensions answer 415
// not_text_file and are served, if at all, through the media
// endpoint owned by V3-07.
export const TEXT_FILE_EXTENSIONS: readonly string[] = ['.md', '.txt'];

export function isTextFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  return TEXT_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function textContentTypeForPath(path: string): string | null {
  if (path.toLowerCase().endsWith('.md')) {
    return 'text/markdown; charset=utf-8';
  }
  if (path.toLowerCase().endsWith('.txt')) {
    return 'text/plain; charset=utf-8';
  }
  return null;
}
