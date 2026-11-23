// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Agent Deep Search routes (F2-2 design 3.3, wave G-F2-2f). The
// Bearer-only agent surface over the same Deep Search job
// repository as the cookie routes in deep-search.ts:
//
// - GET list/detail/candidates/facts under search.read (the agent
//   only reads job results without the write scope);
// - POST create under the separate non-hierarchical scope
//   deepsearch.write (F2-2 decision 4, AD-1088). The scope implies
//   no read scope, and no read scope implies it.
//
// Deliberately absent on this surface: cancel, retry, and
// approve-writing stay on the cookie path. Approve-writing is the
// explicit human approval of decision 8 and is never an agent
// action; cancel/retry were not part of the designed agent
// surface. There is no DELETE anywhere (decision 9).
//
// Workspace resolution mirrors agent-data.ts: the target
// workspace (query workspaceId when given, else the token's single
// workspace, else the owner's default workspace) must be listed
// in the token's workspace_ids AND owned by the token owner, or
// the answer is the generic 404. Jobs created here carry
// createdByTokenId and a null createdByUserId; the create body
// goes through the same fail-closed validation as the cookie
// route, so writingApproved in the body is rejected there too.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isUuid } from '../auth/crypto.js';
import type { AuthStore } from '../auth/store.js';
import { unavailableOnDbError } from '../auth/service.js';
import { getAgentPrincipal, type AgentPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import type { DeepSearchRepository } from '../services/deep-search/repository.js';
import {
  JOB_STATUSES,
  toApiCandidate,
  toApiFactCandidate,
  toApiJob,
  toApiJobStep,
  type JobStatus,
} from '../services/deep-search/represent.js';
import { parseCreateJobBody } from '../services/deep-search/validation.js';

export const AGENT_DEEP_SEARCH_JOBS_PATH = '/api/agent/deep-search/jobs';
export const AGENT_DEEP_SEARCH_JOB_PATH = '/api/agent/deep-search/jobs/:jobId';
export const AGENT_DEEP_SEARCH_JOB_CANDIDATES_PATH =
  '/api/agent/deep-search/jobs/:jobId/candidates';
export const AGENT_DEEP_SEARCH_JOB_FACTS_PATH = '/api/agent/deep-search/jobs/:jobId/facts';

export const AGENT_DEEP_SEARCH_BODY_LIMIT_BYTES = 1024 * 1024;

const MAX_PROJECT_KEY_LENGTH = 128;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

export interface AgentDeepSearchRouteDeps {
  deepSearch: DeepSearchRepository;
  // Ownership checks for workspace resolution. Null fails closed
  // with 503, like the agent data routes.
  store: AuthStore | null;
}

function agentPrincipal(request: FastifyRequest): AgentPrincipal {
  const principal = getAgentPrincipal(request);
  if (principal === undefined) {
    throw ApiError.unauthenticated();
  }
  return principal;
}

function queryRecord(request: FastifyRequest): Record<string, unknown> {
  const query = request.query as unknown;
  if (typeof query === 'object' && query !== null && !Array.isArray(query)) {
    return query as Record<string, unknown>;
  }
  return {};
}

async function resolveAgentWorkspaceId(
  request: FastifyRequest,
  principal: AgentPrincipal,
  store: AuthStore | null,
): Promise<string> {
  if (store === null) {
    throw ApiError.serviceUnavailable('The database is not available.');
  }
  const requested = queryRecord(request)['workspaceId'];
  let candidate: string | undefined;
  if (requested !== undefined) {
    if (typeof requested !== 'string' || !isUuid(requested)) {
      throw ApiError.notFound();
    }
    candidate = requested;
  } else if (principal.workspaceIds.length === 1) {
    candidate = principal.workspaceIds[0];
  } else {
    const fallback = await unavailableOnDbError(() =>
      store.findFirstWorkspaceByOwner(principal.userId),
    );
    candidate = fallback?.id;
  }
  if (candidate === undefined || !principal.workspaceIds.includes(candidate)) {
    throw ApiError.notFound();
  }
  const workspace = await unavailableOnDbError(() => store.findWorkspaceById(candidate));
  if (workspace === null || workspace.ownerUserId !== principal.userId) {
    throw ApiError.notFound();
  }
  return candidate;
}

function parseUuidParam(raw: unknown): string {
  if (typeof raw !== 'string' || !isUuid(raw)) {
    throw ApiError.notFound();
  }
  return raw;
}

function parseListQuery(query: unknown): {
  projectKey?: string;
  status?: JobStatus;
  limit: number;
  cursor?: string;
} {
  const record = (typeof query === 'object' && query !== null ? query : {}) as Record<
    string,
    unknown
  >;
  let projectKey: string | undefined;
  const rawProjectKey = record['projectKey'];
  if (rawProjectKey !== undefined && rawProjectKey !== null && rawProjectKey !== '') {
    if (typeof rawProjectKey !== 'string' || rawProjectKey.trim().length > MAX_PROJECT_KEY_LENGTH) {
      throw ApiError.validation('The project key is not valid.', { field: 'projectKey' });
    }
    projectKey = rawProjectKey.trim();
  }
  let status: JobStatus | undefined;
  const rawStatus = record['status'];
  if (rawStatus !== undefined && rawStatus !== null && rawStatus !== '') {
    if (typeof rawStatus !== 'string' || !(JOB_STATUSES as readonly string[]).includes(rawStatus)) {
      throw ApiError.validation('The status is not valid.', { field: 'status' });
    }
    status = rawStatus as JobStatus;
  }
  let limit = DEFAULT_LIST_LIMIT;
  const rawLimit = record['limit'];
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
    const parsed = typeof rawLimit === 'string' ? Number(rawLimit) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
      throw ApiError.validation('The limit must be an integer from 1 to 100.', {
        field: 'limit',
      });
    }
    limit = parsed;
  }
  let cursor: string | undefined;
  const rawCursor = record['cursor'];
  if (rawCursor !== undefined && rawCursor !== null && rawCursor !== '') {
    if (typeof rawCursor !== 'string') {
      throw ApiError.validation('The cursor is not valid.', { field: 'cursor' });
    }
    cursor = rawCursor;
  }
  return { projectKey, status, limit, cursor };
}

