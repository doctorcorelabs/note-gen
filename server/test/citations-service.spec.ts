// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deterministic specs for the F2-1 citation foundation: source id
// derivation, validation, DOI/PMID dedupe, stable numbering on first
// map, the unmapped rule, citation map as query, bibliography
// formatting, and the mark bibliography companion row. All specs run
// against the fake repository; Drizzle parity is by construction
// (shared pure builder + mirrored semantics).

import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/plugins/envelope.js';
import {
  buildCitationMap,
  formatBibliography,
  formatBibliographyEntry,
} from '../src/services/citations/bibliography.js';
import { createFakeCitationsRepository } from '../src/services/citations/fake-repository.js';
import type { FactRow, ReferenceRow } from '../src/services/citations/represent.js';
import {
  deriveSourceId,
  isValidDoi,
  normalizeDoi,
} from '../src/services/citations/source-id.js';
import {
  parseCreateFactBody,
  parseCreateReferenceBody,
  parseUpsertBibliographyBody,
} from '../src/services/citations/validation.js';

const WS = 'ws-1';
const PROJECT = 'deck-hipospadia';

describe('deriveSourceId', () => {
  it('prefers DOI, normalized lowercase with prefix stripped', () => {
    expect(deriveSourceId({ doi: 'https://doi.org/10.1000/XYZ123', pmid: '42' })).toBe(
      'doi:10.1000/xyz123',
    );
    expect(normalizeDoi('doi:10.1000/ABC')).toBe('10.1000/abc');
    expect(isValidDoi('10.1000/abc')).toBe(true);
    expect(isValidDoi('9.1000/abc')).toBe(false);
  });

  it('falls back to PMID, then PMCID, then URL hash', () => {
    expect(deriveSourceId({ pmid: '12345', pmcid: 'PMC999' })).toBe('pmid:12345');
    expect(deriveSourceId({ pmcid: 'pmc999' })).toBe('pmcid:PMC999');
    const urlId = deriveSourceId({ url: 'https://example.org/paper' });
    expect(urlId.startsWith('url:')).toBe(true);
    expect(urlId).toHaveLength('url:'.length + 64);
    // Same URL, same id (deterministic).
    expect(deriveSourceId({ url: 'https://example.org/paper' })).toBe(urlId);
  });

  it('rejects invalid identifiers instead of falling back silently', () => {
    expect(() => deriveSourceId({ doi: 'not-a-doi', pmid: '42' })).toThrow(ApiError);
    expect(() => deriveSourceId({ pmid: '42x' })).toThrow(ApiError);
    expect(() => deriveSourceId({})).toThrow(ApiError);
  });
});

describe('validation', () => {
  it('parses a reference body and normalizes identifiers', () => {
    const input = parseCreateReferenceBody({
      projectKey: PROJECT,
      title: '  A title  ',
      doi: 'https://doi.org/10.1000/ABC',
      year: 2024,
    });
    expect(input.title).toBe('A title');
    expect(input.doi).toBe('10.1000/abc');
    expect(input.year).toBe(2024);
  });

  it('rejects unknown fields and bad shapes', () => {
    expect(() => parseCreateReferenceBody({ projectKey: PROJECT, bogus: 1 })).toThrow(ApiError);
    expect(() => parseCreateReferenceBody({ doi: '10.1000/abc' })).toThrow(ApiError);
    expect(() =>
      parseCreateReferenceBody({ projectKey: PROJECT, doi: 'nope' }),
    ).toThrow(ApiError);
    expect(() =>
      parseCreateFactBody({ projectKey: PROJECT, text: 'x', score: 101 }),
    ).toThrow(ApiError);
    expect(() =>
      parseCreateFactBody({ projectKey: PROJECT, text: 'x', score: 50, status: 'maybe' }),
    ).toThrow(ApiError);
  });

  it('defaults fact status to unmapped', () => {
    const input = parseCreateFactBody({ projectKey: PROJECT, text: 'A fact.', score: 80 });
    expect(input.status).toBe('unmapped');
  });

  it('parses a bibliography upsert body', () => {
    const input = parseUpsertBibliographyBody({ pmid: '777', oaFlag: true });
    expect(input.pmid).toBe('777');
    expect(input.oaFlag).toBe(true);
  });
});

