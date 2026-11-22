// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Hipospadia demo-data migration planner (Fase 2, wave G-F2-1c).
//
// Design: fase1/evidence/fase2/rancangan-f2-1.md sections 2.2 and 6.
// The hipospadia pipeline test left its citation data in loose files
// (research.md with 103 numbered references, citation_map.json with
// scored facts) and 14 production records tagged "hipospadia" without
// structured bibliography. This module turns those files plus a marks
// listing into a deterministic migration plan for the F2-1 schema
// (references, facts, fact_references, mark_bibliography). It is pure:
// no database, no filesystem, no clock. The CLI in
// server/scripts/f2-1c-hipospadia-migration.mjs owns file reading, the
// read-only dry-run checks, and the gated SQL apply.
//
// Binding rules carried over from the design:
// - Numbering is preserved: a used reference keeps its research.md
//   number so existing [n] markers in the deck and notes keep their
//   meaning. References no fact cites stay unnumbered (number null)
//   and are excluded from the bibliography, exactly like references
//   that were never mapped through the repository. Gaps are allowed;
//   the next new reference continues at max + 1.
// - A fact marked unmapped in the source never receives a link, even
//   when the source JSON lists candidate references for it. Dropped
//   candidate links are reported, never silently kept.
// - A missing source score (fact T22 has none) is stored as 0 and
//   reported. Scores are never invented beyond that floor.
// - Mark matching is conservative and ordered: PMCID, then PMID,
//   then exact URL, then unique first-author + year. Anything
//   ambiguous stays unmatched and is reported. Asset records without
//   a bibliographic identity (the classification image) stay
//   unmatched by design.
// - When several marks match one reference, every matched mark gets
//   a bibliography companion row, and the reference points at the
//   lowest mark id as its canonical source record.

import { formatBibliography } from './bibliography.js';
import type { ReferenceRow } from './represent.js';
import {
  isValidDoi,
  isValidPmcid,
  isValidPmid,
  normalizeDoi,
  normalizePmcid,
  normalizePmid,
} from './source-id.js';

export const HIPOSPADIAS_PROJECT_KEY = 'deck-hipospadia';

export interface ParsedReference {
  oldNumber: number;
  authors: string | undefined;
  title: string | undefined;
  journal: string | undefined;
  year: number | undefined;
  doi: string | undefined;
  pmid: string | undefined;
  pmcid: string | undefined;
  url: string | undefined;
  oaFlag: boolean | undefined;
  // True when the authors/title/journal split fell back to storing
  // the whole citation body as the title.
  parseFallback: boolean;
  rawLine: string;
}

export interface ParsedFact {
  oldId: string;
  text: string;
  // Null in the source (T22); the plan stores 0 and reports it.
  score: number | null;
  unmapped: boolean;
  oldRefNumbers: number[];
}

export interface MarkInput {
  id: number;
  type: string;
  url: string | null;
  sourceId: string | null;
  desc: string | null;
  content: string | null;
  tags: string[];
}

export interface PlanIssue {
  kind: string;
  detail: string;
}

export interface PlanReference extends ParsedReference {
  // Preserved research.md number when at least one mapped fact cites
  // this reference; null when unused (never mapped, no marker).
  number: number | null;
  sourceRecordId: number | null;
}

export interface PlanFact {
  oldId: string;
  text: string;
  score: number;
  scoreWasAbsent: boolean;
  status: 'mapped' | 'unmapped';
  // Old reference numbers this fact links to (mapped facts only).
  linkOldNumbers: number[];
  // Candidate links dropped because the fact is unmapped.
  droppedOldNumbers: number[];
}

export interface MarkMatch {
  markId: number;
  oldNumber: number | null;
  rule: 'pmcid' | 'pmid' | 'url' | 'author-year' | 'unmatched';
}

