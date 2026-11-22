// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Row shapes for the citations service (F2-1). These mirror the M9
// tables one to one; the repository port returns these shapes and the
// route layer (later wave) maps them to wire representations.

export interface ReferenceRow {
  id: string;
  workspaceId: string;
  projectKey: string;
  // Null until the reference is first mapped to a fact in the project.
  number: number | null;
  sourceRecordId: number | null;
  title: string | null;
  authors: string | null;
  journal: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  url: string | null;
  oaFlag: boolean | null;
  createdAt: number;
  updatedAt: number;
}

export type FactStatus = 'mapped' | 'unmapped';

export interface FactRow {
  id: string;
  workspaceId: string;
  projectKey: string;
  text: string;
  score: number;
  status: FactStatus;
  createdAt: number;
  updatedAt: number;
}

export interface MarkBibliographyRow {
  markId: number;
  workspaceId: string;
  title: string | null;
  authors: string | null;
  journal: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  url: string | null;
  oaFlag: boolean | null;
  createdAt: number;
  updatedAt: number;
}

// One citation-map entry: a mapped fact and the sorted citation
// numbers of its references. Unmapped facts never appear here; they
// receive no marker by rule.
export interface CitationMapEntry {
  factId: string;
  numbers: number[];
}

// Sort references for display: numbered first by number ascending,
// then unnumbered by creation order. Numbers are stable; this sort
// never renumbers anything.
export function sortReferences(rows: ReferenceRow[]): ReferenceRow[] {
  return [...rows].sort((a, b) => {
    if (a.number !== null && b.number !== null) return a.number - b.number;
    if (a.number !== null) return -1;
    if (b.number !== null) return 1;
    return a.createdAt - b.createdAt;
  });
}

// Wire representations for the citations routes (wave G-F2-1b).
// Field lists mirror the row shapes one to one; the route layer
// never invents fields the service does not hold.

export interface ApiReference {
  id: string;
  workspaceId: string;
  projectKey: string;
  number: number | null;
  sourceRecordId: number | null;
  title: string | null;
  authors: string | null;
  journal: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  url: string | null;
  oaFlag: boolean | null;
  createdAt: number;
  updatedAt: number;
  duplicate?: boolean;
}

export function toApiReference(row: ReferenceRow, duplicate = false): ApiReference {
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(duplicate ? { duplicate: true } : {}),
  };
}

export interface ApiFact {
  id: string;
  workspaceId: string;
  projectKey: string;
  text: string;
  score: number;
  status: FactStatus;
  createdAt: number;
  updatedAt: number;
}

export function toApiFact(row: FactRow): ApiFact {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectKey: row.projectKey,
    text: row.text,
    score: row.score,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ApiBibliography {
  markId: number;
  workspaceId: string;
  title: string | null;
  authors: string | null;
  journal: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  url: string | null;
  oaFlag: boolean | null;
  createdAt: number;
  updatedAt: number;
}

export function toApiBibliography(row: MarkBibliographyRow): ApiBibliography {
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
