// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deep Search worker specs (F2-2, wave G-F2-2b): claim semantics,
// stage transitions, candidate/evidence persistence, decision-7
// failure handling, timeout, and stale-job recovery, all over the
// in-memory fake repository with a stub collector. No network.

import { describe, expect, it } from 'vitest';
import {
  CollectorError,
  type CollectorResult,
  type PubmedCollector,
} from '../src/services/deep-search/collector-pubmed.js';
import type {
  ExaCollector,
  ExaCollectorResult,
} from '../src/services/deep-search/collector-exa.js';
import {
  createFakeDeepSearchRepository,
  type FakeDeepSearchRepository,
} from '../src/services/deep-search/fake-repository.js';
import type { SearchJobRow } from '../src/services/deep-search/represent.js';
import { parseCreateJobBody } from '../src/services/deep-search/validation.js';
import { runWorkerOnce } from '../src/services/deep-search/worker.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function okResult(overrides: Partial<CollectorResult> = {}): CollectorResult {
  return {
    candidates: [
      {
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
        oaFlag: null,
        snippet: null,
      },
    ],
    candidateEvidence: [
      {
        externalId: 'pmid:40118740',
        queryText: 'hypospadias',
        sourceKind: 'pubmed',
        httpStatus: 200,
        note: null,
      },
    ],
    queryEvidence: [
      {
        candidateId: null,
        queryText: 'hypospadias',
        sourceKind: 'pubmed',
        httpStatus: 200,
        note: 'results=1',
      },
    ],
    sources: {
      europepmc: { ok: true, httpStatus: 200, resultCount: 1, errorCode: null },
      pubmed: { ok: true, httpStatus: 200, resultCount: 1, errorCode: null },
    },
    queries: ['hypospadias'],
    ...overrides,
  };
}

function stubCollector(result: CollectorResult): PubmedCollector {
  return {
    collect: async () => result,
  };
}

async function setupJob(
  repo: FakeDeepSearchRepository,
  topic = 'hypospadias',
): Promise<SearchJobRow> {
  return repo.createJob(
    WORKSPACE_ID,
    USER_ID,
    parseCreateJobBody({ projectKey: 'deck-x', topic }),
  );
}

