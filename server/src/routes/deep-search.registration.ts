// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deep Search registration adapter (F2-2, wave G-F2-2a, rank 117).
// Wires the Deep Search job routes over the Drizzle repository on
// one dedicated handle (closed through the close registry), with
// the same workspace identity resolver as the citations group.
//
// The worker stub is started here to pin the wiring point; it does
// nothing in this wave (jobs stay queued). The executor waves
// replace the stub behind the same start/stop shape.
//
// When no DATABASE_URL is configured, the repository fails closed
// with 503 per request while the routes stay registered (the census
// stays stable across boot variants, mirroring the citations
// adapter).

import type { RegistrationContext } from '../registration/context.js';
import { createDb } from '../db/index.js';
import { ApiError } from '../plugins/envelope.js';
import { createDrizzleDeepSearchRepository } from '../services/deep-search/drizzle-repository.js';
import type { DeepSearchRepository } from '../services/deep-search/repository.js';
import { startDeepSearchWorkerStub } from '../services/deep-search/worker.js';
import { createDrizzleWorkspaceIdentityResolver } from '../services/workspace/reconcile-index-pg.js';
import { registerDeepSearchRoutes, type DeepSearchWorkspaceResolver } from './deep-search.js';

function unavailable(): never {
  throw ApiError.serviceUnavailable('The database is not available.');
}

const UNAVAILABLE_DEEP_SEARCH: DeepSearchRepository = {
  async createJob(): Promise<never> {
    return unavailable();
  },
  async getJob(): Promise<never> {
    return unavailable();
  },
  async listJobs(): Promise<never> {
    return unavailable();
  },
  async getJobSteps(): Promise<never> {
    return unavailable();
  },
  async getJobSummary(): Promise<never> {
    return unavailable();
  },
  async cancelJob(): Promise<never> {
    return unavailable();
  },
  async retryJob(): Promise<never> {
    return unavailable();
  },
  async listCandidates(): Promise<never> {
    return unavailable();
  },
  async listFactCandidates(): Promise<never> {
    return unavailable();
  },
};

export const REGISTRATION_ID = 'deep-search' as const;
export const REGISTRATION_ORDER = 117;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const databaseUrl = ctx.config.databaseUrl;
  let deepSearch: DeepSearchRepository = UNAVAILABLE_DEEP_SEARCH;
  let resolveWorkspaceId: DeepSearchWorkspaceResolver = async () => {
    throw ApiError.serviceUnavailable('The database is not available.');
  };
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
    const handle = createDb(databaseUrl);
    ctx.close.append(async () => {
      await handle.close();
    });
    deepSearch = createDrizzleDeepSearchRepository(handle.db);
    const resolveIdentity = createDrizzleWorkspaceIdentityResolver(handle.db);
    resolveWorkspaceId = async (principal) => {
      const identity = await resolveIdentity(principal);
      return identity?.workspaceId ?? null;
    };
  }
  const worker = startDeepSearchWorkerStub();
  ctx.close.append(async () => {
    worker.stop();
  });
  await registerDeepSearchRoutes(ctx.app, { deepSearch, resolveWorkspaceId });
}
