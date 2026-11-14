// SPDX-License-Identifier: GPL-3.0-only
// Mock server for workspace/files API conformance tests.
//
// Implements the 24 canonical workspace/files routes from
// fase1/kontrak-api-kanonis.md section 3.1 (binding) with domain
// semantics from fase1/desain-workspace-api.md (V1-09), using only
// node:http and node builtins. In-memory state only: no disk, no
// database, no backend implementation. The same test suite runs
// against this mock and, via WORKSPACE_BASE_URL, against a real
// backend. See README.md in this directory.
//
// Test credentials below are fixed mock values, not secrets. They
// exist only so the suite can exercise the 401/403 contract paths.
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const MOCK_SESSION_COOKIE = "mock-session";
export const MOCK_CSRF_TOKEN = "mock-csrf";
export const MOCK_WORKSPACE_KEY = "mock-workspace";

const TEXT_LIMIT_BYTES = 2 * 1024 * 1024;
const MEDIA_LIMIT_BYTES = 20 * 1024 * 1024;
const JSON_LIMIT_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 1024;
const MAX_PATH_SEGMENTS = 50;
const MAX_TRASH_BATCH = 100;
const CONFLICT_PREVIEW_CHARS = 1000;
const RECONCILE_HOLD_MS = 100;

const GENERIC_REJECTED_MESSAGE = "The request was rejected. Please reload and try again.";

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Revision formula, V1-09 section 3.1:
// sha256:<hex(SHA-256(workspaceKey + NUL + filePath + NUL + content bytes))>
export function computeRevision(filePath, contentBuffer) {
  const digest = createHash("sha256");
  digest.update(MOCK_WORKSPACE_KEY, "utf8");
  digest.update(Buffer.from([0]));
  digest.update(filePath, "utf8");
  digest.update(Buffer.from([0]));
  digest.update(contentBuffer);
  return `sha256:${digest.digest("hex")}`;
}

function etagFor(revision) {
  return `"${revision}"`;
}

function isValidUtf8(buffer) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function hasControlChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

// Path validation, V1-09 section 8 as amended by the canonical
// contract. Returns { ok, path, hidden, code } where code is the
// error code when ok is false. Callers map hidden paths to 404 on
// reads and 400 invalid_path on writes (V1-09 section 8.6).
export function validateWorkspacePath(raw, { allowEmpty = false } = {}) {
  if (typeof raw !== "string") return { ok: false, code: "invalid_path" };
  if (raw === "") {
    if (allowEmpty) return { ok: true, path: "", hidden: false };
    return { ok: false, code: "invalid_path" };
  }
  if (hasControlChars(raw)) return { ok: false, code: "invalid_path" };
  if (raw.includes("\\")) return { ok: false, code: "invalid_path" };
  if (raw.startsWith("/")) return { ok: false, code: "invalid_path" };
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, code: "invalid_path" };
  if (Buffer.byteLength(raw, "utf8") > MAX_PATH_BYTES) return { ok: false, code: "invalid_path" };
  const segments = raw.split("/");
  if (segments.length > MAX_PATH_SEGMENTS) return { ok: false, code: "invalid_path" };
  let hidden = false;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return { ok: false, code: "invalid_path" };
    }
    if (segment.startsWith(".")) hidden = true;
  }
  return { ok: true, path: raw, hidden };
}

function lastSegment(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function parentPath(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function extensionOf(path) {
  const name = lastSegment(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index).toLowerCase();
}

function isTextExtension(path) {
  const name = lastSegment(path);
  return name.endsWith(".md") || name.endsWith(".txt");
}

function entryFor(path, node) {
  const isDirectory = node.kind === "dir";
  return {
    name: lastSegment(path),
    path,
    isDirectory,
    isFile: !isDirectory,
    size: isDirectory ? null : node.content.length,
    modifiedAt: node.modifiedAt,
    createdAt: node.createdAt,
    revision: isDirectory ? null : computeRevision(path, node.content),
    version: isDirectory ? null : node.version,
    isLocale: true,
  };
}

// Cursor: opaque base64url of JSON { o: offset }.
function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

function decodeCursor(raw) {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!Number.isInteger(parsed.o) || parsed.o < 0) return null;
    return parsed.o;
  } catch {
    return null;
  }
}

function parseLimit(raw, fallback, max) {
  if (raw === null || raw === undefined) return { ok: true, limit: fallback };
  if (!/^[0-9]+$/.test(raw)) return { ok: false };
  const limit = Number.parseInt(raw, 10);
  if (limit < 1) return { ok: false };
  return { ok: true, limit: Math.min(limit, max) };
}

