// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Drizzle/Postgres implementation of the citations repository
// (F2-1). Every method runs in one transaction via db.transaction().
// Semantics mirror the fake: DOI/PMID dedupe first-write-wins, the
// citation number is assigned on first map (max + 1 in the project,
// guarded by the unique index), unmapped facts can never be mapped,
// and the citation map is built by the shared pure builder so the
// two implementations cannot drift.

import { and, asc, eq, max, or } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import {
  citationReferences,
  factReferences,
  facts,
  markBibliography,
  marks,
  type Database,
} from '../../db/index.js';
import { buildCitationMap } from './bibliography.js';
import type {
  CitationMapEntry,
  FactRow,
  FactStatus,
  MarkBibliographyRow,
  ReferenceRow,
} from './represent.js';
import { sortReferences } from './represent.js';
import type {
  CitationsRepository,
  CreateReferenceResult,
  MapFactResult,
} from './repository.js';
import type {
  BibliographicInput,
  CreateFactInput,
  CreateReferenceInput,
} from './validation.js';

type DbReferenceRow = typeof citationReferences.$inferSelect;
type DbFactRow = typeof facts.$inferSelect;
type DbBibliographyRow = typeof markBibliography.$inferSelect;

function referenceNotFound(): ApiError {
  return ApiError.notFound('The reference was not found in this workspace.');
}

function factNotFound(): ApiError {
  return ApiError.notFound('The fact was not found in this workspace.');
}

