// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deep Search Writer specs (F2-2, wave G-F2-2e): the writing
// stage over the in-memory fakes (deep search + records +
// citations) with stub collectors. No network. The chain runs
// Collector -> Exa (skipped, no budget) -> Assessor ->
// Complement (not triggered at score 85) -> Writer.

import { describe, expect, it } from 'vitest';
import type {
  CollectorResult,
  PubmedCollector,
} from '../src/services/deep-search/collector-pubmed.js';
import type {
  ExaCollector,
  ExaCollectorResult,
} from '../src/services/deep-search/collector-exa.js';
import {
  createFakeDeepSearchRepository,
  type FakeDeepSearchRepository,
} from '../src/services/deep-search/fake-repository.js';
import type { NewCandidate } from '../src/services/deep-search/repository.js';
import type { SearchJobRow } from '../src/services/deep-search/represent.js';
import { parseCreateJobBody } from '../src/services/deep-search/validation.js';
import { runWorkerOnce } from '../src/services/deep-search/worker.js';
import {
  createFakeCitationsRepository,
  type FakeCitationsRepository,
} from '../src/services/citations/fake-repository.js';
import {
  createFakeRecordsRepository,
  type FakeRecordsRepository,
} from '../src/services/records/fake-repository.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT = 'deck-x';

function candidate(overrides: Partial<NewCandidate> = {}): NewCandidate {
  return {
    sourceKind: 'pubmed',
    externalId: 'pmid:40118740',
    title: 'Guidelines on Paediatric Urology Part II',
    authors: 'Skott M',
    journal: 'European Urology',
    year: 2025,
    doi: '10.1016/j.eururo.2025.02.022',
    pmid: '40118740',
    pmcid: null,
    url: 'https://pubmed.ncbi.nlm.nih.gov/40118740/',
    oaFlag: true,
    snippet: 'Hypospadias repair outcomes.',
    ...overrides,
  };
}

function collectorResult(candidates: NewCandidate[]): CollectorResult {
  return {
    candidates,
    candidateEvidence: candidates.map((item) => ({
      externalId: item.externalId,
      queryText: 'hypospadias',
      sourceKind: item.sourceKind === 'exa' ? 'pubmed' : item.sourceKind,
      httpStatus: 200,
      note: null,
    })),
    queryEvidence: [
      {
        candidateId: null,
        queryText: 'hypospadias',
        sourceKind: 'pubmed',
        httpStatus: 200,
        note: `results=${candidates.length}`,
      },
    ],
    sources: {
      europepmc: { ok: true, httpStatus: 200, resultCount: candidates.length, errorCode: null },
      pubmed: { ok: true, httpStatus: 200, resultCount: candidates.length, errorCode: null },
    },
    queries: ['hypospadias'],
  };
}

function stubCollector(result: CollectorResult): PubmedCollector {
  return { collect: async () => result };
}

const stubExaCollector: ExaCollector = {
  collect: async (): Promise<ExaCollectorResult> => {
    throw new Error('Exa must not be called without a budget.');
  },
};

interface Fixture {
  repo: FakeDeepSearchRepository;
  records: FakeRecordsRepository;
  citations: FakeCitationsRepository;
  job: SearchJobRow;
}

async function setupJob(candidates: NewCandidate[]): Promise<Fixture> {
  const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
  const records = createFakeRecordsRepository(WORKSPACE_ID);
  const citations = createFakeCitationsRepository(WORKSPACE_ID);
  const job = await repo.createJob(
    WORKSPACE_ID,
    USER_ID,
    parseCreateJobBody({ projectKey: PROJECT, topic: 'hypospadias' }),
  );
  return { repo, records, citations, job };
}

async function runChain(fixture: Fixture, candidates: NewCandidate[]): Promise<void> {
  const collector = stubCollector(collectorResult(candidates));
  // Collector, Exa skip, Assessor, Complement skip.
  for (let i = 0; i < 4; i += 1) {
    const ran = await runWorkerOnce({
      repository: fixture.repo,
      collector,
      exaCollector: stubExaCollector,
    });
    expect(ran).toBe(true);
  }
}

