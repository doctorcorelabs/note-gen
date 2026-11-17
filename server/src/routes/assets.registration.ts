// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Record assets registration adapter (AD-61; desain registrasi
// programatik section 3.3, rank 130). Wires the V3-31 asset
// registrar that had no production caller before W4-WIRE
// (HARNESS-5).
//
// Routes declared by this group (kontrak 3.7):
// - POST /api/assets (routes/assets.ts)
// - GET /api/assets/:assetKey (routes/assets.ts)
//
// Deps: a FilesystemAssetStore rooted at config.assetRoot
// (ASSET_ROOT), which MUST sit outside the workspace tree under
// /data; the root is never derived from the workspace root. When
// ASSET_ROOT is unset, an unavailable store fails every asset
// operation closed with 503, while the routes stay registered
// (so wrong-method probes still answer 405 and the census stays
// stable across boot variants). The workspace resolver is the
// Drizzle identity resolver over a dedicated handle, applying
// the same membership rule as services/db/workspace.ts; when no
// DATABASE_URL is configured, resolution throws 503 instead of
// returning null, because "cannot verify membership" is not
// "no workspace" (the same fail-closed rule the session
// verifier applies). A null resolution with a live database
// still answers the generic 404 (AD-08) inside the route.

import type { RegistrationContext } from '../registration/context.js';
import { createDb } from '../db/index.js';
import { ApiError } from '../plugins/envelope.js';
import { registerAssetRoutes, type AssetWorkspaceResolver } from './assets.js';
import { AssetService } from '../services/assets/service.js';
import { FilesystemAssetStore, type AssetStore } from '../services/assets/store.js';
import { createDrizzleWorkspaceIdentityResolver } from '../services/workspace/reconcile-index-pg.js';

// Fail-closed store for boots without ASSET_ROOT. Every
// operation throws 503; validation that runs before the store
// (size, empty file, magic bytes) still answers with its own
// code, which is honest: the upload was invalid regardless of
// the missing root.
class UnavailableAssetStore implements AssetStore {
  async save(): Promise<'saved' | 'exists'> {
    throw ApiError.serviceUnavailable('The asset store is not configured.');
  }

  async load(): Promise<null> {
    throw ApiError.serviceUnavailable('The asset store is not configured.');
  }

  async loadMetadata(): Promise<null> {
    throw ApiError.serviceUnavailable('The asset store is not configured.');
  }
}

export const REGISTRATION_ID = 'assets' as const;
export const REGISTRATION_ORDER = 130;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const databaseUrl = ctx.config.databaseUrl;
  let resolveWorkspaceId: AssetWorkspaceResolver;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
    const handle = createDb(databaseUrl);
    ctx.close.append(async () => {
      await handle.close();
    });
    const resolveIdentity = createDrizzleWorkspaceIdentityResolver(handle.db);
    resolveWorkspaceId = async (principal) => {
      const identity = await resolveIdentity(principal);
      return identity?.workspaceId ?? null;
    };
  } else {
    resolveWorkspaceId = async () => {
      throw ApiError.serviceUnavailable('The database is not available.');
    };
  }
  const assetRoot = ctx.config.assetRoot;
  const store: AssetStore =
    assetRoot !== undefined ? new FilesystemAssetStore(assetRoot) : new UnavailableAssetStore();
  const service = new AssetService({ store });
  await registerAssetRoutes(ctx.app, { service, resolveWorkspaceId });
}
