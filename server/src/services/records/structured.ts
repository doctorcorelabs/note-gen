// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Structured records service (F2-1 design 2.2, wave G-F2-1b).
//
// A structured record is an ordinary link record plus a
// mark_bibliography companion row (design option b: the marks table
// is untouched). This module owns the pure parsing and derivation
// rules for the structured endpoints; the route layer orchestrates
// the records repository and the citations repository.
//
// Rules:
// - The record type is always 'link'. The record url is the
//   bibliographic url when given, else derived from the strongest
//   identifier (doi.org, PubMed, PMC), so the link shape rule of
//   the records validation always holds.
// - desc defaults to the bibliographic title; content defaults to
//   empty. An explicit desc/content wins.
// - sourceId: an explicit body sourceId wins (length-checked like
//   the legacy create); otherwise the server derives the
//   deterministic id via citations/source-id (doi:/pmid:/pmcid:/
//   url:sha256). The legacy resolveSourceId is not changed.
// - Dedupe conflict (design section 4): when an existing
//   bibliography row carries the same DOI or PMID but different
//   metadata, the caller answers 409 with the conflicting fields
//   instead of merging silently. conflictingBibliographyFields is
//   the pure comparison behind that answer.

import { ApiError } from '../../plugins/envelope.js';
import {
  fieldError,
  rejectUnknownFields,
  requireJsonObject,
} from '../workspace/write-guards.js';
import { deriveSourceId } from '../citations/source-id.js';
import type { BibliographicInput } from '../citations/validation.js';
import { parseUpsertBibliographyBody } from '../citations/validation.js';
import type { MarkBibliographyRow } from '../citations/represent.js';
import type { CreateRecordInput } from './validation.js';
import { SOURCE_ID_MAX_LENGTH, validateUrlShape } from './validation.js';

export interface StructuredCreateInput {
  record: CreateRecordInput;
  bibliography: BibliographicInput;
}

const BIBLIOGRAPHIC_FIELDS = [
  'title',
  'authors',
  'journal',
  'year',
  'doi',
  'pmid',
  'pmcid',
  'url',
  'oaFlag',
] as const;

type BibliographicField = (typeof BIBLIOGRAPHIC_FIELDS)[number];

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw fieldError(field, 'must be a string');
  }
  return value;
}

function parseTagIdArray(value: unknown, field: string): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((entry) => isPositiveInteger(entry))) {
    throw fieldError(field, 'must be an array of positive integers');
  }
  if (value.length === 0) {
    throw fieldError(field, 'must not be empty');
  }
  return [...value];
}

// The record url for a structured create: explicit bibliographic
// url first, else the canonical landing page of the strongest
// identifier. At least one identifier or a url is required (the
// source-id derivation enforces the same floor).
export function deriveRecordUrl(bibliography: BibliographicInput): string {
  if (bibliography.url !== undefined) {
    return bibliography.url;
  }
  if (bibliography.doi !== undefined) {
    return `https://doi.org/${bibliography.doi}`;
  }
  if (bibliography.pmid !== undefined) {
    return `https://pubmed.ncbi.nlm.nih.gov/${bibliography.pmid}/`;
  }
  if (bibliography.pmcid !== undefined) {
    return `https://pmc.ncbi.nlm.nih.gov/articles/${bibliography.pmcid}/`;
  }
  throw ApiError.validation('A DOI, PMID, PMCID, or URL is required for a structured record.');
}

export function parseStructuredCreateBody(body: unknown): StructuredCreateInput {
  const record = requireJsonObject(body);
  rejectUnknownFields(record, [
    ...BIBLIOGRAPHIC_FIELDS,
    'content',
    'desc',
    'tagId',
    'tagIds',
    'sourceId',
  ]);
  const bibliography = parseUpsertBibliographyBody(
    Object.fromEntries(
      BIBLIOGRAPHIC_FIELDS.filter((field) => record[field] !== undefined).map((field) => [
        field,
        record[field],
      ]),
    ),
  );
  const content = parseOptionalString(record['content'], 'content') ?? '';
  const rawDesc = parseOptionalString(record['desc'], 'desc');
  const desc = rawDesc ?? bibliography.title ?? '';
  const rawTagId = record['tagId'];
  if (rawTagId !== undefined && !isPositiveInteger(rawTagId)) {
    throw fieldError('tagId', 'must be a positive integer');
  }
  const tagId = rawTagId as number | undefined;
  const tagIds = parseTagIdArray(record['tagIds'], 'tagIds');
  if (tagId !== undefined && tagIds !== undefined && !tagIds.includes(tagId)) {
    throw fieldError('tagId', 'must be a member of tagIds');
  }
  const rawSourceId = parseOptionalString(record['sourceId'], 'sourceId');
  if (rawSourceId !== undefined && rawSourceId.length > SOURCE_ID_MAX_LENGTH) {
    throw fieldError('sourceId', `must be at most ${SOURCE_ID_MAX_LENGTH} characters`);
  }
  const url = deriveRecordUrl(bibliography);
  validateUrlShape('link', url);
  const sourceId =
    rawSourceId !== undefined && rawSourceId !== ''
      ? rawSourceId
      : deriveSourceId({
          doi: bibliography.doi,
          pmid: bibliography.pmid,
          pmcid: bibliography.pmcid,
          url: bibliography.url,
        });
  return {
    record: { type: 'link', content, desc, url, tagId, tagIds, sourceId },
    bibliography,
  };
}

// Limited bibliography correction (PATCH): absent fields keep the
// stored value, present fields replace it. An explicit null in the
// body parses to absent (citations validation treats null as
// absent), so clearing a field is not expressible here; that is
// deliberate for a correction endpoint.
export function mergeBibliography(
  existing: MarkBibliographyRow | null,
  patch: BibliographicInput,
): BibliographicInput {
  return {
    title: patch.title ?? existing?.title ?? undefined,
    authors: patch.authors ?? existing?.authors ?? undefined,
    journal: patch.journal ?? existing?.journal ?? undefined,
    year: patch.year ?? existing?.year ?? undefined,
    doi: patch.doi ?? existing?.doi ?? undefined,
    pmid: patch.pmid ?? existing?.pmid ?? undefined,
    pmcid: patch.pmcid ?? existing?.pmcid ?? undefined,
    url: patch.url ?? existing?.url ?? undefined,
    oaFlag: patch.oaFlag ?? existing?.oaFlag ?? undefined,
  };
}

// Fields where both sides carry a value and the values differ.
// A field present on only one side is not a conflict: first-write
// wins keeps the stored value and the retry is a plain duplicate.
export function conflictingBibliographyFields(
  existing: MarkBibliographyRow,
  incoming: BibliographicInput,
): BibliographicField[] {
  const conflicts: BibliographicField[] = [];
  for (const field of BIBLIOGRAPHIC_FIELDS) {
    const stored = existing[field];
    const next = incoming[field];
    if (stored !== null && stored !== undefined && next !== undefined && stored !== next) {
      conflicts.push(field);
    }
  }
  return conflicts;
}
