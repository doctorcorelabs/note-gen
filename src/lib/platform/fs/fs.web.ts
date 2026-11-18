// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Web FsAdapter: filesystem operations over the workspace HTTP API
// (V1-09 contract, /api/workspace/*). No Tauri imports.
//
// How paths resolve (see resolveWorkspacePath for the exact rules):
// - `{ path: "article/<rel>", baseDir: AppData }`, the form produced by
//   getFilePathOptions for the default workspace, maps to workspace
//   path `<rel>`. The bare virtual form `/appdata/article/<rel>` maps
//   the same way, as does `/appdata/article` to the workspace root.
// - Plain relative paths without a baseDir are workspace paths as-is.
//   The `article/` prefix is NOT stripped for them: without a baseDir
//   or virtual prefix the adapter cannot tell a real folder named
//   `article` from the default-workspace prefix, and workspace.ts
//   remains responsible for that form.
// - App-data paths outside `article/` (for example `image/`, `skills/`,
//   managed workspace locations) have no backend in the V1-09 contract,
//   which covers a single default workspace. They fail with a
//   PlatformCapabilityError naming fs.outsideWorkspaceRoot. The same
//   applies to any baseDir other than AppData and to the virtual config
//   prefix. This is explicit failure, not silent misdirection.
// - OS-absolute paths, drive-letter paths, `..` segments, NUL/control
//   characters, over-long paths and over-deep paths are rejected
//   client-side before any request, as defense in depth. The server is
//   authoritative and validates again; hidden (dot-leading) segments
//   are NOT pre-rejected here, so reads answer 404 and writes answer
//   400 exactly as the server decides (V1-09 section 8.6).
//
// How writes guard (V1-09 section 3): every PUT carries exactly one
// guard. Callers may pass expectedRevision (guard with it, no extra
// read), createNew (If-None-Match: *), or force (If-Match: *). Otherwise
// the adapter stats first: existing files are written with If-Match on
// the current revision, missing files with If-None-Match: *. A 412
// revision_conflict or a 409 version_conflict both surface as
// FsAdapterError with code `revision_conflict` carrying the conflict
// payload, so callers handle both guard locations with one flow.
// Text append uses POST /api/workspace/file/append; binary append is a
// read-modify-write because the contract has no binary append endpoint.
// copyFile is a read plus a guarded write for the same reason: the
// contract has no copy endpoint. Both compositions are documented as
// non-atomic.
//
// Binary files: `.md`/`.txt` go through the text endpoints, everything
// else through the media endpoints (GET/PUT /api/workspace/media).
// Media uploads are subject to the server magic-number validation.
//
// CSRF: mutations send X-CSRF-Token when a token provider is injected.
// How the token is obtained belongs to the auth design (V1-09
// assumption A2); without a provider no header is sent and the server
// answers 403, honestly. All requests use same-origin credentials so
// the session cookie is sent. No idempotency keys are sent: the adapter
// never retries internally, and a key generated per call would defeat
// server-side dedupe. Retry safety is a follow-up for the shared API
// client in src/lib/web/ (V1-05 section 3.3), which does not exist yet.
//
// How responses parse (kontrak-api-kanonis.md section 2, canonical
// envelope, W4-DEMO B1): success bodies are `{ ok: true, data: ... }`
// and error bodies are `{ ok: false, error: { code, message,
// requestId, retryable, details } }`, with per-code fields (conflict
// payload, diskWritten) inside `error.details`. Both shapes are
// unwrapped here. A bare body without the envelope (the shape the
// adapter contract fakes use) is still accepted as a fallback, so
// the unwrapping never breaks a caller that already worked.
//
// Watching: watch() translates WebSocket workspace events (V1-09
// section 9) into Tauri WatchEvent shapes, with a polling snapshot
// fallback when WebSocket is unavailable or repeatedly fails (AD-09),
// and when a connected socket stays silent: no workspace traffic
// within one poll interval arms polling alongside the live socket
// (D-WATCHER; a connected socket that never produces must not
// suppress the fallback). Event paths are virtual absolute paths
// under /appdata/article so the
// existing watcher hook converts them back to workspace-relative paths
// with the same code it uses on desktop.

import { capabilityError } from "../errors";
import {
  VIRTUAL_APP_CONFIG_DIR,
  VIRTUAL_APP_DATA_DIR,
} from "../path/interface";
import { BaseDirectory } from "./interface";
import {
  FsAdapterError,
  isFsAdapterError,
  isNotFoundError,
} from "./errors";
import type { FsConflictPayload } from "./errors";
import type {
  CopyFileOptions,
  DebouncedWatchOptions,
  DirEntry,
  ExistsOptions,
  FileInfo,
  FsAdapter,
  FsBinaryFileResult,
  FsFileHandle,
  FsMoveResult,
  FsTextFileResult,
  MkdirOptions,
  OpenOptions,
  ReadDirOptions,
  ReadFileOptions,
  RemoveOptions,
  RenameOptions,
  StatOptions,
  UnwatchFn,
  WatchEvent,
  WriteFileOptions,
} from "./interface";

/**
 * Seek origin for the web file handle: 0 = start, 1 = current, 2 = end.
 * The canonical interface (audit V2-40) has no seek-mode enum because
 * no call site seeks; the web implementation keeps numeric origins
 * locally for the buffered handle below.
 */
type SeekOrigin = 0 | 1 | 2;

/**
 * Web file handle: the canonical FsFileHandle surface plus the
 * seek/truncate/write members this implementation provides. seek works
 * over the buffered bytes; truncate and write reject with a capability
 * error (writable handles are unsupported in web mode). Call sites
 * only ever see FsFileHandle through open().
 */
export interface WebFsFileHandle extends FsFileHandle {
  seek(offset: number, whence: SeekOrigin): Promise<number>;
  truncate(len?: number): Promise<void>;
  write(data: Uint8Array): Promise<number>;
}

const WORKSPACE_API = "/api/workspace";
const LIST_LIMIT = 500;
const MAX_PATH_BYTES = 1024;
const MAX_PATH_SEGMENTS = 50;
const TEXT_EXTENSIONS = [".md", ".txt"];
const STANDARD_CONFLICT_ACTIONS = ["reload", "saveAsCopy", "forceOverwrite"];

/**
 * Default per-request timeout for workspace HTTP calls (DA28-01 /
 * S-P0-17). Matches the ApiClient production budget (15 seconds).
 * Every request through doFetch is raced against this budget, so a
 * stalled API, tunnel, or database surfaces a `timeout`
 * FsAdapterError instead of hanging the caller forever. The race
 * bounds time-to-response-headers; reading a response body that
 * already started is not cut off by it. Override per adapter
 * through WebFsAdapterDeps.defaultTimeoutMs.
 */
export const DEFAULT_FS_REQUEST_TIMEOUT_MS = 15000;

/** Rejection sentinel for the doFetch timeout race. Never surfaces to callers. */
const FETCH_TIMEOUT_SENTINEL: unique symbol = Symbol("fs-fetch-timeout");

