// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Record asset service (V3-31): upload and serve orchestration.
//
// Contract: kontrak-api-kanonis.md section 3.7 and desain-record-search.md
// section 4 (V1-14). The service owns the wire decisions; the store owns
// bytes and metadata; the key module owns key format; the types module
// owns magic-byte typing. No other service is imported.
//
// Upload (V1-14 4.1): one file per request. Checks run in this order:
// size against the configured limit (413 asset_too_large with
// details.limitBytes), empty file (400 validation_failed), type by magic
// bytes (415 unsupported_media_type), then store with a fresh random
// key, retrying on collision. Every upload yields a NEW assetKey; hash
// dedupe is internal only and is not promised by the API (kontrak 3.7),
// so this service never returns an existing key for new bytes. The
// content hash is SHA-256, returned as "sha256:<hex>" and reused as the
// serve ETag. createdAt is epoch milliseconds (kontrak K-08).
//
// Size limit (V1-14 A-5): 20 MiB by default, matching the media upload
// default in kontrak section 6.2, overridable per service instance.
// The limit is a service decision, documented here, and is returned in
// details.limitBytes on every 413. The route parser cap is the limit
// plus multipart framing headroom; the exact limit is enforced here.
//
// Serve (V1-14 4.2): a malformed key, an unknown key, and a key owned by
// another workspace all answer the same generic 404 not_found, with no
// distinction visible to the caller (AD-08). The serve result carries
// the validated MIME type, the disposition derived from it, and the
// ETag from the content hash; header assembly is the route's job.
//
// fileName (V1-14 4.1, selisih S-08): the name comes from the upload,
// never from an upstream column mapping. The optional fileName part
// wins; otherwise the filename of the file part is used. The resolved
// name is a display name only: directory components are stripped, and
// a name that is empty, overlong, or carries control characters is
// rejected. The name never reaches the filesystem and never appears in
// a path; it is echoed in JSON and in the serve Content-Disposition.
//
// Thumbnails (V1-14 4.3, verified before building): a thumbnail is a
// derivative asset served through the same endpoint with a key the
// client receives as thumbnailUrl. No thumbnail generation, size
// variant, or key derivation is built here: the design leaves the
// thumbnail scope to server configuration (A-5) and makes generation
// best-effort async, and no variant decision exists to implement. A
// thumbnail key, when one exists, is an ordinary asset key in this
// same key space, and serving it needs no special case.

import { createHash } from 'node:crypto';
import { ApiError } from '../../plugins/envelope.js';
import { generateAssetKey, isValidAssetKey } from './keys.js';
import type { AssetMetadata, AssetStore, StoredAsset } from './store.js';
import { dispositionForMimeType, validateAssetBytes, type AssetDisposition } from './types.js';

export const DEFAULT_ASSET_LIMIT_BYTES = 20 * 1024 * 1024;
export const MAX_ASSET_KEY_ATTEMPTS = 5;
export const FILE_NAME_MAX_LENGTH = 255;

export interface AssetRepresentation {
  assetKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  createdAt: number;
}

export interface ServedAsset {
  metadata: AssetMetadata;
  bytes: Buffer;
  disposition: AssetDisposition;
  etag: string;
}

export interface AssetServiceDeps {
  store: AssetStore;
  limitBytes?: number;
  clock?: () => number;
  generateKey?: () => string;
}

export function etagForContentHash(contentHash: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
    throw new Error('Invalid content hash.');
  }
  return `"${contentHash.slice('sha256:'.length)}"`;
}

function fileNameError(issue: string): ApiError {
  return ApiError.validation('Request validation failed.', {
    fields: [{ field: 'fileName', issue }],
  });
}

// Resolves the display file name for an upload. The fileName part wins
// when present and non-blank; otherwise the file part filename is used.
// Directory components are stripped from either source. Throws
// validation_failed when no usable name remains.
export function resolveFileName(
  fileNamePart: string | undefined,
  partFilename: string | undefined,
): string {
  const trimmedPart = fileNamePart?.trim();
  const raw = trimmedPart !== undefined && trimmedPart !== '' ? trimmedPart : partFilename;
  if (raw === undefined) {
    throw fileNameError('is required');
  }
  const segments = raw.split(/[/\\]/);
  const base = (segments[segments.length - 1] as string).trim();
  if (base === '' || base === '.' || base === '..') {
    throw fileNameError('must name a file');
  }
  if (base.length > FILE_NAME_MAX_LENGTH) {
    throw fileNameError(`must be at most ${FILE_NAME_MAX_LENGTH} characters`);
  }
  if (/[\x00-\x1F\x7F]/.test(base)) {
    throw fileNameError('must not contain control characters');
  }
  return base;
}

