// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deep Search Assessor and Complement trigger specs (F2-2, wave
// G-F2-2d): deterministic scoring, the 50-point mapped threshold,
// cross-source corroboration, and the Complement trigger in both
// directions. Pure functions only, no network.

import { describe, expect, it } from 'vitest';
import { assessCandidates } from '../src/services/deep-search/assessor.js';
import { evaluateComplementTrigger } from '../src/services/deep-search/complement.js';
import type {
  SearchCandidateRow,
  SearchFactCandidateRow,
} from '../src/services/deep-search/represent.js';

const JOB_ID = '00000000-0000-4000-8000-0000000000aa';

let counter = 0;
function candidate(overrides: Partial<SearchCandidateRow> = {}): SearchCandidateRow {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    jobId: JOB_ID,
    sourceKind: 'pubmed',
    externalId: `pmid:${1000 + counter}`,
    title: `Candidate title ${counter}`,
    authors: 'Author A',
    journal: 'Journal X',
    year: 2024,
    doi: null,
    pmid: null,
    pmcid: null,
    url: null,
    oaFlag: null,
    snippet: 'A short abstract snippet.',
    disposition: 'pending',
    rejectReason: null,
    recordMarkId: null,
    createdAt: 1700000000000 + counter,
    ...overrides,
  };
}

function fact(score: number | null): Pick<SearchFactCandidateRow, 'score'> {
  return { score };
}

const THRESHOLDS = { complementThresholdFact: 70, complementThresholdAverage: 80 };

describe('deep search assessor (pure)', () => {
  it('scores deterministically from metadata', () => {
    const input = [
      candidate({
        sourceKind: 'pubmed',
        doi: '10.1000/abc',
        pmid: '12345',
        year: 2025,
        oaFlag: true,
      }),
    ];
    const first = assessCandidates(input);
    const second = assessCandidates(input);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    // base 45 + doi 10 + pmid 10 + oa 10 + snippet 5 + year 5.
    expect(first[0]?.score).toBe(85);
    expect(first[0]?.status).toBe('mapped');
    expect(first[0]?.text).toBe(input[0]?.title);
    expect(first[0]?.assessorNote).toContain('total=85');
  });

  it('derives one fact per candidate with title and snippet only', () => {
    const facts = assessCandidates([
      candidate({ title: 'Has both', snippet: 'Snippet.' }),
      candidate({ title: null, snippet: 'Snippet.' }),
      candidate({ title: 'No snippet', snippet: null }),
      candidate({ title: '  ', snippet: 'Snippet.' }),
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.text).toBe('Has both');
  });

  it('applies the 50-point mapped threshold', () => {
    // PubMed base 45 + snippet 5 = 50 exactly: mapped.
    const atThreshold = assessCandidates([
      candidate({ sourceKind: 'pubmed', year: null, doi: null, pmid: null, pmcid: null }),
    ]);
    expect(atThreshold[0]?.score).toBe(50);
    expect(atThreshold[0]?.status).toBe('mapped');
    // Exa base 30 + snippet 5 + year 5 = 40: unmapped.
    const below = assessCandidates([candidate({ sourceKind: 'exa' })]);
    expect(below[0]?.score).toBe(40);
    expect(below[0]?.status).toBe('unmapped');
  });

  it('raises the score when the same doi appears from two source kinds', () => {
    const sharedDoi = '10.1000/shared';
    const alone = assessCandidates([
      candidate({ sourceKind: 'exa', doi: sharedDoi, externalId: 'https://example.org/a' }),
    ]);
    const together = assessCandidates([
      candidate({ sourceKind: 'exa', doi: sharedDoi, externalId: 'https://example.org/a' }),
      candidate({
        sourceKind: 'pubmed',
        doi: sharedDoi,
        pmid: '999',
        externalId: 'pmid:999',
      }),
    ]);
    expect(together).toHaveLength(2);
    const exaAlone = alone[0]?.score ?? 0;
    const exaTogether = together[0]?.score ?? 0;
    expect(exaTogether).toBe(exaAlone + 15);
    expect(together[0]?.assessorNote).toContain('corroboration=+15');
    expect(together[1]?.assessorNote).toContain('corroboration=+15');
  });

  it('does not corroborate duplicates from the same source kind', () => {
    const facts = assessCandidates([
      candidate({ sourceKind: 'pubmed', doi: '10.1000/same', externalId: 'pmid:1' }),
      candidate({ sourceKind: 'pubmed', doi: '10.1000/same', externalId: 'pmid:2' }),
    ]);
    expect(facts[0]?.assessorNote).toContain('corroboration=+0');
    expect(facts[1]?.assessorNote).toContain('corroboration=+0');
  });
});

describe('deep search complement trigger (pure)', () => {
  it('does not trigger without fact candidates', () => {
    const result = evaluateComplementTrigger([], THRESHOLDS);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('no_fact_candidates');
    expect(result.minScore).toBeNull();
    expect(result.averageScore).toBeNull();
  });

  it('does not trigger when every score clears both thresholds', () => {
    const result = evaluateComplementTrigger([fact(85), fact(90)], THRESHOLDS);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('not_triggered');
    expect(result.minScore).toBe(85);
    expect(result.averageScore).toBe(87.5);
  });

  it('triggers when one fact falls below the fact threshold', () => {
    const result = evaluateComplementTrigger([fact(95), fact(69)], THRESHOLDS);
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('fact_below_threshold');
    expect(result.minScore).toBe(69);
  });

  it('triggers when the average falls below the average threshold', () => {
    const result = evaluateComplementTrigger([fact(75), fact(75)], THRESHOLDS);
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('average_below_threshold');
    expect(result.averageScore).toBe(75);
  });

  it('triggers with the combined reason when both thresholds fail', () => {
    const result = evaluateComplementTrigger([fact(40)], THRESHOLDS);
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('fact_and_average_below_threshold');
  });
});
