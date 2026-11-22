// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Repository port for the citations service (F2-1). Coarse like the
// records port: each method owns one operation's transaction. Two
// implementations: Drizzle over Postgres, and an in-memory fake for
// specs. HTTP concerns (auth, body parsing, status codes) belong to
// the route layer of a later wave; this wave is schema + service.
//
// Numbering rule (binding): a reference receives its number when it
// is first mapped to a fact in its project (order of appearance).
// The number is stable afterwards and is never reused or shifted;
// renumbering exists only as an explicit gated operation, which is
// not part of this port.
//
// Unmapped rule (binding): a fact with status 'unmapped' can never
// be mapped to a reference and never appears in the citation map.

import type {
  CitationMapEntry,
  FactRow,
  MarkBibliographyRow,
  ReferenceRow,
} from './represent.js';
import type {
  BibliographicInput,
  CreateFactInput,
  CreateReferenceInput,
} from './validation.js';

export interface CreateReferenceResult {
  row: ReferenceRow;
  // True when an existing reference with the same DOI or PMID in the
  // workspace was returned instead of inserting (dedupe).
  duplicate: boolean;
}

export interface MapFactResult {
  fact: FactRow;
  reference: ReferenceRow;
}

export interface CitationsRepository {
  // Create a reference in a project, or return the existing one with
  // duplicate: true when the workspace already holds a reference with
  // the same normalized DOI or PMID (dedupe, first-write-wins).
  createReference(
    workspaceId: string,
    input: CreateReferenceInput,
  ): Promise<CreateReferenceResult>;

  // A single reference. Unknown id answers 404.
  getReference(workspaceId: string, referenceId: string): Promise<ReferenceRow>;

  // All references of a project, numbered first by number ascending,
  // then unnumbered by creation order.
  listReferences(workspaceId: string, projectKey: string): Promise<ReferenceRow[]>;

  // Create a fact. Status defaults to 'unmapped' (validation layer).
  createFact(workspaceId: string, input: CreateFactInput): Promise<FactRow>;

  // A single fact. Unknown id answers 404.
  getFact(workspaceId: string, factId: string): Promise<FactRow>;

  // All facts of a project, creation order.
  listFacts(workspaceId: string, projectKey: string): Promise<FactRow[]>;

  // Map a fact to a reference (same project required). Assigns the
  // reference its number when it has none yet (next number in the
  // project). Mapping an 'unmapped' fact is rejected. Re-mapping the
  // same pair is an idempotent no-op.
  mapFactToReference(
    workspaceId: string,
    factId: string,
    referenceId: string,
  ): Promise<MapFactResult>;

  // The citation map of a project: mapped facts with the sorted
  // numbers of their references. Unmapped facts never appear.
  getCitationMap(workspaceId: string, projectKey: string): Promise<CitationMapEntry[]>;

  // Insert or replace the bibliographic companion row of a record.
  // The mark must exist in the workspace (404 otherwise).
  upsertMarkBibliography(
    workspaceId: string,
    markId: number,
    input: BibliographicInput,
  ): Promise<MarkBibliographyRow>;

  // The bibliographic companion row of a record, or null when the
  // record has none. Unknown mark answers 404.
  getMarkBibliography(
    workspaceId: string,
    markId: number,
  ): Promise<MarkBibliographyRow | null>;
}
