// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { capabilityError } from "../errors";
import type { AssetUrlAdapter } from "./interface";

/**
 * Web implementation of AssetUrlAdapter: a pure URL builder.
 *
 * Contract (V1-09 workspace API, section 7): a workspace-relative
 * path becomes `/api/workspace/media/<path>` with each segment
 * percent-encoded separately. Callers that need cache-busting append
 * `?v=<revision>` themselves, as the canvas call sites already do
 * today; the server ignores `v` for authorization and content, and
 * ETag stays authoritative for revalidation. Media URLs require the
 * same session authentication as every other workspace endpoint;
 * there is no public media URL. This builder performs no I/O and no
 * fetch: it only constructs the string, and the browser loads it
 * with the session cookie.
 *
 * The method takes a workspace-relative path. Absolute OS paths have
 * no meaning in web mode and are rejected. This is a migration
 * dependency, not a drop-in behavior: every upstream call site
 * passes an absolute path today (the `convertImageByWorkspace`
 * funnel in utils.ts joins the workspace root or app-data dir onto
 * the relative path before calling `convertFileSrc`, and the chat,
 * canvas, and screenshot call sites pass absolute paths directly).
 * The G3 codemod must rewrite those call sites to pass the
 * workspace-relative path, and the funnel to stop joining the root;
 * this adapter cannot recover the relative path from an absolute
 * one because it does not know the workspace root.
 *
 * The optional `protocol` argument keeps upstream signature
 * fidelity. Upstream it defaults to "asset"; no call site passes it.
 * In web mode only the default protocol is meaningful, so "asset"
 * (case-insensitive) and an absent value build the media URL, while
 * any other protocol is rejected: a custom Tauri protocol has no
 * web equivalent and must fail explicitly rather than silently
 * produce a media URL for the wrong scheme.
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
 * external media keeps loading directly (V1-09 section 7.1).
 *
 * No internal cache: building the string is cheap, and the existing
 * per-workspace URL caches stay with their call sites (utils.ts),
 * preserving their shape.
 */

const MEDIA_BASE_PATH = "/api/workspace/media";
const RESOLVED_SRC_RE = /^(?:https?:|data:|blob:|asset:|tauri:|file:)/i;
const DRIVE_LETTER_RE = /^[A-Za-z]:/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const MAX_PATH_BYTES = 1024;
const MAX_SEGMENTS = 50;

function invalidPath(reason: string): never {
  throw capabilityError("invalid_argument", "assetUrl", "assetUrl.convertFileSrc", "web", reason);
}

function assertSupportedProtocol(protocol: string | undefined): void {
  if (protocol === undefined || protocol === "") {
    return;
  }
  if (typeof protocol !== "string") {
    throw new TypeError("AssetUrlAdapter.convertFileSrc: protocol must be a string.");
  }
  if (protocol.toLowerCase() !== "asset") {
    throw capabilityError(
      "unsupported",
      "assetUrl",
      "assetUrl.convertFileSrc",
      "web",
      "Only the default asset protocol has a web mapping; custom protocols have no web equivalent",
    );
  }
}

function normalizeSegments(filePath: string): string[] {
  if (filePath.length === 0) {
    invalidPath("Workspace path must not be empty.");
  }
  if (CONTROL_CHAR_RE.test(filePath)) {
    invalidPath("Workspace path must not contain NUL or control characters.");
  }
  if (filePath.startsWith("/")) {
    invalidPath("Absolute paths cannot be converted to media URLs; pass a workspace-relative path.");
  }
  if (DRIVE_LETTER_RE.test(filePath)) {
    invalidPath(
      "Absolute Windows paths cannot be converted to media URLs; pass a workspace-relative path.",
    );
  }
  const unified = filePath.replace(/\\/g, "/");
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

export function createWebAssetUrlAdapter(): AssetUrlAdapter {
  return {
    convertFileSrc(filePath: string, protocol?: string): string {
      if (typeof filePath !== "string") {
        invalidPath("Workspace path must be a string.");
      }
      assertSupportedProtocol(protocol);
      if (filePath === MEDIA_BASE_PATH || filePath.startsWith(`${MEDIA_BASE_PATH}/`)) {
        return filePath;
      }
      if (RESOLVED_SRC_RE.test(filePath)) {
        return filePath;
      }
      const segments = normalizeSegments(filePath);
      return `${MEDIA_BASE_PATH}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
    },
  };
}
