// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Citations registration adapter (F2-1, wave G-F2-1b, rank 115).
// Wires the citations routes (references, facts, mapping,
// bibliography, citation map) and the structured records routes
// (link record + mark_bibliography companion) over Drizzle
// repositories on one dedicated handle (closed through the close
// registry), with the same workspace identity resolver as the
// records group.
//
// When no DATABASE_URL is configured, both repositories fail closed
// with 503 per request while the routes stay registered (the
// census stays stable across boot variants, mirroring the records
// adapter).

import type { RegistrationContext } from '../registration/context.js';
import { createDb } from '../db/index.js';
import { ApiError } from '../plugins/envelope.js';
import { createDrizzleCitationsRepository } from '../services/citations/drizzle-repository.js';
import type { CitationsRepository } from '../services/citations/repository.js';
import { createDrizzleRecordsRepository } from '../services/records/drizzle-repository.js';
import type { RecordsRepository } from '../services/records/repository.js';
import { createDrizzleWorkspaceIdentityResolver } from '../services/workspace/reconcile-index-pg.js';
import { registerCitationsRoutes, type CitationsWorkspaceResolver } from './citations.js';
import { registerStructuredRecordsRoutes } from './records-structured.js';

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

export const REGISTRATION_ID = 'citations' as const;
export const REGISTRATION_ORDER = 115;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const databaseUrl = ctx.config.databaseUrl;
  let citations: CitationsRepository = UNAVAILABLE_CITATIONS;
  let records: RecordsRepository = UNAVAILABLE_RECORDS;
  let resolveWorkspaceId: CitationsWorkspaceResolver = async () => {
    throw ApiError.serviceUnavailable('The database is not available.');
  };
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
    const handle = createDb(databaseUrl);
    ctx.close.append(async () => {
      await handle.close();
    });
    citations = createDrizzleCitationsRepository(handle.db);
    records = createDrizzleRecordsRepository(handle.db);
    const resolveIdentity = createDrizzleWorkspaceIdentityResolver(handle.db);
    resolveWorkspaceId = async (principal) => {
      const identity = await resolveIdentity(principal);
      return identity?.workspaceId ?? null;
    };
  }
  await registerCitationsRoutes(ctx.app, { citations, resolveWorkspaceId });
  await registerStructuredRecordsRoutes(ctx.app, { records, citations, resolveWorkspaceId });
}