async function runWriter(fixture: Fixture): Promise<boolean> {
  return runWorkerOnce({
    repository: fixture.repo,
    collector: stubCollector(collectorResult([])),
    exaCollector: stubExaCollector,
    writer: { records: fixture.records, citations: fixture.citations },
  });
}

describe('deep search writer (fake repositories)', () => {
  it('writes record, bibliography, fact, and numbered reference after approval', async () => {
    const fixture = await setupJob([candidate()]);
    await runChain(fixture, [candidate()]);

    await fixture.repo.approveWriting(WORKSPACE_ID, fixture.job.id);
    expect(await runWriter(fixture)).toBe(true);

    const job = await fixture.repo.getJob(WORKSPACE_ID, fixture.job.id);
    expect(job.status).toBe('completed');
    expect(job.finishedAt).not.toBeNull();

    const candidates = await fixture.repo.listCandidates(WORKSPACE_ID, fixture.job.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.disposition).toBe('accepted');
    expect(candidates[0]?.recordMarkId).not.toBeNull();

    const bibliography = await fixture.citations.getMarkBibliography(
      WORKSPACE_ID,
      candidates[0]?.recordMarkId as number,
    );
    expect(bibliography?.doi).toBe('10.1016/j.eururo.2025.02.022');
    expect(bibliography?.pmid).toBe('40118740');

    const factCandidates = await fixture.repo.listFactCandidates(
      WORKSPACE_ID,
      fixture.job.id,
    );
    expect(factCandidates).toHaveLength(1);
    expect(factCandidates[0]?.factId).not.toBeNull();

    const facts = await fixture.citations.listFacts(WORKSPACE_ID, PROJECT);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.status).toBe('mapped');
    expect(facts[0]?.score).toBe(85);

    const references = await fixture.citations.listReferences(WORKSPACE_ID, PROJECT);
    expect(references).toHaveLength(1);
    expect(references[0]?.number).toBe(1);
    expect(references[0]?.sourceRecordId).toBe(candidates[0]?.recordMarkId);

    const map = await fixture.citations.getCitationMap(WORKSPACE_ID, PROJECT);
    expect(map).toEqual([{ factId: facts[0]?.id, numbers: [1] }]);

    const evidence = fixture.repo.listEvidence(fixture.job.id);
    expect(evidence.some((row) => row.note?.startsWith('writer disposition=accepted'))).toBe(
      true,
    );
    expect(evidence.some((row) => row.note?.startsWith('writer factId='))).toBe(true);
  });

  it('first job of a project waits for approval, then writes', async () => {
    const fixture = await setupJob([candidate()]);
    await runChain(fixture, [candidate()]);

    expect(await runWriter(fixture)).toBe(false);
    const waiting = await fixture.repo.getJob(WORKSPACE_ID, fixture.job.id);
    expect(waiting.status).toBe('queued');
    expect(await fixture.citations.listFacts(WORKSPACE_ID, PROJECT)).toHaveLength(0);

    const approved = await fixture.repo.approveWriting(WORKSPACE_ID, fixture.job.id);
    expect(approved.input.writingApproved).toBe(true);
    // Approving twice is a no-op success.
    await fixture.repo.approveWriting(WORKSPACE_ID, fixture.job.id);

    expect(await runWriter(fixture)).toBe(true);
    const done = await fixture.repo.getJob(WORKSPACE_ID, fixture.job.id);
    expect(done.status).toBe('completed');
  });

  it('second job of the same project writes without approval', async () => {
    const fixture = await setupJob([candidate()]);
    await runChain(fixture, [candidate()]);
    await fixture.repo.approveWriting(WORKSPACE_ID, fixture.job.id);
    expect(await runWriter(fixture)).toBe(true);

    const second = await fixture.repo.createJob(
      WORKSPACE_ID,
      USER_ID,
      parseCreateJobBody({ projectKey: PROJECT, topic: 'hypospadias follow-up' }),
    );
    const secondCandidate = candidate({
      externalId: 'pmid:40118741',
      title: 'Guidelines on Paediatric Urology Part I',
      doi: '10.1016/j.eururo.2025.02.021',
      pmid: '40118741',
      url: 'https://pubmed.ncbi.nlm.nih.gov/40118741/',
    });
    const collector = stubCollector(collectorResult([secondCandidate]));
    for (let i = 0; i < 4; i += 1) {
      expect(
        await runWorkerOnce({
          repository: fixture.repo,
          collector,
          exaCollector: stubExaCollector,
        }),
      ).toBe(true);
    }
    expect(await runWriter(fixture)).toBe(true);
    const done = await fixture.repo.getJob(WORKSPACE_ID, second.id);
    expect(done.status).toBe('completed');
    expect(done.input.writingApproved).toBeUndefined();

    const references = await fixture.citations.listReferences(WORKSPACE_ID, PROJECT);
    expect(references.map((row) => row.number)).toEqual([1, 2]);
  });

  it('deduplicates a candidate whose DOI already has a record', async () => {
    const fixture = await setupJob([candidate()]);
    const seeded = await fixture.records.createMark(
      WORKSPACE_ID,
      {
        type: 'link',
        content: '',
        desc: 'Guidelines on Paediatric Urology Part II',
        url: 'https://doi.org/10.1016/j.eururo.2025.02.022',
        tagId: undefined,
        tagIds: undefined,
        sourceId: 'doi:10.1016/j.eururo.2025.02.022',
      },
      async () => false,
    );
    await fixture.citations.upsertMarkBibliography(WORKSPACE_ID, seeded.row.id, {
      title: 'Guidelines on Paediatric Urology Part II',
      authors: 'Skott M',
      journal: 'European Urology',
      year: 2025,
      doi: '10.1016/j.eururo.2025.02.022',
      pmid: '40118740',
      pmcid: undefined,
      url: 'https://pubmed.ncbi.nlm.nih.gov/40118740/',
      oaFlag: true,
    });

    await runChain(fixture, [candidate()]);
    await fixture.repo.approveWriting(WORKSPACE_ID, fixture.job.id);
    expect(await runWriter(fixture)).toBe(true);

    const candidates = await fixture.repo.listCandidates(WORKSPACE_ID, fixture.job.id);
    expect(candidates[0]?.disposition).toBe('duplicate');
    expect(candidates[0]?.recordMarkId).toBe(seeded.row.id);
    const summary = await fixture.repo.getJobSummary(WORKSPACE_ID, fixture.job.id);
    expect(summary.acceptedCandidates).toBe(0);
  });

  it('rejects a candidate whose DOI carries different metadata', async () => {
    const fixture = await setupJob([candidate()]);
    const seeded = await fixture.records.createMark(
      WORKSPACE_ID,
      {
        type: 'link',
        content: '',
        desc: 'A Different Title Entirely',
        url: 'https://doi.org/10.1016/j.eururo.2025.02.022',
        tagId: undefined,
        tagIds: undefined,
        sourceId: 'doi:10.1016/j.eururo.2025.02.022',
      },
      async () => false,
    );
    await fixture.citations.upsertMarkBibliography(WORKSPACE_ID, seeded.row.id, {
      title: 'A Different Title Entirely',
      authors: undefined,
      journal: undefined,
      year: undefined,
      doi: '10.1016/j.eururo.2025.02.022',
      pmid: undefined,
      pmcid: undefined,
      url: undefined,
      oaFlag: undefined,
    });

    await runChain(fixture, [candidate()]);
    await fixture.repo.approveWriting(WORKSPACE_ID, fixture.job.id);
    expect(await runWriter(fixture)).toBe(true);

    const candidates = await fixture.repo.listCandidates(WORKSPACE_ID, fixture.job.id);
    expect(candidates[0]?.disposition).toBe('rejected');
    expect(candidates[0]?.recordMarkId).toBeNull();
    expect(candidates[0]?.rejectReason).toBe('metadata_conflict:title');
    // The mapped fact candidate has no supporting written
    // candidate, so the fact is written unmapped with no marker.
    const facts = await fixture.citations.listFacts(WORKSPACE_ID, PROJECT);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.status).toBe('unmapped');
    expect(await fixture.citations.getCitationMap(WORKSPACE_ID, PROJECT)).toEqual([]);
    expect(await fixture.citations.listReferences(WORKSPACE_ID, PROJECT)).toHaveLength(0);
  });

  it('rejects a candidate without any identifier', async () => {
    const bare = candidate({
      externalId: 'url:bare',
      doi: null,
      pmid: null,
      pmcid: null,
      url: null,
      oaFlag: null,
      year: null,
    });
    const fixture = await setupJob([bare]);
    await runChain(fixture, [bare]);
    await fixture.repo.approveWriting(WORKSPACE_ID, fixture.job.id);
    expect(await runWriter(fixture)).toBe(true);

    const candidates = await fixture.repo.listCandidates(WORKSPACE_ID, fixture.job.id);
    expect(candidates[0]?.disposition).toBe('rejected');
    expect(candidates[0]?.rejectReason).toBe('no_identifier');
    const facts = await fixture.citations.listFacts(WORKSPACE_ID, PROJECT);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.status).toBe('unmapped');
  });

  it('writes a low-score fact unmapped and creates no reference', async () => {
    const weak = candidate({
      sourceKind: 'exa',
      externalId: 'url:weak',
      title: 'A weak web source',
      authors: null,
      journal: null,
      year: null,
      doi: null,
      pmid: null,
      pmcid: null,
      url: 'https://example.invalid/weak',
      oaFlag: null,
      snippet: 'Some snippet.',
    });
    const fixture = await setupJob([weak]);
    await runChain(fixture, [weak]);
    await fixture.repo.approveWriting(WORKSPACE_ID, fixture.job.id);
    expect(await runWriter(fixture)).toBe(true);

    const candidates = await fixture.repo.listCandidates(WORKSPACE_ID, fixture.job.id);
    expect(candidates[0]?.disposition).toBe('accepted');
    const facts = await fixture.citations.listFacts(WORKSPACE_ID, PROJECT);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.status).toBe('unmapped');
    expect(facts[0]?.score).toBe(35);
    expect(await fixture.citations.listReferences(WORKSPACE_ID, PROJECT)).toHaveLength(0);
    expect(await fixture.citations.getCitationMap(WORKSPACE_ID, PROJECT)).toEqual([]);
  });

  it('is idempotent: a re-run writes nothing twice and numbers stay stable', async () => {
    const fixture = await setupJob([candidate()]);
    await runChain(fixture, [candidate()]);
    await fixture.repo.approveWriting(WORKSPACE_ID, fixture.job.id);
    expect(await runWriter(fixture)).toBe(true);

    fixture.repo.forceJobStatus(fixture.job.id, 'queued');
    expect(await runWriter(fixture)).toBe(true);

    expect(await fixture.citations.listFacts(WORKSPACE_ID, PROJECT)).toHaveLength(1);
    const references = await fixture.citations.listReferences(WORKSPACE_ID, PROJECT);
    expect(references).toHaveLength(1);
    expect(references[0]?.number).toBe(1);
    const candidates = await fixture.repo.listCandidates(WORKSPACE_ID, fixture.job.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.disposition).toBe('accepted');
  });

  it('numbers references in order of appearance across two facts', async () => {
    const second = candidate({
      externalId: 'pmid:40118741',
      title: 'Guidelines on Paediatric Urology Part I',
      doi: '10.1016/j.eururo.2025.02.021',
      pmid: '40118741',
      url: 'https://pubmed.ncbi.nlm.nih.gov/40118741/',
    });
    const fixture = await setupJob([candidate(), second]);
    await runChain(fixture, [candidate(), second]);
    await fixture.repo.approveWriting(WORKSPACE_ID, fixture.job.id);
    expect(await runWriter(fixture)).toBe(true);

    const references = await fixture.citations.listReferences(WORKSPACE_ID, PROJECT);
    expect(references.map((row) => [row.number, row.pmid])).toEqual([
      [1, '40118740'],
      [2, '40118741'],
    ]);
    const map = await fixture.citations.getCitationMap(WORKSPACE_ID, PROJECT);
    expect(map.map((entry) => entry.numbers)).toEqual([[1], [2]]);
  });

  it('approveWriting on a completed job answers 409', async () => {
    const fixture = await setupJob([candidate()]);
    await runChain(fixture, [candidate()]);
    await fixture.repo.approveWriting(WORKSPACE_ID, fixture.job.id);
    expect(await runWriter(fixture)).toBe(true);
    await expect(
      fixture.repo.approveWriting(WORKSPACE_ID, fixture.job.id),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
