// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Agent data routes (F2-1 wave G-F2-1d, desain-auth.md section
// 11.4 and F2-1 design section 2.3). Every route here is
// Bearer-only (config authMode 'agent' with a declared
// agentScope); the session cookie is ignored on these routes and
// the Bearer token is ignored on browser routes, so one endpoint
// has exactly one auth mode. Handlers forward to the same
// services and repositories as the browser routes: records,
// citations, search, the workspace reader/writer, and assets.
//
// Workspace resolution is agent-specific: the target workspace
// (query workspaceId when given, else the token's single
// workspace, else the owner's default workspace) must be listed
// in the token's workspace_ids AND owned by the token owner, or
// the answer is the generic 404 (scope cut by ownership).
//
// Delete operations are deliberately absent from this surface:
// no DELETE file/folder, no record delete, no trash purge, no
// asset delete (F2-1 decision, desain-auth section 11.3 has no
// delete scope). Unmatched agent paths answer the generic 404.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isUuid } from '../auth/crypto.js';
import type { AuthStore } from '../auth/store.js';
import { unavailableOnDbError } from '../auth/service.js';
import { getAgentPrincipal, type AgentPrincipal, type SessionPrincipal } from '../middleware/auth-hook.js';
import { isPathWithinPrefixes, requireAgentScope } from '../middleware/agent-token.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import { AssetService, resolveFileName } from '../services/assets/service.js';
import { formatBibliography } from '../services/citations/bibliography.js';
import type { CitationsRepository } from '../services/citations/repository.js';
import { toApiBibliography, toApiFact, toApiReference } from '../services/citations/represent.js';
import {
  parseCreateFactBody,
  parseCreateReferenceBody,
  parseUpsertBibliographyBody,
} from '../services/citations/validation.js';
import type { RecordsRepository } from '../services/records/repository.js';
import { toApiRecord } from '../services/records/represent.js';
import {
  conflictingBibliographyFields,
  mergeBibliography,
  parseStructuredCreateBody,
} from '../services/records/structured.js';
import {
  parseCreateBody,
  parseListQuery,
  parseMarkIdParam,
  parsePatchBody,
  parsePutTagsBody,
} from '../services/records/validation.js';
import type { KeywordSearchPort } from '../services/search/port.js';
import type { createWorkspaceReader } from '../services/workspace/read.js';
import { parseBodyGuard, parseBodyGuardFields, type HeaderGuard } from '../services/workspace/write-guards.js';
import type { WorkspaceWriteService } from '../services/workspace/write-file.js';
import { multipartBoundary, parseMultipart } from '../services/workspace/write-media.js';
import { contentDispositionFor } from './assets.js';
import { parseKeywordSearchQuery, SEARCH_FUZZY_STATUS, type KeywordSearchResponseData } from './search.js';

export const AGENT_WORKSPACE_LIST_PATH = '/api/agent/workspace/list';
export const AGENT_WORKSPACE_FILE_PATH = '/api/agent/workspace/file';
export const AGENT_WORKSPACE_APPEND_PATH = '/api/agent/workspace/file/append';
export const AGENT_MARKS_PATH = '/api/agent/marks';
export const AGENT_MARK_PATH = '/api/agent/marks/:markId';
export const AGENT_MARK_TAGS_PATH = '/api/agent/marks/:markId/tags';
export const AGENT_STRUCTURED_PATH = '/api/agent/records/structured';
export const AGENT_STRUCTURED_ONE_PATH = '/api/agent/records/structured/:markId';
export const AGENT_SEARCH_PATH = '/api/agent/search';
export const AGENT_CITATIONS_REFERENCES_PATH = '/api/agent/citations/references';
export const AGENT_CITATIONS_FACTS_PATH = '/api/agent/citations/facts';
export const AGENT_CITATIONS_FACT_MAP_PATH = '/api/agent/citations/facts/:factId/map';
export const AGENT_CITATIONS_PROJECT_REFERENCES_PATH =
  '/api/agent/citations/projects/:projectKey/references';
export const AGENT_CITATIONS_PROJECT_BIBLIOGRAPHY_PATH =
  '/api/agent/citations/projects/:projectKey/bibliography';