describe('deep search worker (fake repository)', () => {
  it('runs the collector stage, stores candidates + evidence, returns job to queued', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJob(repo);

    const ran = await runWorkerOnce({ repository: repo, collector: stubCollector(okResult()) });
    expect(ran).toBe(true);

    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('queued');
    expect(after.startedAt).not.toBeNull();

    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    const collectorStep = steps.find((s) => s.step === 'collector_pubmed');
    expect(collectorStep?.status).toBe('completed');
    expect(collectorStep?.detail).toMatchObject({ candidates: 1 });

    const candidates = await repo.listCandidates(WORKSPACE_ID, job.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.disposition).toBe('pending');
    expect(candidates[0]?.recordMarkId).toBeNull();

    const evidence = repo.listEvidence(job.id);
    expect(evidence).toHaveLength(2);
    const candidateEvidence = evidence.find((e) => e.candidateId !== null);
    expect(candidateEvidence?.candidateId).toBe(candidates[0]?.id);

    // The stage is done: this wave's worker must not reclaim it.
    const ranAgain = await runWorkerOnce({
      repository: repo,
      collector: stubCollector(okResult()),
    });
    expect(ranAgain).toBe(false);
  });

  it('fails the job when the PubMed source fails (decision 7)', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJob(repo);
    const result = okResult({
      sources: {
        europepmc: { ok: true, httpStatus: 200, resultCount: 1, errorCode: null },
        pubmed: { ok: false, httpStatus: 429, resultCount: 0, errorCode: 'rate_limited' },
      },
    });
    const ran = await runWorkerOnce({ repository: repo, collector: stubCollector(result) });
    expect(ran).toBe(true);

    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('collector_pubmed_failed');
    expect(after.errorDetail).toContain('rate_limited');
    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    expect(steps.find((s) => s.step === 'collector_pubmed')?.status).toBe('failed');
  });

  it('completes the stage as partial when only Europe PMC fails', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJob(repo);
    const result = okResult({
      sources: {
        europepmc: { ok: false, httpStatus: 503, resultCount: 0, errorCode: 'http_error' },
        pubmed: { ok: true, httpStatus: 200, resultCount: 1, errorCode: null },
      },
    });
    await runWorkerOnce({ repository: repo, collector: stubCollector(result) });

    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('queued');
    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    const step = steps.find((s) => s.step === 'collector_pubmed');
    expect(step?.status).toBe('completed');
    expect(step?.detail).toMatchObject({
      sources: { europepmc: { ok: false, errorCode: 'http_error' } },
    });
  });

  it('fails closed with the collector error code when identity is missing', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJob(repo);
    const collector: PubmedCollector = {
      collect: async () => {
        throw new CollectorError(
          'eutils_identity_missing',
          'The E-utilities contact email is not configured on the server.',
        );
      },
    };
    await runWorkerOnce({ repository: repo, collector });

    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('eutils_identity_missing');
    expect(await repo.listCandidates(WORKSPACE_ID, job.id)).toHaveLength(0);
  });

  it('fails the job with stage_timeout when the stage overruns', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJob(repo);
    const collector: PubmedCollector = {
      collect: () => new Promise<CollectorResult>(() => undefined),
    };
    await runWorkerOnce({ repository: repo, collector, stageTimeoutMs: 20 });

    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('stage_timeout');
  });

  it('marks stale running jobs failed with worker_restarted', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJob(repo);
    const claimed = await repo.claimNextCollectorJob();
    expect(claimed?.id).toBe(job.id);
    expect((await repo.getJob(WORKSPACE_ID, job.id)).status).toBe('collecting');

    const recovered = await repo.markStaleJobsFailed();
    expect(recovered).toBe(1);
    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('worker_restarted');
    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    expect(steps.find((s) => s.step === 'collector_pubmed')?.status).toBe('failed');
  });

  it('claims at most one running job per workspace, oldest first', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const first = await setupJob(repo, 'first topic');
    const second = await setupJob(repo, 'second topic');

    const claimedFirst = await repo.claimNextCollectorJob();
    expect(claimedFirst?.id).toBe(first.id);
    // Workspace busy: nothing else is claimable while collecting.
    expect(await repo.claimNextCollectorJob()).toBeNull();

    await repo.completeStep(first.id, 'collector_pubmed', null);
    await repo.releaseJobToQueued(first.id);
    // First job's collector step is done, so the second job is next.
    const claimedSecond = await repo.claimNextCollectorJob();
    expect(claimedSecond?.id).toBe(second.id);
  });

  it('deduplicates candidates on retry through insertCandidates', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJob(repo);
    const candidate = okResult().candidates[0];
    if (candidate === undefined) throw new Error('fixture missing');
    await repo.insertCandidates(job.id, [candidate]);
    const again = await repo.insertCandidates(job.id, [candidate]);
    expect(again).toHaveLength(1);
    expect(await repo.countCandidates(job.id)).toBe(1);
  });
});

function okExaResult(overrides: Partial<ExaCollectorResult> = {}): ExaCollectorResult {
  return {
    candidates: [
      {
        sourceKind: 'exa',
        externalId: 'https://example.org/guidelines/hypospadias-2024',
        title: 'Hypospadias guideline update 2024',
        authors: 'Guideline Panel',
        journal: null,
        year: 2024,
        doi: null,
        pmid: null,
        pmcid: null,
        url: 'https://example.org/guidelines/hypospadias-2024',
        oaFlag: null,
        snippet: 'First highlight sentence.',
      },
    ],
    candidateEvidence: [
      {
        externalId: 'https://example.org/guidelines/hypospadias-2024',
        queryText: 'hypospadias',
        sourceKind: 'exa',
        httpStatus: 200,
        note: null,
      },
    ],
    queryEvidence: [
      {
        candidateId: null,
        queryText: 'hypospadias',
        sourceKind: 'exa',
        httpStatus: 200,
        note: 'results=1 cost=0.0050',
      },
    ],
    outcome: { ok: true, httpStatus: 200, resultCount: 1, errorCode: null },
    costUsd: '0.0050',
    calls: 1,
    queries: ['hypospadias'],
    ...overrides,
  };
}

