// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Structured records routes (F2-1 design 2.2, wave G-F2-1b):
// POST /api/records/structured creates a link record plus its
// mark_bibliography companion row in one request; GET returns the
// record with its bibliography; PATCH corrects bibliography fields
// only (the record itself is edited through the records routes).
//
// Dedupe (design section 4 + wave title): the deterministic
// sourceId gives first-write-wins on the record. A create whose
// DOI or PMID already exists on another record's bibliography
// returns that record as a duplicate when the metadata agrees, and
// answers 409 already_exists with details.conflictingFields when
// the same identifier carries different metadata - never a silent
// merge.
//
// The two repositories run separate transactions (records first,
// bibliography second). A bibliography failure after the record
// commit leaves a plain link record without metadata, which a
// retry repairs through the duplicate path below (the retry finds
// the record by sourceId and upserts the missing bibliography).
// That is the honest interim shape; one combined transaction is
// later work, not hidden here.
//
// Auth and workspace resolution mirror the records routes
// (requiresAuth, server-side workspace, generic 404). Bodies are
// capped at 1 MiB.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrincipal, type SessionPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import type { CitationsRepository } from '../services/citations/repository.js';
import { toApiBibliography } from '../services/citations/represent.js';
import { parseUpsertBibliographyBody } from '../services/citations/validation.js';
import type { RecordsRepository } from '../services/records/repository.js';
import { toApiRecord } from '../services/records/represent.js';
import {
  conflictingBibliographyFields,
  mergeBibliography,
  parseStructuredCreateBody,
} from '../services/records/structured.js';
import { parseMarkIdParam } from '../services/records/validation.js';

export const STRUCTURED_RECORDS_PATH = '/api/records/structured';
export const STRUCTURED_RECORD_PATH = '/api/records/structured/:markId';

export const STRUCTURED_BODY_LIMIT_BYTES = 1024 * 1024;

export type StructuredWorkspaceResolver = (
  principal: SessionPrincipal,
) => Promise<string | null>;

export interface StructuredRouteDeps {
  records: RecordsRepository;
  citations: CitationsRepository;
  resolveWorkspaceId: StructuredWorkspaceResolver;
}

async function workspaceIdOf(
  request: FastifyRequest,
  resolveWorkspaceId: StructuredWorkspaceResolver,
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

export async function registerStructuredRecordsRoutes(
  app: FastifyInstance,
  deps: StructuredRouteDeps,
): Promise<void> {
  app.post(
    STRUCTURED_RECORDS_PATH,
    { config: { requiresAuth: true }, bodyLimit: STRUCTURED_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const input = parseStructuredCreateBody(request.body);

      // Identifier dedupe first: the same DOI/PMID on another
      // record's bibliography is either an idempotent retry
      // (metadata agrees) or a 409 conflict (metadata differs).
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
      // On a sourceId duplicate the record may already carry a
      // bibliography (retry) or not (interrupted first attempt).
      // Upsert only when missing; an existing row is compared, not
      // overwritten, so retries stay first-write-wins.
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
    STRUCTURED_RECORD_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
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
    STRUCTURED_RECORD_PATH,
    { config: { requiresAuth: true }, bodyLimit: STRUCTURED_BODY_LIMIT_BYTES },
    async (request: FastifyRequest) => {
      const workspaceId = await workspaceIdOf(request, deps.resolveWorkspaceId);
      const markId = parseMarkIdParam((request.params as { markId?: unknown }).markId);
      const patch = parseUpsertBibliographyBody(request.body);
      const record = await deps.records.getMark(workspaceId, markId);
      const existing = await deps.citations.getMarkBibliography(workspaceId, markId);
      const merged = mergeBibliography(existing, patch);
      // A corrected DOI/PMID must not collide with another record.
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
}