export const AGENT_CITATIONS_PROJECT_MAP_PATH = '/api/agent/citations/projects/:projectKey/map';
export const AGENT_ASSETS_PATH = '/api/agent/assets';
export const AGENT_ASSET_PATH = '/api/agent/assets/:assetKey';

export const AGENT_BODY_LIMIT_BYTES = 1024 * 1024;
const MAX_PROJECT_KEY_LENGTH = 200;

type WorkspaceReader = ReturnType<typeof createWorkspaceReader>;

export interface AgentDataRouteDeps {
  records: RecordsRepository;
  citations: CitationsRepository;
  search: KeywordSearchPort;
  reader: Pick<WorkspaceReader, 'list' | 'readFile'>;
  writeService: WorkspaceWriteService;
  assets: AssetService;
  // Ownership checks for workspace resolution. Null fails closed
  // with 503, like the verifiers.
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

function checkPathPrefix(principal: AgentPrincipal, path: unknown): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw ApiError.validation('Request validation failed.', { field: 'path' });
  }
  if (!isPathWithinPrefixes(principal.pathPrefixes, path)) {
    throw ApiError.notFound();
  }
  return path;
}

function parseUuidParam(raw: unknown): string {
  if (typeof raw !== 'string' || !isUuid(raw)) {
    throw ApiError.notFound();
  }
  return raw;
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

function parseFileWriteBody(body: unknown): {
  path: string;
  content: string;
  guard: HeaderGuard;
  bodyGuard: ReturnType<typeof parseBodyGuard>;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiError.validation('The request body must be an object.');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['path', 'content', 'expectedRevision', 'force'].includes(key)) {
      throw ApiError.validation('The request body contains an unknown field.', { field: key });
    }
  }
  const path = record['path'];
  const content = record['content'];
  if (typeof path !== 'string' || path.trim() === '') {
    throw ApiError.validation('Request validation failed.', { field: 'path' });
  }
  if (typeof content !== 'string') {
    throw ApiError.validation('Request validation failed.', { field: 'content' });
  }
  const bodyGuard = parseBodyGuard(record);
  const guard: HeaderGuard =
    bodyGuard.kind === 'force'
      ? { kind: 'force' }
      : parseBodyGuardFields({ ifMatch: bodyGuard.revision, ifNoneMatch: undefined });
  return { path, content, guard, bodyGuard };
}

function invalidUpload(): ApiError {
  return new ApiError(400, 'invalid_upload', 'The multipart upload is not valid.');
}