function stubExaCollector(result: ExaCollectorResult): ExaCollector {
  return {
    collect: async () => result,
  };
}

// Drive one job through the PubMed stage so its Exa step becomes
// claimable, then hand back the job row.
async function setupJobPastPubmed(
  repo: FakeDeepSearchRepository,
  body: Record<string, unknown> = {},
): Promise<SearchJobRow> {
  const job = await repo.createJob(
    WORKSPACE_ID,
    USER_ID,
    parseCreateJobBody({ projectKey: 'deck-x', topic: 'hypospadias', ...body }),
  );
  await runWorkerOnce({ repository: repo, collector: stubCollector(okResult()) });
  return job;
}

describe('deep search worker exa stage (fake repository)', () => {
  it('runs the exa stage after pubmed, stores candidates, records cost', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJobPastPubmed(repo, { budgetExaUsd: 0.15 });

    const ran = await runWorkerOnce({
      repository: repo,
      collector: stubCollector(okResult()),
      exaCollector: stubExaCollector(okExaResult()),
    });
    expect(ran).toBe(true);

    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('queued');
    expect(after.costExaUsd).toBe('0.0050');

    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    const exaStep = steps.find((s) => s.step === 'collector_exa');
    expect(exaStep?.status).toBe('completed');
    expect(exaStep?.detail).toMatchObject({ calls: 1, costUsd: '0.0050' });

    const candidates = await repo.listCandidates(WORKSPACE_ID, job.id);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.sourceKind)).toEqual(['pubmed', 'exa']);

    const evidence = repo.listEvidence(job.id);
    expect(evidence.filter((e) => e.sourceKind === 'exa')).toHaveLength(2);

    // Both collector stages are done: the Assessor stage is next
    // in the chain (G-F2-2d). The default fixture candidate has
    // no snippet, so the Assessor derives no facts but still
    // completes its step.
    const ranAgain = await runWorkerOnce({
      repository: repo,
      collector: stubCollector(okResult()),
      exaCollector: stubExaCollector(okExaResult()),
    });
    expect(ranAgain).toBe(true);
    const stepsAfter = await repo.getJobSteps(WORKSPACE_ID, job.id);
    expect(stepsAfter.find((s) => s.step === 'assessor')?.status).toBe('completed');
  });

  it('skips the exa stage with a recorded reason when the job has no budget', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJobPastPubmed(repo);

    const ran = await runWorkerOnce({
      repository: repo,
      collector: stubCollector(okResult()),
      exaCollector: stubExaCollector(okExaResult()),
    });
    expect(ran).toBe(true);

    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('queued');
    expect(after.costExaUsd).toBe('0');
    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    const exaStep = steps.find((s) => s.step === 'collector_exa');
    expect(exaStep?.status).toBe('skipped');
    expect(exaStep?.detail).toMatchObject({ skipped: 'no_exa_budget' });
    expect(await repo.listCandidates(WORKSPACE_ID, job.id)).toHaveLength(1);
  });

  it('skips the exa stage when the server key is missing', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJobPastPubmed(repo, { budgetExaUsd: 0.15 });
    const exaCollector: ExaCollector = {
      collect: async () => {
        throw new CollectorError(
          'exa_key_missing',
          'The Exa API key is not configured on the server.',
        );
      },
    };
    await runWorkerOnce({
      repository: repo,
      collector: stubCollector(okResult()),
      exaCollector,
    });

    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('queued');
    expect(after.errorCode).toBeNull();
    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    const exaStep = steps.find((s) => s.step === 'collector_exa');
    expect(exaStep?.status).toBe('skipped');
    expect(exaStep?.detail).toMatchObject({ skipped: 'exa_key_missing' });
  });

  it('fails only the exa step on a 429 and keeps the job partial (decision 7)', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJobPastPubmed(repo, { budgetExaUsd: 0.15 });
    const result = okExaResult({
      candidates: [],
      candidateEvidence: [],
      outcome: { ok: false, httpStatus: 429, resultCount: 0, errorCode: 'rate_limited' },
      costUsd: '0.0000',
    });
    await runWorkerOnce({
      repository: repo,
      collector: stubCollector(okResult()),
      exaCollector: stubExaCollector(result),
    });

    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('queued');
    expect(after.costExaUsd).toBe('0');
    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    expect(steps.find((s) => s.step === 'collector_exa')?.status).toBe('failed');
    // The PubMed candidate trail is untouched.
    expect(await repo.listCandidates(WORKSPACE_ID, job.id)).toHaveLength(1);
  });

  it('does not claim the exa step before the pubmed step completes', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    await repo.createJob(
      WORKSPACE_ID,
      USER_ID,
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'hypospadias', budgetExaUsd: 0.15 }),
    );
    expect(await repo.claimNextExaJob()).toBeNull();
  });
});

