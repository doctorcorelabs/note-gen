// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deep Search service semantics over the in-memory fake repository
// (F2-2 wave G-F2-2a): queued creation with pending steps, decision
// enforcement in validation, cancel/retry status machine, cursor
// pagination, and seeded candidate/fact reads. The executor that
// produces candidates lands in G-F2-2b..e; HTTP is pinned by
// deep-search-routes.spec.ts.

import { describe, expect, it } from 'vitest';
import {
  createFakeDeepSearchRepository,
  type FakeDeepSearchRepository,
} from '../src/services/deep-search/fake-repository.js';
import { parseCreateJobBody } from '../src/services/deep-search/validation.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function setup(): FakeDeepSearchRepository {
  return createFakeDeepSearchRepository(WORKSPACE_ID);
}

describe('deep search validation', () => {
  it('applies binding defaults (100 candidates, thresholds 70/80, full chain)', () => {
    const input = parseCreateJobBody({ projectKey: 'deck-x', topic: 'Hipospadia' });
    expect(input.input.maxCandidates).toBe(100);
    expect(input.input.complementThresholdFact).toBe(70);
    expect(input.input.complementThresholdAverage).toBe(80);
    expect(input.input.stages).toBe('full');
    expect(input.budgetExaUsd).toBeUndefined();
  });

  it('accepts an Exa ceiling at the decision-1 initial cap and rejects above it', () => {
    const ok = parseCreateJobBody({ projectKey: 'deck-x', topic: 'T', budgetExaUsd: 0.15 });
    expect(ok.budgetExaUsd).toBe('0.1500');
    expect(() =>
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'T', budgetExaUsd: 0.16 }),
    ).toThrowError(/at most 0.15/);
    expect(() =>
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'T', budgetExaUsd: 0 }),
    ).toThrowError(/greater than 0/);
  });

  it('rejects loosened Complement thresholds and caps above 100 (decisions 10 and 6)', () => {
    expect(() =>
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'T', complementThresholdFact: 69 }),
    ).toThrowError(/only tighten/);
    expect(() =>
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'T', complementThresholdAverage: 79 }),
    ).toThrowError(/only tighten/);
    const tightened = parseCreateJobBody({
      projectKey: 'deck-x',
      topic: 'T',
      complementThresholdFact: 75,
      complementThresholdAverage: 85,
    });
    expect(tightened.input.complementThresholdFact).toBe(75);
    expect(tightened.input.complementThresholdAverage).toBe(85);
    expect(() =>
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'T', maxCandidates: 101 }),
    ).toThrowError(/1 to 100/);
  });

  it('rejects unknown fields, empty topic, and inverted year range (K-09)', () => {
    expect(() =>
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'T', apiKey: 'nope' }),
    ).toThrowError(/unknown field/);
    expect(() => parseCreateJobBody({ projectKey: 'deck-x', topic: '  ' })).toThrowError(
      /topic is required/,
    );
    expect(() =>
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'T', yearFrom: 2025, yearTo: 2020 }),
    ).toThrowError(/must not exceed/);
  });
});