export async function registerAgentDataRoutes(
  app: FastifyInstance,
  deps: AgentDataRouteDeps,
): Promise<void> {
  const assetExists = async (workspaceId: string, assetKey: string): Promise<boolean> =>
    (await deps.assets.findMetadata(workspaceId, assetKey)) !== null;

  app.get(
    AGENT_WORKSPACE_LIST_PATH,
    { config: { authMode: 'agent', agentScope: 'workspace.read' } },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      if (deps.store === null) {
        throw ApiError.serviceUnavailable('The database is not available.');
      }
      const owned = await unavailableOnDbError(() =>
        (deps.store as AuthStore).listWorkspacesByOwner(principal.userId),
      );
      const workspaces = owned
        .filter((row) => principal.workspaceIds.includes(row.id))
        .map((row) => ({ id: row.id, name: row.name }));
      const query = queryRecord(request);
      const files = await deps.reader.list(query['path'], {
        cursor: query['cursor'],
        limit: query['limit'],
        includeMetadata: query['includeMetadata'],
      });
      return successEnvelope({ workspaces, files });
    },
  );

  app.get(
    AGENT_WORKSPACE_FILE_PATH,
    { config: { authMode: 'agent', agentScope: 'workspace.read' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = agentPrincipal(request);
      requireAgentScope(principal, 'notes.read');
      const path = checkPathPrefix(principal, queryRecord(request)['path']);
      const result = await deps.reader.readFile(path, request.headers['if-none-match']);
      reply.header('Content-Type', result.contentType);
      reply.header('X-Revision', result.revision);
      reply.header('Cache-Control', 'private, no-cache');
      reply.header('X-Content-Type-Options', 'nosniff');
      if (result.notModified) {
        return reply.code(304).send();
      }
      reply.header('Content-Length', String(result.size));
      return reply.code(200).send(result.text as string);
    },
  );

  app.put(
    AGENT_WORKSPACE_FILE_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.write' }, bodyLimit: AGENT_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = agentPrincipal(request);
      const input = parseFileWriteBody(request.body);
      checkPathPrefix(principal, input.path);
      const outcome = await deps.writeService.putFile({
        rawPath: input.path,
        guard: input.guard,
        body: Buffer.from(input.content, 'utf8'),
        idempotencyKey:
          typeof request.headers['idempotency-key'] === 'string'
            ? request.headers['idempotency-key']
            : undefined,
        principal: undefined,
      });
      reply.code(outcome.status);
      return successEnvelope(outcome.data);
    },
  );

  app.post(
    AGENT_WORKSPACE_APPEND_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.append' }, bodyLimit: AGENT_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = agentPrincipal(request);
      const input = parseFileWriteBody(request.body);
      checkPathPrefix(principal, input.path);
      const outcome = await deps.writeService.appendFile({
        rawPath: input.path,
        guard: input.bodyGuard,
        content: input.content,
        idempotencyKey:
          typeof request.headers['idempotency-key'] === 'string'
            ? request.headers['idempotency-key']
            : undefined,
        principal: undefined,
      });
      reply.code(outcome.status);
      return successEnvelope(outcome.data);
    },
  );

  app.post(
    AGENT_MARKS_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.write' }, bodyLimit: AGENT_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const input = parseCreateBody(request.body, request.headers['idempotency-key']);
      const result = await deps.records.createMark(workspaceId, input, (assetKey) =>
        assetExists(workspaceId, assetKey),
      );
      if (!result.duplicate) {
        reply.code(201);
      }
      return successEnvelope(toApiRecord(result.row, result.duplicate));
    },
  );

  app.get(
    AGENT_MARKS_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.read' } },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const query = parseListQuery(request.query);
      const page = await deps.records.listMarks(workspaceId, query);
      return successEnvelope({
        items: page.items.map((row) => toApiRecord(row)),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    },
  );

  app.get(
    AGENT_MARK_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.read' } },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const markId = parseMarkIdParam((request.params as { markId?: unknown }).markId);
      const row = await deps.records.getMark(workspaceId, markId);
      return successEnvelope(toApiRecord(row));
    },
  );

  app.patch(
    AGENT_MARK_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.write' }, bodyLimit: AGENT_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const markId = parseMarkIdParam((request.params as { markId?: unknown }).markId);
      const input = parsePatchBody(request.body, request.headers['if-match']);
      const result = await deps.records.patchMark(workspaceId, markId, input, (assetKey) =>
        assetExists(workspaceId, assetKey),
      );
      return successEnvelope(toApiRecord(result.row));
    },
  );

  app.put(
    AGENT_MARK_TAGS_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.write' }, bodyLimit: AGENT_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const markId = parseMarkIdParam((request.params as { markId?: unknown }).markId);
      const input = parsePutTagsBody(request.body);
      const row = await deps.records.putMarkTags(workspaceId, markId, input);
      return successEnvelope(toApiRecord(row));
    },
  );

  app.post(
    AGENT_STRUCTURED_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.write' }, bodyLimit: AGENT_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const input = parseStructuredCreateBody(request.body);
      const existingBib = await deps.citations.findMarkBibliographyByIdentifier(workspaceId, {
        doi: input.bibliography.doi,
        pmid: input.bibliography.pmid,
      });
      if (existingBib !== null) {
        const conflicts = conflictingBibliographyFields(existingBib, input.bibliography);
        if (conflicts.length > 0) {
          throw new ApiError(
            409,
            'already_exists',
            'A record with the same DOI or PMID already exists with different metadata.',
            { details: { markId: existingBib.markId, conflictingFields: conflicts } },
          );
        }
        const existingRecord = await deps.records.getMark(workspaceId, existingBib.markId);
        return successEnvelope({
          record: toApiRecord(existingRecord, true),
          bibliography: toApiBibliography(existingBib),
          duplicate: true,
        });
      }
      const created = await deps.records.createMark(workspaceId, input.record, async () => false);
      const currentBib = await deps.citations.getMarkBibliography(workspaceId, created.row.id);
      if (currentBib !== null) {
        const conflicts = conflictingBibliographyFields(currentBib, input.bibliography);
        if (conflicts.length > 0) {
          throw new ApiError(
            409,
            'already_exists',
            'A record with the same source id already exists with different metadata.',
            { details: { markId: created.row.id, conflictingFields: conflicts } },
          );
        }
        return successEnvelope({
          record: toApiRecord(created.row, created.duplicate),
          bibliography: toApiBibliography(currentBib),
          ...(created.duplicate ? { duplicate: true } : {}),
        });
      }
      const bib = await deps.citations.upsertMarkBibliography(
        workspaceId,
        created.row.id,
        input.bibliography,
      );
      if (!created.duplicate) {
        reply.code(201);
      }
      return successEnvelope({
        record: toApiRecord(created.row, created.duplicate),
        bibliography: toApiBibliography(bib),
        ...(created.duplicate ? { duplicate: true } : {}),
      });
    },
  );

  app.get(
    AGENT_STRUCTURED_ONE_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.read' } },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const markId = parseMarkIdParam((request.params as { markId?: unknown }).markId);
      const record = await deps.records.getMark(workspaceId, markId);
      const bib = await deps.citations.getMarkBibliography(workspaceId, markId);
      return successEnvelope({
        record: toApiRecord(record),
        bibliography: bib === null ? null : toApiBibliography(bib),
      });
    },
  );

  app.patch(
    AGENT_STRUCTURED_ONE_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.write' }, bodyLimit: AGENT_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const markId = parseMarkIdParam((request.params as { markId?: unknown }).markId);
      const patch = parseUpsertBibliographyBody(request.body);
      const record = await deps.records.getMark(workspaceId, markId);
      const existing = await deps.citations.getMarkBibliography(workspaceId, markId);
      const merged = mergeBibliography(existing, patch);
      const collision = await deps.citations.findMarkBibliographyByIdentifier(workspaceId, {
        doi: merged.doi,
        pmid: merged.pmid,
      });
      if (collision !== null && collision.markId !== markId) {
        throw new ApiError(
          409,
          'already_exists',
          'Another record already carries the same DOI or PMID.',
          { details: { markId: collision.markId } },
        );
      }
      const bib = await deps.citations.upsertMarkBibliography(workspaceId, markId, merged);
      return successEnvelope({
        record: toApiRecord(record),
        bibliography: toApiBibliography(bib),
      });
    },
  );

  app.get(
    AGENT_SEARCH_PATH,
    { config: { authMode: 'agent', agentScope: 'search.read' } },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      // The search port resolves the owner's default workspace
      // from the principal; the agent workspace check above the
      // port call keeps the token's workspace list authoritative
      // in the single-workspace deployment shape.
      await resolveAgentWorkspaceId(request, principal, deps.store);
      const sessionPrincipal: SessionPrincipal = {
        userId: principal.userId,
        role: 'user',
        sessionId: principal.tokenId,
      };
      const input = parseKeywordSearchQuery(request.query, sessionPrincipal);
      const page = await deps.search.search(input);
      const data: KeywordSearchResponseData = {
        query: input.query,
        scope: input.scope,
        results: page.results,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        fuzzy: { ...SEARCH_FUZZY_STATUS },
        degraded: page.degraded,
      };
      return successEnvelope(data);
    },
  );

  app.post(
    AGENT_CITATIONS_REFERENCES_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.write' }, bodyLimit: AGENT_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const input = parseCreateReferenceBody(request.body);
      const result = await deps.citations.createReference(workspaceId, input);
      if (!result.duplicate) {
        reply.code(201);
      }
      return successEnvelope(toApiReference(result.row, result.duplicate));
    },
  );

  app.get(
    AGENT_CITATIONS_PROJECT_REFERENCES_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.read' } },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const projectKey = parseProjectKeyParam(
        (request.params as { projectKey?: unknown }).projectKey,
      );
      const rows = await deps.citations.listReferences(workspaceId, projectKey);
      return successEnvelope({ items: rows.map((row) => toApiReference(row)) });
    },
  );

  app.get(
    AGENT_CITATIONS_PROJECT_BIBLIOGRAPHY_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.read' } },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const projectKey = parseProjectKeyParam(
        (request.params as { projectKey?: unknown }).projectKey,
      );
      const rows = await deps.citations.listReferences(workspaceId, projectKey);
      return successEnvelope({ projectKey, text: formatBibliography(rows) });
    },
  );

  app.get(
    AGENT_CITATIONS_PROJECT_MAP_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.read' } },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const projectKey = parseProjectKeyParam(
        (request.params as { projectKey?: unknown }).projectKey,
      );
      const entries = await deps.citations.getCitationMap(workspaceId, projectKey);
      return successEnvelope({ projectKey, entries });
    },
  );

  app.post(
    AGENT_CITATIONS_FACTS_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.write' }, bodyLimit: AGENT_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const input = parseCreateFactBody(request.body);
      const row = await deps.citations.createFact(workspaceId, input);
      reply.code(201);
      return successEnvelope(toApiFact(row));
    },
  );

  app.post(
    AGENT_CITATIONS_FACT_MAP_PATH,
    { config: { authMode: 'agent', agentScope: 'notes.write' }, bodyLimit: AGENT_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const principal = agentPrincipal(request);
      const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
      const factId = parseUuidParam((request.params as { factId?: unknown }).factId);
      const body = request.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw ApiError.validation('The request body must be an object.');
      }
      const record = body as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key !== 'referenceId') {
          throw ApiError.validation('The request body contains an unknown field.', { field: key });
        }
      }
      const referenceId = parseUuidParam(record['referenceId']);
      const result = await deps.citations.mapFactToReference(workspaceId, factId, referenceId);
      return successEnvelope({
        fact: toApiFact(result.fact),
        reference: toApiReference(result.reference),
      });
    },
  );

  await app.register(async (scoped) => {
    if (!scoped.hasContentTypeParser('multipart/form-data')) {
      scoped.addContentTypeParser(
        'multipart/form-data',
        { parseAs: 'buffer', bodyLimit: deps.assets.limitBytes + 64 * 1024 },
        (_request, payload, done) => {
          done(null, payload);
        },
      );
    }

    scoped.post(
      AGENT_ASSETS_PATH,
      {
        config: {
          authMode: 'agent',
          agentScope: 'files.write',
          bodyTooLarge: {
            code: 'asset_too_large',
            limitBytes: deps.assets.limitBytes,
            message: 'Asset is too large.',
          },
        },
        bodyLimit: deps.assets.limitBytes + 64 * 1024,
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = agentPrincipal(request);
        const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
        const boundary = multipartBoundary(request.headers['content-type']);
        if (boundary === null || !Buffer.isBuffer(request.body)) {
          throw invalidUpload();
        }
        const parsed = parseMultipart(request.body, boundary);
        if (parsed.files.length !== 1 || parsed.files[0]?.name !== 'file') {
          throw invalidUpload();
        }
        for (const fieldName of parsed.fields.keys()) {
          if (fieldName !== 'fileName') {
            throw invalidUpload();
          }
        }
        const fileNameValues = parsed.fields.get('fileName') ?? [];
        if (fileNameValues.length > 1) {
          throw invalidUpload();
        }
        const file = parsed.files[0] as { data: Buffer; filename: string | undefined };
        const fileName = resolveFileName(fileNameValues[0], file.filename);
        const representation = await deps.assets.upload({
          workspaceId,
          fileName,
          bytes: file.data,
        });
        reply.code(201);
        return successEnvelope(representation);
      },
    );

    scoped.get(
      AGENT_ASSET_PATH,
      { config: { authMode: 'agent', agentScope: 'files.read' } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = agentPrincipal(request);
        const workspaceId = await resolveAgentWorkspaceId(request, principal, deps.store);
        const params = request.params as { assetKey?: unknown };
        const served = await deps.assets.serve(workspaceId, params.assetKey);
        reply.header('Content-Type', served.metadata.mimeType);
        reply.header(
          'Content-Disposition',
          contentDispositionFor(served.disposition, served.metadata.fileName),
        );
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Cache-Control', 'private');
        reply.header('ETag', served.etag);
        reply.header('Content-Length', String(served.bytes.length));
        reply.code(200);
        return reply.send(served.bytes);
      },
    );
  });
}