export class AssetService {
  readonly limitBytes: number;
  readonly #store: AssetStore;
  readonly #clock: () => number;
  readonly #generateKey: () => string;

  constructor(deps: AssetServiceDeps) {
    const limitBytes = deps.limitBytes ?? DEFAULT_ASSET_LIMIT_BYTES;
    if (!Number.isInteger(limitBytes) || limitBytes <= 0) {
      throw new Error('Asset size limit must be a positive integer.');
    }
    this.limitBytes = limitBytes;
    this.#store = deps.store;
    this.#clock = deps.clock ?? (() => Date.now());
    this.#generateKey = deps.generateKey ?? generateAssetKey;
  }

  async upload(input: {
    workspaceId: string;
    fileName: string;
    bytes: Buffer;
  }): Promise<AssetRepresentation> {
    if (!Buffer.isBuffer(input.bytes)) {
      throw ApiError.validation('Request validation failed.', {
        fields: [{ field: 'file', issue: 'must be file bytes' }],
      });
    }
    if (input.bytes.length > this.limitBytes) {
      throw ApiError.assetTooLarge(this.limitBytes);
    }
    if (input.bytes.length === 0) {
      throw ApiError.validation('Request validation failed.', {
        fields: [{ field: 'file', issue: 'must not be empty' }],
      });
    }
    // Re-validate the resolved name: the route resolves it, but the
    // service never trusts a name it did not check itself.
    const fileName = resolveFileName(input.fileName, undefined);
    const validated = validateAssetBytes(input.bytes);
    const contentHash = `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`;
    const createdAt = this.#clock();
    for (let attempt = 0; attempt < MAX_ASSET_KEY_ATTEMPTS; attempt += 1) {
      const assetKey = this.#generateKey();
      if (!isValidAssetKey(assetKey)) {
        throw ApiError.internalError();
      }
      const saved = await this.#store.save({
        workspaceId: input.workspaceId,
        assetKey,
        fileName,
        mimeType: validated.mimeType,
        bytes: input.bytes,
        contentHash,
        createdAt,
      });
      if (saved === 'saved') {
        return {
          assetKey,
          fileName,
          mimeType: validated.mimeType,
          sizeBytes: input.bytes.length,
          contentHash,
          createdAt,
        };
      }
    }
    throw ApiError.internalError();
  }

  async serve(workspaceId: string, assetKey: unknown): Promise<ServedAsset> {
    if (!isValidAssetKey(assetKey)) {
      throw ApiError.notFound();
    }
    const loaded: StoredAsset | null = await this.#store.load(workspaceId, assetKey);
    if (loaded === null) {
      throw ApiError.notFound();
    }
    return {
      metadata: loaded.metadata,
      bytes: loaded.bytes,
      disposition: dispositionForMimeType(loaded.metadata.mimeType),
      etag: etagForContentHash(loaded.metadata.contentHash),
    };
  }

  // Metadata lookup for callers that must check key ownership without
  // reading bytes (for example the records layer, which answers 400
  // asset_not_found when a record references an unknown key, V1-14
  // 3.2). A malformed key and an unknown key both return null.
  async findMetadata(workspaceId: string, assetKey: unknown): Promise<AssetMetadata | null> {
    if (!isValidAssetKey(assetKey)) {
      return null;
    }
    return this.#store.loadMetadata(workspaceId, assetKey);
  }

  // Removes one stored asset. A malformed key is not an asset key
  // and deletes nothing (false). The caller owns the
  // reference-count check: this method deletes unconditionally
  // once the key is well-formed.
  async deleteAsset(workspaceId: string, assetKey: unknown): Promise<boolean> {
    if (!isValidAssetKey(assetKey)) {
      return false;
    }
    return this.#store.delete(workspaceId, assetKey);
  }
}
