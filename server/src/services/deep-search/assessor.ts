// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Assessor stage (F2-2, wave G-F2-2d).
//
// Pure and deterministic: no network, no clock, no randomness.
// From the collector candidates of one job it derives fact
// candidates, one per source candidate that carries both a title
// and a snippet. The fact text is the candidate title. Each fact
// gets a 0-100 heuristic score from candidate metadata only, so
// the same input always yields the same output and specs can
// assert exact numbers.
//
// Scoring (integer points, clamped to 0-100):
// - Base per source kind: pubmed 45, europepmc 45, exa 30. The
//   PubMed chain is the binding primary source; Exa is the
//   non-PubMed collector and starts lower.
// - Identifier bonus: doi +10, pmid +10, pmcid +5.
// - Open access bonus: oaFlag true +10.
// - Snippet present +5. Only candidates with a snippet become
//   facts, so this bonus always applies to a derived fact; it is
//   still scored explicitly so the note stays self-describing.
// - Year present +5.
// - Corroboration +15 when the same identity (externalId, doi,
//   or pmid) appears from more than one distinct source kind in
//   the same candidate set. Corroboration is computed over the
//   full input set, including candidates that do not become
//   facts, because the second sighting is evidence either way.
//
// Status follows the F2-1 rule: score >= 50 is mapped, below 50
// without reinforcement is unmapped. The assessor note lists the
// score components in short non-secret form. This stage never
// writes F2-1 data: facts stay candidates until the writing
// stage of a later wave.

import type {
  FactCandidateStatus,
  SearchCandidateRow,
  SourceKind,
} from './represent.js';

export const MAPPED_THRESHOLD = 50;
export const CORROBORATION_BONUS = 15;

export interface AssessedFact {
  // Source candidate row id this fact was derived from.
  candidateId: string;
  text: string;
  score: number;
  status: FactCandidateStatus;
  assessorNote: string;
  sourceKind: SourceKind;
}

const BASE_SCORE: Record<SourceKind, number> = {
  pubmed: 45,
  europepmc: 45,
  exa: 30,
};

function nonEmpty(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function identityKeys(candidate: SearchCandidateRow): string[] {
  const keys: string[] = [`external:${candidate.externalId}`];
  const doi = nonEmpty(candidate.doi);
  if (doi !== null) {
    keys.push(`doi:${doi.toLowerCase()}`);
  }
  const pmid = nonEmpty(candidate.pmid);
  if (pmid !== null) {
    keys.push(`pmid:${pmid}`);
  }
  return keys;
}

function corroboratedCandidateIds(candidates: SearchCandidateRow[]): Set<string> {
  const kindsByKey = new Map<string, Set<SourceKind>>();
  for (const candidate of candidates) {
    for (const key of identityKeys(candidate)) {
      let kinds = kindsByKey.get(key);
      if (kinds === undefined) {
        kinds = new Set<SourceKind>();
        kindsByKey.set(key, kinds);
      }
      kinds.add(candidate.sourceKind);
    }
  }
  const corroborated = new Set<string>();
  for (const candidate of candidates) {
    for (const key of identityKeys(candidate)) {
      const kinds = kindsByKey.get(key);
      if (kinds !== undefined && kinds.size > 1) {
        corroborated.add(candidate.id);
        break;
      }
    }
  }
  return corroborated;
}

export function assessCandidates(candidates: SearchCandidateRow[]): AssessedFact[] {
  const corroborated = corroboratedCandidateIds(candidates);
  const facts: AssessedFact[] = [];
  for (const candidate of candidates) {
    const title = nonEmpty(candidate.title);
    const snippet = nonEmpty(candidate.snippet);
    if (title === null || snippet === null) {
      continue;
    }
    const base = BASE_SCORE[candidate.sourceKind];
    const doiBonus = nonEmpty(candidate.doi) !== null ? 10 : 0;
    const pmidBonus = nonEmpty(candidate.pmid) !== null ? 10 : 0;
    const pmcidBonus = nonEmpty(candidate.pmcid) !== null ? 5 : 0;
    const oaBonus = candidate.oaFlag === true ? 10 : 0;
    const snippetBonus = 5;
    const yearBonus = candidate.year !== null ? 5 : 0;
    const corroborationBonus = corroborated.has(candidate.id) ? CORROBORATION_BONUS : 0;
    const raw =
      base + doiBonus + pmidBonus + pmcidBonus + oaBonus + snippetBonus + yearBonus + corroborationBonus;
    const score = Math.max(0, Math.min(100, raw));
    const status: FactCandidateStatus = score >= MAPPED_THRESHOLD ? 'mapped' : 'unmapped';
    const assessorNote =
      `base=${base} doi=+${doiBonus} pmid=+${pmidBonus} pmcid=+${pmcidBonus} ` +
      `oa=+${oaBonus} snippet=+${snippetBonus} year=+${yearBonus} ` +
      `corroboration=+${corroborationBonus} total=${score}`;
    facts.push({
      candidateId: candidate.id,
      text: title,
      score,
      status,
      assessorNote,
      sourceKind: candidate.sourceKind,
    });
  }
  return facts;
}

export function averageScoreOf(scores: number[]): number | null {
  if (scores.length === 0) return null;
  const sum = scores.reduce((total, value) => total + value, 0);
  return Math.round((sum / scores.length) * 100) / 100;
}
