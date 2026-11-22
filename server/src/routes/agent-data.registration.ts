// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Agent data registration adapter (F2-1 wave G-F2-1d, rank 116).
// Wires the Bearer-only agent data routes over the same Drizzle
// repositories, search port, workspace reader/writer, and asset
// service as the browser groups, on one dedicated handle closed
// through the close registry. Workspace ownership checks use the
// injected auth store; without it they fail closed with 503.
//
// When no DATABASE_URL is configured, the repositories fail
// closed with 503 per request while the routes stay registered
// (the census stays stable across boot variants, mirroring the
// citations adapter). When ASSET_ROOT is unset, asset operations
// fail closed with 503 the same way.

import type { RegistrationContext } from '../registration/context.js';
import { createDb } from '../db/index.js';
import { ApiError } from '../plugins/envelope.js';
import { AssetService } from '../services/assets/service.js';
import { FilesystemAssetStore, type AssetStore } from '../services/assets/store.js';
import { createDrizzleCitationsRepository } from '../services/citations/drizzle-repository.js';
import type { CitationsRepository } from '../services/citations/repository.js';
import { createDrizzleRecordsRepository } from '../services/records/drizzle-repository.js';
import type { RecordsRepository } from '../services/records/repository.js';
import { createDirectKeywordSearchPort } from '../services/search/direct.js';
import type { KeywordSearchPort } from '../services/search/port.js';
import { createWorkspaceReader } from '../services/workspace/read.js';
import { createDrizzleWorkspaceIdentityResolver } from '../services/workspace/reconcile-index-pg.js';
import { createV304aWritePorts } from '../services/workspace/write-adapter.js';
import { WorkspaceWriteService } from '../services/workspace/write-file.js';
import { registerAgentDataRoutes } from './agent-data.js';

function unavailable(): never {
  throw ApiError.serviceUnavailable('The database is not available.');
}

const UNAVAILABLE_CITATIONS: CitationsRepository = {
  async createReference(): Promise<never> {
    return unavailable();
  },
  async getReference(): Promise<never> {
    return unavailable();
  },
  async listReferences(): Promise<never> {
    return unavailable();
  },
  async createFact(): Promise<never> {
    return unavailable();
  },
  async getFact(): Promise<never> {
    return unavailable();
  },
  async listFacts(): Promise<never> {
    return unavailable();
  },
  async mapFactToReference(): Promise<never> {
    return unavailable();
  },
  async getCitationMap(): Promise<never> {
    return unavailable();
  },
  async upsertMarkBibliography(): Promise<never> {
    return unavailable();
  },
  async getMarkBibliography(): Promise<never> {
    return unavailable();
  },
  async findMarkBibliographyByIdentifier(): Promise<never> {
    return unavailable();
  },
};

const UNAVAILABLE_RECORDS: RecordsRepository = {
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

  async delete(): Promise<boolean> {
    throw ApiError.serviceUnavailable('The asset store is not configured.');
  }
}

export const REGISTRATION_ID = 'agent-data' as const;
export const REGISTRATION_ORDER = 116;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const databaseUrl = ctx.config.databaseUrl;
  let citations: CitationsRepository = UNAVAILABLE_CITATIONS;
  let records: RecordsRepository = UNAVAILABLE_RECORDS;
  let search: KeywordSearchPort = createDirectKeywordSearchPort({
    workspaceRoot: ctx.config.workspaceRoot,
    resolveWorkspaceId: async () => {
      throw ApiError.serviceUnavailable('The database is not available.');
    },
  });
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
    const handle = createDb(databaseUrl);
    ctx.close.append(async () => {
      await handle.close();
    });
    citations = createDrizzleCitationsRepository(handle.db);
    records = createDrizzleRecordsRepository(handle.db);
    const resolveIdentity = createDrizzleWorkspaceIdentityResolver(handle.db);
    search = createDirectKeywordSearchPort({
      db: handle.db,
      workspaceRoot: ctx.config.workspaceRoot,
      resolveWorkspaceId: async (principal) => {
        const identity = await resolveIdentity(principal);
        return identity?.workspaceId ?? null;
      },
    });
  }
  const reader = createWorkspaceReader({ workspaceRoot: ctx.config.workspaceRoot });
  const writeService = new WorkspaceWriteService({
    ports: createV304aWritePorts(ctx.config.workspaceRoot),
  });
  const assetRoot = ctx.config.assetRoot;
  const assetStore: AssetStore =
    assetRoot !== undefined ? new FilesystemAssetStore(assetRoot) : new UnavailableAssetStore();
  const assets = new AssetService({ store: assetStore });
  await registerAgentDataRoutes(ctx.app, {
    records,
    citations,
    search,
    reader,
    writeService,
    assets,
    store: ctx.auth?.store ?? null,
  });
}