function toReferenceRow(row: DbReferenceRow): ReferenceRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectKey: row.projectKey,
    number: row.number,
    sourceRecordId: row.sourceRecordId,
    title: row.title,
    authors: row.authors,
    journal: row.journal,
    year: row.year,
    doi: row.doi,
    pmid: row.pmid,
    pmcid: row.pmcid,
    url: row.url,
    oaFlag: row.oaFlag,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toFactRow(row: DbFactRow): FactRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectKey: row.projectKey,
    text: row.factText,
    score: row.score,
    status: row.status as FactStatus,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toBibliographyRow(row: DbBibliographyRow): MarkBibliographyRow {
  return {
    markId: row.markId,
    workspaceId: row.workspaceId,
    title: row.title,
    authors: row.authors,
    journal: row.journal,
    year: row.year,
    doi: row.doi,
    pmid: row.pmid,
    pmcid: row.pmcid,
    url: row.url,
    oaFlag: row.oaFlag,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function createDrizzleCitationsRepository(db: Database): CitationsRepository {
  return {
    async createReference(
      workspaceId: string,
      input: CreateReferenceInput,
    ): Promise<CreateReferenceResult> {
      return db.transaction(async (tx) => {
        const dedupeConditions = [];
        if (input.doi !== undefined) {
          dedupeConditions.push(eq(citationReferences.doi, input.doi));
        }
        if (input.pmid !== undefined) {
          dedupeConditions.push(eq(citationReferences.pmid, input.pmid));
        }
        if (dedupeConditions.length > 0) {
          const existing = await tx
            .select()
            .from(citationReferences)
            .where(
              and(
                eq(citationReferences.workspaceId, workspaceId),
                or(...dedupeConditions),
              ),
            )
            .limit(1);
          if (existing[0] !== undefined) {
            return { row: toReferenceRow(existing[0]), duplicate: true };
          }
        }
        const inserted = await tx
          .insert(citationReferences)
          .values({
            workspaceId,
            projectKey: input.projectKey,
            sourceRecordId: input.sourceRecordId ?? null,
            title: input.title ?? null,
            authors: input.authors ?? null,
            journal: input.journal ?? null,
            year: input.year ?? null,
            doi: input.doi ?? null,
            pmid: input.pmid ?? null,
            pmcid: input.pmcid ?? null,
            url: input.url ?? null,
            oaFlag: input.oaFlag ?? null,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted[0] !== undefined) {
          return { row: toReferenceRow(inserted[0]), duplicate: false };
        }
        // Lost a dedupe race: the winner row is the duplicate answer.
        if (dedupeConditions.length > 0) {
          const winner = await tx
            .select()
            .from(citationReferences)
            .where(
              and(
                eq(citationReferences.workspaceId, workspaceId),
                or(...dedupeConditions),
              ),
            )
            .limit(1);
          if (winner[0] !== undefined) {
            return { row: toReferenceRow(winner[0]), duplicate: true };
          }
        }
        throw ApiError.internalError();
      });
    },

    async getReference(workspaceId: string, referenceId: string): Promise<ReferenceRow> {
      const rows = await db
        .select()
        .from(citationReferences)
        .where(
          and(
            eq(citationReferences.workspaceId, workspaceId),
            eq(citationReferences.id, referenceId),
          ),
        )
        .limit(1);
      if (rows[0] === undefined) throw referenceNotFound();
      return toReferenceRow(rows[0]);
    },

    async listReferences(workspaceId: string, projectKey: string): Promise<ReferenceRow[]> {
      const rows = await db
        .select()
        .from(citationReferences)
        .where(
          and(
            eq(citationReferences.workspaceId, workspaceId),
            eq(citationReferences.projectKey, projectKey),
          ),
        );
      return sortReferences(rows.map(toReferenceRow));
    },

    async createFact(workspaceId: string, input: CreateFactInput): Promise<FactRow> {
      const inserted = await db
        .insert(facts)
        .values({
          workspaceId,
          projectKey: input.projectKey,
          factText: input.text,
          score: input.score,
          status: input.status,
        })
        .returning();
      if (inserted[0] === undefined) throw ApiError.internalError();
      return toFactRow(inserted[0]);
    },

    async getFact(workspaceId: string, factId: string): Promise<FactRow> {
      const rows = await db
        .select()
        .from(facts)
        .where(and(eq(facts.workspaceId, workspaceId), eq(facts.id, factId)))
        .limit(1);
      if (rows[0] === undefined) throw factNotFound();
      return toFactRow(rows[0]);
    },

    async listFacts(workspaceId: string, projectKey: string): Promise<FactRow[]> {
      const rows = await db
        .select()
        .from(facts)
        .where(and(eq(facts.workspaceId, workspaceId), eq(facts.projectKey, projectKey)))
        .orderBy(asc(facts.createdAt));
      return rows.map(toFactRow);
    },

    async mapFactToReference(
      workspaceId: string,
      factId: string,
      referenceId: string,
    ): Promise<MapFactResult> {
      return db.transaction(async (tx) => {
        const factRows = await tx
          .select()
          .from(facts)
          .where(and(eq(facts.workspaceId, workspaceId), eq(facts.id, factId)))
          .limit(1);
        if (factRows[0] === undefined) throw factNotFound();
        const referenceRows = await tx
          .select()
          .from(citationReferences)
          .where(
            and(
              eq(citationReferences.workspaceId, workspaceId),
              eq(citationReferences.id, referenceId),
            ),
          )
          .limit(1);
        if (referenceRows[0] === undefined) throw referenceNotFound();
        const fact = factRows[0];
        let reference = referenceRows[0];
        if (fact.projectKey !== reference.projectKey) {
          throw ApiError.validation('The fact and reference belong to different projects.');
        }
        if (fact.status !== 'mapped') {
          throw new ApiError(
            409,
            'invalid_operation',
            'An unmapped fact cannot be mapped to a reference.',
            { details: { factId } },
          );
        }
        await tx
          .insert(factReferences)
          .values({ factId, referenceId, workspaceId })
          .onConflictDoNothing();
        if (reference.number === null) {
          const maxRows = await tx
            .select({ value: max(citationReferences.number) })
            .from(citationReferences)
            .where(
              and(
                eq(citationReferences.workspaceId, workspaceId),
                eq(citationReferences.projectKey, reference.projectKey),
              ),
            );
          const nextNumber = (maxRows[0]?.value ?? 0) + 1;
          const updated = await tx
            .update(citationReferences)
            .set({ number: nextNumber })
            .where(eq(citationReferences.id, referenceId))
            .returning();
          if (updated[0] === undefined) throw ApiError.internalError();
          reference = updated[0];
        }
        return { fact: toFactRow(fact), reference: toReferenceRow(reference) };
      });
    },

    async getCitationMap(
      workspaceId: string,
      projectKey: string,
    ): Promise<CitationMapEntry[]> {
      const factRows = await db
        .select()
        .from(facts)
        .where(and(eq(facts.workspaceId, workspaceId), eq(facts.projectKey, projectKey)));
      const referenceRows = await db
        .select()
        .from(citationReferences)
        .where(
          and(
            eq(citationReferences.workspaceId, workspaceId),
            eq(citationReferences.projectKey, projectKey),
          ),
        );
      const linkRows = await db
        .select()
        .from(factReferences)
        .where(eq(factReferences.workspaceId, workspaceId));
      return buildCitationMap(
        factRows.map(toFactRow),
        linkRows.map((link) => ({ factId: link.factId, referenceId: link.referenceId })),
        referenceRows.map(toReferenceRow),
      );
    },

    async upsertMarkBibliography(
      workspaceId: string,
      markId: number,
      input: BibliographicInput,
    ): Promise<MarkBibliographyRow> {
      return db.transaction(async (tx) => {
        const markRows = await tx
          .select({ id: marks.id })
          .from(marks)
          .where(and(eq(marks.workspaceId, workspaceId), eq(marks.id, markId)))
          .limit(1);
        if (markRows[0] === undefined) {
          throw ApiError.notFound('The record was not found in this workspace.');
        }
        const values = {
          title: input.title ?? null,
          authors: input.authors ?? null,
          journal: input.journal ?? null,
          year: input.year ?? null,
          doi: input.doi ?? null,
          pmid: input.pmid ?? null,
          pmcid: input.pmcid ?? null,
          url: input.url ?? null,
          oaFlag: input.oaFlag ?? null,
        };
        const upserted = await tx
          .insert(markBibliography)
          .values({ markId, workspaceId, ...values })
          .onConflictDoUpdate({ target: markBibliography.markId, set: values })
          .returning();
        if (upserted[0] === undefined) throw ApiError.internalError();
        return toBibliographyRow(upserted[0]);
      });
    },

    async getMarkBibliography(
      workspaceId: string,
      markId: number,
    ): Promise<MarkBibliographyRow | null> {
      const markRows = await db
        .select({ id: marks.id })
        .from(marks)
        .where(and(eq(marks.workspaceId, workspaceId), eq(marks.id, markId)))
        .limit(1);
      if (markRows[0] === undefined) {
        throw ApiError.notFound('The record was not found in this workspace.');
      }
      const rows = await db
        .select()
        .from(markBibliography)
        .where(
          and(
            eq(markBibliography.workspaceId, workspaceId),
            eq(markBibliography.markId, markId),
          ),
        )
        .limit(1);
      return rows[0] === undefined ? null : toBibliographyRow(rows[0]);
    },

    async findMarkBibliographyByIdentifier(
      workspaceId: string,
      identifier: { doi?: string | undefined; pmid?: string | undefined },
    ): Promise<MarkBibliographyRow | null> {
      const condition =
        identifier.doi !== undefined
          ? eq(markBibliography.doi, identifier.doi)
          : identifier.pmid !== undefined
            ? eq(markBibliography.pmid, identifier.pmid)
            : undefined;
      if (condition === undefined) {
        return null;
      }
      const rows = await db
        .select()
        .from(markBibliography)
        .where(and(eq(markBibliography.workspaceId, workspaceId), condition))
        .limit(1);
      return rows[0] === undefined ? null : toBibliographyRow(rows[0]);
    },
  };
}
