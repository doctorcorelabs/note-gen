// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Thin client and resolvers for record assets (Fase 1, V3-32).
//
// Contract: fase1/kontrak-api-kanonis.md section 3.7 and
// fase1/desain-record-search.md section 4 (V1-14). The canonical
// paths bind here, not the V1-14 literals: POST /api/assets
// (multipart, one part "file" plus an optional "fileName" part)
// and GET /api/assets/:assetKey (authenticated bytes, key fully
// URL-encoded). No workspace identifier appears in any request.
//
// Two asset lanes stay separate (rencana-gelombang3.md section
// 1.3). This module owns the RECORD lane only: server-generated
// opaque keys served at /api/assets/:assetKey. The WORKSPACE
// MEDIA lane (workspace-relative paths served at
// /api/workspace/media/<path>) keeps its existing client resolver,
// platform.assetUrl.convertFileSrc; this module never builds a
// media URL, never passes a key through path validation, and never
// passes a media path as a key. The lane of a stored reference is
// declared by the caller from the data model (a record "url" holds
// a key; a Markdown image destination holds a workspace-relative
// path). It is never inferred from string shape: a bare key and a
// bare file name look alike, and guessing would mix the lanes.
//
// Keys are opaque. This module never parses key structure, never
// builds a disk path from a key, and never constructs a thumbnail
// key. A thumbnailUrl received from a record is passed through
// unchanged; when it is null or absent, the full asset (or a
// placeholder) is used. No thumbnail generation exists in the
// V3-31 server, so no thumbnail behavior is claimed here.
//
// Delete semantics (Opsi A, stated explicitly because the
// contract has NO delete endpoint for assets): "delete from the
// UI" removes the REFERENCE from the owning content or record.
// The stored file is never deleted by this flow. It becomes an
// orphan, and orphan cleanup is Fase 2 work that must never delete
// an asset that is still referenced (desain section 4.1). The
// owning surface supplies the removal callback (a record update
// or a content edit); this module never calls a DELETE endpoint,
// because inventing one is forbidden. A failed removal is
// reported through an explicit result value, never swallowed and
// never thrown away silently.
//
// All requests go through the centralized ApiClient (V3-30).
// This module performs no ad hoc fetch to /api/*.

import {
  defaultApiClient,
  type ApiClient,
  type ApiRequestOptions,
} from "./api-client";
import { ApiError, createLocalApiError } from "./errors";

export const RECORD_ASSETS_PATH = "/api/assets";

// Representation returned by POST /api/assets, 201 (kontrak 3.7).
// createdAt is epoch milliseconds (kontrak K-08).
export interface AssetRepresentation {
  assetKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  createdAt: number;
}

// Minimal client surface this module needs. ApiClient satisfies
// it structurally; tests inject a fake with requestJson only.
export type RecordAssetApiClient = Pick<ApiClient, "requestJson">;

export interface UploadRecordAssetOptions {
  // Client to send through. Defaults to defaultApiClient. The
  // wiring layer passes a client with a CSRF token provider; an
  // unwired client sends no token and the server answers 403.
  client?: RecordAssetApiClient;
  // Display name sent as the fileName part. Wins over the file
  // name when both are present. When absent, the File name is
  // used; a Blob without a name needs this option.
  fileName?: string;
  // Caller abort signal, forwarded to the client.
  signal?: AbortSignal;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Strict shape check for the upload response. A malformed shape
// is a server error, reported as such, never rendered as a
// half-filled asset row.
export function parseAssetRepresentation(value: unknown): AssetRepresentation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { assetKey, fileName, mimeType, sizeBytes, contentHash, createdAt } = record;
  if (!isNonEmptyString(assetKey)) {
    return null;
  }
  if (!isNonEmptyString(fileName)) {
    return null;
  }
  if (!isNonEmptyString(mimeType)) {
    return null;
  }
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
    return null;
  }
  if (!isNonEmptyString(contentHash)) {
    return null;
  }
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return null;
  }
  return { assetKey, fileName, mimeType, sizeBytes, contentHash, createdAt };
}

function resolveUploadFileName(file: File | Blob, fileNameOption: string | undefined): string {
  const explicit = fileNameOption?.trim();
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  if (file instanceof File) {
    const name = file.name.trim();
    if (name !== "") {
      return name;
    }
  }
  throw createLocalApiError("VALIDATION_ERROR");
}

