// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deterministic specs for the hipospadia migration planner (wave
// G-F2-1c): research reference parsing, citation-map parsing, number
// preservation with gaps, the unmapped rule, conservative mark
// matching, and the bibliography preview. Pure functions only; the
// gated SQL apply lives in server/scripts and is not exercised here.

import { describe, expect, it } from 'vitest';
import {
  buildMigrationPlan,
  formatPlanReport,
  parseCitationMap,
  parseResearchReferences,
  plannedBibliographyText,
  type MarkInput,
} from '../src/services/citations/hipospadia-migration.js';

const RESEARCH = [
  '# Title',
  '',
  '## Referensi (4)',
  '',
  '1. Halaseh SA et al. Hypospadias: A Comprehensive Review. Cureus. 2022;14. [PMID 36060359; PMCID PMC9428502; DOI 10.7759/cureus.27544; full text dibaca]',
  '2. van der Horst HJ et al. Hypospadias, all there is to know. Eur J Pediatr. 2017;176. [PMID 28190103; PMCID PMC5352742; DOI 10.1007/s00431-017-2864-5; full text dibaca per seksi]',
  '3. Baskin LS et al. Hypospadias and endocrine disruption: is there a connection?. Environ Health Perspect. 2001;109. [PMID 11713004; PMCID PMC1240480; DOI 10.1289/ehp.011091175; abstrak dibaca]',
  '4. European Association of Urology. EAU Guidelines on Paediatric Urology - Hypospadias (bab 9). Uroweb. https://uroweb.org/guidelines/paediatric-urology/chapter/hypospadias [diakses 2026-11-21 via sorotan Exa]',
].join('\n');

const MAP = {
  facts: [
    { id: 'E1', fact: 'Fact one', refs: [1, 2], score: 90, unmapped: false },
    { id: 'E2', fact: 'Fact two', refs: [4], score: 55, unmapped: false },
    { id: 'T22', fact: 'Unmapped no score', refs: [], score: null, unmapped: true },
    { id: 'T23', fact: 'Unmapped with candidates', refs: [2, 3], score: 48, unmapped: true },
  ],
};

const MARKS: MarkInput[] = [
  {
    id: 8,
    type: 'link',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9428502/',
    sourceId: 'x',
    desc: 'pmc.ncbi.nlm.nih.gov',
    content: '',
    tags: ['hipospadia'],
  },
  {
    id: 9,
    type: 'link',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9428502/',
    sourceId: 'y',
    desc: 'pmc.ncbi.nlm.nih.gov',
    content: '',
    tags: ['hipospadia'],
  },
  {
    id: 6,
    type: 'link',
    url: 'https://uroweb.org/guidelines/paediatric-urology/chapter/hypospadias',
    sourceId: 'z',
    desc: 'uroweb.org',
    content: '',
    tags: ['hipospadia'],
  },
  {
    id: 18,
    type: 'image',
    url: 'ast_123',
    sourceId: 'w',
    desc: 'Klasifikasi posisi meatus hipospadia',
    content: '',
    tags: ['hipospadia'],
  },
];

describe('parseResearchReferences', () => {
  it('parses numbered lines with identifiers and split fields', () => {
    const { references, issues } = parseResearchReferences(RESEARCH);
    expect(references).toHaveLength(4);
    expect(issues).toEqual([]);
    const first = references[0];
    expect(first?.oldNumber).toBe(1);
    expect(first?.authors).toBe('Halaseh SA et al');
    expect(first?.title).toBe('Hypospadias: A Comprehensive Review');
    expect(first?.journal).toBe('Cureus');
    expect(first?.year).toBe(2022);
    expect(first?.doi).toBe('10.7759/cureus.27544');
    expect(first?.pmid).toBe('36060359');
    expect(first?.pmcid).toBe('PMC9428502');
    expect(first?.oaFlag).toBe(true);
    const web = references[3];
    expect(web?.doi).toBeUndefined();
    expect(web?.pmid).toBeUndefined();
    expect(web?.url).toBe('https://uroweb.org/guidelines/paediatric-urology/chapter/hypospadias');
    expect(web?.year).toBeUndefined();
  });

  it('reports duplicate DOIs instead of merging silently', () => {
    const text = [
      '## Referensi (2)',
      '1. A A et al. First title. J One. 2020;1. [PMID 111; DOI 10.1000/abc]',
      '2. B B et al. Second title. J Two. 2021;2. [PMID 222; DOI 10.1000/ABC]',
    ].join('\n');
    const { issues } = parseResearchReferences(text);
    expect(issues.some((i) => i.kind === 'duplicate-doi')).toBe(true);
  });
});

