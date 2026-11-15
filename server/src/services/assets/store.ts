// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Record asset storage (V3-31): a filesystem store behind a port.
//
// Contract: kontrak-api-kanonis.md section 3.7 and desain-record-search.md
// section 4 (V1-14). Assets are bytes on server disk under a server-chosen
// root, addressed only by opaque key. There is NO asset table in the
// canonical schema (server/src/db/schema, M1-M8): no migration is part of
// this task, and this module never touches the database. Workspace
// isolation is enforced by the directory layout plus a metadata sidecar:
// every asset lives under <root>/<workspaceId>/, and the sidecar records
// the owning workspace id. A read checks both, so a key from another
// workspace (or a sidecar that disagrees with its directory) is a miss,
// answered 404 generically by the service layer.
//
// Layout, per workspace directory:
//   <assetKey>.bin   the exact uploaded bytes, never transformed
//   <assetKey>.json  metadata: assetKey, workspaceId, fileName, mimeType,
//                    sizeBytes, contentHash ("sha256:<hex>"), createdAt
//                    (epoch milliseconds, kontrak K-08 for the assets group)
// The root MUST sit outside the workspace file tree: asset files are not
// workspace files and must never appear in workspace list/scan results
// or the file index. The exact root under /data is a deployment decision
// made by the integrator at wiring time (see routes/assets.ts); this
// module only takes the root as an injected path and never derives it
// from the workspace root.
//
// Safety properties:
// - Keys are validated with isValidAssetKey before any filesystem
//   access, and workspace ids must match the UUID shape. Both checks
//   make traversal impossible by construction: no caller-supplied path
//   component ever reaches the filesystem, and keys contain no slash,
//   dot, or separator. Invalid ids on read return null without touching
//   the disk; invalid ids on save throw validation_failed.
// - Saves are put-if-absent: the byte file is created by hard link from
//   a temporary file, so a colliding key is detected atomically and the
//   service can retry with a fresh key. The metadata file is written
//   atomically (temp file plus rename) after the bytes land. A byte file
//   without metadata is invisible to reads; orphaned assets are not
//   deleted automatically in MVP (V1-14 4.1), and orphan cleanup is
//   Fase 2 work that must never delete a referenced asset.
// - Reads verify integrity: the sidecar must agree with the directory
//   and the key, the stored size must match the byte length, and the
//   SHA-256 of the bytes must match the stored hash. Any disagreement
//   is a miss (null), fail-closed, with no detail leaked to the caller.

import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError } from '../../plugins/envelope.js';
import { isValidAssetKey } from './keys.js';

export interface AssetMetadata {
  assetKey: string;
  workspaceId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  createdAt: number;
}

export interface StoredAsset {
  metadata: AssetMetadata;
  bytes: Buffer;
}

export interface AssetSaveInput {
  workspaceId: string;
  assetKey: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  contentHash: string;
  createdAt: number;
}

// The asset store port. The service layer depends only on this
// interface; the filesystem implementation below is the production
// one, and tests use it against temporary directories.
export interface AssetStore {
  save(input: AssetSaveInput): Promise<'saved' | 'exists'>;
  load(workspaceId: string, assetKey: string): Promise<StoredAsset | null>;
  loadMetadata(workspaceId: string, assetKey: string): Promise<AssetMetadata | null>;
}

const WORKSPACE_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isValidWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && WORKSPACE_ID_PATTERN.test(value);
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}

function parseMetadata(raw: string, workspaceId: string, assetKey: string): AssetMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    record['assetKey'] !== assetKey ||
    record['workspaceId'] !== workspaceId ||
    typeof record['fileName'] !== 'string' ||
    record['fileName'] === '' ||
    typeof record['mimeType'] !== 'string' ||
    record['mimeType'] === '' ||
    typeof record['sizeBytes'] !== 'number' ||
    !Number.isInteger(record['sizeBytes']) ||
    (record['sizeBytes'] as number) < 0 ||
    typeof record['contentHash'] !== 'string' ||
    !CONTENT_HASH_PATTERN.test(record['contentHash']) ||
    typeof record['createdAt'] !== 'number' ||
    !Number.isFinite(record['createdAt'])
  ) {
    return null;
  }
  return {
    assetKey,
    workspaceId,
    fileName: record['fileName'],
    mimeType: record['mimeType'],
    sizeBytes: record['sizeBytes'],
    contentHash: record['contentHash'],
    createdAt: record['createdAt'],
  };
}

