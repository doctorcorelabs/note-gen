// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// In-memory implementation of the citations repository, for specs
// only. It mirrors the Drizzle implementation's observable semantics
// (DOI/PMID dedupe, stable numbering on first map, unmapped rule,
// citation map as query) without a database. It must never be wired
// into production.
//
// The fake owns one workspace per instance; the workspaceId argument
// is accepted for interface compatibility and checked for equality.
// Ids and timestamps come from monotonic counters so ordering is
// deterministic in specs. Marks are not modeled: mark bibliography
// methods accept any positive mark id (existence is a Drizzle-side
// concern proven by the FK).

import { ApiError } from '../../plugins/envelope.js';
import { buildCitationMap, type FactReferenceLink } from './bibliography.js';
import type {
  CitationMapEntry,
  FactRow,
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

export type FakeCitationsRepository = CitationsRepository;

function referenceNotFound(): ApiError {
  return ApiError.notFound('The reference was not found in this workspace.');
}

function factNotFound(): ApiError {
  return ApiError.notFound('The fact was not found in this workspace.');
}

export function createFakeCitationsRepository(workspaceId: string): FakeCitationsRepository {
  const referencesStore = new Map<string, ReferenceRow>();
  const factsStore = new Map<string, FactRow>();
  const links: FactReferenceLink[] = [];
  const bibliographyStore = new Map<number, MarkBibliographyRow>();
  // High-water mark per project: numbers are never reused, even if a
  // numbered reference were removed (no delete exists in this port,
  // but the counter keeps the invariant explicit).
  const nextNumberByProject = new Map<string, number>();
  let idCounter = 0;
  let clock = 1_700_000_000_000;

  function now(): number {
    clock += 1;
    return clock;
  }

  function nextId(): string {
    idCounter += 1;
    return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
  }

  function checkWorkspace(requested: string): void {
    if (requested !== workspaceId) {
      throw ApiError.notFound();
    }
  }

  function findDuplicate(input: CreateReferenceInput): ReferenceRow | undefined {
    for (const row of referencesStore.values()) {
      if (input.doi !== undefined && row.doi === input.doi) return row;
      if (input.pmid !== undefined && row.pmid === input.pmid) return row;
    }
    return undefined;
  }

  return {
    async createReference(
      requestedWorkspaceId: string,
      input: CreateReferenceInput,
    ): Promise<CreateReferenceResult> {
      checkWorkspace(requestedWorkspaceId);
      const existing = findDuplicate(input);
      if (existing !== undefined) {
        return { row: { ...existing }, duplicate: true };
      }
      const timestamp = now();
      const row: ReferenceRow = {
        id: nextId(),
        workspaceId,
        projectKey: input.projectKey,
        number: null,
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
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      referencesStore.set(row.id, row);
      return { row: { ...row }, duplicate: false };
    },

    async getReference(
      requestedWorkspaceId: string,
      referenceId: string,
    ): Promise<ReferenceRow> {
      checkWorkspace(requestedWorkspaceId);
      const row = referencesStore.get(referenceId);
      if (row === undefined) throw referenceNotFound();
      return { ...row };
    },

    async listReferences(
      requestedWorkspaceId: string,
      projectKey: string,
    ): Promise<ReferenceRow[]> {
      checkWorkspace(requestedWorkspaceId);
      return sortReferences(
        [...referencesStore.values()]
          .filter((row) => row.projectKey === projectKey)
          .map((row) => ({ ...row })),
      );
    },

    async createFact(
      requestedWorkspaceId: string,
      input: CreateFactInput,
    ): Promise<FactRow> {
      checkWorkspace(requestedWorkspaceId);
      const timestamp = now();
      const row: FactRow = {
        id: nextId(),
        workspaceId,
        projectKey: input.projectKey,
        text: input.text,
        score: input.score,
        status: input.status,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      factsStore.set(row.id, row);
      return { ...row };
    },

    async getFact(requestedWorkspaceId: string, factId: string): Promise<FactRow> {
      checkWorkspace(requestedWorkspaceId);
      const row = factsStore.get(factId);
      if (row === undefined) throw factNotFound();
      return { ...row };
    },

    async listFacts(requestedWorkspaceId: string, projectKey: string): Promise<FactRow[]> {
      checkWorkspace(requestedWorkspaceId);
      return [...factsStore.values()]
        .filter((row) => row.projectKey === projectKey)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((row) => ({ ...row }));
    },

    async mapFactToReference(
      requestedWorkspaceId: string,
      factId: string,
      referenceId: string,
    ): Promise<MapFactResult> {
      checkWorkspace(requestedWorkspaceId);
      const fact = factsStore.get(factId);
      if (fact === undefined) throw factNotFound();
      const reference = referencesStore.get(referenceId);
      if (reference === undefined) throw referenceNotFound();
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
      const alreadyLinked = links.some(
        (link) => link.factId === factId && link.referenceId === referenceId,
      );
      if (!alreadyLinked) {
        links.push({ factId, referenceId });
      }
      if (reference.number === null) {
        const next = nextNumberByProject.get(reference.projectKey) ?? 1;
        reference.number = next;
        reference.updatedAt = now();
        nextNumberByProject.set(reference.projectKey, next + 1);
      }
      return { fact: { ...fact }, reference: { ...reference } };
    },

    async getCitationMap(
      requestedWorkspaceId: string,
      projectKey: string,
    ): Promise<CitationMapEntry[]> {
      checkWorkspace(requestedWorkspaceId);
      const facts = [...factsStore.values()].filter((row) => row.projectKey === projectKey);
      const references = [...referencesStore.values()].filter(
        (row) => row.projectKey === projectKey,
      );
      return buildCitationMap(facts, links, references);
    },

    async upsertMarkBibliography(
      requestedWorkspaceId: string,
      markId: number,
      input: BibliographicInput,
    ): Promise<MarkBibliographyRow> {
      checkWorkspace(requestedWorkspaceId);
      const existing = bibliographyStore.get(markId);
      const timestamp = now();
      const row: MarkBibliographyRow = {
        markId,
        workspaceId,
        title: input.title ?? null,
        authors: input.authors ?? null,
        journal: input.journal ?? null,
        year: input.year ?? null,
        doi: input.doi ?? null,
        pmid: input.pmid ?? null,
        pmcid: input.pmcid ?? null,
        url: input.url ?? null,
        oaFlag: input.oaFlag ?? null,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      bibliographyStore.set(markId, row);
      return { ...row };
    },

    async getMarkBibliography(
      requestedWorkspaceId: string,
      markId: number,
    ): Promise<MarkBibliographyRow | null> {
      checkWorkspace(requestedWorkspaceId);
      const row = bibliographyStore.get(markId);
      return row === undefined ? null : { ...row };
    },
  };
}