describe('fake repository: dedupe', () => {
  it('returns duplicate on same DOI or PMID in the workspace', async () => {
    const repo = createFakeCitationsRepository(WS);
    const first = await repo.createReference(
      WS,
      parseCreateReferenceBody({ projectKey: PROJECT, doi: '10.1000/abc', title: 'One' }),
    );
    expect(first.duplicate).toBe(false);
    const byDoi = await repo.createReference(
      WS,
      parseCreateReferenceBody({ projectKey: 'other-project', doi: '10.1000/ABC', title: 'Two' }),
    );
    expect(byDoi.duplicate).toBe(true);
    expect(byDoi.row.id).toBe(first.row.id);
    const withPmid = await repo.createReference(
      WS,
      parseCreateReferenceBody({ projectKey: PROJECT, pmid: '555' }),
    );
    const byPmid = await repo.createReference(
      WS,
      parseCreateReferenceBody({ projectKey: PROJECT, pmid: '555', doi: '10.2000/zzz' }),
    );
    expect(byPmid.duplicate).toBe(true);
    expect(byPmid.row.id).toBe(withPmid.row.id);
  });
});

describe('fake repository: stable numbering', () => {
  it('assigns numbers in order of first mapping, never renumbers', async () => {
    const repo = createFakeCitationsRepository(WS);
    const refA = (
      await repo.createReference(
        WS,
        parseCreateReferenceBody({ projectKey: PROJECT, doi: '10.1000/a', title: 'A' }),
      )
    ).row;
    const refB = (
      await repo.createReference(
        WS,
        parseCreateReferenceBody({ projectKey: PROJECT, doi: '10.1000/b', title: 'B' }),
      )
    ).row;
    const fact = await repo.createFact(
      WS,
      parseCreateFactBody({ projectKey: PROJECT, text: 'Fact.', score: 90, status: 'mapped' }),
    );
    // Map B first: B gets number 1 even though A was created first.
    const mappedB = await repo.mapFactToReference(WS, fact.id, refB.id);
    expect(mappedB.reference.number).toBe(1);
    const mappedA = await repo.mapFactToReference(WS, fact.id, refA.id);
    expect(mappedA.reference.number).toBe(2);
    // Re-mapping is a no-op and keeps the numbers.
    const again = await repo.mapFactToReference(WS, fact.id, refB.id);
    expect(again.reference.number).toBe(1);
    const listed = await repo.listReferences(WS, PROJECT);
    expect(listed.map((row) => row.number)).toEqual([1, 2]);
  });

  it('rejects mapping an unmapped fact and cross-project mapping', async () => {
    const repo = createFakeCitationsRepository(WS);
    const ref = (
      await repo.createReference(
        WS,
        parseCreateReferenceBody({ projectKey: PROJECT, doi: '10.1000/a' }),
      )
    ).row;
    const unmapped = await repo.createFact(
      WS,
      parseCreateFactBody({ projectKey: PROJECT, text: 'Unmapped fact.', score: 30 }),
    );
    await expect(repo.mapFactToReference(WS, unmapped.id, ref.id)).rejects.toThrow(ApiError);
    const otherFact = await repo.createFact(
      WS,
      parseCreateFactBody({
        projectKey: 'other-project',
        text: 'Other.',
        score: 90,
        status: 'mapped',
      }),
    );
    await expect(repo.mapFactToReference(WS, otherFact.id, ref.id)).rejects.toThrow(ApiError);
  });
});

