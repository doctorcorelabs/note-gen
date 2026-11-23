// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deep Search registration adapter (F2-2, waves G-F2-2a and
// G-F2-2b, rank 117). Wires the Deep Search job routes over the
// Drizzle repository on one dedicated handle (closed through the
// close registry), with the same workspace identity resolver as
// the citations group.
//
// G-F2-2b starts the real worker here (PubMed collector stage)
// when a database is configured. The E-utilities identity comes
// from server config (design 3.4); without a configured contact
// email the collector fails closed per job, which is recorded on
// the job, not hidden.
//
// When no DATABASE_URL is configured, the repository fails closed
// with 503 per request while the routes stay registered (the census
// stays stable across boot variants, mirroring the citations
// adapter), and no worker runs.

import type { RegistrationContext } from '../registration/context.js';
import { createDb } from '../db/index.js';
import { ApiError } from '../plugins/envelope.js';
import { createPubmedCollector } from '../services/deep-search/collector-pubmed.js';
import { createDrizzleDeepSearchRepository } from '../services/deep-search/drizzle-repository.js';
import type { DeepSearchRepository } from '../services/deep-search/repository.js';
import { startDeepSearchWorker } from '../services/deep-search/worker.js';
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
  async claimNextCollectorJob(): Promise<never> {
    return unavailable();
  },
  async markStaleJobsFailed(): Promise<never> {
    return unavailable();
  },
  async completeStep(): Promise<never> {
    return unavailable();
  },
  async failStep(): Promise<never> {
    return unavailable();
  },
  async insertCandidates(): Promise<never> {
    return unavailable();
  },
  async insertEvidence(): Promise<never> {
    return unavailable();
  },
  async countCandidates(): Promise<never> {
    return unavailable();
  },
  async releaseJobToQueued(): Promise<never> {
    return unavailable();
  },
  async failJob(): Promise<never> {
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
    deepSearch = createDrizzleDeepSearchRepository(handle.db);
    const resolveIdentity = createDrizzleWorkspaceIdentityResolver(handle.db);
    resolveWorkspaceId = async (principal) => {
      const identity = await resolveIdentity(principal);
      return identity?.workspaceId ?? null;
    };
    const collector = createPubmedCollector({
      tool: ctx.config.ncbiEutilsTool ?? 'notegen',
      email: ctx.config.ncbiEutilsEmail,
    });
    // The worker runs on its own bounded handle: a short connect
    // timeout makes an unreachable database fail fast inside the
    // worker loop, and a bounded close timeout keeps app shutdown
    // from waiting on a stuck background query. The worker stop
    // step is appended before the request-path handle close so the
    // worker is stopped first (close steps run in append order).
    const workerHandle = createDb(databaseUrl, {
      max: 2,
      connectTimeoutSeconds: 5,
      closeTimeoutSeconds: 2,
    });
    const worker = startDeepSearchWorker({
      repository: createDrizzleDeepSearchRepository(workerHandle.db),
      collector,
    });
    ctx.close.append(async () => {
      worker.stop();
      await workerHandle.close();
    });
    ctx.close.append(async () => {
      await handle.close();
    });
  }
  await registerDeepSearchRoutes(ctx.app, { deepSearch, resolveWorkspaceId });
}