/** Minimal fetch surface, so tests can inject a fake without DOM types. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  credentials?: string;
  /**
   * Abort signal for the request. doFetch always supplies its own
   * timeout controller signal, so a fetch implementation that
   * honors signals aborts promptly; the timeout race bounds the
   * call even for implementations that ignore the signal.
   */
  signal?: AbortSignal;
}

export type FetchLike = (
  url: string,
  init?: FetchInitLike,
) => Promise<FetchResponseLike>;

/** Minimal WebSocket surface used by watch(). */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketImpl = new (url: string) => WebSocketLike;

export interface WebFsAdapterDeps {
  /** Fetch implementation. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /**
   * CSRF token provider for mutations. Return null/undefined when no
   * token is available; the request is then sent without the header.
   */
  getCsrfToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /**
   * WebSocket constructor for watch(). Defaults to the global
   * WebSocket. Pass null to disable WebSocket and use polling only.
   */
  webSocketImpl?: WebSocketImpl | null;
  /** Polling interval while the tab is visible. Default 10000 ms. */
  watchPollIntervalMs?: number;
  /** Polling interval while the tab is hidden. Default 30000 ms. */
  watchPollIntervalHiddenMs?: number;
  /**
   * Per-request timeout in milliseconds for workspace HTTP calls.
   * Defaults to DEFAULT_FS_REQUEST_TIMEOUT_MS. Must be a finite
   * number above zero when set; anything else throws at
   * construction. There is no unbounded mode: a stalled request
   * must always surface as a `timeout` error (DA28-01).
   */
  defaultTimeoutMs?: number;
}

interface WorkspaceEntryWire {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number | null;
  modifiedAt: string | null;
  createdAt: string | null;
  revision: string | null;
  version: number | null;
  isLocale: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : typeof value === "string"
      ? value
      : null;
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : typeof value === "number" && Number.isFinite(value)
      ? value
      : null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function invalidPathError(
  path: string,
  detail: string,
): FsAdapterError {
  return new FsAdapterError({
    code: "invalid_path",
    status: 400,
    message: `Invalid workspace path: ${detail}`,
    path,
    detail,
  });
}

function outsideWorkspaceError(path: string): Error {
  return capabilityError(
    "unsupported",
    "fs",
    "fs.outsideWorkspaceRoot",
    "web",
    `Path "${path}" is outside the workspace root and has no web backend in this MVP; only article/ paths map to the workspace API`,
  );
}

function pathInputToString(input: string | URL): string {
  if (typeof input === "string") {
    return input;
  }
  try {
    return decodeURIComponent(input.pathname);
  } catch {
    return input.pathname;
  }
}

function isOsAbsolute(posixPath: string): boolean {
  return posixPath.startsWith("/") || /^[a-zA-Z]:/.test(posixPath);
}

function validateRelative(relative: string, original: string): string {
  if (/[\u0000-\u001f\u007f]/.test(relative)) {
    throw invalidPathError(original, "path contains NUL or control characters");
  }
  const segments: string[] = [];
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw invalidPathError(original, "path contains .. segments");
    }
    segments.push(segment);
  }
  const clean = segments.join("/");
  if (new TextEncoder().encode(clean).length > MAX_PATH_BYTES) {
    throw invalidPathError(original, "path exceeds 1024 UTF-8 bytes");
  }
  if (segments.length > MAX_PATH_SEGMENTS) {
    throw invalidPathError(original, "path exceeds 50 segments");
  }
  return clean;
}

/**
 * Resolve a caller path plus optional baseDir to a workspace-relative
 * path ("" means the workspace root). Throws FsAdapterError
 * invalid_path for traversal/absolute/malformed paths and
 * PlatformCapabilityError for paths outside the workspace root. See the
 * file header for the full mapping table.
 */
function resolveWorkspacePath(
  input: string | URL,
  baseDir?: number,
): string {
  const raw = pathInputToString(input).trim().replace(/\\/g, "/");
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw invalidPathError(raw, "path contains NUL or control characters");
  }
  if (baseDir !== undefined && baseDir !== BaseDirectory.AppData) {
    throw capabilityError(
      "unsupported",
      "fs",
      "fs.baseDirectory",
      "web",
      `Base directory ${baseDir} has no web mapping; only AppData is supported`,
    );
  }
  const appDataPrefix = `${VIRTUAL_APP_DATA_DIR}/`;
  const configPrefix = `${VIRTUAL_APP_CONFIG_DIR}/`;
  let relative: string | null = null;
  if (raw === VIRTUAL_APP_DATA_DIR || raw.startsWith(appDataPrefix)) {
    const rest = raw.slice(VIRTUAL_APP_DATA_DIR.length).replace(/^\//, "");
    if (rest === "article") {
      relative = "";
    } else if (rest.startsWith("article/")) {
      relative = rest.slice("article/".length);
    } else {
      throw outsideWorkspaceError(raw);
    }
  } else if (raw === VIRTUAL_APP_CONFIG_DIR || raw.startsWith(configPrefix)) {
    throw outsideWorkspaceError(raw);
  } else if (baseDir === BaseDirectory.AppData) {
    if (isOsAbsolute(raw)) {
      throw invalidPathError(raw, "absolute path passed with a baseDir");
    }
    if (raw === "article") {
      relative = "";
    } else if (raw.startsWith("article/")) {
      relative = restSlice(raw);
    } else {
      throw outsideWorkspaceError(raw);
    }
  } else {
    if (isOsAbsolute(raw)) {
      throw invalidPathError(
        raw,
        "absolute paths outside the virtual workspace root are rejected",
      );
    }
    relative = raw;
  }
  return validateRelative(relative, raw);
}

function restSlice(raw: string): string {
  return raw.slice("article/".length);
}

function encodeQueryPath(relative: string): string {
  return encodeURIComponent(relative);
}