// Uploads one file as one record asset. One request uploads one
// file (desain 4.1); callers upload several files with several
// calls and report each result separately. The server decides the
// type from magic bytes and enforces the size limit; the only
// client-side pre-check is the empty file, which the server
// rejects as validation_failed. ApiError from the server
// propagates unchanged so callers can branch on wireCode
// (asset_too_large carries details.limitBytes from the server;
// this module never invents a limit number).
export async function uploadRecordAsset(
  file: File | Blob,
  options: UploadRecordAssetOptions = {},
): Promise<AssetRepresentation> {
  if (file.size === 0) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  const fileName = resolveUploadFileName(file, options.fileName);
  const form = new FormData();
  form.append("file", file, fileName);
  form.append("fileName", fileName);
  const requestOptions: ApiRequestOptions = {
    method: "POST",
    formDataBody: form,
  };
  if (options.signal !== undefined) {
    requestOptions.signal = options.signal;
  }
  const client = options.client ?? defaultApiClient;
  const data = await client.requestJson<unknown>(RECORD_ASSETS_PATH, requestOptions);
  const representation = parseAssetRepresentation(data);
  if (representation === null) {
    throw createLocalApiError("SERVER_ERROR");
  }
  return representation;
}

// Reads the server-declared size limit out of a 413 error, or
// null when the error carries no usable limit. The limit is only
// ever shown from this value, never from a client-side constant.
export function assetLimitBytesFromError(error: unknown): number | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  if (error.wireCode !== "asset_too_large") {
    return null;
  }
  const limit = error.details["limitBytes"];
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  return limit;
}

export function formatAssetBytes(sizeBytes: number): string {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return "Unknown size";
  }
  if (sizeBytes === 0) {
    return "0 Bytes";
  }
  const units = ["Bytes", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(sizeBytes) / Math.log(1024)));
  const unit = units[index] as string;
  if (index === 0) {
    return `${sizeBytes} ${unit}`;
  }
  const value = sizeBytes / Math.pow(1024, index);
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

// User-facing message for an upload failure. Branches on the
// wire code, never on message text. The size limit appears only
// when the server supplied it in the error details.
export function describeAssetUploadError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.wireCode === "asset_too_large") {
      const limit = assetLimitBytesFromError(error);
      if (limit !== null) {
        return `The file is larger than the server limit (${formatAssetBytes(limit)}). Choose a smaller file.`;
      }
      return "The file is larger than the server limit. Choose a smaller file.";
    }
    if (error.wireCode === "unsupported_media_type") {
      return "This file type is not accepted. The server checks the file contents, not just its name.";
    }
    if (error.wireCode === "unauthenticated") {
      return "Your session has expired. Sign in again; the file was not uploaded.";
    }
    if (error.wireCode === "csrf_invalid") {
      return "The security token was stale. Try the upload again.";
    }
    if (error.wireCode === "validation_failed" && error.wireMessage !== null) {
      return error.wireMessage;
    }
    if (error.localCode === "NETWORK_ERROR" || error.localCode === "TIMEOUT") {
      return "The upload could not reach the server. Check the connection and try again.";
    }
    if (error.wireCode !== null) {
      return `Upload failed (${error.wireCode}). The file was not uploaded.`;
    }
    return "Upload failed. The file was not uploaded.";
  }
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return "Upload failed. The file was not uploaded.";
}

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

// Builds the serve URL for an opaque key: the whole key is
// URL-encoded as one value (kontrak 3.7: full encoding, including
// any slash inside the key). The key is never decoded, trimmed
// into shape, or parsed. Error messages never echo the key.
export function recordAssetServeUrl(assetKey: string): string {
  if (typeof assetKey !== "string" || assetKey === "") {
    throw new TypeError("recordAssetServeUrl: assetKey must be a non-empty string.");
  }
  if (assetKey !== assetKey.trim() || /\s/.test(assetKey) || CONTROL_CHAR_RE.test(assetKey)) {
    throw new TypeError("recordAssetServeUrl: assetKey must not contain whitespace or control characters.");
  }
  return `${RECORD_ASSETS_PATH}/${encodeURIComponent(assetKey)}`;
}

