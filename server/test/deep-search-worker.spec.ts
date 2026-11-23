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