function encodeMediaPath(relative: string): string {
  return relative
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseRevisionHeader(headers: { get(name: string): string | null }): string | null {
  const direct = headers.get("X-Revision");
  if (direct && direct.trim() !== "") {
    return direct.trim();
  }
  const etag = headers.get("ETag");
  if (!etag) {
    return null;
  }
  let value = etag.trim();
  if (value.startsWith("W/")) {
    value = value.slice(2).trim();
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return value === "" ? null : value;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number.parseInt(value.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function formatIfMatch(revision: string): string {
  let value = revision.trim();
  if (value.startsWith("W/")) {
    value = value.slice(2).trim();
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value;
  }
  return `"${value}"`;
}

function parseConflictPayload(
  envelope: Record<string, unknown> | null,
  path: string,
): FsConflictPayload {
  const actionsRaw = envelope?.actions;
  const actions =
    Array.isArray(actionsRaw) &&
    actionsRaw.length > 0 &&
    actionsRaw.every((a) => typeof a === "string")
      ? (actionsRaw as string[])
      : [...STANDARD_CONFLICT_ACTIONS];
  const failedRaw = envelope?.failedOperation;
  return {
    path: asString(envelope?.path) ?? path,
    serverRevision: asString(envelope?.serverRevision) ?? "",
    serverVersion: asNullableNumber(envelope?.serverVersion),
    serverModifiedAt: asString(envelope?.serverModifiedAt) ?? "",
    serverSize: asNumber(envelope?.serverSize) ?? 0,
    currentPreview: asNullableString(envelope?.currentPreview),
    previewTruncated: envelope?.previewTruncated === true,
    suggestedCopyPath: asNullableString(envelope?.suggestedCopyPath),
    actions,
    ...(failedRaw === "append" || failedRaw === "patch"
      ? { failedOperation: failedRaw }
      : {}),
  };
}

function asWorkspaceEntry(value: unknown): WorkspaceEntryWire | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = asString(value.name);
  const path = asString(value.path);
  if (name === null || path === null) {
    return null;
  }
  if (typeof value.isDirectory !== "boolean" || typeof value.isFile !== "boolean") {
    return null;
  }
  return {
    name,
    path,
    isDirectory: value.isDirectory,
    isFile: value.isFile,
    size: asNullableNumber(value.size),
    modifiedAt: asNullableString(value.modifiedAt),
    createdAt: asNullableString(value.createdAt),
    revision: asNullableString(value.revision),
    version: asNullableNumber(value.version),
    isLocale: value.isLocale === true,
  };
}

function entryToFileInfo(entry: WorkspaceEntryWire): FileInfo {
  return {
    isFile: entry.isFile,
    isDirectory: entry.isDirectory,
    isSymlink: false,
    size: entry.size ?? 0,
    mtime: entry.modifiedAt ? new Date(entry.modifiedAt) : null,
    atime: null,
    birthtime: entry.createdAt ? new Date(entry.createdAt) : null,
    readonly: false,
    fileAttributes: null,
    dev: null,
    ino: null,
    mode: null,
    nlink: null,
    uid: null,
    gid: null,
    rdev: null,
    blksize: null,
    blocks: null,
    revision: entry.revision,
    version: entry.version,
  };
}

function rootFileInfo(): FileInfo {
  return {
    isFile: false,
    isDirectory: true,
    isSymlink: false,
    size: 0,
    mtime: null,
    atime: null,
    birthtime: null,
    readonly: false,
    fileAttributes: null,
    dev: null,
    ino: null,
    mode: null,
    nlink: null,
    uid: null,
    gid: null,
    rdev: null,
    blksize: null,
    blocks: null,
    revision: null,
    version: null,
  };
}

function isTextPath(relative: string): boolean {
  return TEXT_EXTENSIONS.some((ext) => relative.endsWith(ext));
}

function defaultFetchImpl(): FetchLike {
  return (url, init) => {
    const fetchFn = (globalThis as { fetch?: unknown }).fetch;
    if (typeof fetchFn !== "function") {
      return Promise.reject(
        new FsAdapterError({
          code: "network_error",
          status: 0,
          message: "No fetch implementation is available in this runtime",
        }),
      );
    }
    return (fetchFn as FetchLike)(url, init);
  };
}

export function createWebFsAdapter(deps: WebFsAdapterDeps = {}): FsAdapter {
  const fetchImpl: FetchLike = deps.fetchImpl ?? defaultFetchImpl();
  const timeoutMs = deps.defaultTimeoutMs ?? DEFAULT_FS_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(
      "WebFsAdapterDeps.defaultTimeoutMs must be a finite number above zero",
    );
  }

  async function csrfHeader(mutating: boolean): Promise<Record<string, string>> {
    if (!mutating || !deps.getCsrfToken) {
      return {};
    }
    const token = await deps.getCsrfToken();
    return token ? { "X-CSRF-Token": token } : {};
  }

  async function doFetch(
    url: string,
    init: FetchInitLike,
    mutating: boolean,
  ): Promise<FetchResponseLike> {
    const headers = { ...(init.headers ?? {}), ...(await csrfHeader(mutating)) };
    // Timeout race (DA28-01): the fetch is raced against an
    // explicit timer on top of the AbortSignal, mirroring
    // ApiClient.fetchWithBudget, so the call can never hang on a
    // fetch implementation that ignores the signal. A timeout
    // surfaces as a `timeout` FsAdapterError, never as a hang and
    // never with the request URL in the message.
    const controller = new AbortController();
    let timedOut = false;
    let rejectOnTimeout: ((reason: unknown) => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectOnTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectOnTimeout?.(FETCH_TIMEOUT_SENTINEL);
    }, timeoutMs);
    try {
      return await Promise.race([
        fetchImpl(url, {
          ...init,
          headers,
          credentials: "same-origin",
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
    } catch (err) {
      if (err === FETCH_TIMEOUT_SENTINEL || timedOut) {
        throw new FsAdapterError({
          code: "timeout",
          status: 0,
          message:
            "Workspace request timed out: the server did not respond in time. Try again.",
        });
      }
      if (err instanceof FsAdapterError) {
        throw err;
      }
      throw new FsAdapterError({
        code: "network_error",
        status: 0,
        message: `Workspace request failed: ${messageOf(err)}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function throwForError(
    res: FetchResponseLike,
    pathForError: string,
  ): Promise<never> {
    let rawText = "";
    try {
      rawText = await res.text();
    } catch {
      rawText = "";
    }
    let parsed: unknown = null;
    if (rawText !== "") {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }
    }
    const body = isRecord(parsed) ? parsed : null;
    // Canonical error envelope (W4-DEMO B1): code/message/requestId
    // live in the nested `error` object, and per-code fields live in
    // `error.details`. A flat body keeps working as a fallback.
    const nested = body !== null && isRecord(body.error) ? body.error : null;
    const codeSource = nested ?? body;
    const rawCode = codeSource !== null ? asString(codeSource.code) : null;
    let code = rawCode ?? (res.status >= 500 ? "internal_error" : "unknown");
    const message =
      (codeSource !== null ? asString(codeSource.message) : null) ??
      `Workspace request failed with status ${res.status}`;
    const requestId =
      codeSource !== null ? (asString(codeSource.requestId) ?? undefined) : undefined;
    const detail =
      codeSource !== null ? (asString(codeSource.detail) ?? undefined) : undefined;
    const detailsRecord =
      nested !== null && isRecord(nested.details) ? nested.details : null;
    let conflict: FsConflictPayload | undefined;
    if (code === "revision_conflict" || code === "version_conflict") {
      code = "revision_conflict";
      // Conflict fields come from error.details on the wire; merge
      // over the flat body so fields missing from details still fall
      // back to top-level values (and flat bodies keep working).
      conflict = parseConflictPayload(
        { ...(body ?? {}), ...(detailsRecord ?? {}) },
        pathForError,
      );
    }
    const diskWritten =
      detailsRecord?.diskWritten === true || body?.diskWritten === true
        ? true
        : undefined;
    throw new FsAdapterError({
      code,
      status: res.status,
      message,
      path: pathForError,
      requestId,
      detail,
      conflict,
      retryAfterSeconds: parseRetryAfter(res.headers.get("Retry-After")),
      diskWritten,
    });
  }

  async function requestJson<T>(
    method: string,
    url: string,
    pathForError: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const mutating = method !== "GET" && method !== "HEAD";
    const res = await doFetch(
      url,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(extraHeaders ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      mutating,
    );
    if (!res.ok) {
      await throwForError(res, pathForError);
    }
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      throw new FsAdapterError({
        code: "invalid_response",
        status: res.status,
        message: `Could not read response body: ${messageOf(err)}`,
        path: pathForError,
      });
    }
    if (text === "") {
      throw new FsAdapterError({
        code: "invalid_response",
        status: res.status,
        message: "Empty response body where JSON was expected",
        path: pathForError,
      });
    }
    try {
      const parsed: unknown = JSON.parse(text);
      // Unwrap the canonical success envelope `{ ok: true, data }`
      // (W4-DEMO B1/B5: without this, stat/list callers read the
      // envelope itself and see no entry). Bare bodies without the
      // envelope pass through unchanged as a fallback.
      if (isRecord(parsed) && parsed.ok === true && "data" in parsed) {
        return parsed.data as T;
      }
      return parsed as T;
    } catch {
      throw new FsAdapterError({
        code: "invalid_response",
        status: res.status,
        message: "Response body is not valid JSON",
        path: pathForError,
      });
    }
  }

  async function requestNoContent(
    method: string,
    url: string,
    pathForError: string,
  ): Promise<void> {
    const res = await doFetch(url, { method }, true);
    if (!res.ok) {
      await throwForError(res, pathForError);
    }
  }

  async function fetchStatEntry(relative: string): Promise<WorkspaceEntryWire> {
    const url = `${WORKSPACE_API}/stat?path=${encodeQueryPath(relative)}`;
    const entry = await requestJson<unknown>("GET", url, relative);
    const parsed = asWorkspaceEntry(entry);
    if (!parsed) {
      throw new FsAdapterError({
        code: "invalid_response",
        status: 200,
        message: "Stat response did not contain a workspace entry",
        path: relative,
      });
    }
    return parsed;
  }

  async function currentRevisionState(
    relative: string,
  ): Promise<{ exists: boolean; revision: string | null }> {
    try {
      const entry = await fetchStatEntry(relative);
      return { exists: true, revision: entry.revision };
    } catch (err) {
      if (isNotFoundError(err)) {
        return { exists: false, revision: null };
      }
      throw err;
    }
  }

  async function writeGuardHeaders(
    relative: string,
    options: WriteFileOptions | undefined,
  ): Promise<Record<string, string>> {
    if (options?.force) {
      return { "If-Match": "*" };
    }
    if (options?.expectedRevision) {
      return { "If-Match": formatIfMatch(options.expectedRevision) };
    }
    if (options?.createNew) {
      return { "If-None-Match": "*" };
    }
    const current = await currentRevisionState(relative);
    if (!current.exists) {
      if (options?.create === false) {
        throw new FsAdapterError({
          code: "not_found",
          status: 404,
          message: `File does not exist and create is false: ${relative}`,
          path: relative,
        });
      }
      return { "If-None-Match": "*" };
    }
    if (!current.revision) {
      throw new FsAdapterError({
        code: "invalid_response",
        status: 200,
        message: `Server did not return a revision for existing file: ${relative}`,
        path: relative,
      });
    }
    return { "If-Match": formatIfMatch(current.revision) };
  }

  async function putText(
    relative: string,
    text: string,
    guardHeaders: Record<string, string>,
  ): Promise<void> {
    const url = `${WORKSPACE_API}/file?path=${encodeQueryPath(relative)}`;
    const res = await doFetch(
      url,
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...guardHeaders,
        },
        body: text,
      },
      true,
    );
    if (!res.ok) {
      await throwForError(res, relative);
    }
  }

  async function putMedia(
    relative: string,
    bytes: Uint8Array,
    guardHeaders: Record<string, string>,
  ): Promise<void> {
    const url = `${WORKSPACE_API}/media?path=${encodeQueryPath(relative)}`;
    const res = await doFetch(
      url,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          ...guardHeaders,
        },
        body: bytes,
      },
      true,
    );
    if (!res.ok) {
      await throwForError(res, relative);
    }
  }

  async function putBytes(
    relative: string,
    bytes: Uint8Array,
    guardHeaders: Record<string, string>,
  ): Promise<void> {
    if (isTextPath(relative)) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new FsAdapterError({
          code: "invalid_text_encoding",
          status: 422,
          message: `Binary content for text path is not valid UTF-8: ${relative}`,
          path: relative,
        });
      }
      await putText(relative, text, guardHeaders);
      return;
    }
    await putMedia(relative, bytes, guardHeaders);
  }

  interface TextRead {
    text: string;
    revision: string | null;
    version: number | null;
    modifiedAt: string | null;
    size: number | null;
  }

  async function getTextFile(relative: string): Promise<TextRead> {
    const url = `${WORKSPACE_API}/file?path=${encodeQueryPath(relative)}`;
    const res = await doFetch(url, { method: "GET" }, false);
    if (!res.ok) {
      await throwForError(res, relative);
    }
    const text = await res.text();
    const lengthHeader = res.headers.get("Content-Length");
    const parsedLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : NaN;
    return {
      text,
      revision: parseRevisionHeader(res.headers),
      version: asNullableNumber(
        res.headers.get("X-Version") === null
          ? null
          : Number(res.headers.get("X-Version")),
      ),
      modifiedAt: res.headers.get("Last-Modified"),
      size: Number.isFinite(parsedLength)
        ? parsedLength
        : new TextEncoder().encode(text).length,
    };
  }

  interface BytesRead {
    data: Uint8Array;
    revision: string | null;
    version: number | null;
    modifiedAt: string | null;
    size: number | null;
  }

  async function getMediaFile(relative: string): Promise<BytesRead> {
    const url = `${WORKSPACE_API}/media/${encodeMediaPath(relative)}`;
    const res = await doFetch(url, { method: "GET" }, false);
    if (!res.ok) {
      await throwForError(res, relative);
    }
    const buffer = await res.arrayBuffer();
    const lengthHeader = res.headers.get("Content-Length");
    const parsedLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : NaN;
    return {
      data: new Uint8Array(buffer),
      revision: parseRevisionHeader(res.headers),
      version: null,
      modifiedAt: res.headers.get("Last-Modified"),
      size: Number.isFinite(parsedLength) ? parsedLength : buffer.byteLength,
    };
  }

  async function readBytesFlow(relative: string): Promise<BytesRead> {
    if (isTextPath(relative)) {
      const textRead = await getTextFile(relative);
      return {
        data: new TextEncoder().encode(textRead.text),
        revision: textRead.revision,
        version: textRead.version,
        modifiedAt: textRead.modifiedAt,
        size: textRead.size,
      };
    }
    return getMediaFile(relative);
  }

  async function listAll(relative: string): Promise<WorkspaceEntryWire[]> {
    const out: WorkspaceEntryWire[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const params = `path=${encodeQueryPath(relative)}&includeMetadata=true&limit=${LIST_LIMIT}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const page = await requestJson<{
        entries?: unknown;
        nextCursor?: unknown;
      }>("GET", `${WORKSPACE_API}/list?${params}`, relative);
      const entries = Array.isArray(page.entries) ? page.entries : [];
      for (const raw of entries) {
        const entry = asWorkspaceEntry(raw);
        if (!entry || seen.has(entry.path)) {
          continue;
        }
        seen.add(entry.path);
        out.push(entry);
      }
      cursor = asNullableString(page.nextCursor);
    } while (cursor !== null);
    return out;
  }

  async function writeTextFlow(
    relative: string,
    text: string,
    options: WriteFileOptions | undefined,
  ): Promise<void> {
    if (options?.append) {
      let expectedRevision = options.expectedRevision;
      const force = options.force === true;
      if (!force && !expectedRevision) {
        const current = await currentRevisionState(relative);
        if (!current.exists) {
          throw new FsAdapterError({
            code: "not_found",
            status: 404,
            message: `Append target does not exist (append never creates): ${relative}`,
            path: relative,
          });
        }
        if (!current.revision) {
          throw new FsAdapterError({
            code: "invalid_response",
            status: 200,
            message: `Server did not return a revision for existing file: ${relative}`,
            path: relative,
          });
        }
        expectedRevision = current.revision;
      }
      const url = `${WORKSPACE_API}/file/append?path=${encodeQueryPath(relative)}`;
      await requestJson<unknown>("POST", url, relative, {
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        content: text,
        force,
      });
      return;
    }
    const guardHeaders = await writeGuardHeaders(relative, options);
    await putText(relative, text, guardHeaders);
  }

  async function writeBytesFlow(
    relative: string,
    data: Uint8Array,
    options: WriteFileOptions | undefined,
  ): Promise<void> {
    if (options?.append) {
      let existing: BytesRead | null = null;
      try {
        existing = await readBytesFlow(relative);
      } catch (err) {
        if (!isNotFoundError(err)) {
          throw err;
        }
      }
      if (!existing && options.create === false) {
        throw new FsAdapterError({
          code: "not_found",
          status: 404,
          message: `Append target does not exist and create is false: ${relative}`,
          path: relative,
        });
      }
      const combined = new Uint8Array((existing?.data.length ?? 0) + data.length);
      if (existing) {
        combined.set(existing.data, 0);
      }
      combined.set(data, existing?.data.length ?? 0);
      if (!existing && !options.expectedRevision && !options.force) {
        await putBytes(relative, combined, { "If-None-Match": "*" });
        return;
      }
      if (options.force) {
        await putBytes(relative, combined, { "If-Match": "*" });
        return;
      }
      const revision = options.expectedRevision ?? existing?.revision ?? null;
      if (!revision) {
        throw new FsAdapterError({
          code: "invalid_response",
          status: 200,
          message: `Server did not return a revision for existing file: ${relative}`,
          path: relative,
        });
      }
      await putBytes(relative, combined, { "If-Match": formatIfMatch(revision) });
      return;
    }
    const guardHeaders = await writeGuardHeaders(relative, options);
    await putBytes(relative, data, guardHeaders);
  }

  async function moveFlow(
    source: string,
    target: string,
    options: RenameOptions | undefined,
  ): Promise<FsMoveResult> {
    const body: Record<string, unknown> = {
      source,
      target,
      rewriteLinks: options?.rewriteLinks ?? true,
    };
    if (options?.expectedRevision !== undefined) {
      body.expectedRevision = options.expectedRevision;
    }
    const result = await requestJson<unknown>(
      "POST",
      `${WORKSPACE_API}/move`,
      source,
      body,
    );
    if (!isRecord(result)) {
      throw new FsAdapterError({
        code: "invalid_response",
        status: 200,
        message: "Move response was not a JSON object",
        path: source,
      });
    }
    const rewrittenRaw = Array.isArray(result.rewrittenFiles)
      ? result.rewrittenFiles
      : [];
    const skippedRaw = Array.isArray(result.skipped) ? result.skipped : [];
    const pendingRaw = Array.isArray(result.pending) ? result.pending : [];
    const fileList = (raw: unknown[]): FsMoveResult["rewrittenFiles"] =>
      raw
        .map((item) => {
          if (!isRecord(item)) return null;
          const p = asString(item.path);
          const oldR = asString(item.oldRevision);
          const newR = asString(item.newRevision);
          const reps = asNumber(item.replacements);
          return p !== null && oldR !== null && newR !== null && reps !== null
            ? { path: p, oldRevision: oldR, newRevision: newR, replacements: reps }
            : null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
    const skipList = (raw: unknown[]): FsMoveResult["skipped"] =>
      raw
        .map((item) => {
          if (!isRecord(item)) return null;
          const p = asString(item.path);
          const reason = asString(item.reason);
          const detail = asString(item.detail);
          return p !== null && reason !== null && detail !== null
            ? { path: p, reason, detail }
            : null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
    const statusRaw = asString(result.rewriteStatus);
    const rewriteStatus =
      statusRaw === "complete" ||
      statusRaw === "partial" ||
      statusRaw === "skipped_only" ||
      statusRaw === "disabled"
        ? statusRaw
        : "complete";
    return {
      source: asString(result.source) ?? source,
      target: asString(result.target) ?? target,
      kind: result.kind === "folder" ? "folder" : "file",
      rewriteLinks: result.rewriteLinks !== false,
      rewriteStatus,
      revision: asNullableString(result.revision),
      rewrittenFiles: fileList(rewrittenRaw),
      skipped: skipList(skippedRaw),
      pending: skipList(pendingRaw),
      affectedCount: asNumber(result.affectedCount) ?? 0,
      indexHookWarning: asNullableString(result.indexHookWarning),
    };
  }

  // ------------------------------------------------------------------
  // Watching (WebSocket with polling fallback)
  // ------------------------------------------------------------------

  function virtualEventPath(relative: string): string {
    return relative === ""
      ? `${VIRTUAL_APP_DATA_DIR}/article`
      : `${VIRTUAL_APP_DATA_DIR}/article/${relative}`;
  }

  function hasDotSegment(relative: string): boolean {
    return relative.split("/").some((segment) => segment.startsWith("."));
  }

  function eventUnderWatch(relative: string, watched: readonly string[]): boolean {
    return watched.some(
      (root) => root === "" || relative === root || relative.startsWith(`${root}/`),
    );
  }

  function translateServerEvent(
    raw: Record<string, unknown>,
  ): WatchEvent | null {
    const kind = asString(raw.kind);
    const rel = asString(raw.path);
    if (kind === null || rel === null || hasDotSegment(rel)) {
      return null;
    }
    const isDir = raw.isDirectory === true;
    const vpath = virtualEventPath(rel);
    if (kind === "created") {
      return {
        type: { create: { kind: isDir ? "folder" : "file" } },
        paths: [vpath],
        attrs: null,
      };
    }
    if (kind === "changed") {
      return {
        type: { modify: { kind: "data", mode: "content" } },
        paths: [vpath],
        attrs: null,
      };
    }
    if (kind === "deleted") {
      return {
        type: { remove: { kind: isDir ? "folder" : "file" } },
        paths: [vpath],
        attrs: null,
      };
    }
    if (kind === "moved") {
      const prev = asString(raw.previousPath);
      const paths =
        prev !== null && !hasDotSegment(prev)
          ? [virtualEventPath(prev), vpath]
          : [vpath];
      return {
        type: { modify: { kind: "rename", mode: "both" } },
        paths,
        attrs: null,
      };
    }
    if (kind === "rescan") {
      return { type: "any", paths: [vpath], attrs: null };
    }
    return null;
  }

  function eventsUrl(): string | null {
    const loc = (globalThis as {
      location?: { protocol?: string; host?: string };
    }).location;
    if (!loc || !loc.host) {
      return null;
    }
    const scheme = loc.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${loc.host}${WORKSPACE_API}/events`;
  }

  function globalWebSocketCtor(): WebSocketImpl | null {
    const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
    return typeof ctor === "function" ? (ctor as WebSocketImpl) : null;
  }

  interface SnapshotEntry {
    fingerprint: string;
    isDirectory: boolean;
  }

  function startWatch(
    watched: readonly string[],
    cb: (event: WatchEvent) => void,
    options: DebouncedWatchOptions | undefined,
  ): UnwatchFn {
    let disposed = false;
    let lastSeq = 0;
    let failures = 0;
    let socket: WebSocketLike | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    let pollBackoffMs = 0;
    let snapshot: Map<string, SnapshotEntry> | null = null;
    const delayMs = options?.delayMs ?? 0;
    // Silence threshold: one visible poll interval with no workspace
    // traffic proves the socket is not producing, so polling takes
    // over. Reuses the poll interval dep (default 10000 ms) so tests
    // control both with one value; it is a watchdog bound, not a
    // second poll interval.
    const silenceThresholdMs = deps.watchPollIntervalMs ?? 10000;
    const pending = new Map<string, ReturnType<typeof setTimeout>>();

    const deliverNow = (event: WatchEvent): void => {
      if (disposed) {
        return;
      }
      try {
        cb(event);
      } catch {
        // A throwing listener must not break the watcher.
      }
    };

    const deliver = (event: WatchEvent): void => {
      if (disposed) {
        return;
      }
      if (delayMs <= 0) {
        deliverNow(event);
        return;
      }
      const key = event.paths[0] ?? "";
      const existing = pending.get(key);
      if (existing) {
        clearTimeout(existing);
      }
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key);
          deliverNow(event);
        }, delayMs),
      );
    };

    const sendResync = (): void => {
      if (!socket || lastSeq <= 0) {
        return;
      }
      try {
        socket.send(JSON.stringify({ type: "resync", sinceSeq: lastSeq }));
      } catch {
        // Socket is closing; the reconnect path handles recovery.
      }
    };

    const handleServerEvent = (raw: unknown): void => {
      if (!isRecord(raw)) {
        return;
      }
      const seq = asNumber(raw.seq);
      if (seq !== null) {
        if (seq <= lastSeq) {
          return;
        }
        if (lastSeq > 0 && seq > lastSeq + 1) {
          sendResync();
        }
        lastSeq = seq;
      }
      const rel = asString(raw.path);
      const prev = asString(raw.previousPath);
      if (
        rel !== null &&
        !eventUnderWatch(rel, watched) &&
        !(prev !== null && eventUnderWatch(prev, watched))
      ) {
        return;
      }
      const event = translateServerEvent(raw);
      if (event) {
        deliver(event);
      }
    };

    const handleMessage = (data: unknown): void => {
      if (typeof data !== "string") {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!isRecord(parsed)) {
        return;
      }
      const type = asString(parsed.type);
      if (type === "hello") {
        const helloSeq = asNumber(parsed.lastSeq);
        if (helloSeq !== null) {
          lastSeq = helloSeq;
        }
        failures = 0;
        noteWorkspaceTraffic();
        return;
      }
      if (type === "batch" && Array.isArray(parsed.events)) {
        noteWorkspaceTraffic();
        for (const item of parsed.events) {
          handleServerEvent(item);
        }
        return;
      }
      if (type === "workspace-file-changed") {
        noteWorkspaceTraffic();
        handleServerEvent(parsed);
        return;
      }
      if (type === "resync-required") {
        noteWorkspaceTraffic();
        deliver({
          type: "any",
          paths: watched.map((root) => virtualEventPath(root)),
          attrs: null,
        });
        return;
      }
      // pong, resync-ok, error: nothing to do.
    };

    async function snapshotTree(
      root: string,
      out: Map<string, SnapshotEntry>,
    ): Promise<void> {
      const entries = await listAll(root);
      for (const entry of entries) {
        if (hasDotSegment(entry.path)) {
          continue;
        }
        out.set(entry.path, {
          fingerprint:
            entry.revision ?? `${entry.size ?? ""}@${entry.modifiedAt ?? ""}`,
          isDirectory: entry.isDirectory,
        });
        if (entry.isDirectory) {
          await snapshotTree(entry.path, out);
        }
      }
    }

    const diffSnapshots = (
      oldSnap: Map<string, SnapshotEntry>,
      newSnap: Map<string, SnapshotEntry>,
    ): void => {
      const created: string[] = [];
      const changed: string[] = [];
      const deleted: string[] = [];
      for (const [path, entry] of newSnap) {
        const prev = oldSnap.get(path);
        if (!prev) {
          created.push(path);
        } else if (prev.fingerprint !== entry.fingerprint) {
          changed.push(path);
        }
      }
      for (const path of oldSnap.keys()) {
        if (!newSnap.has(path)) {
          deleted.push(path);
        }
      }
      const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
      for (const path of [...created.sort(byPath), ...changed.sort(byPath)]) {
        const entry = newSnap.get(path);
        const isDir = entry?.isDirectory === true;
        const isCreate = created.includes(path);
        deliver(
          isCreate
            ? {
                type: { create: { kind: isDir ? "folder" : "file" } },
                paths: [virtualEventPath(path)],
                attrs: null,
              }
            : {
                type: { modify: { kind: "data", mode: "content" } },
                paths: [virtualEventPath(path)],
                attrs: null,
              },
        );
      }
      for (const path of deleted.sort(byPath)) {
        const entry = oldSnap.get(path);
        deliver({
          type: { remove: { kind: entry?.isDirectory ? "folder" : "file" } },
          paths: [virtualEventPath(path)],
          attrs: null,
        });
      }
    };

    const scheduleNextPoll = (): void => {
      if (disposed || !polling) {
        return;
      }
      const hidden =
        typeof document !== "undefined" && document.visibilityState === "hidden";
      const base = hidden
        ? (deps.watchPollIntervalHiddenMs ?? 30000)
        : (deps.watchPollIntervalMs ?? 10000);
      pollTimer = setTimeout(() => void pollOnce(), Math.max(base, pollBackoffMs));
    };

    const pollOnce = async (): Promise<void> => {
      if (disposed || !polling) {
        return;
      }
      try {
        const next = new Map<string, SnapshotEntry>();
        for (const root of watched) {
          await snapshotTree(root, next);
        }
        if (snapshot) {
          diffSnapshots(snapshot, next);
        }
        snapshot = next;
        pollBackoffMs = 0;
      } catch (err) {
        if (isFsAdapterError(err) && err.code === "rate_limited") {
          pollBackoffMs = Math.min(
            pollBackoffMs === 0 ? 20000 : pollBackoffMs * 2,
            60000,
          );
        }
      }
      scheduleNextPoll();
    };

    function startPolling(): void {
      if (polling || disposed) {
        return;
      }
      polling = true;
      snapshot = null;
      // The first snapshot after a late polling start baselines the
      // CURRENT disk state, so writes that landed before the
      // baseline would never diff (D-WATCHER probe15: the early
      // write stayed invisible while a post-baseline write
      // surfaced). Close the gap with one pathless rescan event:
      // the watcher hook treats a pathless structural event as a
      // full tree reload, which surfaces every file the baseline
      // already contains. The rescan carries no paths on purpose:
      // a root-path event maps to an empty relative path and is
      // dropped by the hook's hidden/out-of-workspace filter.
      // Later polls diff against the fresh baseline, so no
      // duplicate rescan follows.
      deliver({ type: "any", paths: [], attrs: null });
      void pollOnce();
    }

    function stopPolling(): void {
      polling = false;
      snapshot = null;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    }

    // Silence watchdog (D-WATCHER): a connected socket that never
    // delivers workspace traffic must not suppress polling forever.
    // The hub has no producer until the V3-08b remainder lands, so a
    // live socket currently stays silent after hello; without this
    // timer polling is armed only by repeated socket failures and
    // external writes never surface. The timer is armed when a
    // socket is opened and re-armed by every hello, batch,
    // workspace-file-changed, and resync-required message (traffic
    // proves the producer is alive even when the subtree filter
    // drops an event). Pong, resync-ok, error, and malformed
    // messages do not re-arm it: they carry no file-change
    // evidence. Firing starts polling alongside the live socket
    // (plus one pathless rescan event from startPolling, closing
    // the pre-baseline gap); the socket stays connected with seq
    // tracking intact, and the next workspace message stops
    // polling again.
    function clearSilenceTimer(): void {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
    }

    function armSilenceTimer(): void {
      clearSilenceTimer();
      if (disposed) {
        return;
      }
      silenceTimer = setTimeout(() => {
        silenceTimer = null;
        startPolling();
      }, Math.max(0, silenceThresholdMs));
    }

    function noteWorkspaceTraffic(): void {
      stopPolling();
      armSilenceTimer();
    }

    const scheduleReconnect = (): void => {
      if (disposed) {
        return;
      }
      failures += 1;
      if (failures >= 5) {
        startPolling();
      }
      const base = Math.min(1000 * 2 ** (failures - 1), 15000);
      const wait = Math.random() * base;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, wait);
    };

    const connect = (): void => {
      if (disposed) {
        return;
      }
      const ctor =
        deps.webSocketImpl === undefined ? globalWebSocketCtor() : deps.webSocketImpl;
      if (!ctor) {
        startPolling();
        return;
      }
      const url = eventsUrl();
      if (url === null && deps.webSocketImpl === undefined) {
        // No location to build an absolute URL from (non-browser
        // runtime) and no injected constructor: polling only.
        startPolling();
        return;
      }
      let ws: WebSocketLike;
      try {
        ws = new ctor(url ?? `${WORKSPACE_API}/events`);
      } catch {
        scheduleReconnect();
        return;
      }
      socket = ws;
      ws.onopen = () => {
        // The server speaks first with `hello`; nothing to send yet.
      };
      ws.onmessage = (event) => {
        handleMessage(event.data);
      };
      ws.onclose = (event) => {
        socket = null;
        clearSilenceTimer();
        if (disposed) {
          return;
        }
        if (event.code === 4401 || event.code === 4403) {
          // Session or origin rejected: do not reconnect blindly.
          startPolling();
          return;
        }
        scheduleReconnect();
      };
      ws.onerror = () => {
        // A close event normally follows; recovery happens there.
      };
      // Watch for a socket that connects but never produces.
      armSilenceTimer();
    };

    connect();

    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearSilenceTimer();
      stopPolling();
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
      if (socket) {
        try {
          socket.close(1000, "unwatch");
        } catch {
          // Socket already closed.
        }
        socket = null;
      }
    };
  }

  // ------------------------------------------------------------------
  // Adapter
  // ------------------------------------------------------------------

  const adapter: FsAdapter = {
    async exists(
      path: string | URL,
      options?: ExistsOptions,
    ): Promise<boolean> {
      const relative = resolveWorkspacePath(path, options?.baseDir);
      if (relative === "") {
        return true;
      }
      try {
        await fetchStatEntry(relative);
        return true;
      } catch (err) {
        if (isNotFoundError(err)) {
          return false;
        }
        throw err;
      }
    },

    async mkdir(
      path: string | URL,
      options?: MkdirOptions,
    ): Promise<void> {
      const relative = resolveWorkspacePath(path, options?.baseDir);
      if (relative === "") {
        return;
      }
      // The server always creates parent folders, so `recursive` needs
      // no client-side handling.
      await requestJson<unknown>("POST", `${WORKSPACE_API}/mkdir`, relative, {
        path: relative,
      });
    },

    async readFile(
      path: string | URL,
      options?: ReadFileOptions,
    ): Promise<Uint8Array> {
      const relative = resolveWorkspacePath(path, options?.baseDir);
      if (relative === "") {
        throw invalidPathError("", "cannot read the workspace root as a file");
      }
      const read = await readBytesFlow(relative);
      return read.data;
    },

    async readTextFile(
      path: string | URL,
      options?: ReadFileOptions,
    ): Promise<string> {
      const relative = resolveWorkspacePath(path, options?.baseDir);
      if (relative === "") {
        throw invalidPathError("", "cannot read the workspace root as a file");
      }
      const read = await getTextFile(relative);
      return read.text;
    },

    async writeFile(
      path: string | URL,
      data: Uint8Array,
      options?: WriteFileOptions,
    ): Promise<void> {
      const relative = resolveWorkspacePath(path, options?.baseDir);
      if (relative === "") {
        throw invalidPathError("", "cannot write the workspace root as a file");
      }
      await writeBytesFlow(relative, data, options);
    },

    async writeTextFile(
      path: string | URL,
      data: string,
      options?: WriteFileOptions,
    ): Promise<void> {
      const relative = resolveWorkspacePath(path, options?.baseDir);
      if (relative === "") {
        throw invalidPathError("", "cannot write the workspace root as a file");
      }
      await writeTextFlow(relative, data, options);
    },

    async readDir(
      path: string | URL,
      options?: ReadDirOptions,
    ): Promise<DirEntry[]> {
      const relative = resolveWorkspacePath(path, options?.baseDir);
      const entries = await listAll(relative);
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isFile: entry.isFile,
        isSymlink: false,
      }));
    },

    async remove(
      path: string | URL,
      options?: RemoveOptions,
    ): Promise<void> {
      const relative = resolveWorkspacePath(path, options?.baseDir);
      if (relative === "") {
        throw invalidPathError("", "cannot remove the workspace root");
      }
      const entry = await fetchStatEntry(relative);
      if (entry.isDirectory && !options?.recursive) {
        const children = await listAll(relative);
        if (children.length > 0) {
          throw new FsAdapterError({
            code: "directory_not_empty",
            status: 400,
            message: `Directory is not empty and recursive is not set: ${relative}`,
            path: relative,
          });
        }
      }
      const endpoint = entry.isDirectory ? "folder" : "file";
      await requestNoContent(
        "DELETE",
        `${WORKSPACE_API}/${endpoint}?path=${encodeQueryPath(relative)}`,
        relative,
      );
    },

    async stat(
      path: string | URL,
      options?: StatOptions,
    ): Promise<FileInfo> {
      const relative = resolveWorkspacePath(path, options?.baseDir);
      if (relative === "") {
        return rootFileInfo();
      }
      return entryToFileInfo(await fetchStatEntry(relative));
    },

    async lstat(
      path: string | URL,
      options?: StatOptions,
    ): Promise<FileInfo> {
      // The server never exposes symlinks, so lstat and stat are the
      // same view in web mode.
      return adapter.stat(path, options);
    },

    async copyFile(
      fromPath: string | URL,
      toPath: string | URL,
      options?: CopyFileOptions,
    ): Promise<void> {
      const source = resolveWorkspacePath(fromPath, options?.fromPathBaseDir);
      const target = resolveWorkspacePath(toPath, options?.toPathBaseDir);
      if (source === "" || target === "") {
        throw invalidPathError(
          source === "" ? "" : target,
          "cannot copy the workspace root",
        );
      }
      // No copy endpoint in the V1-09 contract: read plus guarded
      // write. This composition is not atomic.
      const read = await readBytesFlow(source);
      await writeBytesFlow(target, read.data, undefined);
    },

    async rename(
      oldPath: string | URL,
      newPath: string | URL,
      options?: RenameOptions,
    ): Promise<void> {
      await adapter.renameWithResult(oldPath, newPath, options);
    },

    async renameWithResult(
      oldPath: string | URL,
      newPath: string | URL,
      options?: RenameOptions,
    ): Promise<FsMoveResult> {
      const source = resolveWorkspacePath(oldPath, options?.oldPathBaseDir);
      const target = resolveWorkspacePath(newPath, options?.newPathBaseDir);
      if (source === "" || target === "") {
        throw invalidPathError(
          source === "" ? "" : target,
          "cannot move the workspace root",
        );
      }
      return moveFlow(source, target, options);
    },

    async open(
      path: string | URL,
      options?: OpenOptions,
    ): Promise<FsFileHandle> {
      const relative = resolveWorkspacePath(path, options?.baseDir);
      if (relative === "") {
        throw invalidPathError("", "cannot open the workspace root as a file");
      }
      if (
        options?.write === true ||
        options?.append === true ||
        options?.truncate === true ||
        options?.create === true ||
        options?.createNew === true
      ) {
        throw capabilityError(
          "unsupported",
          "fs",
          "fs.openWritable",
          "web",
          "Writable file handles are not supported in web mode; use writeFile or writeTextFile",
        );
      }
      const info = entryToFileInfo(await fetchStatEntry(relative));
      if (!info.isFile) {
        throw new FsAdapterError({
          code: "not_a_file",
          status: 400,
          message: `Path is not a file: ${relative}`,
          path: relative,
        });
      }
      const read = await readBytesFlow(relative);
      const bytes = read.data;
      let cursor = 0;
      let closed = false;
      const handle: WebFsFileHandle = {
        async read(buffer: Uint8Array): Promise<number | null> {
          if (closed) {
            throw new FsAdapterError({
              code: "invalid_state",
              status: 400,
              message: "File handle is closed",
              path: relative,
            });
          }
          if (cursor >= bytes.length) {
            return null;
          }
          const count = Math.min(buffer.length, bytes.length - cursor);
          buffer.set(bytes.subarray(cursor, cursor + count), 0);
          cursor += count;
          return count;
        },
        async seek(offset: number, whence: SeekOrigin): Promise<number> {
          if (closed) {
            throw new FsAdapterError({
              code: "invalid_state",
              status: 400,
              message: "File handle is closed",
              path: relative,
            });
          }
          let next: number;
          if (whence === 0) {
            next = offset;
          } else if (whence === 1) {
            next = cursor + offset;
          } else {
            next = bytes.length + offset;
          }
          if (next < 0) {
            throw new FsAdapterError({
              code: "invalid_argument",
              status: 400,
              message: "Seek offset is before the start of the file",
              path: relative,
            });
          }
          cursor = next;
          return cursor;
        },
        async stat(): Promise<FileInfo> {
          return info;
        },
        async truncate(): Promise<void> {
          throw capabilityError(
            "unsupported",
            "fs",
            "fs.openWritable",
            "web",
            "Writable file handles are not supported in web mode; use writeFile or writeTextFile",
          );
        },
        async write(): Promise<number> {
          throw capabilityError(
            "unsupported",
            "fs",
            "fs.openWritable",
            "web",
            "Writable file handles are not supported in web mode; use writeFile or writeTextFile",
          );
        },
        async close(): Promise<void> {
          closed = true;
        },
      };
      return handle;
    },

    async watch(
      paths: string | string[] | URL | URL[],
      cb: (event: WatchEvent) => void,
      options?: DebouncedWatchOptions,
    ): Promise<UnwatchFn> {
      const list = Array.isArray(paths) ? paths : [paths];
      const resolved = list.map((p) => resolveWorkspacePath(p, options?.baseDir));
      const unique = [...new Set(resolved)];
      return startWatch(unique, cb, options);
    },

    async readTextFileDetailed(
      path: string | URL,
      options?: ReadFileOptions,
    ): Promise<FsTextFileResult> {
      const relative = resolveWorkspacePath(path, options?.baseDir);
      if (relative === "") {
        throw invalidPathError("", "cannot read the workspace root as a file");
      }
      const read = await getTextFile(relative);
      return {
        content: read.text,
        revision: read.revision,
        version: read.version,
        size: read.size,
        modifiedAt: read.modifiedAt,
      };
    },

    async readFileDetailed(
      path: string | URL,
      options?: ReadFileOptions,
    ): Promise<FsBinaryFileResult> {
      const relative = resolveWorkspacePath(path, options?.baseDir);
      if (relative === "") {
        throw invalidPathError("", "cannot read the workspace root as a file");
      }
      const read = await readBytesFlow(relative);
      return {
        data: read.data,
        revision: read.revision,
        version: read.version,
        size: read.size,
        modifiedAt: read.modifiedAt,
      };
    },
  };

  return adapter;
}