export interface MigrationPlan {
  projectKey: string;
  references: PlanReference[];
  facts: PlanFact[];
  markMatches: MarkMatch[];
  issues: PlanIssue[];
  counts: {
    references: number;
    numberedReferences: number;
    unnumberedReferences: number;
    facts: number;
    mappedFacts: number;
    unmappedFacts: number;
    links: number;
    droppedLinks: number;
    marks: number;
    matchedMarks: number;
    unmatchedMarks: number;
  };
}

const REFERENCE_HEADING = '## Referensi';
const PMID_PATTERN = /PMID[:\s]*(\d+)/;
const PMCID_PATTERN = /PMCID[:\s]*(PMC\d+)/;
const DOI_PATTERN = /DOI[:\s]*(10\.\d{4,9}\/[^\s;\]]+)/;
const URL_PATTERN = /https?:\/\/[^\s\]]+/;
const YEAR_SEGMENT_PATTERN = /^(\d{4})(?:;|\.|$)/;

function extractIdentifiers(line: string): {
  doi: string | undefined;
  pmid: string | undefined;
  pmcid: string | undefined;
  url: string | undefined;
  issues: PlanIssue[];
  oldNumber: number;
} {
  const issues: PlanIssue[] = [];
  const oldNumber = Number.parseInt(line.split('.')[0] ?? '0', 10);
  let doi: string | undefined;
  const doiMatch = DOI_PATTERN.exec(line);
  if (doiMatch?.[1] !== undefined) {
    const candidate = normalizeDoi(doiMatch[1].replace(/[.,]$/, ''));
    if (isValidDoi(candidate)) {
      doi = candidate;
    } else {
      issues.push({
        kind: 'invalid-doi',
        detail: `reference ${oldNumber}: DOI "${doiMatch[1]}" failed validation and was omitted`,
      });
    }
  }
  let pmid: string | undefined;
  const pmidMatch = PMID_PATTERN.exec(line);
  if (pmidMatch?.[1] !== undefined) {
    const candidate = normalizePmid(pmidMatch[1]);
    if (isValidPmid(candidate)) {
      pmid = candidate;
    } else {
      issues.push({
        kind: 'invalid-pmid',
        detail: `reference ${oldNumber}: PMID "${pmidMatch[1]}" failed validation and was omitted`,
      });
    }
  }
  let pmcid: string | undefined;
  const pmcidMatch = PMCID_PATTERN.exec(line);
  if (pmcidMatch?.[1] !== undefined) {
    const candidate = normalizePmcid(pmcidMatch[1]);
    if (isValidPmcid(candidate)) {
      pmcid = candidate;
    } else {
      issues.push({
        kind: 'invalid-pmcid',
        detail: `reference ${oldNumber}: PMCID "${pmcidMatch[1]}" failed validation and was omitted`,
      });
    }
  }
  const urlMatch = URL_PATTERN.exec(line);
  const url = urlMatch?.[0]?.replace(/[.,]$/, '');
  return { doi, pmid, pmcid, url, issues, oldNumber };
}

function extractOaFlag(line: string): boolean | undefined {
  const lower = line.toLowerCase();
  if (lower.includes('non-oa') || lower.includes('berbayar')) return false;
  if (lower.includes('full text')) return true;
  if (lower.includes('halaman resmi') || lower.includes('halaman web resmi')) return true;
  return undefined;
}

// Cut the citation body at the first identifier-note marker so the
// authors/title/journal/year split never sees bracket notes.
function citationBody(line: string): string {
  const withoutNumber = line.replace(/^\d+\.\s*/, '');
  const cutMarkers = ['[PMID', 'PMID ', 'PMID:', '[diakses', '(abstrak', '(full text', '(Full text'];
  let cut = withoutNumber.length;
  for (const marker of cutMarkers) {
    const idx = withoutNumber.indexOf(marker);
    if (idx >= 0 && idx < cut) cut = idx;
  }
  return withoutNumber.slice(0, cut).trim().replace(/\.$/, '');
}