describe('citation map', () => {
  it('excludes unmapped facts and unnumbered references', async () => {
    const repo = createFakeCitationsRepository(WS);
    const ref = (
      await repo.createReference(
        WS,
        parseCreateReferenceBody({ projectKey: PROJECT, doi: '10.1000/a', title: 'A' }),
      )
    ).row;
    const mapped = await repo.createFact(
      WS,
      parseCreateFactBody({ projectKey: PROJECT, text: 'Mapped.', score: 90, status: 'mapped' }),
    );
    const unmapped = await repo.createFact(
      WS,
      parseCreateFactBody({ projectKey: PROJECT, text: 'Unmapped.', score: 20 }),
    );
    await repo.mapFactToReference(WS, mapped.id, ref.id);
    const map = await repo.getCitationMap(WS, PROJECT);
    expect(map).toEqual([{ factId: mapped.id, numbers: [1] }]);
    expect(map.some((entry) => entry.factId === unmapped.id)).toBe(false);
  });

  it('pure builder sorts numbers and skips unnumbered links', () => {
    const fact: FactRow = {
      id: 'f1',
      workspaceId: WS,
      projectKey: PROJECT,
      text: 'x',
      score: 90,
      status: 'mapped',
      createdAt: 1,
      updatedAt: 1,
    };
    const ref = (id: string, number: number | null): ReferenceRow => ({
      id,
      workspaceId: WS,
      projectKey: PROJECT,
      number,
      sourceRecordId: null,
      title: null,
      authors: null,
      journal: null,
      year: null,
      doi: null,
      pmid: null,
      pmcid: null,
      url: null,
      oaFlag: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const map = buildCitationMap(
      [fact],
      [
        { factId: 'f1', referenceId: 'r2' },
        { factId: 'f1', referenceId: 'r1' },
        { factId: 'f1', referenceId: 'r3' },
      ],
      [ref('r1', 2), ref('r2', 1), ref('r3', null)],
    );
    expect(map).toEqual([{ factId: 'f1', numbers: [1, 2] }]);
  });
});

describe('bibliography formatting', () => {
  it('formats numbered entries in number order, skips unnumbered', async () => {
    const repo = createFakeCitationsRepository(WS);
    const ref = (
      await repo.createReference(
        WS,
        parseCreateReferenceBody({
          projectKey: PROJECT,
          authors: 'Doe J, Smith A',
          title: 'A study of things',
          journal: 'J Test',
          year: 2024,
          doi: '10.1000/abc',
        }),
      )
    ).row;
    const unnumbered = (
      await repo.createReference(
        WS,
        parseCreateReferenceBody({ projectKey: PROJECT, title: 'Never mapped' }),
      )
    ).row;
    const fact = await repo.createFact(
      WS,
      parseCreateFactBody({ projectKey: PROJECT, text: 'Fact.', score: 90, status: 'mapped' }),
    );
    await repo.mapFactToReference(WS, fact.id, ref.id);
    const listed = await repo.listReferences(WS, PROJECT);
    const text = formatBibliography(listed);
    expect(text).toBe('1. Doe J, Smith A. A study of things. J Test. 2024. doi:10.1000/abc');
    expect(text).not.toContain('Never mapped');
    expect(() => formatBibliographyEntry(unnumbered)).toThrow();
  });
});

describe('mark bibliography companion', () => {
  it('upserts and reads back without touching marks semantics', async () => {
    const repo = createFakeCitationsRepository(WS);
    expect(await repo.getMarkBibliography(WS, 7)).toBeNull();
    const created = await repo.upsertMarkBibliography(
      WS,
      7,
      parseUpsertBibliographyBody({ doi: '10.1000/abc', year: 2023 }),
    );
    expect(created.doi).toBe('10.1000/abc');
    const replaced = await repo.upsertMarkBibliography(
      WS,
      7,
      parseUpsertBibliographyBody({ pmid: '999' }),
    );
    expect(replaced.doi).toBeNull();
    expect(replaced.pmid).toBe('999');
    expect(replaced.createdAt).toBe(created.createdAt);
  });

  it('rejects a foreign workspace', async () => {
    const repo = createFakeCitationsRepository(WS);
    await expect(repo.listReferences('other-ws', PROJECT)).rejects.toThrow(ApiError);
  });
});
