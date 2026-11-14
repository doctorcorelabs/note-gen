// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { capabilityError } from "../errors";
import type { AssetUrlAdapter, AssetUrlOptions } from "./interface";

/**
 * Web implementation of AssetUrlAdapter: a pure URL builder.
 *
 * Contract (V1-09 workspace API, section 7): a workspace-relative
 * path becomes `/api/workspace/media/<path>` with each segment
 * percent-encoded separately, plus an optional `?v=` cache-busting
 * value from the file revision. The server ignores `v` for
 * authorization and content; ETag stays authoritative for
 * revalidation. Media URLs require the same session authentication
 * as every other workspace endpoint; there is no public media URL.
 * This builder performs no I/O and no fetch: it only constructs the
 * string, and the browser loads it with the session cookie.
 *
 * Client-side path defense (first layer only; the server validates
 * again authoritatively per V1-09 section 8, and the server verdict
 * always wins):
 * - Backslashes are normalized to slashes, empty segments and "."
 *   segments are dropped, matching the server normalization.
 * - ".." segments are rejected, never resolved upward: resolving
 *   them is the classic traversal bypass.
 * - Segments starting with "." are rejected: hidden entries are
 *   never exposed through the workspace API.
 * - Absolute paths (leading slash, Windows drive letter) are
 *   rejected: they cannot name a file inside the workspace.
 * - NUL and control characters, paths over 1024 UTF-8 bytes, and
 *   paths over 50 segments are rejected, matching the server limits.
 * - Error reasons never echo the supplied path.
 *
 * Passthrough: already-resolved sources and already-built media
 * URLs are returned unchanged, so the builder is idempotent and so
 * external media keeps loading directly (V1-09 section 7.1). When a
 * media URL is passed through, revision options are ignored.
 *
 * No internal cache: building the string is cheap, and the existing
 * per-workspace URL caches stay with their call sites (utils.ts),
 * preserving their shape. Callers must pass the revision through
 * AssetUrlOptions instead of appending "?v=" by hand to the result.
 */

const MEDIA_BASE_PATH = "/api/workspace/media";
const RESOLVED_SRC_RE = /^(?:https?:|data:|blob:|asset:|tauri:|file:)/i;
const DRIVE_LETTER_RE = /^[A-Za-z]:/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const MAX_PATH_BYTES = 1024;
const MAX_SEGMENTS = 50;

function invalidPath(reason: string): never {
  throw capabilityError("invalid_argument", "asset-url", "assetUrl.convertFileSrc", "web", reason);
}

function normalizeSegments(workspacePath: string): string[] {
  if (workspacePath.length === 0) {
    invalidPath("Workspace path must not be empty.");
  }
  if (CONTROL_CHAR_RE.test(workspacePath)) {
    invalidPath("Workspace path must not contain NUL or control characters.");
  }
  if (workspacePath.startsWith("/")) {
    invalidPath("Absolute paths cannot be converted to media URLs; pass a workspace-relative path.");
  }
  if (DRIVE_LETTER_RE.test(workspacePath)) {
    invalidPath(
      "Absolute Windows paths cannot be converted to media URLs; pass a workspace-relative path.",
    );
  }
  const unified = workspacePath.replace(/\\/g, "/");
  if (unified.startsWith("/")) {
    invalidPath("Absolute paths cannot be converted to media URLs; pass a workspace-relative path.");
  }
  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      invalidPath('Workspace path must not contain ".." segments.');
    }
    if (segment.startsWith(".")) {
      invalidPath("Path segments starting with a dot are hidden and never exposed as media URLs.");
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    invalidPath("Workspace path must name a file inside the workspace.");
  }
  if (segments.length > MAX_SEGMENTS) {
    invalidPath("Workspace path has too many segments.");
  }
  const byteLength = new TextEncoder().encode(segments.join("/")).length;
  if (byteLength > MAX_PATH_BYTES) {
    invalidPath("Workspace path exceeds the maximum length.");
  }
  return segments;
}

function cacheBusterValue(options: AssetUrlOptions | undefined): string | null {
  for (const candidate of [options?.cacheBuster, options?.revision]) {
    if (candidate === null || candidate === undefined) {
      continue;
    }
    const text = typeof candidate === "number" ? String(candidate) : candidate;
    const stripped = text.startsWith("sha256:") ? text.slice("sha256:".length) : text;
    if (stripped.length > 0) {
      return stripped;
    }
  }
  return null;
}

export function createWebAssetUrlAdapter(): AssetUrlAdapter {
  return {
    convertFileSrc(workspacePath: string, options?: AssetUrlOptions): string {
      if (typeof workspacePath !== "string") {
        invalidPath("Workspace path must be a string.");
      }
      if (workspacePath === MEDIA_BASE_PATH || workspacePath.startsWith(`${MEDIA_BASE_PATH}/`)) {
        return workspacePath;
      }
      if (RESOLVED_SRC_RE.test(workspacePath)) {
        return workspacePath;
      }
      const segments = normalizeSegments(workspacePath);
      const path = `${MEDIA_BASE_PATH}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
      const version = cacheBusterValue(options);
      return version === null ? path : `${path}?v=${encodeURIComponent(version)}`;
    },
  };
}