function splitCitationBody(body: string): {
  authors: string | undefined;
  title: string | undefined;
  journal: string | undefined;
  year: number | undefined;
  parseFallback: boolean;
} {
  const segments = body.split('. ').map((s) => s.trim()).filter((s) => s !== '');
  if (segments.length < 2) {
    return { authors: undefined, title: body, journal: undefined, year: undefined, parseFallback: true };
  }
  const authors = segments[0];
  // The year lives in a trailing "YYYY;volume" segment when present.
  let year: number | undefined;
  let yearIdx = -1;
  for (let i = segments.length - 1; i >= 1; i -= 1) {
    const match = YEAR_SEGMENT_PATTERN.exec(segments[i] ?? '');
    if (match?.[1] !== undefined) {
      const value = Number.parseInt(match[1], 10);
      if (value >= 1900 && value <= 2099) {
        year = value;
        yearIdx = i;
        break;
      }
    }
  }
  // Segments after the year segment (volume leftovers) are ignored;
  // a URL segment is never a journal.
  const beforeYear = yearIdx >= 0 ? segments.slice(1, yearIdx) : segments.slice(1);
  const textSegments = beforeYear.filter((s) => !s.startsWith('http'));
  if (textSegments.length === 0) {
    return { authors, title: undefined, journal: undefined, year, parseFallback: true };
  }
  if (textSegments.length === 1) {
    return { authors, title: textSegments[0], journal: undefined, year, parseFallback: false };
  }
  const journal = textSegments[textSegments.length - 1];
  const title = textSegments.slice(0, -1).join('. ');
  return { authors, title, journal, year, parseFallback: false };
}

export function parseResearchReferences(markdown: string): {
  references: ParsedReference[];
  issues: PlanIssue[];
} {
  const issues: PlanIssue[] = [];
  const headingIdx = markdown.indexOf(REFERENCE_HEADING);
  if (headingIdx < 0) {
    issues.push({ kind: 'missing-heading', detail: 'reference heading not found in research text' });
    return { references: [], issues };
  }
  const section = markdown.slice(headingIdx);
  const references: ParsedReference[] = [];
  const seenNumbers = new Set<number>();
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (!/^\d+\.\s/.test(line)) continue;
    const ids = extractIdentifiers(line);
    issues.push(...ids.issues);
    if (seenNumbers.has(ids.oldNumber)) {
      issues.push({
        kind: 'duplicate-number',
        detail: `reference number ${ids.oldNumber} appears twice; second occurrence skipped`,
      });
      continue;
    }
    seenNumbers.add(ids.oldNumber);
    const split = splitCitationBody(citationBody(line));
    if (split.parseFallback) {
      issues.push({
        kind: 'parse-fallback',
        detail: `reference ${ids.oldNumber}: citation body stored as title without split`,
      });
    }
    references.push({
      oldNumber: ids.oldNumber,
      authors: split.authors,
      title: split.title,
      journal: split.journal,
      year: split.year,
      doi: ids.doi,
      pmid: ids.pmid,
      pmcid: ids.pmcid,
      url: ids.url,
      oaFlag: extractOaFlag(line),
      parseFallback: split.parseFallback,
      rawLine: line,
    });
  }
  references.sort((a, b) => a.oldNumber - b.oldNumber);
  // Duplicate identifiers across references would violate the unique
  // indexes; report them here so the plan fails closed at review.
  const seenDoi = new Map<string, number>();
  const seenPmid = new Map<string, number>();
  for (const ref of references) {
    if (ref.doi !== undefined) {
      const prior = seenDoi.get(ref.doi);
      if (prior !== undefined) {
        issues.push({
          kind: 'duplicate-doi',
          detail: `DOI ${ref.doi} shared by references ${prior} and ${ref.oldNumber}`,
        });
      } else {
        seenDoi.set(ref.doi, ref.oldNumber);
      }
    }
    if (ref.pmid !== undefined) {
      const prior = seenPmid.get(ref.pmid);
      if (prior !== undefined) {
        issues.push({
          kind: 'duplicate-pmid',
          detail: `PMID ${ref.pmid} shared by references ${prior} and ${ref.oldNumber}`,
        });
      } else {
        seenPmid.set(ref.pmid, ref.oldNumber);
      }
    }
  }
  return { references, issues };
}