describe('parseCitationMap', () => {
  it('keeps null scores and unmapped flags verbatim', () => {
    const { facts, issues } = parseCitationMap(MAP);
    expect(facts).toHaveLength(4);
    expect(issues).toEqual([]);
    expect(facts.find((f) => f.oldId === 'T22')?.score).toBeNull();
    expect(facts.find((f) => f.oldId === 'T23')?.unmapped).toBe(true);
  });

  it('rejects malformed shapes with issues, never throws', () => {
    expect(parseCitationMap(null).facts).toEqual([]);
    expect(parseCitationMap({ facts: 'nope' }).issues.length).toBeGreaterThan(0);
    const { facts } = parseCitationMap({ facts: [{ id: '', fact: '' }, { id: 'X1', fact: 'ok', refs: ['a'], score: 500 }] });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.score).toBeNull();
  });
});

describe('buildMigrationPlan', () => {
  it('preserves numbers, leaves unused references unnumbered, drops unmapped links', () => {
    const refs = parseResearchReferences(RESEARCH);
    const map = parseCitationMap(MAP);
    const plan = buildMigrationPlan({
      projectKey: 'deck-hipospadia',
      references: refs.references,
      facts: map.facts,
      marks: MARKS,
      parseIssues: [...refs.issues, ...map.issues],
    });
    // Reference 3 is cited only by unmapped T23, so it stays
    // unnumbered; 1, 2, 4 keep their research numbers (gap at 3).
    expect(plan.references.map((r) => r.number)).toEqual([1, 2, null, 4]);
    expect(plan.counts).toMatchObject({
      references: 4,
      numberedReferences: 3,
      unnumberedReferences: 1,
      facts: 4,
      mappedFacts: 2,
      unmappedFacts: 2,
      links: 3,
      droppedLinks: 2,
      marks: 4,
      matchedMarks: 3,
      unmatchedMarks: 1,
    });
    const t22 = plan.facts.find((f) => f.oldId === 'T22');
    expect(t22?.score).toBe(0);
    expect(t22?.scoreWasAbsent).toBe(true);
    expect(t22?.linkOldNumbers).toEqual([]);
    const t23 = plan.facts.find((f) => f.oldId === 'T23');
    expect(t23?.linkOldNumbers).toEqual([]);
    expect(t23?.droppedOldNumbers).toEqual([2, 3]);
  });

  it('matches marks conservatively and picks the lowest mark id as canonical', () => {
    const refs = parseResearchReferences(RESEARCH);
    const map = parseCitationMap(MAP);
    const plan = buildMigrationPlan({
      projectKey: 'deck-hipospadia',
      references: refs.references,
      facts: map.facts,
      marks: MARKS,
    });
    expect(plan.markMatches).toEqual([
      { markId: 8, oldNumber: 1, rule: 'pmcid' },
      { markId: 9, oldNumber: 1, rule: 'pmcid' },
      { markId: 6, oldNumber: 4, rule: 'url' },
      { markId: 18, oldNumber: null, rule: 'unmatched' },
    ]);
    expect(plan.references.find((r) => r.oldNumber === 1)?.sourceRecordId).toBe(8);
    expect(plan.references.find((r) => r.oldNumber === 4)?.sourceRecordId).toBe(6);
    expect(plan.references.find((r) => r.oldNumber === 2)?.sourceRecordId).toBeNull();
  });

  it('renders the bibliography preview with numbered references only', () => {
    const refs = parseResearchReferences(RESEARCH);
    const map = parseCitationMap(MAP);
    const plan = buildMigrationPlan({
      projectKey: 'deck-hipospadia',
      references: refs.references,
      facts: map.facts,
      marks: MARKS,
    });
    const text = plannedBibliographyText(plan);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('1. Halaseh SA et al.');
    expect(lines[0]).toContain('doi:10.7759/cureus.27544');
    expect(lines[2]).toContain('4. European Association of Urology.');
    expect(text).not.toContain('Baskin');
    expect(formatPlanReport(plan)).toContain('projectKey: deck-hipospadia');
  });
});
