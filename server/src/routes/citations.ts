// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Citations routes (F2-1 design 2.1, wave G-F2-1b): the cookie-auth
// HTTP surface over the citations service landed in G-F2-1a.
// References, facts, fact-to-reference mapping, the per-project
// bibliography text, and the citation map.
//
// Auth comes from the frozen global hook (requiresAuth; mutations
// also get Origin and CSRF checks). The workspace never comes from
// the request: it is resolved server-side from the session
// principal, and a null resolution answers the generic 404 (AD-08),
// mirroring the records routes.
//
// Numbering and unmapped rules live in the repository; this module
// owns HTTP only: status codes, the success envelope, and param
// parsing. Bodies are capped at 1 MiB like the records routes.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrincipal, type SessionPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import { formatBibliography } from '../services/citations/bibliography.js';
import type { CitationsRepository } from '../services/citations/repository.js';
import { toApiFact, toApiReference } from '../services/citations/represent.js';
import {
  parseCreateFactBody,
  parseCreateReferenceBody,
} from '../services/citations/validation.js';

export const CITATIONS_REFERENCES_PATH = '/api/citations/references';
export const CITATIONS_REFERENCE_PATH = '/api/citations/references/:referenceId';
export const CITATIONS_PROJECT_REFERENCES_PATH =
  '/api/citations/projects/:projectKey/references';
export const CITATIONS_PROJECT_BIBLIOGRAPHY_PATH =
  '/api/citations/projects/:projectKey/bibliography';
export const CITATIONS_PROJECT_MAP_PATH = '/api/citations/projects/:projectKey/map';
export const CITATIONS_FACTS_PATH = '/api/citations/facts';
export const CITATIONS_FACT_PATH = '/api/citations/facts/:factId';
export const CITATIONS_FACT_MAP_PATH = '/api/citations/facts/:factId/map';
export const CITATIONS_PROJECT_FACTS_PATH = '/api/citations/projects/:projectKey/facts';

export const CITATIONS_BODY_LIMIT_BYTES = 1024 * 1024;

const MAX_PROJECT_KEY_LENGTH = 128;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CitationsWorkspaceResolver = (principal: SessionPrincipal) => Promise<string | null>;

export interface CitationsRouteDeps {
  citations: CitationsRepository;
  resolveWorkspaceId: CitationsWorkspaceResolver;
}

async function workspaceIdOf(
  request: FastifyRequest,
  resolveWorkspaceId: CitationsWorkspaceResolver,
): Promise<string> {
  const principal = getPrincipal(request);
  if (principal === undefined) {
    throw ApiError.unauthenticated();
  }
  const workspaceId = await resolveWorkspaceId(principal);
  if (workspaceId === null) {
    throw ApiError.notFound();
  }
  return workspaceId;
}

function parseUuidParam(raw: unknown): string {
  if (typeof raw === 'string' && UUID_PATTERN.test(raw)) {
    return raw;
  }
  throw ApiError.notFound();
}

function parseProjectKeyParam(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw ApiError.notFound();
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_PROJECT_KEY_LENGTH) {
    throw ApiError.validation('The project key is too long.', { field: 'projectKey' });
  }
  return trimmed;
}

function parseMapBody(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiError.validation('The request body must be an object.');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'referenceId') {
      throw ApiError.validation('The request body contains an unknown field.', { field: key });
    }
  }
  return parseUuidParam(record['referenceId']);
}

export async function registerCitationsRoutes(
  app: FastifyInstance,
  deps: CitationsRouteDeps,
): Promise<void> {
  app.post(
    CITATIONS_REFERENCES_PATH,
    { config: { requiresAuth: true }, bodyLimit: CITATIONS_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const input = parseCreateReferenceBody(request.body);
      const result = await deps.citations.createReference(workspaceId, input);
      if (!result.duplicate) {
        reply.code(201);
      }
      return successEnvelope(toApiReference(result.row, result.duplicate));
    },
  );

  app.get(
    CITATIONS_REFERENCE_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const referenceId = parseUuidParam(
        (request.params as { referenceId?: unknown }).referenceId,
      );
      const row = await deps.citations.getReference(workspaceId, referenceId);
      return successEnvelope(toApiReference(row));
    },
  );

  app.get(
    CITATIONS_PROJECT_REFERENCES_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const projectKey = parseProjectKeyParam(
        (request.params as { projectKey?: unknown }).projectKey,
      );
      const rows = await deps.citations.listReferences(workspaceId, projectKey);
      return successEnvelope({ items: rows.map((row) => toApiReference(row)) });
    },
  );

  app.get(
    CITATIONS_PROJECT_BIBLIOGRAPHY_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const projectKey = parseProjectKeyParam(
        (request.params as { projectKey?: unknown }).projectKey,
      );
      const rows = await deps.citations.listReferences(workspaceId, projectKey);
      return successEnvelope({ projectKey, text: formatBibliography(rows) });
    },
  );

  app.get(
    CITATIONS_PROJECT_MAP_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const projectKey = parseProjectKeyParam(
        (request.params as { projectKey?: unknown }).projectKey,
      );
      const entries = await deps.citations.getCitationMap(workspaceId, projectKey);
      return successEnvelope({ projectKey, entries });
    },
  );

  app.post(
    CITATIONS_FACTS_PATH,
    { config: { requiresAuth: true }, bodyLimit: CITATIONS_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const input = parseCreateFactBody(request.body);
      const row = await deps.citations.createFact(workspaceId, input);
      reply.code(201);
      return successEnvelope(toApiFact(row));
    },
  );

  app.get(
    CITATIONS_FACT_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const factId = parseUuidParam((request.params as { factId?: unknown }).factId);
      const row = await deps.citations.getFact(workspaceId, factId);
      return successEnvelope(toApiFact(row));
    },
  );

  app.get(
    CITATIONS_PROJECT_FACTS_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const projectKey = parseProjectKeyParam(
        (request.params as { projectKey?: unknown }).projectKey,
      );
      const rows = await deps.citations.listFacts(workspaceId, projectKey);
      return successEnvelope({ items: rows.map((row) => toApiFact(row)) });
    },
  );

  app.post(
    CITATIONS_FACT_MAP_PATH,
    { config: { requiresAuth: true }, bodyLimit: CITATIONS_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const factId = parseUuidParam((request.params as { factId?: unknown }).factId);
      const referenceId = parseMapBody(request.body);
      const result = await deps.citations.mapFactToReference(workspaceId, factId, referenceId);
      return successEnvelope({
        fact: toApiFact(result.fact),
        reference: toApiReference(result.reference),
      });
    },
  );
}
