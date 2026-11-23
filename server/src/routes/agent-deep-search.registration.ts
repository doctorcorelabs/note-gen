// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Agent Deep Search registration adapter (F2-2, wave G-F2-2f,
// rank 118). Wires the Bearer-only agent Deep Search routes over
// the Drizzle repository on one dedicated handle (closed through
// the close registry). The worker itself stays with the
// deep-search group (rank 117); this group only serves the agent
// HTTP surface and never starts a second worker.
//
// When no DATABASE_URL is configured, the repository fails closed
// with 503 per request while the routes stay registered (the
// census stays stable across boot variants, mirroring the
// deep-search adapter).

import type { RegistrationContext } from '../registration/context.js';
import { createDb } from '../db/index.js';
import { ApiError } from '../plugins/envelope.js';
import { createDrizzleDeepSearchRepository } from '../services/deep-search/drizzle-repository.js';
import type { DeepSearchRepository } from '../services/deep-search/repository.js';
import { registerAgentDeepSearchRoutes } from './agent-deep-search.js';

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
  async claimNextExaJob(): Promise<never> {
    return unavailable();
  },
  async skipStep(): Promise<never> {
    return unavailable();
  },
  async addJobCost(): Promise<never> {
    return unavailable();
  },
  async claimNextAssessorJob(): Promise<never> {
    return unavailable();
  },
  async claimNextComplementJob(): Promise<never> {
    return unavailable();
  },
  async insertFactCandidates(): Promise<never> {
    return unavailable();
  },
  async updateFactCandidateScores(): Promise<never> {
    return unavailable();
  },
  async approveWriting(): Promise<never> {
    return unavailable();
  },
  async claimNextWriterJob(): Promise<never> {
    return unavailable();
  },
  async completeJob(): Promise<never> {
    return unavailable();
  },
  async setCandidateWritten(): Promise<never> {
    return unavailable();
  },
  async setFactWritten(): Promise<never> {
    return unavailable();
  },
  async listJobEvidence(): Promise<never> {
    return unavailable();
  },
};

export const REGISTRATION_ID = 'agent-deep-search' as const;
export const REGISTRATION_ORDER = 118;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const databaseUrl = ctx.config.databaseUrl;
  let deepSearch: DeepSearchRepository = UNAVAILABLE_DEEP_SEARCH;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
    const handle = createDb(databaseUrl);
    ctx.close.append(async () => {
      await handle.close();
    });
    deepSearch = createDrizzleDeepSearchRepository(handle.db);
  }
  await registerAgentDeepSearchRoutes(ctx.app, {
    deepSearch,
    store: ctx.auth?.store ?? null,
  });
}