export async function registerAgentDeepSearchRoutes(
  app: FastifyInstance,
  deps: AgentDeepSearchRouteDeps,
): Promise<void> {
  app.post(
    AGENT_DEEP_SEARCH_JOBS_PATH,
    {
      config: { authMode: 'agent', agentScope: 'deepsearch.write' },
      bodyLimit: AGENT_DEEP_SEARCH_BODY_LIMIT_BYTES,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const input = parseCreateJobBody(request.body);
      const row = await deps.deepSearch.createJob(workspaceId, null, input, principal.tokenId);
      reply.code(202);
      return successEnvelope(toApiJob(row));
    },
  );

  app.get(
    AGENT_DEEP_SEARCH_JOBS_PATH,
    { config: { authMode: 'agent', agentScope: 'search.read' } },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const filter = parseListQuery(request.query);
      const result = await deps.deepSearch.listJobs(workspaceId, filter);
      return successEnvelope({
        items: result.items.map((row) => toApiJob(row)),
        nextCursor: result.nextCursor,
      });
    },
  );

  app.get(
    AGENT_DEEP_SEARCH_JOB_PATH,
    { config: { authMode: 'agent', agentScope: 'search.read' } },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const jobId = parseUuidParam((request.params as { jobId?: unknown }).jobId);
      const job = await deps.deepSearch.getJob(workspaceId, jobId);
      const steps = await deps.deepSearch.getJobSteps(workspaceId, jobId);
      const summary = await deps.deepSearch.getJobSummary(workspaceId, jobId);
      return successEnvelope({
        job: toApiJob(job),
        steps: steps.map((row) => toApiJobStep(row)),
        summary,
      });
    },
  );

  app.get(
    AGENT_DEEP_SEARCH_JOB_CANDIDATES_PATH,
    { config: { authMode: 'agent', agentScope: 'search.read' } },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const jobId = parseUuidParam((request.params as { jobId?: unknown }).jobId);
      const rows = await deps.deepSearch.listCandidates(workspaceId, jobId);
      return successEnvelope({ items: rows.map((row) => toApiCandidate(row)) });
    },
  );

  app.get(
    AGENT_DEEP_SEARCH_JOB_FACTS_PATH,
    { config: { authMode: 'agent', agentScope: 'search.read' } },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const jobId = parseUuidParam((request.params as { jobId?: unknown }).jobId);
      const rows = await deps.deepSearch.listFactCandidates(workspaceId, jobId);
      return successEnvelope({ items: rows.map((row) => toApiFactCandidate(row)) });
    },
  );
}
