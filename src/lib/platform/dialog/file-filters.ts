// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Pure helpers that translate Tauri-style dialog filters into the shapes
 * the browser pickers understand. No DOM access here, so these helpers are
 * unit testable in plain Node.
 */

import type { DialogFilter } from "./interface";

/** Best-effort extension to MIME type map for the File System Access API. */
const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  mmd: "text/plain",
  mermaid: "text/plain",
  txt: "text/plain",
  json: "application/json",
  canvas: "application/json",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  csv: "text/csv",
  xml: "text/xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  pdf: "application/pdf",
  zip: "application/zip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/** Fallback MIME type for extensions with no known mapping. */
const FALLBACK_MIME_TYPE = "application/octet-stream";

/**
 * Normalize one extension: strip a leading dot, trim, lowercase. Returns an
 * empty string for values that cannot be used in a picker filter.
 */
function normalizeExtension(extension: string): string {
  const cleaned = extension.trim().replace(/^\.+/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(cleaned)) {
    return "";
  }
  return cleaned;
}

/** Collect the distinct normalized extensions of all filters, in order. */
function collectExtensions(filters: readonly DialogFilter[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const filter of filters) {
    for (const extension of filter.extensions) {
      const normalized = normalizeExtension(extension);
      if (normalized !== "" && !seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    }
  }
  return result;
}

/**
 * Build the `accept` attribute value for a hidden file input from dialog
 * filters, for example `.png,.jpg`. Returns an empty string when no usable
 * extension is present, which means the input accepts all files.
 */
export function dialogFiltersToAccept(
  filters: readonly DialogFilter[] | undefined,
): string {
  if (!filters || filters.length === 0) {
    return "";
  }
  return collectExtensions(filters)
    .map((extension) => `.${extension}`)
    .join(",");
}

/**
 * Accept-type shape for `showOpenFilePicker` / `showSaveFilePicker`.
 * Declared structurally here because the installed TypeScript DOM library
 * does not declare the picker functions; the web adapter passes these
 * objects through a narrow structural cast at the picker call boundary.
 */
export interface DialogPickerAcceptType {
  description: string;
  accept: Record<string, string[]>;
}

/**
 * Build the `types` list for the File System Access pickers from dialog
 * filters. Extensions are grouped by MIME type; unknown extensions fall
 * back to `application/octet-stream`. Returns an empty array when no usable
 * extension is present, in which case the caller omits `types` so the
 * picker accepts all files.
 */
export function dialogFiltersToPickerTypes(
  filters: readonly DialogFilter[] | undefined,
): DialogPickerAcceptType[] {
  if (!filters || filters.length === 0) {
    return [];
  }
  const result: DialogPickerAcceptType[] = [];
  for (const filter of filters) {
    const accept: Record<string, string[]> = {};
    const seen = new Set<string>();
    for (const extension of filter.extensions) {
      const normalized = normalizeExtension(extension);
      if (normalized === "" || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      const mimeType =
        EXTENSION_MIME_TYPES[normalized] ?? FALLBACK_MIME_TYPE;
      const bucket = accept[mimeType] ?? [];
      bucket.push(`.${normalized}`);
      accept[mimeType] = bucket;
    }
    if (Object.keys(accept).length > 0) {
      result.push({ description: filter.name, accept });
    }
  }
  return result;
}

/**
 * Derive a suggested file name from a `defaultPath` value. Directory parts
 * (both `/` and `\` separators) are stripped. Returns `fallback` when no
 * file name part remains.
 */
export function suggestedFileName(
  defaultPath: string | undefined,
  fallback = "untitled",
): string {
  if (!defaultPath) {
    return fallback;
  }
  const parts = defaultPath.split(/[\\/]/).filter((part) => part !== "");
  const last = parts[parts.length - 1];
  if (!last) {
    return fallback;
  }
  return last.trim() === "" ? fallback : last;
}
