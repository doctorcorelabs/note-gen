// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Records registration adapter (AD-61; desain registrasi
// programatik section 3.3, rank 110). Wires the REST marks/tags
// routes (W4-WIRE, S5-Q2: REST is the intended transport, the
// contract stays fixed at 86 routes per AD-114).
//
// Routes declared by this group (kontrak 3.5/3.6):
// - POST/GET /api/marks, GET/PATCH/DELETE /api/marks/:markId,
//   PUT /api/marks/:markId/tags, POST
//   /api/marks/:markId/restore, DELETE
//   /api/marks/:markId/permanent, DELETE /api/marks/trash
//   (routes/records-marks.ts)
// - GET/POST /api/tags, GET/PATCH/DELETE /api/tags/:tagId
//   (routes/records-tags.ts)
//
// Deps: a Drizzle records repository over a dedicated handle
// (closed through the close registry), the Drizzle identity
// resolver applying the same membership rule as
// services/db/workspace.ts, and an asset port over a
// FilesystemAssetStore rooted at config.assetRoot. When no
// DATABASE_URL is configured, the repository and the resolver
// fail closed with 503 per request while the routes stay
// registered (wrong-method probes still answer 405 and the
// census stays stable across boot variants). When ASSET_ROOT
// is unset, the asset port reports no key as existing (an
// unconfigured store holds no keys, so asset-type creates
// answer 400 asset_not_found) and the post-commit sweep is a
// no-op.

import type { RegistrationContext } from '../registration/context.js';
import { createDb } from '../db/index.js';
import { ApiError } from '../plugins/envelope.js';
import { AssetService } from '../services/assets/service.js';
import { FilesystemAssetStore } from '../services/assets/store.js';
import { createDrizzleRecordsRepository } from '../services/records/drizzle-repository.js';
import type { RecordsRepository } from '../services/records/repository.js';
import { createDrizzleWorkspaceIdentityResolver } from '../services/workspace/reconcile-index-pg.js';
import { registerMarksRoutes, type RecordsAssetPort, type RecordsWorkspaceResolver } from './records-marks.js';
import { registerTagsRoutes } from './records-tags.js';

function unavailable(): never {
  throw ApiError.serviceUnavailable('The database is not available.');
}

const UNAVAILABLE_REPOSITORY: RecordsRepository = {
  async createMark(): Promise<never> {
    return unavailable();
  },
  async getMark(): Promise<never> {
    return unavailable();
  },
  async listMarks(): Promise<never> {
    return unavailable();
  },
  async patchMark(): Promise<never> {
    return unavailable();
  },
  async putMarkTags(): Promise<never> {
    return unavailable();
  },
  async softDeleteMark(): Promise<never> {
    return unavailable();
  },
  async restoreMark(): Promise<never> {
    return unavailable();
  },
  async permanentDeleteMark(): Promise<never> {
    return unavailable();
  },
  async emptyTrash(): Promise<never> {
    return unavailable();
  },
  async listTags(): Promise<never> {
    return unavailable();
  },
  async createTag(): Promise<never> {
    return unavailable();
  },
  async patchTag(): Promise<never> {
    return unavailable();
  },
  async deleteTag(): Promise<never> {
    return unavailable();
  },
  async hasUrlReference(): Promise<never> {
    return unavailable();
  },
};

export const REGISTRATION_ID = 'records' as const;
export const REGISTRATION_ORDER = 110;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const databaseUrl = ctx.config.databaseUrl;
  let repository: RecordsRepository = UNAVAILABLE_REPOSITORY;
  let resolveWorkspaceId: RecordsWorkspaceResolver = async () => {
    throw ApiError.serviceUnavailable('The database is not available.');
  };
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
    const handle = createDb(databaseUrl);
    ctx.close.append(async () => {
      await handle.close();
    });
    repository = createDrizzleRecordsRepository(handle.db);
    const resolveIdentity = createDrizzleWorkspaceIdentityResolver(handle.db);
    resolveWorkspaceId = async (principal) => {
      const identity = await resolveIdentity(principal);
      return identity?.workspaceId ?? null;
    };
  }
  const assetRoot = ctx.config.assetRoot;
  let assets: RecordsAssetPort;
  if (assetRoot !== undefined) {
    const service = new AssetService({ store: new FilesystemAssetStore(assetRoot) });
    assets = {
      exists: async (workspaceId, assetKey) =>
        (await service.findMetadata(workspaceId, assetKey)) !== null,
      remove: async (workspaceId, assetKey) => service.deleteAsset(workspaceId, assetKey),
    };
  } else {
    assets = {
      exists: async () => false,
      remove: async () => false,
    };
  }
  const deps = { repository, resolveWorkspaceId, assets };
  await registerMarksRoutes(ctx.app, deps);
  await registerTagsRoutes(ctx.app, deps);
}