export function parseCitationMap(json: unknown): { facts: ParsedFact[]; issues: PlanIssue[] } {
  const issues: PlanIssue[] = [];
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    issues.push({ kind: 'bad-map', detail: 'citation map is not an object' });
    return { facts: [], issues };
  }
  const rawFacts = (json as Record<string, unknown>)['facts'];
  if (!Array.isArray(rawFacts)) {
    issues.push({ kind: 'bad-map', detail: 'citation map has no facts array' });
    return { facts: [], issues };
  }
  const facts: ParsedFact[] = [];
  const seenIds = new Set<string>();
  for (const entry of rawFacts) {
    if (typeof entry !== 'object' || entry === null) {
      issues.push({ kind: 'bad-fact', detail: 'fact entry is not an object; skipped' });
      continue;
    }
    const record = entry as Record<string, unknown>;
    const oldId = typeof record['id'] === 'string' ? record['id'] : '';
    const text = typeof record['fact'] === 'string' ? record['fact'] : '';
    if (oldId === '' || text.trim() === '') {
      issues.push({ kind: 'bad-fact', detail: 'fact entry without id or text; skipped' });
      continue;
    }
    if (seenIds.has(oldId)) {
      issues.push({ kind: 'duplicate-fact-id', detail: `fact id ${oldId} appears twice; second skipped` });
      continue;
    }
    seenIds.add(oldId);
    const rawScore = record['score'];
    let score: number | null = null;
    if (typeof rawScore === 'number' && Number.isInteger(rawScore) && rawScore >= 0 && rawScore <= 100) {
      score = rawScore;
    } else if (rawScore !== null && rawScore !== undefined) {
      issues.push({
        kind: 'bad-score',
        detail: `fact ${oldId}: score ${String(rawScore)} is not an integer 0-100; stored as 0`,
      });
    }
    const rawRefs = record['refs'];
    const oldRefNumbers: number[] = [];
    if (Array.isArray(rawRefs)) {
      for (const value of rawRefs) {
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
          oldRefNumbers.push(value);
        } else {
          issues.push({
            kind: 'bad-ref',
            detail: `fact ${oldId}: reference value ${String(value)} is not a positive integer; ignored`,
          });
        }
      }
    }
    facts.push({ oldId, text: text.trim(), score, unmapped: record['unmapped'] === true, oldRefNumbers });
  }
  return { facts, issues };
}

function firstAuthorSurname(authors: string | undefined): string | undefined {
  if (authors === undefined) return undefined;
  const first = authors.split(',')[0]?.trim() ?? '';
  const surname = first.split(/\s+/)[0]?.trim() ?? '';
  return surname === '' ? undefined : surname;
}

function matchMark(
  mark: MarkInput,
  references: ParsedReference[],
  byPmcid: Map<string, ParsedReference>,
  byPmid: Map<string, ParsedReference>,
  byUrl: Map<string, ParsedReference>,
): MarkMatch {
  const haystack = `${mark.url ?? ''}\n${mark.desc ?? ''}\n${mark.content ?? ''}`;
  const pmcidMatch = /PMC\d+/.exec(haystack);
  if (pmcidMatch !== null) {
    const ref = byPmcid.get(normalizePmcid(pmcidMatch[0]));
    if (ref !== undefined) return { markId: mark.id, oldNumber: ref.oldNumber, rule: 'pmcid' };
  }
  const pmidMatch = PMID_PATTERN.exec(haystack);
  if (pmidMatch?.[1] !== undefined) {
    const ref = byPmid.get(normalizePmid(pmidMatch[1]));
    if (ref !== undefined) return { markId: mark.id, oldNumber: ref.oldNumber, rule: 'pmid' };
  }
  const markUrl = (mark.url ?? '').trim();
  if (markUrl !== '') {
    const ref = byUrl.get(markUrl);
    if (ref !== undefined) return { markId: mark.id, oldNumber: ref.oldNumber, rule: 'url' };
  }
  const text = `${mark.desc ?? ''}\n${mark.content ?? ''}`;
  const candidates: ParsedReference[] = [];
  for (const ref of references) {
    const surname = firstAuthorSurname(ref.authors);
    if (surname === undefined || ref.year === undefined) continue;
    if (text.includes(surname) && text.includes(String(ref.year))) {
      candidates.push(ref);
    }
  }
  if (candidates.length === 1 && candidates[0] !== undefined) {
    return { markId: mark.id, oldNumber: candidates[0].oldNumber, rule: 'author-year' };
  }
  return { markId: mark.id, oldNumber: null, rule: 'unmatched' };
}