// Resolves the display URL for a record asset. A thumbnailUrl
// received from the server is already a relative endpoint path
// (desain 3.1) and is passed through unchanged; the client never
// constructs a thumbnail key. When thumbnailUrl is null, absent,
// or blank, the full asset serve URL is returned.
export function resolveRecordAssetDisplayUrl(
  assetKey: string,
  thumbnailUrl: string | null | undefined,
): string {
  if (typeof thumbnailUrl === "string") {
    const trimmed = thumbnailUrl.trim();
    if (trimmed !== "" && !CONTROL_CHAR_RE.test(trimmed) && !/\s/.test(trimmed)) {
      return trimmed;
    }
  }
  return recordAssetServeUrl(assetKey);
}

// Whether the validated MIME type may be previewed inline in an
// <img>. SVG is excluded: the server rejects SVG uploads outright,
// so an SVG here is unexpected input and must render as a file
// row, never as inline markup-capable content.
export function isPreviewableAssetImage(mimeType: string): boolean {
  return mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
}

// One known location that references an asset key. Supplied by
// the owning surface, which knows its own model; this module
// never invents locations.
export interface AssetReferenceLocation {
  label: string;
  detail?: string;
}

// An asset as shown in the record-context list. The lane is
// fixed: list items are always record assets, never workspace
// media. referencesChecked records whether the caller actually
// looked for other references; false means "not checked" and the
// UI must say so instead of implying a complete search.
export interface RecordAssetListItem {
  assetKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailUrl?: string | null;
  ownerLabel: string;
  knownReferences?: readonly AssetReferenceLocation[];
  referencesChecked: boolean;
}

// Counts non-overlapping mentions of an asset key inside a text
// the caller owns. Used to report leftover references honestly
// for content the caller can scan; it says nothing about content
// the caller did not supply.
export function countAssetKeyMentions(text: string, assetKey: string): number {
  if (assetKey === "" || text === "") {
    return 0;
  }
  let count = 0;
  let from = 0;
  for (;;) {
    const found = text.indexOf(assetKey, from);
    if (found === -1) {
      return count;
    }
    count += 1;
    from = found + assetKey.length;
  }
}

export function textStillReferencesAsset(
  text: string | null | undefined,
  assetKey: string,
): boolean {
  if (typeof text !== "string" || assetKey === "") {
    return false;
  }
  return text.includes(assetKey);
}

// Plan for removing a reference from the UI. deletesStoredFile
// is always false in MVP: no delete endpoint exists, so the
// stored file stays on the server as an orphan. The confirmation
// dialog renders this plan verbatim in intent: what is removed,
// what stays, and which references are known or unchecked.
export interface AssetReferenceRemovalPlan {
  assetKey: string;
  fileName: string;
  ownerLabel: string;
  knownReferences: readonly AssetReferenceLocation[];
  referencesChecked: boolean;
  deletesStoredFile: false;
}

export function buildAssetReferenceRemovalPlan(
  item: RecordAssetListItem,
): AssetReferenceRemovalPlan {
  return {
    assetKey: item.assetKey,
    fileName: item.fileName,
    ownerLabel: item.ownerLabel,
    knownReferences: item.knownReferences ?? [],
    referencesChecked: item.referencesChecked,
    deletesStoredFile: false,
  };
}

export type AssetReferenceRemovalResult =
  | {
      ok: true;
      removedFrom: string;
      remainingReferences: readonly AssetReferenceLocation[];
    }
  | {
      ok: false;
      errorMessage: string;
      remainingReferences: readonly AssetReferenceLocation[];
      removedFrom: null;
    };

// Executes a reference removal through the callback supplied by
// the owning surface. Never throws: success and failure both
// return explicit results, and a failure keeps the owner in the
// remaining references, because the reference is still there.
// Remaining references after success are the known references
// the caller reported; they still point at the stored file,
// which this flow never deletes.
export async function executeAssetReferenceRemoval(
  plan: AssetReferenceRemovalPlan,
  removeReference: () => Promise<unknown>,
): Promise<AssetReferenceRemovalResult> {
  try {
    await removeReference();
  } catch (error) {
    const message =
      error instanceof Error && error.message !== ""
        ? error.message
        : "The reference could not be removed.";
    return {
      ok: false,
      errorMessage: message,
      remainingReferences: [{ label: plan.ownerLabel }, ...plan.knownReferences],
      removedFrom: null,
    };
  }
  return {
    ok: true,
    removedFrom: plan.ownerLabel,
    remainingReferences: plan.knownReferences,
  };
}