function strongResult(): CollectorResult {
  return okResult({
    candidates: [
      {
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
        snippet: 'A short abstract snippet.',
      },
    ],
  });
}

function sequenceCollector(results: CollectorResult[]): PubmedCollector {
  let calls = 0;
  return {
    collect: async () => {
      const result = results[Math.min(calls, results.length - 1)] as CollectorResult;
      calls += 1;
      return result;
    },
  };
}

// Drive one job through PubMed plus the Exa skip (no budget) so
// its Assessor step becomes claimable.
async function setupJobPastCollectors(
  repo: FakeDeepSearchRepository,
  collector: PubmedCollector,
): Promise<SearchJobRow> {
  const job = await repo.createJob(
    WORKSPACE_ID,
    USER_ID,
    parseCreateJobBody({ projectKey: 'deck-x', topic: 'hypospadias' }),
  );
  await runWorkerOnce({ repository: repo, collector });
  await runWorkerOnce({
    repository: repo,
    collector,
    exaCollector: stubExaCollector(okExaResult()),
  });
  return job;
}

describe('deep search worker assessor and complement stages (fake repository)', () => {
  it('runs the assessor stage and stores fact candidates with evidence', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJobPastCollectors(repo, stubCollector(strongResult()));

    const ran = await runWorkerOnce({
      repository: repo,
      collector: stubCollector(strongResult()),
      exaCollector: stubExaCollector(okExaResult()),
    });
    expect(ran).toBe(true);

    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('queued');
    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    const assessorStep = steps.find((s) => s.step === 'assessor');
    expect(assessorStep?.status).toBe('completed');
    expect(assessorStep?.detail).toMatchObject({
      facts: 1,
      mapped: 1,
      unmapped: 0,
      averageScore: 85,
    });

    const facts = await repo.listFactCandidates(WORKSPACE_ID, job.id);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.score).toBe(85);
    expect(facts[0]?.status).toBe('mapped');
    expect(facts[0]?.factId).toBeNull();

    const candidates = await repo.listCandidates(WORKSPACE_ID, job.id);
    const evidence = repo.listEvidence(job.id);
    const factEvidence = evidence.find((e) => e.factCandidateId !== null);
    expect(factEvidence?.factCandidateId).toBe(facts[0]?.id);
    expect(factEvidence?.candidateId).toBe(candidates[0]?.id);
  });

  it('records the complement step skipped when scores clear the thresholds', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJobPastCollectors(repo, stubCollector(strongResult()));
    await runWorkerOnce({
      repository: repo,
      collector: stubCollector(strongResult()),
      exaCollector: stubExaCollector(okExaResult()),
    });

    const ran = await runWorkerOnce({
      repository: repo,
      collector: stubCollector(strongResult()),
      exaCollector: stubExaCollector(okExaResult()),
    });
    expect(ran).toBe(true);

    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('queued');
    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    const complementStep = steps.find((s) => s.step === 'complement');
    expect(complementStep?.status).toBe('skipped');
    expect(complementStep?.detail).toMatchObject({
      skipped: 'complement_not_triggered',
      minScore: 85,
      averageScore: 85,
    });
    // No second collection happened.
    expect(await repo.listCandidates(WORKSPACE_ID, job.id)).toHaveLength(1);
  });

  it('re-collects on complement trigger and raises the corroborated score', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const initial = okResult({
      candidates: [
        {
          sourceKind: 'europepmc',
          externalId: 'epmc:1',
          title: 'Shared article title',
          authors: 'Author A',
          journal: 'Journal X',
          year: 2024,
          doi: '10.1000/shared',
          pmid: null,
          pmcid: null,
          url: null,
          oaFlag: null,
          snippet: 'A short abstract snippet.',
        },
      ],
      candidateEvidence: [
        {
          externalId: 'epmc:1',
          queryText: 'hypospadias',
          sourceKind: 'europepmc',
          httpStatus: 200,
          note: null,
        },
      ],
    });
    const complementHit = okResult({
      candidates: [
        {
          sourceKind: 'pubmed',
          externalId: 'pmid:2',
          title: 'Shared article title',
          authors: 'Author A',
          journal: 'Journal X',
          year: 2024,
          doi: '10.1000/shared',
          pmid: '2',
          pmcid: null,
          url: null,
          oaFlag: null,
          snippet: 'A short abstract snippet.',
        },
      ],
      candidateEvidence: [
        {
          externalId: 'pmid:2',
          queryText: 'hypospadias',
          sourceKind: 'pubmed',
          httpStatus: 200,
          note: null,
        },
      ],
    });
    const collector = sequenceCollector([initial, complementHit]);
    const job = await setupJobPastCollectors(repo, collector);
    await runWorkerOnce({
      repository: repo,
      collector,
      exaCollector: stubExaCollector(okExaResult()),
    });

    const before = await repo.listFactCandidates(WORKSPACE_ID, job.id);
    expect(before).toHaveLength(1);
    // base 45 + doi 10 + snippet 5 + year 5 = 65, below 70.
    expect(before[0]?.score).toBe(65);

    const ran = await runWorkerOnce({
      repository: repo,
      collector,
      exaCollector: stubExaCollector(okExaResult()),
    });
    expect(ran).toBe(true);

    const after = await repo.getJob(WORKSPACE_ID, job.id);
    expect(after.status).toBe('queued');
    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    const complementStep = steps.find((s) => s.step === 'complement');
    expect(complementStep?.status).toBe('completed');
    expect(complementStep?.detail).toMatchObject({
      triggered: true,
      candidatesBefore: 1,
      candidatesAfter: 2,
      updated: 1,
      inserted: 1,
    });

    const factsAfter = await repo.listFactCandidates(WORKSPACE_ID, job.id);
    expect(factsAfter).toHaveLength(2);
    const raised = factsAfter.find((f) => f.id === before[0]?.id);
    // Corroboration across europepmc and pubmed adds 15.
    expect(raised?.score).toBe(80);
    expect(raised?.assessorNote).toContain('corroboration=+15');
  });

  it('does not claim the assessor step before the exa step resolves', async () => {
    const repo = createFakeDeepSearchRepository(WORKSPACE_ID);
    const job = await setupJobPastPubmed(repo);
    expect(job.id).toBeDefined();
    expect(await repo.claimNextAssessorJob()).toBeNull();
    expect(await repo.claimNextComplementJob()).toBeNull();
  });
});