function paginate(items, cursorRaw, limitRaw, fallback, max) {
  const limitResult = parseLimit(limitRaw, fallback, max);
  if (!limitResult.ok) return { error: "invalid_limit" };
  let offset = 0;
  if (cursorRaw !== null && cursorRaw !== undefined && cursorRaw !== "") {
    const decoded = decodeCursor(cursorRaw);
    if (decoded === null || decoded > items.length) return { error: "invalid_cursor" };
    offset = decoded;
  }
  const page = items.slice(offset, offset + limitResult.limit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < items.length ? encodeCursor(nextOffset) : null;
  return { page, nextCursor, hasMore: nextCursor !== null };
}

function sortListEntries(entries) {
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
}

// Suggested copy path, V1-09 section 3.4: insert " (salinan)"
// before the extension, then " (salinan 2)", and so on.
function suggestedCopyPath(path, exists) {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const suffix = attempt === 1 ? " (salinan)" : ` (salinan ${attempt})`;
    const candidate = `${dir}${stem}${suffix}${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return null;
}

function conflictDetails(path, node, exists, failedOperation) {
  const revision = computeRevision(path, node.content);
  let currentPreview = null;
  let previewTruncated = false;
  if (isTextExtension(path) && isValidUtf8(node.content)) {
    const text = node.content.toString("utf8");
    currentPreview = text.slice(0, CONFLICT_PREVIEW_CHARS);
    previewTruncated = text.length > CONFLICT_PREVIEW_CHARS;
  }
  const details = {
    detail: `path: ${path}`,
    path,
    serverRevision: revision,
    serverVersion: node.version,
    serverModifiedAt: node.modifiedAt,
    serverSize: node.content.length,
    currentPreview,
    previewTruncated,
    suggestedCopyPath: suggestedCopyPath(path, exists),
    actions: ["reload", "saveAsCopy", "forceOverwrite"],
  };
  if (failedOperation) details.failedOperation = failedOperation;
  return details;
}

// Parse a single If-Match value: trim, strip W/ prefix, strip one
// pair of double quotes. Returns { value } or { error }.
function parseMatchValue(raw) {
  let value = raw.trim();
  if (value.startsWith("W/")) value = value.slice(2);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  if (value === "" || value.includes('"') || value.includes(",")) {
    return { error: "invalid_precondition" };
  }
  return { value };
}

// Guard headers for PUT-style writes. Returns one of:
// { kind: "match", value }, { kind: "force" }, { kind: "create-only" },
// { kind: "none" }, { error: "invalid_precondition" }.
function parseGuards(headers) {
  const ifMatch = headers["if-match"];
  const ifNoneMatch = headers["if-none-match"];
  if (ifMatch !== undefined && ifNoneMatch !== undefined) {
    return { error: "invalid_precondition" };
  }
  if (ifMatch !== undefined) {
    const trimmed = ifMatch.trim();
    if (trimmed === "*") return { kind: "force" };
    if (trimmed.includes(",")) return { error: "invalid_precondition" };
    const parsed = parseMatchValue(trimmed);
    if (parsed.error) return { error: parsed.error };
    return { kind: "match", value: parsed.value };
  }
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() !== "*") return { error: "invalid_precondition" };
    return { kind: "create-only" };
  }
  return { kind: "none" };
}

function noneMatchMatches(headerValue, revision) {
  if (headerValue === undefined) return false;
  const trimmed = headerValue.trim();
  if (trimmed === "*") return true;
  for (const part of trimmed.split(",")) {
    const parsed = parseMatchValue(part);
    if (!parsed.error && parsed.value === revision) return true;
  }
  return false;
}

// --- Media type detection, V1-09 section 7.3 ---
function detectMediaType(bytes) {
  const startsWith = (list) =>
    list.length <= bytes.length && list.every((b, i) => bytes[i] === b);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith([0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return "gif";
  if (startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "gif";
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return "wav";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "avif";
    return "mp4";
  }
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return "webm";
  if (startsWith([0x49, 0x44, 0x33])) return "mp3";
  if (
    bytes.length >= 2 &&
    bytes[0] === 0xff &&
    (bytes[1] & 0xe0) === 0xe0
  ) {
    return "mp3";
  }
  if (startsWith([0x4f, 0x67, 0x67, 0x53])) return "ogg";
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (startsWith([0x50, 0x4b, 0x05, 0x06])) return "zip";
  const textStart = bytes
    .subarray(0, Math.min(bytes.length, 512))
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  if (textStart.startsWith("<svg")) return "svg";
  if (
    textStart.startsWith("<!doctype html") ||
    textStart.startsWith("<html") ||
    textStart.startsWith("<script")
  ) {
    return "html";
  }
  return "unknown";
}

const MIME_BY_TYPE = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  zip: "application/zip",
};

const INLINE_TYPES = new Set([
  "png",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "pdf",
  "mp4",
  "webm",
  "mp3",
  "wav",
  "ogg",
]);

const EXPECTED_TYPE_BY_EXT = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".gif": "gif",
  ".webp": "webp",
  ".avif": "avif",
  ".pdf": "pdf",
  ".mp4": "mp4",
  ".mov": "mp4",
  ".m4v": "mp4",
  ".webm": "webm",
  ".mp3": "mp3",
  ".wav": "wav",
  ".ogg": "ogg",
  ".oga": "ogg",
  ".zip": "zip",
};

const REJECTED_MEDIA_EXTS = new Set([".html", ".htm", ".js", ".mjs", ".xhtml"]);

// Validate an upload per V1-09 section 7.3. Returns
// { mimeType, detectedType, disposition } or { error: "unsupported_media_type" }.
function validateMedia(path, bytes) {
  const ext = extensionOf(path);
  if (REJECTED_MEDIA_EXTS.has(ext)) return { error: "unsupported_media_type" };
  const detected = detectMediaType(bytes);
  if (detected === "html") return { error: "unsupported_media_type" };
  if (ext === ".svg") {
    if (detected !== "svg") return { error: "unsupported_media_type" };
    return { mimeType: "application/octet-stream", detectedType: "svg", disposition: "attachment" };
  }
  if (ext === ".md" || ext === ".txt") {
    if (!isValidUtf8(bytes)) return { error: "unsupported_media_type" };
    return {
      mimeType: ext === ".md" ? "text/markdown" : "text/plain",
      detectedType: "text",
      disposition: "attachment",
    };
  }
  const expected = EXPECTED_TYPE_BY_EXT[ext];
  if (expected) {
    if (detected !== expected) return { error: "unsupported_media_type" };
    return {
      mimeType: MIME_BY_TYPE[detected],
      detectedType: detected,
      disposition: INLINE_TYPES.has(detected) ? "inline" : "attachment",
    };
  }
  if (detected === "unknown") {
    return { mimeType: "application/octet-stream", detectedType: "unknown", disposition: "attachment" };
  }
  if (detected === "svg") {
    return { mimeType: "application/octet-stream", detectedType: "svg", disposition: "attachment" };
  }
  return {
    mimeType: MIME_BY_TYPE[detected] || "application/octet-stream",
    detectedType: detected,
    disposition: INLINE_TYPES.has(detected) ? "inline" : "attachment",
  };
}

// Serving headers for GET/HEAD media, V1-09 section 7.2.
function mediaServing(path, bytes) {
  const ext = extensionOf(path);
  if (ext === ".svg") {
    return { mimeType: "application/octet-stream", disposition: "attachment" };
  }
  const detected = detectMediaType(bytes);
  if (detected !== "unknown" && detected !== "html" && MIME_BY_TYPE[detected]) {
    return {
      mimeType: MIME_BY_TYPE[detected],
      disposition: INLINE_TYPES.has(detected) ? "inline" : "attachment",
    };
  }
  if (ext === ".md") return { mimeType: "text/markdown", disposition: "attachment" };
  if (ext === ".txt") return { mimeType: "text/plain", disposition: "attachment" };
  const byExt = EXPECTED_TYPE_BY_EXT[ext];
  if (byExt && MIME_BY_TYPE[byExt]) {
    return {
      mimeType: MIME_BY_TYPE[byExt],
      disposition: INLINE_TYPES.has(byExt) ? "inline" : "attachment",
    };
  }
  return { mimeType: "application/octet-stream", disposition: "attachment" };
}

// Minimal multipart/form-data parser (Buffer based, no dependencies).
// Returns { fields: Map<string, string[]>, files: [{ name, filename, contentType, data }] }
// or { error: "invalid_upload" }.
function parseMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = new Map();
  const files = [];
  let cursor = body.indexOf(delimiter);
  if (cursor === -1) return { error: "invalid_upload" };
  cursor += delimiter.length;
  while (cursor < body.length) {
    if (body.subarray(cursor, cursor + 2).toString("ascii") === "--") break;
    if (body.subarray(cursor, cursor + 2).toString("ascii") === "\r\n") cursor += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd === -1) return { error: "invalid_upload" };
    const headerText = body.subarray(cursor, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;
    let next = body.indexOf(delimiter, dataStart);
    if (next === -1) return { error: "invalid_upload" };
    let dataEnd = next;
    if (body.subarray(dataEnd - 2, dataEnd).toString("ascii") === "\r\n") dataEnd -= 2;
    const data = body.subarray(dataStart, dataEnd);
    const nameMatch = headerText.match(/name="([^"]*)"/);
    if (!nameMatch) return { error: "invalid_upload" };
    const filenameMatch = headerText.match(/filename="([^"]*)"/);
    const typeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
    if (filenameMatch) {
      files.push({
        name: nameMatch[1],
        filename: filenameMatch[1],
        contentType: typeMatch ? typeMatch[1].trim() : "application/octet-stream",
        data: Buffer.from(data),
      });
    } else {
      const list = fields.get(nameMatch[1]) || [];
      list.push(data.toString("utf8"));
      fields.set(nameMatch[1], list);
    }
    cursor = next + delimiter.length;
  }
  return { fields, files };
}

// --- Link rewriting, V1-09 section 6.3 (subset) ---
// Rewrites relative Markdown/image destinations that resolve to the
// moved path. Skips fenced code blocks, inline code spans, and HTML
// comments. Absolute, schemed, and out-of-root destinations are kept.

function splitSuffix(destination) {
  const query = destination.indexOf("?");
  const hash = destination.indexOf("#");
  let cut = destination.length;
  if (query !== -1) cut = Math.min(cut, query);
  if (hash !== -1) cut = Math.min(cut, hash);
  return { base: destination.slice(0, cut), suffix: destination.slice(cut) };
}

function resolveRelative(fromDir, destination) {
  const parts = fromDir === "" ? [] : fromDir.split("/");
  for (const segment of destination.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

function relativePath(fromDir, target) {
  const from = fromDir === "" ? [] : fromDir.split("/");
  const to = target.split("/");
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common += 1;
  }
  const ups = Array(from.length - common).fill("..");
  return [...ups, ...to.slice(common)].join("/");
}

function decodeSegments(value) {
  return value
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function encodeSegments(value) {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function rewriteDestination(destination, fromDir, source, target, isFolderMove) {
  const { base, suffix } = splitSuffix(destination);
  if (base === "" || base.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(base)) {
    return null;
  }
  const wasEncoded = base.includes("%");
  const decoded = wasEncoded ? decodeSegments(base) : base;
  const resolved = resolveRelative(fromDir, decoded);
  if (resolved === null) return null;
  let mapped = null;
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

function rewriteLine(line, fromDir, source, target, isFolderMove) {
  let replacements = 0;
  // Split on inline code spans: only even segments are prose.
  const spans = line.split("`");
  for (let i = 0; i < spans.length; i += 2) {
    let segment = spans[i];
    segment = segment.replace(
      /(!?\[[^\]]*\]\()([^)\s<>]+)([^)]*\))/g,
      (whole, open, dest, rest) => {
        const next = rewriteDestination(dest, fromDir, source, target, isFolderMove);
        if (next === null) return whole;
        replacements += 1;
        if (next.includes(" ") && !next.includes("%20")) return `${open}<${next}>${rest}`;
        return `${open}${next}${rest}`;
      },
    );
    segment = segment.replace(
      /(!?\[[^\]]*\]\(<)([^>]+)(>\))/g,
      (whole, open, dest, rest) => {
        const next = rewriteDestination(dest, fromDir, source, target, isFolderMove);
        if (next === null) return whole;
        replacements += 1;
        return `${open}${next}${rest}`;
      },
    );
    segment = segment.replace(
      /(<img\s+[^>]*?src=["'])([^"']+)(["'])/gi,
      (whole, open, dest, close) => {
        const next = rewriteDestination(dest, fromDir, source, target, isFolderMove);
        if (next === null) return whole;
        replacements += 1;
        return `${open}${next.replace(/ /g, "%20")}${close}`;
      },
    );
    spans[i] = segment;
  }
  let joined = spans.join("`");
  const defMatch = joined.match(/^(\s*\[[^\]]+\]:\s*)(<?)([^>\s]+)(>?)(.*)$/);
  if (defMatch && !joined.includes("`")) {
    const next = rewriteDestination(defMatch[3], fromDir, source, target, isFolderMove);
    if (next !== null) {
      replacements += 1;
      joined = `${defMatch[1]}${defMatch[2]}${next}${defMatch[4]}${defMatch[5]}`;
    }
  }
  return { line: joined, replacements };
}

function rewriteMarkdownLinks(content, referrerPath, source, target, isFolderMove) {
  const fromDir = parentPath(referrerPath);
  const lines = content.split("\n");
  let inFence = null;
  let inComment = false;
  let replacements = 0;
  const out = lines.map((line) => {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (inFence === null) inFence = fence[1][0];
      else if (fence[1][0] === inFence) inFence = null;
      return line;
    }
    if (inFence !== null) return line;
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      return line;
    }
    if (line.includes("<!--") && !line.includes("-->")) {
      inComment = true;
      return line;
    }
    if (line.includes("<!--") && line.includes("-->")) return line;
    const result = rewriteLine(line, fromDir, source, target, isFolderMove);
    replacements += result.replacements;
    return result.line;
  });
  return { content: out.join("\n"), replacements };
}