export function buildMigrationPlan(input: {
  projectKey: string;
  references: ParsedReference[];
  facts: ParsedFact[];
  marks: MarkInput[];
  parseIssues?: PlanIssue[];
}): MigrationPlan {
  const issues: PlanIssue[] = [...(input.parseIssues ?? [])];
  const refByNumber = new Map<number, ParsedReference>();
  for (const ref of input.references) refByNumber.set(ref.oldNumber, ref);

  const planFacts: PlanFact[] = [];
  const usedNumbers = new Set<number>();
  let links = 0;
  let droppedLinks = 0;
  for (const fact of input.facts) {
    const known: number[] = [];
    for (const oldNumber of fact.oldRefNumbers) {
      if (refByNumber.has(oldNumber)) {
        known.push(oldNumber);
      } else {
        issues.push({
          kind: 'unknown-ref',
          detail: `fact ${fact.oldId}: reference ${oldNumber} not found in research list; link ignored`,
        });
      }
    }
    if (fact.unmapped) {
      if (known.length > 0) {
        droppedLinks += known.length;
        issues.push({
          kind: 'unmapped-links-dropped',
          detail: `fact ${fact.oldId}: unmapped, ${known.length} candidate link(s) dropped [${known.join(', ')}]`,
        });
      }
      planFacts.push({
        oldId: fact.oldId,
        text: fact.text,
        score: fact.score ?? 0,
        scoreWasAbsent: fact.score === null,
        status: 'unmapped',
        linkOldNumbers: [],
        droppedOldNumbers: known,
      });
    } else {
      if (known.length === 0) {
        issues.push({
          kind: 'mapped-without-links',
          detail: `fact ${fact.oldId}: marked mapped but has no resolvable reference`,
        });
      }
      for (const oldNumber of known) usedNumbers.add(oldNumber);
      links += known.length;
      planFacts.push({
        oldId: fact.oldId,
        text: fact.text,
        score: fact.score ?? 0,
        scoreWasAbsent: fact.score === null,
        status: 'mapped',
        linkOldNumbers: known,
        droppedOldNumbers: [],
      });
    }
    if (fact.score === null) {
      issues.push({
        kind: 'score-absent',
        detail: `fact ${fact.oldId}: no score in source; stored as 0`,
      });
    }
  }

  const byPmcid = new Map<string, ParsedReference>();
  const byPmid = new Map<string, ParsedReference>();
  const byUrl = new Map<string, ParsedReference>();
  for (const ref of input.references) {
    if (ref.pmcid !== undefined) byPmcid.set(ref.pmcid, ref);
    if (ref.pmid !== undefined) byPmid.set(ref.pmid, ref);
    if (ref.url !== undefined) byUrl.set(ref.url, ref);
  }
  const markMatches = input.marks.map((mark) => matchMark(mark, input.references, byPmcid, byPmid, byUrl));
  const canonicalMarkByRef = new Map<number, number>();
  for (const match of markMatches) {
    if (match.oldNumber === null) {
      issues.push({
        kind: 'mark-unmatched',
        detail: `mark ${match.markId}: no conservative bibliographic match; no companion row planned`,
      });
      continue;
    }
    const prior = canonicalMarkByRef.get(match.oldNumber);
    if (prior === undefined || match.markId < prior) {
      canonicalMarkByRef.set(match.oldNumber, match.markId);
    }
  }

  const planReferences: PlanReference[] = input.references.map((ref) => ({
    ...ref,
    number: usedNumbers.has(ref.oldNumber) ? ref.oldNumber : null,
    sourceRecordId: canonicalMarkByRef.get(ref.oldNumber) ?? null,
  }));

  const numbered = planReferences.filter((r) => r.number !== null).length;
  return {
    projectKey: input.projectKey,
    references: planReferences,
    facts: planFacts,
    markMatches,
    issues,
    counts: {
      references: planReferences.length,
      numberedReferences: numbered,
      unnumberedReferences: planReferences.length - numbered,
      facts: planFacts.length,
      mappedFacts: planFacts.filter((f) => f.status === 'mapped').length,
      unmappedFacts: planFacts.filter((f) => f.status === 'unmapped').length,
      links,
      droppedLinks,
      marks: input.marks.length,
      matchedMarks: markMatches.filter((m) => m.oldNumber !== null).length,
      unmatchedMarks: markMatches.filter((m) => m.oldNumber === null).length,
    },
  };
}

