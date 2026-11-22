// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Pure validation for the citations service (F2-1). Following the
// records K-09 contract: unknown fields are rejected, strings are
// trimmed, empty strings mean absent, and DOI/PMID/PMCID are
// normalized + shape-checked here so repositories only ever store
// canonical values.

import { ApiError } from '../../plugins/envelope.js';
import {
  isValidDoi,
  isValidPmcid,
  isValidPmid,
  normalizeDoi,
  normalizePmcid,
  normalizePmid,
} from './source-id.js';
import type { FactStatus } from './represent.js';

export interface BibliographicInput {
  title: string | undefined;
  authors: string | undefined;
  journal: string | undefined;
  year: number | undefined;
  doi: string | undefined;
  pmid: string | undefined;
  pmcid: string | undefined;
  url: string | undefined;
  oaFlag: boolean | undefined;
}

export interface CreateReferenceInput extends BibliographicInput {
  projectKey: string;
  sourceRecordId: number | undefined;
}

export interface CreateFactInput {
  projectKey: string;
  text: string;
  score: number;
  status: FactStatus;
}

const BIBLIOGRAPHIC_KEYS: ReadonlySet<string> = new Set([
  'title',
  'authors',
  'journal',
  'year',
  'doi',
  'pmid',
  'pmcid',
  'url',
  'oaFlag',
]);

const MAX_PROJECT_KEY_LENGTH = 128;
const MAX_TEXT_LENGTH = 10000;

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiError.validation('The request body must be an object.');
  }
  return body as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw ApiError.validation('The request body contains an unknown field.', { field: key });
    }
  }
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw ApiError.validation('A field has the wrong type.', { field: key });
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseBibliographic(record: Record<string, unknown>): BibliographicInput {
  const title = optionalString(record, 'title');
  const authors = optionalString(record, 'authors');
  const journal = optionalString(record, 'journal');
  const url = optionalString(record, 'url');

  let year: number | undefined;
  const rawYear = record['year'];
  if (rawYear !== undefined && rawYear !== null) {
    if (typeof rawYear !== 'number' || !Number.isInteger(rawYear) || rawYear < 1000 || rawYear > 9999) {
      throw ApiError.validation('The year is not valid.', { field: 'year' });
    }
    year = rawYear;
  }

  let oaFlag: boolean | undefined;
  const rawOa = record['oaFlag'];
  if (rawOa !== undefined && rawOa !== null) {
    if (typeof rawOa !== 'boolean') {
      throw ApiError.validation('A field has the wrong type.', { field: 'oaFlag' });
    }
    oaFlag = rawOa;
  }

  let doi: string | undefined;
  const rawDoi = optionalString(record, 'doi');
  if (rawDoi !== undefined) {
    doi = normalizeDoi(rawDoi);
    if (!isValidDoi(doi)) {
      throw ApiError.validation('The DOI is not valid.', { field: 'doi' });
    }
  }

  let pmid: string | undefined;
  const rawPmid = optionalString(record, 'pmid');
  if (rawPmid !== undefined) {
    pmid = normalizePmid(rawPmid);
    if (!isValidPmid(pmid)) {
      throw ApiError.validation('The PMID is not valid.', { field: 'pmid' });
    }
  }

  let pmcid: string | undefined;
  const rawPmcid = optionalString(record, 'pmcid');
  if (rawPmcid !== undefined) {
    pmcid = normalizePmcid(rawPmcid);
    if (!isValidPmcid(pmcid)) {
      throw ApiError.validation('The PMCID is not valid.', { field: 'pmcid' });
    }
  }

  return { title, authors, journal, year, doi, pmid, pmcid, url, oaFlag };
}

function parseProjectKey(record: Record<string, unknown>): string {
  const value = record['projectKey'];
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.validation('The project key is required.', { field: 'projectKey' });
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_PROJECT_KEY_LENGTH) {
    throw ApiError.validation('The project key is too long.', { field: 'projectKey' });
  }
  return trimmed;
}

export function parseCreateReferenceBody(body: unknown): CreateReferenceInput {
  const record = asRecord(body);
  const allowed = new Set<string>([...BIBLIOGRAPHIC_KEYS, 'projectKey', 'sourceRecordId']);
  rejectUnknownKeys(record, allowed);
  const projectKey = parseProjectKey(record);
  const bib = parseBibliographic(record);

  let sourceRecordId: number | undefined;
  const rawSource = record['sourceRecordId'];
  if (rawSource !== undefined && rawSource !== null) {
    if (typeof rawSource !== 'number' || !Number.isInteger(rawSource) || rawSource <= 0) {
      throw ApiError.validation('The source record id is not valid.', { field: 'sourceRecordId' });
    }
    sourceRecordId = rawSource;
  }

  return { ...bib, projectKey, sourceRecordId };
}

export function parseCreateFactBody(body: unknown): CreateFactInput {
  const record = asRecord(body);
  rejectUnknownKeys(record, new Set(['projectKey', 'text', 'score', 'status']));
  const projectKey = parseProjectKey(record);

  const rawText = record['text'];
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw ApiError.validation('The fact text is required.', { field: 'text' });
  }
  const text = rawText.trim();
  if (text.length > MAX_TEXT_LENGTH) {
    throw ApiError.validation('The fact text is too long.', { field: 'text' });
  }

  const rawScore = record['score'];
  if (typeof rawScore !== 'number' || !Number.isInteger(rawScore) || rawScore < 0 || rawScore > 100) {
    throw ApiError.validation('The score must be an integer from 0 to 100.', { field: 'score' });
  }

  let status: FactStatus = 'unmapped';
  const rawStatus = record['status'];
  if (rawStatus !== undefined && rawStatus !== null) {
    if (rawStatus !== 'mapped' && rawStatus !== 'unmapped') {
      throw ApiError.validation('The status is not valid.', { field: 'status' });
    }
    status = rawStatus;
  }

  return { projectKey, text, score: rawScore, status };
}

export function parseUpsertBibliographyBody(body: unknown): BibliographicInput {
  const record = asRecord(body);
  rejectUnknownKeys(record, BIBLIOGRAPHIC_KEYS);
  return parseBibliographic(record);
}