// --- In-memory store ---
function createStore() {
  return {
    // path -> { kind: "file"|"dir"|"symlink", content: Buffer,
    //   version, createdAt, modifiedAt, target? }
    nodes: new Map(),
    // trash id -> entry with blob snapshot
    trash: new Map(),
    // idempotency key -> { hash, status, headers, body }
    idempotency: new Map(),
    reconcile: { running: false, lastRun: null, timer: null },
  };
}

function cloneNode(node) {
  return {
    kind: node.kind,
    content: Buffer.from(node.content),
    version: node.version,
    createdAt: node.createdAt,
    modifiedAt: node.modifiedAt,
    target: node.target,
  };
}

export function createMockServer() {
  const store = createStore();

  function nodeAt(path) {
    if (path === "") return { kind: "dir", content: Buffer.alloc(0), version: null, createdAt: null, modifiedAt: nowIso() };
    return store.nodes.get(path) || null;
  }

  function hasSymlinkComponent(path) {
    const segments = path.split("/");
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      const node = store.nodes.get(prefix);
      if (node && node.kind === "symlink") return true;
    }
    return false;
  }

  function ensureParents(path, stamp) {
    const dir = parentPath(path);
    if (dir === "") return;
    const segments = dir.split("/");
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      if (!store.nodes.has(prefix)) {
        store.nodes.set(prefix, {
          kind: "dir",
          content: Buffer.alloc(0),
          version: null,
          createdAt: stamp,
          modifiedAt: stamp,
        });
      }
    }
  }

  function subtreePaths(path) {
    const out = [];
    for (const key of store.nodes.keys()) {
      if (key === path || key.startsWith(`${path}/`)) out.push(key);
    }
    out.sort();
    return out;
  }

  function snapshotSubtree(path) {
    return subtreePaths(path).map((key) => ({
      rel: key === path ? "" : key.slice(path.length + 1),
      node: cloneNode(store.nodes.get(key)),
    }));
  }

  function subtreeSizeAndCount(path) {
    let size = 0;
    let count = 0;
    for (const key of subtreePaths(path)) {
      count += 1;
      const node = store.nodes.get(key);
      if (node.kind === "file") size += node.content.length;
    }
    return { size, count };
  }

  function moveToTrash(path, stamp) {
    const node = store.nodes.get(path);
    const kind = node.kind === "dir" ? "folder" : "file";
    const { size, count } = subtreeSizeAndCount(path);
    const id = randomUUID();
    const entry = {
      id,
      originalPath: path,
      name: lastSegment(path),
      kind,
      size,
      entryCount: count,
      revision: kind === "file" ? computeRevision(path, node.content) : null,
      deletedAt: stamp,
      blob: snapshotSubtree(path),
      blobMissing: false,
    };
    for (const key of subtreePaths(path)) store.nodes.delete(key);
    store.trash.set(id, entry);
    return entry;
  }

  function restoreFromTrash(entry, destination, stamp) {
    for (const { rel, node } of entry.blob) {
      const targetPath = rel === "" ? destination : `${destination}/${rel}`;
      ensureParents(targetPath, stamp);
      const restored = cloneNode(node);
      restored.modifiedAt = stamp;
      store.nodes.set(targetPath, restored);
    }
    store.trash.delete(entry.id);
  }

  // --- HTTP plumbing ---
  function requestIdOf(req) {
    const sent = req.headers["x-request-id"];
    return typeof sent === "string" && sent !== "" ? sent : `req-${randomUUID()}`;
  }

  function sendJson(req, res, status, payload, extraHeaders = {}) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "X-Request-Id": requestIdOf(req),
      "X-Mock-Workspace": "1",
      ...extraHeaders,
    });
    res.end(body);
  }

  function sendOk(req, res, status, data, extraHeaders = {}) {
    sendJson(req, res, status, { ok: true, data }, extraHeaders);
  }

  function sendError(req, res, status, code, message, details = {}) {
    const retryable = status === 429 || status === 503;
    sendJson(req, res, status, {
      ok: false,
      error: { code, message, requestId: requestIdOf(req), retryable, details },
    });
  }

  function readBody(req, cap) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let truncated = false;
      req.on("data", (chunk) => {
        if (truncated) return;
        total += chunk.length;
        if (total > cap) {
          truncated = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve({ buffer: Buffer.concat(chunks), truncated }));
      req.on("error", reject);
    });
  }

  function parseJsonBody(buffer) {
    if (buffer.length === 0) return { error: "invalid_json" };
    try {
      const value = JSON.parse(buffer.toString("utf8"));
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { error: "validation_failed" };
      }
      return { value };
    } catch {
      return { error: "invalid_json" };
    }
  }

  function rejectUnknownFields(body, allowed) {
    const extras = Object.keys(body).filter((key) => !allowed.includes(key));
    if (extras.length === 0) return null;
    return {
      fields: extras.map((field) => ({ field, issue: "unknown field" })),
    };
  }

  function fieldError(field, issue) {
    return { fields: [{ field, issue }] };
  }

  function idempotencyHash(method, url, headers, body) {
    return sha256Hex(
      Buffer.concat([
        Buffer.from(`${method}\n${url}\n${headers["if-match"] || ""}\n${headers["if-none-match"] || ""}\n`, "utf8"),
        body,
      ]),
    );
  }

  // Returns "continue", or sends a response and returns "done".
  function checkIdempotency(req, res, body) {
    const key = req.headers["idempotency-key"];
    if (key === undefined || key === "") return { active: false };
    if (key.length > 128) {
      sendError(req, res, 400, "validation_failed", "The Idempotency-Key header is too long.", fieldError("Idempotency-Key", "at most 128 characters"));
      return { active: false, done: true };
    }
    const hash = idempotencyHash(req.method, req.url, req.headers, body);
    const existing = store.idempotency.get(key);
    if (existing) {
      if (existing.hash !== hash) {
        sendError(req, res, 409, "idempotency_key_reused", "The idempotency key was already used with a different request.", {});
        return { active: false, done: true };
      }
      res.writeHead(existing.status, {
        ...existing.headers,
        "X-Request-Id": requestIdOf(req),
        "X-Mock-Workspace": "1",
      });
      res.end(existing.body);
      return { active: false, done: true };
    }
    return {
      active: true,
      store(status, headers, bodyBuffer) {
        store.idempotency.set(key, { hash, status, headers, body: bodyBuffer });
      },
    };
  }

  function sendOkIdempotent(req, res, status, data, idem, extraHeaders = {}) {
    const body = Buffer.from(JSON.stringify({ ok: true, data }), "utf8");
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      ...extraHeaders,
    };
    if (idem && idem.active) idem.store(status, headers, body);
    res.writeHead(status, { ...headers, "X-Request-Id": requestIdOf(req), "X-Mock-Workspace": "1" });
    res.end(body);
  }

  // --- Handlers: reads ---
  function handleList(req, res, url) {
    const rawPath = url.searchParams.get("path") || "";
    const checked = validateWorkspacePath(rawPath, { allowEmpty: true });
    if (!checked.ok) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    if (checked.hidden || hasSymlinkComponent(checked.path)) {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    const node = nodeAt(checked.path);
    if (!node) {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    if (node.kind !== "dir") {
      sendError(req, res, 400, "not_a_directory", "The path is not a directory.", {});
      return;
    }
    const prefix = checked.path === "" ? "" : `${checked.path}/`;
    const children = [];
    for (const [key, child] of store.nodes) {
      if (!key.startsWith(prefix) || key === checked.path) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes("/")) continue;
      if (child.kind === "symlink") continue;
      if (rest.startsWith(".")) continue;
      children.push(entryFor(key, child));
    }
    sortListEntries(children);
    const includeMetadata = url.searchParams.get("includeMetadata") !== "false";
    const page = paginate(
      children,
      url.searchParams.get("cursor"),
      url.searchParams.get("limit"),
      500,
      1000,
    );
    if (page.error) {
      sendError(req, res, 400, page.error, page.error === "invalid_limit" ? "The limit is not valid." : "The cursor is not valid.", {});
      return;
    }
    const entries = page.page.map((entry) =>
      includeMetadata
        ? entry
        : { ...entry, size: entry.isDirectory ? null : null, modifiedAt: null, createdAt: null },
    );
    sendOk(req, res, 200, {
      path: checked.path,
      entries,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    });
  }

  function handleScan(req, res, url) {
    const rawFolder = url.searchParams.get("folder") || "";
    const checked = validateWorkspacePath(rawFolder, { allowEmpty: true });
    if (!checked.ok) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    if (checked.hidden || hasSymlinkComponent(checked.path)) {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    const node = nodeAt(checked.path);
    if (!node) {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    if (node.kind !== "dir") {
      sendError(req, res, 400, "not_a_directory", "The path is not a directory.", {});
      return;
    }
    const prefix = checked.path === "" ? "" : `${checked.path}/`;
    const found = [];
    for (const [key, child] of store.nodes) {
      if (child.kind !== "file") continue;
      if (checked.path !== "" && key !== checked.path && !key.startsWith(prefix)) continue;
      if (key.split("/").some((segment) => segment.startsWith("."))) continue;
      if (hasSymlinkComponent(key)) continue;
      if (!lastSegment(key).endsWith(".md")) continue;
      const entry = entryFor(key, child);
      entry.relativePath = checked.path === "" ? key : key.slice(prefix.length);
      found.push(entry);
    }
    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const includeMetadata = url.searchParams.get("includeMetadata") !== "false";
    const page = paginate(
      found,
      url.searchParams.get("cursor"),
      url.searchParams.get("limit"),
      500,
      1000,
    );
    if (page.error) {
      sendError(req, res, 400, page.error, page.error === "invalid_limit" ? "The limit is not valid." : "The cursor is not valid.", {});
      return;
    }
    const entries = page.page.map((entry) =>
      includeMetadata ? entry : { ...entry, size: null, modifiedAt: null },
    );
    sendOk(req, res, 200, {
      folder: checked.path,
      entries,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    });
  }

  function handleStat(req, res, url) {
    const rawPath = url.searchParams.get("path");
    if (rawPath === null) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    const checked = validateWorkspacePath(rawPath);
    if (!checked.ok) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    if (checked.hidden || hasSymlinkComponent(checked.path)) {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    const node = nodeAt(checked.path);
    if (!node) {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    const entry = entryFor(checked.path, node);
    const headers = {};
    if (node.kind === "file") {
      headers.ETag = etagFor(entry.revision);
      headers["X-Revision"] = entry.revision;
      headers["Last-Modified"] = new Date(node.modifiedAt).toUTCString();
    }
    sendOk(req, res, 200, entry, headers);
  }

  function handleGetFile(req, res, url, isHead) {
    const rawPath = url.searchParams.get("path");
    if (rawPath === null) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    const checked = validateWorkspacePath(rawPath);
    if (!checked.ok) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    if (checked.hidden || hasSymlinkComponent(checked.path)) {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    const node = nodeAt(checked.path);
    if (!node || node.kind !== "file") {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    const revision = computeRevision(checked.path, node.content);
    const headers = {
      ETag: etagFor(revision),
      "X-Revision": revision,
      "X-Version": String(node.version),
      "Last-Modified": new Date(node.modifiedAt).toUTCString(),
      "Cache-Control": "private, no-cache",
      "Content-Length": node.content.length,
      "X-Request-Id": requestIdOf(req),
      "X-Mock-Workspace": "1",
    };
    if (!isHead && !isTextExtension(checked.path)) {
      sendError(req, res, 415, "not_text_file", "The file is not a text file.", {
        detail: "Use the media endpoint to read this file.",
      });
      return;
    }
    if (!isHead && !isValidUtf8(node.content)) {
      sendError(req, res, 422, "invalid_text_encoding", "The file is not valid UTF-8 text.", {});
      return;
    }
    if (noneMatchMatches(req.headers["if-none-match"], revision)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    headers["Content-Type"] = checked.path.endsWith(".md")
      ? "text/markdown; charset=utf-8"
      : checked.path.endsWith(".txt")
        ? "text/plain; charset=utf-8"
        : "application/octet-stream";
    res.writeHead(200, headers);
    res.end(isHead ? undefined : node.content);
  }

  // --- Handlers: writes ---
  function guardFailureFor(node, path, guard, exists) {
    if (guard.kind === "none") return { status: 428, code: "precondition_required", message: "A write guard header is required." };
    if (guard.kind === "create-only" && exists) {
      return { status: 409, code: "already_exists", message: "The resource already exists." };
    }
    if (guard.kind === "match") {
      if (!exists) return { status: 404, code: "not_found", message: "The requested resource was not found." };
      const current = computeRevision(path, node.content);
      if (guard.value !== current) {
        return {
          status: 412,
          code: "revision_conflict",
          message: "The file changed since it was last read.",
          details: conflictDetails(path, node, (p) => store.nodes.has(p)),
        };
      }
    }
    return null;
  }

  async function handlePutFile(req, res, url) {
    const rawPath = url.searchParams.get("path");
    if (rawPath === null) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    const checked = validateWorkspacePath(rawPath);
    if (!checked.ok || checked.hidden) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    if (hasSymlinkComponent(checked.path)) {
      sendError(req, res, 400, "symlink_not_allowed", "Symlinks are not allowed.", {});
      return;
    }
    const guard = parseGuards(req.headers);
    if (guard.error) {
      sendError(req, res, 400, "invalid_precondition", "The guard headers are not valid.", {});
      return;
    }
    const { buffer, truncated } = await readBody(req, TEXT_LIMIT_BYTES);
    if (truncated) {
      sendError(req, res, 413, "text_too_large", "The text exceeds the size limit.", {});
      return;
    }
    const idem = checkIdempotency(req, res, buffer);
    if (idem.done) return;
    if (guard.kind === "none") {
      sendError(req, res, 428, "precondition_required", "A write guard header is required.", {});
      return;
    }
    if (!isValidUtf8(buffer)) {
      sendError(req, res, 422, "invalid_text_encoding", "The body is not valid UTF-8 text.", {});
      return;
    }
    const existing = store.nodes.get(checked.path) || null;
    if (existing && existing.kind === "dir") {
      sendError(req, res, 400, "invalid_path", "The path is a directory.", {});
      return;
    }
    const failure = guardFailureFor(existing, checked.path, guard, existing !== null);
    if (failure) {
      sendError(req, res, failure.status, failure.code, failure.message, failure.details || {});
      return;
    }
    const stamp = nowIso();
    ensureParents(checked.path, stamp);
    const created = existing === null;
    const node = {
      kind: "file",
      content: buffer,
      version: created ? 1 : existing.version + 1,
      createdAt: created ? stamp : existing.createdAt,
      modifiedAt: stamp,
    };
    store.nodes.set(checked.path, node);
    const revision = computeRevision(checked.path, buffer);
    sendOkIdempotent(
      req,
      res,
      created ? 201 : 200,
      { path: checked.path, revision, version: node.version, size: buffer.length, modifiedAt: stamp, created },
      idem,
      { ETag: etagFor(revision), "X-Revision": revision, "Last-Modified": new Date(stamp).toUTCString() },
    );
  }

  async function readJsonWithLimit(req, res) {
    const { buffer, truncated } = await readBody(req, JSON_LIMIT_BYTES);
    if (truncated) {
      sendError(req, res, 413, "payload_too_large", "The JSON body exceeds the size limit.", {});
      return null;
    }
    const parsed = parseJsonBody(buffer);
    if (parsed.error === "invalid_json") {
      sendError(req, res, 400, "invalid_json", "The body is not valid JSON.", {});
      return null;
    }
    if (parsed.error) {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", {});
      return null;
    }
    return { body: parsed.value, raw: buffer };
  }

  function checkWritePath(rawPath) {
    const checked = validateWorkspacePath(rawPath);
    if (!checked.ok || checked.hidden) return { error: "invalid_path" };
    if (hasSymlinkComponent(checked.path)) return { error: "symlink_not_allowed" };
    return { path: checked.path };
  }

  async function handleAppendOrPatch(req, res, url, isPatch) {
    const rawPath = url.searchParams.get("path");
    if (rawPath === null) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    const pathCheck = checkWritePath(rawPath);
    if (pathCheck.error) {
      const code = pathCheck.error;
      sendError(req, res, 400, code, code === "invalid_path" ? "The path is not valid." : "Symlinks are not allowed.", {});
      return;
    }
    const path = pathCheck.path;
    const read = await readJsonWithLimit(req, res);
    if (!read) return;
    const allowed = isPatch
      ? ["expectedRevision", "startLine", "endLine", "replacement", "force", "expectedModifiedAt"]
      : ["expectedRevision", "content", "force", "expectedModifiedAt"];
    const unknown = rejectUnknownFields(read.body, allowed);
    if (unknown) {
      sendError(req, res, 400, "validation_failed", "The body contains unknown fields.", unknown);
      return;
    }
    const idem = checkIdempotency(req, res, read.raw);
    if (idem.done) return;
    const body = read.body;
    const force = body.force === undefined ? false : body.force;
    if (typeof force !== "boolean") {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError("force", "expected a boolean"));
      return;
    }
    if (!force && body.expectedRevision === undefined) {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError("expectedRevision", "required unless force is true"));
      return;
    }
    if (body.expectedRevision !== undefined && typeof body.expectedRevision !== "string") {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError("expectedRevision", "expected a string"));
      return;
    }
    const node = store.nodes.get(path) || null;
    if (!node || node.kind !== "file") {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    if (!force) {
      const current = computeRevision(path, node.content);
      if (body.expectedRevision !== current) {
        sendError(req, res, 409, "revision_conflict", "The file changed since it was last read.", conflictDetails(path, node, (p) => store.nodes.has(p), isPatch ? "patch" : "append"));
        return;
      }
    }
    const stamp = nowIso();
    if (!isPatch) {
      if (typeof body.content !== "string") {
        sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError("content", "expected a string"));
        return;
      }
      if (body.content === "") {
        const revision = computeRevision(path, node.content);
        sendOkIdempotent(req, res, 200, { path, revision, version: node.version, size: node.content.length, modifiedAt: node.modifiedAt, appendedBytes: 0 }, idem);
        return;
      }
      const appended = Buffer.from(body.content, "utf8");
      const next = Buffer.concat([node.content, appended]);
      if (next.length > TEXT_LIMIT_BYTES) {
        sendError(req, res, 413, "text_too_large", "The text exceeds the size limit.", {});
        return;
      }
      const nextNode = { ...node, content: next, version: node.version + 1, modifiedAt: stamp };
      store.nodes.set(path, nextNode);
      sendOkIdempotent(req, res, 200, { path, revision: computeRevision(path, next), version: nextNode.version, size: next.length, modifiedAt: stamp, appendedBytes: appended.length }, idem);
      return;
    }
    const { startLine, endLine, replacement } = body;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || typeof replacement !== "string") {
      const field = !Number.isInteger(startLine) ? "startLine" : !Number.isInteger(endLine) ? "endLine" : "replacement";
      sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError(field, "expected an integer line number or a string replacement"));
      return;
    }
    const text = node.content.toString("utf8");
    const lineStarts = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "\n") lineStarts.push(i + 1);
    }
    const lineCount = lineStarts.length;
    if (startLine < 1 || startLine > lineCount + 1 || endLine < startLine || endLine > lineCount + 1) {
      sendError(req, res, 400, "invalid_patch_range", "The patch line range is outside the file.", {});
      return;
    }
    const startOffset = startLine <= lineCount ? lineStarts[startLine - 1] : text.length;
    const endOffset = endLine <= lineCount ? lineStarts[endLine - 1] : text.length;
    const nextText = text.slice(0, startOffset) + replacement + text.slice(endOffset);
    const next = Buffer.from(nextText, "utf8");
    if (next.length > TEXT_LIMIT_BYTES) {
      sendError(req, res, 413, "text_too_large", "The text exceeds the size limit.", {});
      return;
    }
    const nextNode = { ...node, content: next, version: node.version + 1, modifiedAt: stamp };
    store.nodes.set(path, nextNode);
    sendOkIdempotent(req, res, 200, { path, revision: computeRevision(path, next), version: nextNode.version, size: next.length, modifiedAt: stamp, patchedLines: endLine - startLine }, idem);
  }

  async function handleMkdir(req, res) {
    const read = await readJsonWithLimit(req, res);
    if (!read) return;
    const unknown = rejectUnknownFields(read.body, ["path"]);
    if (unknown) {
      sendError(req, res, 400, "validation_failed", "The body contains unknown fields.", unknown);
      return;
    }
    if (typeof read.body.path !== "string") {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError("path", "expected a string"));
      return;
    }
    const pathCheck = checkWritePath(read.body.path);
    if (pathCheck.error) {
      const code = pathCheck.error;
      sendError(req, res, 400, code, code === "invalid_path" ? "The path is not valid." : "Symlinks are not allowed.", {});
      return;
    }
    const path = pathCheck.path;
    const existing = store.nodes.get(path) || null;
    if (existing) {
      if (existing.kind !== "dir") {
        sendError(req, res, 409, "already_exists", "The path already exists as a file.", {});
        return;
      }
      sendOk(req, res, 200, { path, created: false, entry: entryFor(path, existing) });
      return;
    }
    const stamp = nowIso();
    ensureParents(path, stamp);
    const segments = path.split("/");
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      const atPrefix = store.nodes.get(prefix);
      if (atPrefix && atPrefix.kind !== "dir") {
        sendError(req, res, 409, "already_exists", "The path already exists as a file.", {});
        return;
      }
      if (!atPrefix) {
        store.nodes.set(prefix, { kind: "dir", content: Buffer.alloc(0), version: null, createdAt: stamp, modifiedAt: stamp });
      }
    }
    sendOk(req, res, 201, { path, created: true, entry: entryFor(path, store.nodes.get(path)) });
  }

  // --- Handlers: move, repair-links ---
  function runRewrite(source, target, isFolderMove, stamp) {
    const rewrittenFiles = [];
    const skipped = [];
    const candidates = [];
    for (const [key, child] of store.nodes) {
      if (child.kind !== "file") continue;
      if (!lastSegment(key).endsWith(".md")) continue;
      if (key.split("/").some((segment) => segment.startsWith("."))) continue;
      if (hasSymlinkComponent(key)) continue;
      candidates.push(key);
    }
    candidates.sort();
    for (const key of candidates) {
      const node = store.nodes.get(key);
      if (!isValidUtf8(node.content)) {
        skipped.push({ path: key, reason: "read_error", detail: "File is not valid UTF-8 text." });
        continue;
      }
      const oldRevision = computeRevision(key, node.content);
      const result = rewriteMarkdownLinks(node.content.toString("utf8"), key, source, target, isFolderMove);
      if (result.replacements === 0) continue;
      const next = Buffer.from(result.content, "utf8");
      const nextNode = { ...node, content: next, version: node.version + 1, modifiedAt: stamp };
      store.nodes.set(key, nextNode);
      rewrittenFiles.push({
        path: key,
        oldRevision,
        newRevision: computeRevision(key, next),
        replacements: result.replacements,
      });
    }
    return { rewrittenFiles, skipped, pending: [] };
  }

  async function handleMove(req, res) {
    const read = await readJsonWithLimit(req, res);
    if (!read) return;
    const unknown = rejectUnknownFields(read.body, ["source", "target", "rewriteLinks", "expectedRevision"]);
    if (unknown) {
      sendError(req, res, 400, "validation_failed", "The body contains unknown fields.", unknown);
      return;
    }
    const body = read.body;
    if (typeof body.source !== "string" || typeof body.target !== "string") {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError(typeof body.source !== "string" ? "source" : "target", "expected a string"));
      return;
    }
    const rewriteLinks = body.rewriteLinks === undefined ? true : body.rewriteLinks;
    if (typeof rewriteLinks !== "boolean") {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError("rewriteLinks", "expected a boolean"));
      return;
    }
    if (body.expectedRevision !== undefined && typeof body.expectedRevision !== "string") {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError("expectedRevision", "expected a string"));
      return;
    }
    const sourceCheck = checkWritePath(body.source);
    const targetCheck = checkWritePath(body.target);
    const bad = sourceCheck.error || targetCheck.error;
    if (bad) {
      sendError(req, res, 400, bad, bad === "invalid_path" ? "The path is not valid." : "Symlinks are not allowed.", {});
      return;
    }
    const source = sourceCheck.path;
    const target = targetCheck.path;
    const idem = checkIdempotency(req, res, read.raw);
    if (idem.done) return;
    if (source === target) {
      sendError(req, res, 400, "invalid_move", "The source and the target are the same.", {});
      return;
    }
    const sourceNode = store.nodes.get(source) || null;
    if (!sourceNode) {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    const isFolderMove = sourceNode.kind === "dir";
    if (isFolderMove && (target === source || target.startsWith(`${source}/`))) {
      sendError(req, res, 400, "invalid_move", "A folder cannot be moved into its own subtree.", {});
      return;
    }
    if (store.nodes.has(target)) {
      sendError(req, res, 409, "already_exists", "The target already exists.", {});
      return;
    }
    if (!isFolderMove && body.expectedRevision !== undefined) {
      const current = computeRevision(source, sourceNode.content);
      if (body.expectedRevision !== current) {
        sendError(req, res, 412, "revision_conflict", "The file changed since it was last read.", conflictDetails(source, sourceNode, (p) => store.nodes.has(p)));
        return;
      }
    }
    const stamp = nowIso();
    const moved = snapshotSubtree(source);
    for (const key of subtreePaths(source)) store.nodes.delete(key);
    ensureParents(target, stamp);
    for (const { rel, node } of moved) {
      const targetPath = rel === "" ? target : `${target}/${rel}`;
      store.nodes.set(targetPath, cloneNode(node));
    }
    let rewrite = { rewrittenFiles: [], skipped: [], pending: [] };
    if (rewriteLinks) rewrite = runRewrite(source, target, isFolderMove, stamp);
    const rewriteStatus = !rewriteLinks
      ? "disabled"
      : rewrite.skipped.length > 0 && rewrite.rewrittenFiles.length === 0
        ? "skipped_only"
        : "complete";
    const targetNode = store.nodes.get(target);
    sendOkIdempotent(req, res, 200, {
      source,
      target,
      kind: isFolderMove ? "folder" : "file",
      rewriteLinks,
      rewriteStatus,
      revision: isFolderMove ? null : computeRevision(target, targetNode.content),
      rewrittenFiles: rewrite.rewrittenFiles,
      skipped: rewrite.skipped,
      pending: rewrite.pending,
      affectedCount: moved.length,
      indexHookWarning: null,
    }, idem);
  }

  async function handleRepairLinks(req, res) {
    const read = await readJsonWithLimit(req, res);
    if (!read) return;
    const unknown = rejectUnknownFields(read.body, ["source", "target"]);
    if (unknown) {
      sendError(req, res, 400, "validation_failed", "The body contains unknown fields.", unknown);
      return;
    }
    if (typeof read.body.source !== "string" || typeof read.body.target !== "string") {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError(typeof read.body.source !== "string" ? "source" : "target", "expected a string"));
      return;
    }
    const sourceCheck = checkWritePath(read.body.source);
    const targetCheck = checkWritePath(read.body.target);
    const bad = sourceCheck.error || targetCheck.error;
    if (bad) {
      sendError(req, res, 400, bad, bad === "invalid_path" ? "The path is not valid." : "Symlinks are not allowed.", {});
      return;
    }
    const source = sourceCheck.path;
    const target = targetCheck.path;
    const targetNode = store.nodes.get(target) || null;
    if (!targetNode || store.nodes.has(source)) {
      sendError(req, res, 409, "repair_precondition_failed", "Repair requires the target to exist and the source to be gone.", {});
      return;
    }
    const stamp = nowIso();
    const isFolderMove = targetNode.kind === "dir";
    const rewrite = runRewrite(source, target, isFolderMove, stamp);
    sendOk(req, res, 200, {
      source,
      target,
      kind: isFolderMove ? "folder" : "file",
      rewriteLinks: true,
      rewriteStatus: "complete",
      revision: isFolderMove ? null : computeRevision(target, targetNode.content),
      rewrittenFiles: rewrite.rewrittenFiles,
      skipped: rewrite.skipped,
      pending: rewrite.pending,
      affectedCount: 0,
      indexHookWarning: null,
      repaired: true,
    });
  }

  // --- Handlers: delete and trash ---
  function handleDelete(req, res, url, kind) {
    if (url.searchParams.has("permanent")) {
      sendError(req, res, 400, "invalid_query", "Permanent delete is not accepted on this endpoint.", {});
      return;
    }
    const rawPath = url.searchParams.get("path");
    if (rawPath === null) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    const pathCheck = checkWritePath(rawPath);
    if (pathCheck.error) {
      const code = pathCheck.error;
      sendError(req, res, 400, code, code === "invalid_path" ? "The path is not valid." : "Symlinks are not allowed.", {});
      return;
    }
    const path = pathCheck.path;
    const node = store.nodes.get(path) || null;
    if (!node) {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    const actualKind = node.kind === "dir" ? "folder" : "file";
    if (actualKind !== kind) {
      sendError(req, res, 409, "wrong_kind", "The endpoint does not match the kind of the entry.", {});
      return;
    }
    const stamp = nowIso();
    const entry = moveToTrash(path, stamp);
    sendOk(req, res, 200, {
      path,
      trashId: entry.id,
      kind: actualKind,
      entryCount: entry.entryCount,
      size: entry.size,
      deletedAt: stamp,
    });
  }

  async function handleBatchTrash(req, res) {
    const read = await readJsonWithLimit(req, res);
    if (!read) return;
    const unknown = rejectUnknownFields(read.body, ["paths"]);
    if (unknown) {
      sendError(req, res, 400, "validation_failed", "The body contains unknown fields.", unknown);
      return;
    }
    if (!Array.isArray(read.body.paths) || read.body.paths.length === 0 || read.body.paths.length > MAX_TRASH_BATCH) {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError("paths", `expected a non-empty array of at most ${MAX_TRASH_BATCH} paths`));
      return;
    }
    const moved = [];
    const notFound = [];
    const rejected = [];
    const stamp = nowIso();
    for (const raw of read.body.paths) {
      const pathCheck = typeof raw === "string" ? checkWritePath(raw) : { error: "invalid_path" };
      if (pathCheck.error) {
        rejected.push({ path: typeof raw === "string" ? raw : String(raw), reason: pathCheck.error });
        continue;
      }
      const path = pathCheck.path;
      const node = store.nodes.get(path) || null;
      if (!node) {
        const existing = [...store.trash.values()].find((entry) => entry.originalPath === path);
        if (existing) {
          moved.push({ path, trashId: existing.id, kind: existing.kind });
        } else {
          notFound.push(path);
        }
        continue;
      }
      const entry = moveToTrash(path, stamp);
      moved.push({ path, trashId: entry.id, kind: entry.kind });
    }
    sendOk(req, res, 200, { moved, notFound, rejected });
  }

  function trashEntryView(entry) {
    return {
      id: entry.id,
      originalPath: entry.originalPath,
      name: entry.name,
      kind: entry.kind,
      size: entry.size,
      entryCount: entry.entryCount,
      revision: entry.revision,
      deletedAt: entry.deletedAt,
    };
  }

  function handleListTrash(req, res, url) {
    const entries = [...store.trash.values()]
      .sort((a, b) => {
        if (a.deletedAt !== b.deletedAt) return a.deletedAt < b.deletedAt ? 1 : -1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map(trashEntryView);
    const page = paginate(entries, url.searchParams.get("cursor"), url.searchParams.get("limit"), 50, 200);
    if (page.error) {
      sendError(req, res, 400, page.error, page.error === "invalid_limit" ? "The limit is not valid." : "The cursor is not valid.", {});
      return;
    }
    const totalSize = [...store.trash.values()].reduce((sum, entry) => sum + entry.size, 0);
    sendOk(req, res, 200, {
      entries: page.page,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      totalCount: store.trash.size,
      totalSize,
    });
  }

  async function handleRestore(req, res, id) {
    const { buffer, truncated } = await readBody(req, JSON_LIMIT_BYTES);
    if (truncated) {
      sendError(req, res, 413, "payload_too_large", "The JSON body exceeds the size limit.", {});
      return;
    }
    let body = {};
    if (buffer.length > 0) {
      const parsed = parseJsonBody(buffer);
      if (parsed.error === "invalid_json") {
        sendError(req, res, 400, "invalid_json", "The body is not valid JSON.", {});
        return;
      }
      if (parsed.error) {
        sendError(req, res, 400, "validation_failed", "The body is not valid.", {});
        return;
      }
      body = parsed.value;
    }
    const unknown = rejectUnknownFields(body, ["target"]);
    if (unknown) {
      sendError(req, res, 400, "validation_failed", "The body contains unknown fields.", unknown);
      return;
    }
    if (body.target !== undefined && typeof body.target !== "string") {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError("target", "expected a string"));
      return;
    }
    const idem = checkIdempotency(req, res, buffer);
    if (idem.done) return;
    const entry = store.trash.get(id) || null;
    if (!entry) {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    if (entry.blobMissing) {
      sendError(req, res, 500, "trash_blob_missing", "The trash data is missing.", { id: entry.id, originalPath: entry.originalPath });
      return;
    }
    const destination = body.target === undefined ? entry.originalPath : body.target;
    const destCheck = checkWritePath(destination);
    if (destCheck.error) {
      const code = destCheck.error;
      sendError(req, res, 400, code, code === "invalid_path" ? "The path is not valid." : "Symlinks are not allowed.", {});
      return;
    }
    const restoredPath = destCheck.path;
    const occupant = store.nodes.get(restoredPath) || null;
    if (occupant) {
      const suggested = suggestedCopyPath(restoredPath, (p) => store.nodes.has(p));
      sendError(req, res, 409, "target_exists", "The restore target is already occupied.", {
        suggestedTarget: suggested,
        existingKind: occupant.kind === "dir" ? "folder" : "file",
      });
      return;
    }
    const stamp = nowIso();
    restoreFromTrash(entry, restoredPath, stamp);
    const restoredNode = store.nodes.get(restoredPath);
    sendOkIdempotent(req, res, 200, {
      id: entry.id,
      originalPath: entry.originalPath,
      restoredPath,
      kind: entry.kind,
      revision: entry.kind === "file" ? computeRevision(restoredPath, restoredNode.content) : null,
      size: entry.size,
      restoredAt: stamp,
    }, idem);
  }

  function handlePurgeOne(req, res, id) {
    const entry = store.trash.get(id) || null;
    if (!entry) {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    if (entry.blobMissing) {
      sendError(req, res, 500, "trash_blob_missing", "The trash data is missing.", { id: entry.id, originalPath: entry.originalPath });
      return;
    }
    store.trash.delete(id);
    sendOk(req, res, 200, { id, purged: true, purgedAt: nowIso() });
  }

  async function handleEmptyTrash(req, res) {
    const { buffer, truncated } = await readBody(req, JSON_LIMIT_BYTES);
    if (truncated) {
      sendError(req, res, 413, "payload_too_large", "The JSON body exceeds the size limit.", {});
      return;
    }
    if (buffer.length === 0) {
      sendError(req, res, 400, "confirm_required", "Emptying the trash requires confirm: true.", {});
      return;
    }
    const parsed = parseJsonBody(buffer);
    if (parsed.error === "invalid_json") {
      sendError(req, res, 400, "invalid_json", "The body is not valid JSON.", {});
      return;
    }
    if (parsed.error) {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", {});
      return;
    }
    const unknown = rejectUnknownFields(parsed.value, ["confirm"]);
    if (unknown) {
      sendError(req, res, 400, "validation_failed", "The body contains unknown fields.", unknown);
      return;
    }
    if (parsed.value.confirm !== true) {
      sendError(req, res, 400, "confirm_required", "Emptying the trash requires confirm: true.", {});
      return;
    }
    let purged = 0;
    let failed = 0;
    const failures = [];
    for (const entry of [...store.trash.values()]) {
      if (entry.blobMissing) {
        failed += 1;
        failures.push({ id: entry.id, code: "trash_blob_missing" });
        continue;
      }
      store.trash.delete(entry.id);
      purged += 1;
    }
    sendOk(req, res, 200, { purged, failed, failures, purgedAt: nowIso() });
  }

  // --- Handlers: reconcile ---
  async function handlePostReconcile(req, res) {
    const { buffer, truncated } = await readBody(req, JSON_LIMIT_BYTES);
    if (truncated) {
      sendError(req, res, 413, "payload_too_large", "The JSON body exceeds the size limit.", {});
      return;
    }
    let body = {};
    if (buffer.length > 0) {
      const parsed = parseJsonBody(buffer);
      if (parsed.error === "invalid_json") {
        sendError(req, res, 400, "invalid_json", "The body is not valid JSON.", {});
        return;
      }
      if (parsed.error) {
        sendError(req, res, 400, "validation_failed", "The body is not valid.", {});
        return;
      }
      body = parsed.value;
    }
    const unknown = rejectUnknownFields(body, ["full", "dryRun"]);
    if (unknown) {
      sendError(req, res, 400, "validation_failed", "The body contains unknown fields.", unknown);
      return;
    }
    const full = body.full === undefined ? true : body.full;
    const dryRun = body.dryRun === undefined ? false : body.dryRun;
    if (typeof full !== "boolean" || typeof dryRun !== "boolean") {
      sendError(req, res, 400, "validation_failed", "The body is not valid.", fieldError(typeof full !== "boolean" ? "full" : "dryRun", "expected a boolean"));
      return;
    }
    if (store.reconcile.running) {
      sendError(req, res, 409, "reconcile_already_running", "A reconciliation is already running.", {});
      return;
    }
    const jobId = `rec-${randomUUID()}`;
    const startedAt = nowIso();
    store.reconcile.running = true;
    store.reconcile.timer = setTimeout(() => {
      const finishedAt = nowIso();
      const filesScanned = [...store.nodes.values()].filter((node) => node.kind === "file").length;
      store.reconcile.running = false;
      store.reconcile.timer = null;
      store.reconcile.lastRun = {
        jobId,
        startedAt,
        finishedAt,
        durationMs: RECONCILE_HOLD_MS,
        filesScanned,
        indexRowsChecked: filesScanned,
        driftFound: 0,
        driftRepaired: 0,
        driftRemaining: 0,
        skippedLocked: 0,
        categories: { orphanDisk: 0, phantomIndex: 0, hashMismatch: 0, metadataMismatch: 0 },
        dryRun,
        driftPaths: [],
        status: "completed",
      };
    }, RECONCILE_HOLD_MS);
    if (typeof store.reconcile.timer.unref === "function") store.reconcile.timer.unref();
    sendOk(req, res, 202, { jobId, status: "running", full, dryRun, startedAt });
  }

  function handleGetReconcile(req, res) {
    sendOk(req, res, 200, {
      running: store.reconcile.running,
      lastRun: store.reconcile.lastRun,
      driftWarning: false,
      driftCritical: false,
      watcherDegraded: false,
      nextScheduledRunAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
  }

  // --- Handlers: media ---
  function mediaPathFromUrl(pathname) {
    const prefix = "/api/workspace/media/";
    if (!pathname.startsWith(prefix)) return { error: "invalid_path" };
    const remainder = pathname.slice(prefix.length);
    if (remainder === "") return { error: "invalid_path" };
    const segments = [];
    for (const segment of remainder.split("/")) {
      try {
        segments.push(decodeURIComponent(segment));
      } catch {
        return { error: "invalid_path" };
      }
    }
    return { path: segments.join("/") };
  }

  function handleGetMedia(req, res, url, pathname, isHead) {
    const extracted = mediaPathFromUrl(pathname);
    if (extracted.error) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    const checked = validateWorkspacePath(extracted.path);
    if (!checked.ok) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    if (checked.hidden || hasSymlinkComponent(checked.path)) {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    const node = nodeAt(checked.path);
    if (!node || node.kind !== "file") {
      sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
      return;
    }
    const revision = computeRevision(checked.path, node.content);
    const serving = mediaServing(checked.path, node.content);
    const safeName = lastSegment(checked.path).replace(/["\r\n]/g, "%22");
    const headers = {
      "Content-Type": serving.mimeType,
      ETag: etagFor(revision),
      "X-Revision": revision,
      "Last-Modified": new Date(node.modifiedAt).toUTCString(),
      "Content-Disposition": serving.disposition === "inline" ? "inline" : `attachment; filename="${safeName}"`,
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Cache-Control": url.searchParams.has("v") ? "private, max-age=86400" : "private, max-age=0, must-revalidate",
      "X-Request-Id": requestIdOf(req),
      "X-Mock-Workspace": "1",
    };
    if (serving.disposition === "inline") headers["Content-Security-Policy"] = "sandbox";
    if (noneMatchMatches(req.headers["if-none-match"], revision)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let body = node.content;
    let status = 200;
    const rangeHeader = req.headers.range;
    if (typeof rangeHeader === "string" && rangeHeader.startsWith("bytes=") && !rangeHeader.includes(",")) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (match) {
        const size = node.content.length;
        let start;
        let end;
        if (match[1] === "" && match[2] !== "") {
          const suffix = Number.parseInt(match[2], 10);
          start = Math.max(0, size - suffix);
          end = size - 1;
        } else if (match[1] !== "" && match[2] === "") {
          start = Number.parseInt(match[1], 10);
          end = size - 1;
        } else if (match[1] !== "" && match[2] !== "") {
          start = Number.parseInt(match[1], 10);
          end = Math.min(Number.parseInt(match[2], 10), size - 1);
        }
        if (start === undefined || start >= size || start > end || size === 0) {
          sendJson(req, res, 416, {
            ok: false,
            error: {
              code: "range_not_satisfiable",
              message: "The requested range cannot be satisfied.",
              requestId: requestIdOf(req),
              retryable: false,
              details: {},
            },
          }, { "Content-Range": `bytes */${size}` });
          return;
        }
        body = node.content.subarray(start, end + 1);
        status = 206;
        headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      }
    }
    headers["Content-Length"] = body.length;
    res.writeHead(status, headers);
    res.end(isHead ? undefined : body);
  }

  function writeMediaNode(path, bytes, guard, media, stamp, idem, req, res) {
    const existing = store.nodes.get(path) || null;
    if (existing && existing.kind === "dir") {
      sendError(req, res, 400, "invalid_path", "The path is a directory.", {});
      return;
    }
    const failure = guardFailureFor(existing, path, guard, existing !== null);
    if (failure) {
      sendError(req, res, failure.status, failure.code, failure.message, failure.details || {});
      return;
    }
    const created = existing === null;
    const node = {
      kind: "file",
      content: bytes,
      version: created ? 1 : existing.version + 1,
      createdAt: created ? stamp : existing.createdAt,
      modifiedAt: stamp,
    };
    ensureParents(path, stamp);
    store.nodes.set(path, node);
    const revision = computeRevision(path, bytes);
    const mediaUrl = `/api/workspace/media/${path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
    sendOkIdempotent(
      req,
      res,
      created ? 201 : 200,
      {
        path,
        revision,
        version: node.version,
        size: bytes.length,
        mimeType: media.mimeType,
        detectedType: media.detectedType,
        disposition: media.disposition,
        mediaUrl,
        modifiedAt: stamp,
      },
      idem,
      { ETag: etagFor(revision), "X-Revision": revision, "Last-Modified": new Date(stamp).toUTCString() },
    );
  }

  async function handlePostMedia(req, res) {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = /multipart\/form-data;\s*boundary=(.+)$/.exec(contentType);
    if (!boundaryMatch) {
      await readBody(req, 1024);
      sendError(req, res, 400, "invalid_upload", "The upload is not valid multipart data.", {});
      return;
    }
    const boundary = boundaryMatch[1].replace(/^"|"$/g, "");
    const { buffer, truncated } = await readBody(req, MEDIA_LIMIT_BYTES + 1024 * 1024 + 1);
    if (truncated) {
      sendError(req, res, 413, "media_too_large", "The media exceeds the size limit.", {});
      return;
    }
    const parsed = parseMultipart(buffer, boundary);
    if (parsed.error) {
      sendError(req, res, 400, "invalid_upload", "The upload is not valid multipart data.", {});
      return;
    }
    const fileParts = parsed.files.filter((part) => part.name === "file");
    const pathValues = parsed.fields.get("path") || [];
    if (parsed.files.length !== 1 || fileParts.length !== 1 || pathValues.length !== 1) {
      sendError(req, res, 400, "invalid_upload", "The upload must carry exactly one path field and one file.", {});
      return;
    }
    const pathCheck = checkWritePath(pathValues[0]);
    if (pathCheck.error) {
      const code = pathCheck.error;
      sendError(req, res, 400, code, code === "invalid_path" ? "The path is not valid." : "Symlinks are not allowed.", {});
      return;
    }
    const path = pathCheck.path;
    const headerGuard = parseGuards(req.headers);
    if (headerGuard.error) {
      sendError(req, res, 400, "invalid_precondition", "The guard headers are not valid.", {});
      return;
    }
    let bodyGuard = { kind: "none" };
    const ifMatchValues = parsed.fields.get("ifMatch") || [];
    const ifNoneMatchValues = parsed.fields.get("ifNoneMatch") || [];
    if (ifMatchValues.length > 1 || ifNoneMatchValues.length > 1) {
      sendError(req, res, 400, "invalid_precondition", "The guard fields are not valid.", {});
      return;
    }
    if (ifMatchValues.length === 1 && ifNoneMatchValues.length === 1) {
      sendError(req, res, 400, "invalid_precondition", "The guard fields are not valid.", {});
      return;
    }
    if (ifMatchValues.length === 1) {
      if (ifMatchValues[0].trim() === "*") bodyGuard = { kind: "force" };
      else {
        const parsedValue = parseMatchValue(ifMatchValues[0]);
        if (parsedValue.error) {
          sendError(req, res, 400, "invalid_precondition", "The guard fields are not valid.", {});
          return;
        }
        bodyGuard = { kind: "match", value: parsedValue.value };
      }
    }
    if (ifNoneMatchValues.length === 1) {
      if (ifNoneMatchValues[0].trim() !== "*") {
        sendError(req, res, 400, "invalid_precondition", "The guard fields are not valid.", {});
        return;
      }
      bodyGuard = { kind: "create-only" };
    }
    if (headerGuard.kind !== "none" && bodyGuard.kind !== "none") {
      const same = headerGuard.kind === bodyGuard.kind && headerGuard.value === bodyGuard.value;
      if (!same) {
        sendError(req, res, 400, "invalid_precondition", "The header guard and the body guard differ.", {});
        return;
      }
    }
    const guard = headerGuard.kind !== "none" ? headerGuard : bodyGuard;
    if (guard.kind === "none") {
      sendError(req, res, 428, "precondition_required", "A write guard header is required.", {});
      return;
    }
    const bytes = fileParts[0].data;
    if (bytes.length > MEDIA_LIMIT_BYTES) {
      sendError(req, res, 413, "media_too_large", "The media exceeds the size limit.", {});
      return;
    }
    const media = validateMedia(path, bytes);
    if (media.error) {
      sendError(req, res, 415, "unsupported_media_type", "The media type is not supported.", {});
      return;
    }
    const idem = checkIdempotency(req, res, buffer);
    if (idem.done) return;
    writeMediaNode(path, bytes, guard, media, nowIso(), idem, req, res);
  }

  async function handlePutMedia(req, res, url) {
    const rawPath = url.searchParams.get("path");
    if (rawPath === null) {
      sendError(req, res, 400, "invalid_path", "The path is not valid.", {});
      return;
    }
    const pathCheck = checkWritePath(rawPath);
    if (pathCheck.error) {
      const code = pathCheck.error;
      sendError(req, res, 400, code, code === "invalid_path" ? "The path is not valid." : "Symlinks are not allowed.", {});
      return;
    }
    const guard = parseGuards(req.headers);
    if (guard.error) {
      sendError(req, res, 400, "invalid_precondition", "The guard headers are not valid.", {});
      return;
    }
    const { buffer, truncated } = await readBody(req, MEDIA_LIMIT_BYTES);
    if (truncated) {
      sendError(req, res, 413, "media_too_large", "The media exceeds the size limit.", {});
      return;
    }
    const idem = checkIdempotency(req, res, buffer);
    if (idem.done) return;
    if (guard.kind === "none") {
      sendError(req, res, 428, "precondition_required", "A write guard header is required.", {});
      return;
    }
    const media = validateMedia(pathCheck.path, buffer);
    if (media.error) {
      sendError(req, res, 415, "unsupported_media_type", "The media type is not supported.", {});
      return;
    }
    writeMediaNode(pathCheck.path, buffer, guard, media, nowIso(), idem, req, res);
  }

  // --- Router ---
  const EXACT_ROUTES = new Map([
    ["/api/workspace/list", new Map([["GET", handleList]])],
    ["/api/workspace/file", new Map([
      ["GET", (req, res, url) => handleGetFile(req, res, url, false)],
      ["HEAD", (req, res, url) => handleGetFile(req, res, url, true)],
      ["PUT", handlePutFile],
      ["DELETE", (req, res, url) => handleDelete(req, res, url, "file")],
    ])],
    ["/api/workspace/file/append", new Map([["POST", (req, res, url) => handleAppendOrPatch(req, res, url, false)]])],
    ["/api/workspace/file/patch", new Map([["POST", (req, res, url) => handleAppendOrPatch(req, res, url, true)]])],
    ["/api/workspace/mkdir", new Map([["POST", handleMkdir]])],
    ["/api/workspace/move", new Map([["POST", handleMove]])],
    ["/api/workspace/move/repair-links", new Map([["POST", handleRepairLinks]])],
    ["/api/workspace/folder", new Map([["DELETE", (req, res, url) => handleDelete(req, res, url, "folder")]])],
    ["/api/workspace/trash", new Map([
      ["POST", handleBatchTrash],
      ["GET", handleListTrash],
      ["DELETE", handleEmptyTrash],
    ])],
    ["/api/workspace/scan", new Map([["GET", handleScan]])],
    ["/api/workspace/stat", new Map([["GET", handleStat]])],
    ["/api/workspace/media", new Map([
      ["POST", handlePostMedia],
      ["PUT", handlePutMedia],
    ])],
    ["/api/workspace/reconcile", new Map([
      ["POST", handlePostReconcile],
      ["GET", handleGetReconcile],
    ])],
  ]);

  const TRASH_ID_RE = /^\/api\/workspace\/trash\/([^/]+)$/;
  const TRASH_RESTORE_RE = /^\/api\/workspace\/trash\/([^/]+)\/restore$/;

  function matchRoute(method, pathname) {
    const exact = EXACT_ROUTES.get(pathname);
    if (exact) {
      if (exact.has(method)) return { handler: exact.get(method), params: {} };
      return { known: true };
    }
    if (pathname.startsWith("/api/workspace/media/")) {
      if (method === "GET") return { handler: (req, res, url) => handleGetMedia(req, res, url, pathname, false), params: {} };
      if (method === "HEAD") return { handler: (req, res, url) => handleGetMedia(req, res, url, pathname, true), params: {} };
      return { known: true };
    }
    const restoreMatch = TRASH_RESTORE_RE.exec(pathname);
    if (restoreMatch) {
      if (method === "POST") {
        return { handler: (req, res) => handleRestore(req, res, decodeURIComponent(restoreMatch[1])), params: {} };
      }
      return { known: true };
    }
    const trashMatch = TRASH_ID_RE.exec(pathname);
    if (trashMatch) {
      if (method === "DELETE") {
        return { handler: (req, res) => handlePurgeOne(req, res, decodeURIComponent(trashMatch[1])), params: {} };
      }
      return { known: true };
    }
    return { known: false };
  }

  function hasSession(req) {
    const cookie = req.headers.cookie || "";
    return cookie.split(";").some((part) => part.trim() === `session=${MOCK_SESSION_COOKIE}`);
  }

  async function dispatch(req, res) {
    try {
      const rawPath = req.url.split("?")[0];
      const url = new URL(req.url, "http://mock.invalid");
      if (!rawPath.startsWith("/api/")) {
        sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
        return;
      }
      if (!hasSession(req)) {
        sendError(req, res, 401, "unauthenticated", "Authentication is required.", {});
        return;
      }
      const matched = matchRoute(req.method, rawPath);
      if (!matched.handler) {
        if (matched.known) {
          sendError(req, res, 405, "method_not_allowed", "The method is not allowed on this path.", {});
        } else {
          sendError(req, res, 404, "not_found", "The requested resource was not found.", {});
        }
        return;
      }
      if (req.method === "PUT" || req.method === "POST" || req.method === "DELETE") {
        if (req.headers["x-csrf-token"] !== MOCK_CSRF_TOKEN) {
          sendError(req, res, 403, "csrf_invalid", GENERIC_REJECTED_MESSAGE, {});
          return;
        }
        const expectedOrigin = `http://${req.headers.host}`;
        if (req.headers.origin !== expectedOrigin) {
          sendError(req, res, 403, "origin_rejected", GENERIC_REJECTED_MESSAGE, {});
          return;
        }
      }
      await matched.handler(req, res, url);
    } catch (error) {
      if (!res.headersSent) {
        sendError(req, res, 500, "internal_error", "An internal error occurred.", {});
      } else {
        res.end();
      }
    }
  }

  const server = http.createServer(dispatch);

  // Test-only fixtures. These bypass the API on purpose so the suite
  // can plant states the API itself refuses to create (symlinks,
  // invalid UTF-8). They exist only in-process; the same suite run
  // against a real backend skips fixture-dependent cases.
  const fixtures = {
    injectFile(path, buffer, { version = 1 } = {}) {
      const stamp = nowIso();
      ensureParents(path, stamp);
      store.nodes.set(path, {
        kind: "file",
        content: Buffer.from(buffer),
        version,
        createdAt: stamp,
        modifiedAt: stamp,
      });
    },
    injectDir(path) {
      const stamp = nowIso();
      ensureParents(path, stamp);
      store.nodes.set(path, {
        kind: "dir",
        content: Buffer.alloc(0),
        version: null,
        createdAt: stamp,
        modifiedAt: stamp,
      });
    },
    injectSymlink(path, target) {
      const stamp = nowIso();
      ensureParents(path, stamp);
      store.nodes.set(path, {
        kind: "symlink",
        content: Buffer.alloc(0),
        version: null,
        createdAt: stamp,
        modifiedAt: stamp,
        target,
      });
    },
    markBlobMissing(id) {
      const entry = store.trash.get(id);
      if (!entry) return false;
      entry.blobMissing = true;
      return true;
    },
    trashIds() {
      return [...store.trash.keys()];
    },
    paths() {
      return [...store.nodes.keys()].sort();
    },
    reset() {
      if (store.reconcile.timer) clearTimeout(store.reconcile.timer);
      store.nodes.clear();
      store.trash.clear();
      store.idempotency.clear();
      store.reconcile.running = false;
      store.reconcile.lastRun = null;
      store.reconcile.timer = null;
    },
  };

  return { server, store: fixtures };
}

export async function startMockServer() {
  const { server, store } = createMockServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    server,
    store,
    baseUrl,
    async close() {
      store.reset();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : "";
if (process.argv[1] && invokedPath === process.argv[1]) {
  const port = Number.parseInt(process.env.PORT || "3101", 10);
  const { server } = createMockServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Workspace mock server listening on http://127.0.0.1:${port}`);
    console.log("Test session cookie: session=mock-session; CSRF token: mock-csrf");
  });
}
