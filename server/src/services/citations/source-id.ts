// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deterministic source ids for pipeline sources (F2-1 design 2.2).
//
// Convention enforced by the citations service layer (the legacy
// resolveSourceId in services/records is not changed):
//   doi:<doi-lowercase>  when a DOI exists
//   pmid:<pmid>          else when a PMID exists
//   pmcid:<pmcid>        else when a PMCID exists
//   url:<sha256(url)>    otherwise
// The existing partial unique index (workspace_id, source_id) on
// marks gives first-write-wins dedupe for collector retries.
//
// Normalization is conservative: DOI prefixes ("doi:",
// "https://doi.org/", "http://doi.org/") are stripped and the value
// is lowercased; PMID must be digits; PMCID must match PMC<digits>
// (normalized to uppercase PMC). Invalid shapes are rejected, never
// silently rewritten.

import { createHash } from 'node:crypto';
import { ApiError } from '../../plugins/envelope.js';

const DOI_PATTERN = /^10\.\d{4,9}\/[^\s]+$/;
const PMID_PATTERN = /^\d+$/;
const PMCID_PATTERN = /^PMC\d+$/;

export function normalizeDoi(raw: string): string {
  let value = raw.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith('https://doi.org/')) {
    value = value.slice('https://doi.org/'.length);
  } else if (lower.startsWith('http://doi.org/')) {
    value = value.slice('http://doi.org/'.length);
  } else if (lower.startsWith('doi:')) {
    value = value.slice('doi:'.length);
  }
  return value.trim().toLowerCase();
}

export function isValidDoi(value: string): boolean {
  return DOI_PATTERN.test(value);
}

export function normalizePmid(raw: string): string {
  return raw.trim();
}

export function isValidPmid(value: string): boolean {
  return PMID_PATTERN.test(value);
}

export function normalizePmcid(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidPmcid(value: string): boolean {
  return PMCID_PATTERN.test(value);
}

export interface SourceIdInput {
  doi?: string | undefined;
  pmid?: string | undefined;
  pmcid?: string | undefined;
  url?: string | undefined;
}

// Derive the deterministic source id. Present-but-invalid identifiers
// are a validation error (400), not a silent fallback, so a malformed
// DOI can never dedupe against a different source by accident.
export function deriveSourceId(input: SourceIdInput): string {
  if (input.doi !== undefined && input.doi.trim() !== '') {
    const doi = normalizeDoi(input.doi);
    if (!isValidDoi(doi)) {
      throw ApiError.validation('The DOI is not valid.');
    }
    return `doi:${doi}`;
  }
  if (input.pmid !== undefined && input.pmid.trim() !== '') {
    const pmid = normalizePmid(input.pmid);
    if (!isValidPmid(pmid)) {
      throw ApiError.validation('The PMID is not valid.');
    }
    return `pmid:${pmid}`;
  }
  if (input.pmcid !== undefined && input.pmcid.trim() !== '') {
    const pmcid = normalizePmcid(input.pmcid);
    if (!isValidPmcid(pmcid)) {
      throw ApiError.validation('The PMCID is not valid.');
    }
    return `pmcid:${pmcid}`;
  }
  if (input.url !== undefined && input.url.trim() !== '') {
    const hash = createHash('sha256').update(input.url.trim()).digest('hex');
    return `url:${hash}`;
  }
  throw ApiError.validation('A DOI, PMID, PMCID, or URL is required to derive a source id.');
}
