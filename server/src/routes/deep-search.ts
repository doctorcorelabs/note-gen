// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deep Search routes (F2-2 design 3.3, wave G-F2-2a): the
// cookie-auth HTTP surface over the Deep Search job service.
// Create, list, detail, candidates, facts, cancel, retry. No
// DELETE: a job is the search audit trail (decision 9). No
// executor in this wave: created jobs stay queued.
//
// Auth comes from the frozen global hook (requiresAuth; mutations
// also get Origin and CSRF checks). The workspace never comes from
// the request: it is resolved server-side from the session
// principal, and a null resolution answers the generic 404 (AD-08),
// mirroring the citations routes.
//
// Status-machine rules live in the repository; this module owns
// HTTP only: status codes, the success envelope, and param/query
// parsing. Bodies are capped at 1 MiB like the citations routes.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrincipal, type SessionPrincipal } from '../middleware/auth-hook.js';
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

export const DEEP_SEARCH_JOBS_PATH = '/api/deep-search/jobs';
export const DEEP_SEARCH_JOB_PATH = '/api/deep-search/jobs/:jobId';
export const DEEP_SEARCH_JOB_CANDIDATES_PATH = '/api/deep-search/jobs/:jobId/candidates';
export const DEEP_SEARCH_JOB_FACTS_PATH = '/api/deep-search/jobs/:jobId/facts';
export const DEEP_SEARCH_JOB_CANCEL_PATH = '/api/deep-search/jobs/:jobId/cancel';
export const DEEP_SEARCH_JOB_RETRY_PATH = '/api/deep-search/jobs/:jobId/retry';

export const DEEP_SEARCH_BODY_LIMIT_BYTES = 1024 * 1024;

const MAX_PROJECT_KEY_LENGTH = 128;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeepSearchWorkspaceResolver = (principal: SessionPrincipal) => Promise<string | null>;

export interface DeepSearchRouteDeps {
  deepSearch: DeepSearchRepository;
  resolveWorkspaceId: DeepSearchWorkspaceResolver;
}

async function principalAndWorkspace(
  request: FastifyRequest,
  resolveWorkspaceId: DeepSearchWorkspaceResolver,
): Promise<{ principal: SessionPrincipal; workspaceId: string }> {
  const principal = getPrincipal(request);
  if (principal === undefined) {
    throw ApiError.unauthenticated();
  }
  const workspaceId = await resolveWorkspaceId(principal);
  if (workspaceId === null) {
    throw ApiError.notFound();
  }
  return { principal, workspaceId };
}

function parseUuidParam(raw: unknown): string {
  if (typeof raw === 'string' && UUID_PATTERN.test(raw)) {
    return raw;
  }
  throw ApiError.notFound();
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

export async function registerDeepSearchRoutes(
  app: FastifyInstance,
  deps: DeepSearchRouteDeps,
): Promise<void> {
  app.post(
    DEEP_SEARCH_JOBS_PATH,
    { config: { requiresAuth: true }, bodyLimit: DEEP_SEARCH_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { principal, workspaceId } = await principalAndWorkspace(
        request,
        deps.resolveWorkspaceId,
      );
      const input = parseCreateJobBody(request.body);
      const createdByUserId = UUID_PATTERN.test(principal.userId) ? principal.userId : null;
      const row = await deps.deepSearch.createJob(workspaceId, createdByUserId, input);
      reply.code(202);
      return successEnvelope(toApiJob(row));
    },
  );

  app.get(
    DEEP_SEARCH_JOBS_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const { workspaceId } = await principalAndWorkspace(request, deps.resolveWorkspaceId);
      const filter = parseListQuery(request.query);
      const result = await deps.deepSearch.listJobs(workspaceId, filter);
      return successEnvelope({
        items: result.items.map((row) => toApiJob(row)),
        nextCursor: result.nextCursor,
      });
    },
  );

  app.get(
    DEEP_SEARCH_JOB_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const { workspaceId } = await principalAndWorkspace(request, deps.resolveWorkspaceId);
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
    DEEP_SEARCH_JOB_CANDIDATES_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const { workspaceId } = await principalAndWorkspace(request, deps.resolveWorkspaceId);
      const jobId = parseUuidParam((request.params as { jobId?: unknown }).jobId);
      const rows = await deps.deepSearch.listCandidates(workspaceId, jobId);
      return successEnvelope({ items: rows.map((row) => toApiCandidate(row)) });
    },
  );

  app.get(
    DEEP_SEARCH_JOB_FACTS_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const { workspaceId } = await principalAndWorkspace(request, deps.resolveWorkspaceId);
      const jobId = parseUuidParam((request.params as { jobId?: unknown }).jobId);
      const rows = await deps.deepSearch.listFactCandidates(workspaceId, jobId);
      return successEnvelope({ items: rows.map((row) => toApiFactCandidate(row)) });
    },
  );

  app.post(
    DEEP_SEARCH_JOB_CANCEL_PATH,
    { config: { requiresAuth: true }, bodyLimit: DEEP_SEARCH_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const { workspaceId } = await principalAndWorkspace(request, deps.resolveWorkspaceId);
      const jobId = parseUuidParam((request.params as { jobId?: unknown }).jobId);
      const row = await deps.deepSearch.cancelJob(workspaceId, jobId);
      return successEnvelope(toApiJob(row));
    },
  );

  app.post(
    DEEP_SEARCH_JOB_RETRY_PATH,
    { config: { requiresAuth: true }, bodyLimit: DEEP_SEARCH_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const { workspaceId } = await principalAndWorkspace(request, deps.resolveWorkspaceId);
      const jobId = parseUuidParam((request.params as { jobId?: unknown }).jobId);
      const row = await deps.deepSearch.retryJob(workspaceId, jobId);
      return successEnvelope(toApiJob(row));
    },
  );
}