describe('deep search job lifecycle (fake)', () => {
  it('creates a queued job with four pending steps in chain order', async () => {
    const repo = setup();
    const input = parseCreateJobBody({
      projectKey: 'deck-x',
      topic: 'Hipospadia',
      budgetExaUsd: 0.1,
    });
    const job = await repo.createJob(WORKSPACE_ID, USER_ID, input);
    expect(job.status).toBe('queued');
    expect(job.budgetExaUsd).toBe('0.1000');
    expect(job.costExaUsd).toBe('0');
    expect(job.createdByUserId).toBe(USER_ID);
    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    expect(steps.map((s) => s.step)).toEqual([
      'collector_pubmed',
      'collector_exa',
      'assessor',
      'complement',
    ]);
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('cancels a queued job and refuses terminal transitions with 409', async () => {
    const repo = setup();
    const job = await repo.createJob(
      WORKSPACE_ID,
      USER_ID,
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'T' }),
    );
    const cancelled = await repo.cancelJob(WORKSPACE_ID, job.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).not.toBeNull();
    await expect(repo.cancelJob(WORKSPACE_ID, job.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(repo.retryJob(WORKSPACE_ID, job.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('retries only a failed job, resetting steps and clearing the error', async () => {
    const repo = setup();
    const job = await repo.createJob(
      WORKSPACE_ID,
      USER_ID,
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'T' }),
    );
    await expect(repo.retryJob(WORKSPACE_ID, job.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    repo.forceJobStatus(job.id, 'failed');
    const retried = await repo.retryJob(WORKSPACE_ID, job.id);
    expect(retried.status).toBe('queued');
    expect(retried.errorCode).toBeNull();
    expect(retried.finishedAt).toBeNull();
    const steps = await repo.getJobSteps(WORKSPACE_ID, job.id);
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('refuses to cancel a writing job in this wave', async () => {
    const repo = setup();
    const job = await repo.createJob(
      WORKSPACE_ID,
      USER_ID,
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'T' }),
    );
    repo.forceJobStatus(job.id, 'writing');
    await expect(repo.cancelJob(WORKSPACE_ID, job.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('answers 404 for unknown jobs and foreign workspaces', async () => {
    const repo = setup();
    await expect(
      repo.getJob(WORKSPACE_ID, '00000000-0000-4000-8000-000000000099'),
    ).rejects.toMatchObject({ statusCode: 404 });
    const job = await repo.createJob(
      WORKSPACE_ID,
      USER_ID,
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'T' }),
    );
    await expect(repo.getJob(OTHER_WORKSPACE_ID, job.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('paginates newest first with an opaque cursor and filters', async () => {
    const repo = setup();
    for (let i = 0; i < 3; i += 1) {
      await repo.createJob(
        WORKSPACE_ID,
        USER_ID,
        parseCreateJobBody({ projectKey: 'deck-x', topic: `Topik ${i}` }),
      );
    }
    await repo.createJob(
      WORKSPACE_ID,
      USER_ID,
      parseCreateJobBody({ projectKey: 'deck-y', topic: 'Lain' }),
    );
    const first = await repo.listJobs(WORKSPACE_ID, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.topic).toBe('Lain');
    expect(first.nextCursor).not.toBeNull();
    const second = await repo.listJobs(WORKSPACE_ID, {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const filtered = await repo.listJobs(WORKSPACE_ID, { limit: 10, projectKey: 'deck-x' });
    expect(filtered.items).toHaveLength(3);
    await expect(
      repo.listJobs(WORKSPACE_ID, { limit: 2, cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('summarizes seeded candidates and fact candidates', async () => {
    const repo = setup();
    const job = await repo.createJob(
      WORKSPACE_ID,
      USER_ID,
      parseCreateJobBody({ projectKey: 'deck-x', topic: 'T' }),
    );
    repo.seedCandidate({
      jobId: job.id,
      sourceKind: 'pubmed',
      externalId: '40118740',
      title: 'Studi A',
      authors: null,
      journal: null,
      year: 2025,
      doi: null,
      pmid: '40118740',
      pmcid: null,
      url: null,
      oaFlag: true,
      snippet: null,
      disposition: 'accepted',
      rejectReason: null,
      recordMarkId: null,
    });
    repo.seedFactCandidate({
      jobId: job.id,
      text: 'Fakta kuat',
      score: 92,
      status: 'mapped',
      factId: null,
      assessorNote: null,
    });
    repo.seedFactCandidate({
      jobId: job.id,
      text: 'Fakta lemah',
      score: 35,
      status: 'unmapped',
      factId: null,
      assessorNote: null,
    });
    const summary = await repo.getJobSummary(WORKSPACE_ID, job.id);
    expect(summary).toEqual({
      candidates: 1,
      acceptedCandidates: 1,
      factCandidates: 2,
      mappedFacts: 1,
      unmappedFacts: 1,
    });
    const candidates = await repo.listCandidates(WORKSPACE_ID, job.id);
    expect(candidates[0]?.externalId).toBe('40118740');
    const facts = await repo.listFactCandidates(WORKSPACE_ID, job.id);
    expect(facts.map((f) => f.status)).toEqual(['mapped', 'unmapped']);
  });
});