// Bibliography preview rows: planned references in ReferenceRow shape
// with placeholder ids, so formatBibliography renders exactly what
// the gated apply will make readable through the citations routes.
export function plannedBibliographyText(plan: MigrationPlan): string {
  const rows: ReferenceRow[] = plan.references.map((ref, index) => ({
    id: `planned-${ref.oldNumber}`,
    workspaceId: 'planned',
    projectKey: plan.projectKey,
    number: ref.number,
    sourceRecordId: ref.sourceRecordId,
    title: ref.title ?? null,
    authors: ref.authors ?? null,
    journal: ref.journal ?? null,
    year: ref.year ?? null,
    doi: ref.doi ?? null,
    pmid: ref.pmid ?? null,
    pmcid: ref.pmcid ?? null,
    url: ref.url ?? null,
    oaFlag: ref.oaFlag ?? null,
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  return formatBibliography(rows);
}

export function formatPlanReport(plan: MigrationPlan): string {
  const lines: string[] = [];
  const c = plan.counts;
  lines.push(`projectKey: ${plan.projectKey}`);
  lines.push(
    `references: ${c.references} (numbered ${c.numberedReferences}, unnumbered ${c.unnumberedReferences})`,
  );
  lines.push(`facts: ${c.facts} (mapped ${c.mappedFacts}, unmapped ${c.unmappedFacts})`);
  lines.push(`links: ${c.links} (dropped unmapped candidates ${c.droppedLinks})`);
  lines.push(`marks: ${c.marks} (matched ${c.matchedMarks}, unmatched ${c.unmatchedMarks})`);
  lines.push('');
  lines.push('mark mapping (markId -> oldNumber via rule):');
  for (const match of plan.markMatches) {
    lines.push(`- mark ${match.markId} -> ${match.oldNumber === null ? 'none' : match.oldNumber} (${match.rule})`);
  }
  lines.push('');
  lines.push('unmapped facts (no marker, no links):');
  for (const fact of plan.facts) {
    if (fact.status === 'unmapped') {
      lines.push(`- ${fact.oldId} score ${fact.score}${fact.scoreWasAbsent ? ' (absent in source)' : ''}: ${fact.text}`);
    }
  }
  lines.push('');
  lines.push('unnumbered references (cited by no mapped fact):');
  for (const ref of plan.references) {
    if (ref.number === null) lines.push(`- ${ref.oldNumber}. ${ref.title ?? '(no title)'}`);
  }
  lines.push('');
  lines.push(`issues: ${plan.issues.length}`);
  for (const issue of plan.issues) {
    lines.push(`- [${issue.kind}] ${issue.detail}`);
  }
  return lines.join('\n');
}