export class FilesystemAssetStore implements AssetStore {
  readonly #root: string;

  constructor(assetsRoot: string) {
    if (typeof assetsRoot !== 'string' || assetsRoot.trim() === '') {
      throw new Error('Asset store root is required.');
    }
    this.#root = assetsRoot;
  }

  async save(input: AssetSaveInput): Promise<'saved' | 'exists'> {
    if (!isValidWorkspaceId(input.workspaceId)) {
      throw ApiError.validation('Request validation failed.', {
        fields: [{ field: 'workspaceId', issue: 'must be a UUID' }],
      });
    }
    if (!isValidAssetKey(input.assetKey)) {
      throw ApiError.validation('Request validation failed.', {
        fields: [{ field: 'assetKey', issue: 'must be a valid asset key' }],
      });
    }
    const dir = join(this.#root, input.workspaceId);
    await mkdir(dir, { recursive: true });
    const bytesPath = join(dir, `${input.assetKey}.bin`);
    const metaPath = join(dir, `${input.assetKey}.json`);
    const nonce = randomBytes(8).toString('hex');
    const tmpBytesPath = join(dir, `.tmp-${input.assetKey}-${nonce}.bin`);
    await writeFile(tmpBytesPath, input.bytes, { flag: 'wx' });
    try {
      await link(tmpBytesPath, bytesPath);
    } catch (error) {
      await unlink(tmpBytesPath).catch(() => {});
      if (isErrorWithCode(error, 'EEXIST')) {
        return 'exists';
      }
      throw error;
    }
    await unlink(tmpBytesPath).catch(() => {});
    const metadata: AssetMetadata = {
      assetKey: input.assetKey,
      workspaceId: input.workspaceId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      contentHash: input.contentHash,
      createdAt: input.createdAt,
    };
    const tmpMetaPath = join(dir, `.tmp-${input.assetKey}-${nonce}.json`);
    try {
      await writeFile(tmpMetaPath, JSON.stringify(metadata), { flag: 'wx' });
      await rename(tmpMetaPath, metaPath);
    } catch (error) {
      await unlink(tmpMetaPath).catch(() => {});
      // The bytes are invisible without metadata, but remove them so
      // a failed save does not reserve the key forever.
      await unlink(bytesPath).catch(() => {});
      throw error;
    }
    return 'saved';
  }

  async load(workspaceId: string, assetKey: string): Promise<StoredAsset | null> {
    const metadata = await this.loadMetadata(workspaceId, assetKey);
    if (metadata === null) {
      return null;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.#root, workspaceId, `${assetKey}.bin`));
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT') || isErrorWithCode(error, 'ENOTDIR')) {
        return null;
      }
      throw error;
    }
    if (bytes.length !== metadata.sizeBytes) {
      return null;
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (metadata.contentHash !== `sha256:${hash}`) {
      return null;
    }
    return { metadata, bytes };
  }

  async loadMetadata(workspaceId: string, assetKey: string): Promise<AssetMetadata | null> {
    if (!isValidWorkspaceId(workspaceId) || !isValidAssetKey(assetKey)) {
      return null;
    }
    let raw: string;
    try {
      raw = await readFile(join(this.#root, workspaceId, `${assetKey}.json`), 'utf8');
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT') || isErrorWithCode(error, 'ENOTDIR')) {
        return null;
      }
      throw error;
    }
    return parseMetadata(raw, workspaceId, assetKey);
  }
}

export function createFilesystemAssetStore(assetsRoot: string): FilesystemAssetStore {
  return new FilesystemAssetStore(assetsRoot);
}
