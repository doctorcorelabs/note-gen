// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// In-memory implementation of the Deep Search repository, for specs
// only. It mirrors the Drizzle implementation's observable semantics
// (queued creation with pending steps, cancel/retry status machine,
// cursor pagination, and since G-F2-2b the executor claim and stage
// transitions) without a database. It must never be wired into
// production.
//
// The fake owns one workspace per instance; the workspaceId argument
// is accepted for interface compatibility and checked for equality.
// Ids and timestamps come from monotonic counters so ordering is
// deterministic in specs. Candidates and fact candidates can still
// be seeded through the test-only helpers below; the executor
// methods produce them for real in worker specs.

import { ApiError } from '../../plugins/envelope.js';
import {
  STEP_KINDS,
  type JobSummary,
  type SearchCandidateRow,
  type SearchFactCandidateRow,
  type SearchJobRow,
  type SearchJobStepRow,
  type StepKind,
} from './represent.js';
import {
  decodeJobCursor,
  encodeJobCursor,
  type DeepSearchRepository,
  type ListJobsFilter,
  type ListJobsResult,
  type NewCandidate,
  type NewEvidence,
} from './repository.js';
import type { CreateJobInput } from './validation.js';

// Stored evidence row shape (the port only writes evidence; the
// fake keeps rows so specs can assert the search trail).
export interface FakeEvidenceRow extends NewEvidence {
  id: string;
  jobId: string;
  retrievedAt: number;
}

export interface FakeDeepSearchRepository extends DeepSearchRepository {
  // Test-only seeding.
  seedCandidate(row: Omit<SearchCandidateRow, 'id' | 'createdAt'>): SearchCandidateRow;
  seedFactCandidate(
    row: Omit<SearchFactCandidateRow, 'id' | 'createdAt'>,
  ): SearchFactCandidateRow;
  // Test-only status forcing so specs can reach failed/writing.
  forceJobStatus(jobId: string, status: SearchJobRow['status']): void;
  // Test-only evidence read-back (the port has no evidence read).
  listEvidence(jobId: string): FakeEvidenceRow[];
}

function jobNotFound(): ApiError {
  return ApiError.notFound('The search job was not found in this workspace.');
}

export function createFakeDeepSearchRepository(workspaceId: string): FakeDeepSearchRepository {
  const jobsStore = new Map<string, SearchJobRow>();
  const stepsStore = new Map<string, SearchJobStepRow[]>();
  const candidatesStore: SearchCandidateRow[] = [];
  const factCandidatesStore: SearchFactCandidateRow[] = [];
  const evidenceStore: FakeEvidenceRow[] = [];
  let idCounter = 0;
  let clock = 1_700_000_000_000;

  function now(): number {
    clock += 1;
    return clock;
  }

  function nextId(): string {
    idCounter += 1;
    return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
  }

  function checkWorkspace(requested: string): void {
    if (requested !== workspaceId) {
      throw ApiError.notFound();
    }
  }

  function requireJob(jobId: string): SearchJobRow {
    const row = jobsStore.get(jobId);
    if (row === undefined) {
      throw jobNotFound();
    }
    return row;
  }

  function freshSteps(jobId: string): SearchJobStepRow[] {
    return STEP_KINDS.map((step) => ({
      id: nextId(),
      jobId,
      step,
      status: 'pending' as const,
      detail: null,
      startedAt: null,
      finishedAt: null,
    }));
  }

  return {
    async createJob(
      requestedWorkspaceId: string,
      createdByUserId: string | null,
      input: CreateJobInput,
    ): Promise<SearchJobRow> {
      checkWorkspace(requestedWorkspaceId);
      const row: SearchJobRow = {
        id: nextId(),
        workspaceId,
        projectKey: input.projectKey,
        topic: input.topic,
        status: 'queued',
        input: input.input,
        budgetExaUsd: input.budgetExaUsd ?? null,
        costExaUsd: '0',
        createdByUserId,
        createdByTokenId: null,
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        errorCode: null,
        errorDetail: null,
      };
      jobsStore.set(row.id, row);
      stepsStore.set(row.id, freshSteps(row.id));
      return { ...row };
    },

    async getJob(requestedWorkspaceId: string, jobId: string): Promise<SearchJobRow> {
      checkWorkspace(requestedWorkspaceId);
      return { ...requireJob(jobId) };
    },

    async listJobs(
      requestedWorkspaceId: string,
      filter: ListJobsFilter,
    ): Promise<ListJobsResult> {
      checkWorkspace(requestedWorkspaceId);
      let rows = [...jobsStore.values()].sort((a, b) =>
        a.createdAt !== b.createdAt ? b.createdAt - a.createdAt : b.id.localeCompare(a.id),
      );
      if (filter.projectKey !== undefined) {
        rows = rows.filter((row) => row.projectKey === filter.projectKey);
      }
      if (filter.status !== undefined) {
        rows = rows.filter((row) => row.status === filter.status);
      }
      if (filter.cursor !== undefined) {
        const cursor = decodeJobCursor(filter.cursor);
        if (cursor === null) {
          throw ApiError.validation('The cursor is not valid.', { field: 'cursor' });
        }
        rows = rows.filter(
          (row) =>
            row.createdAt < cursor.createdAt ||
            (row.createdAt === cursor.createdAt && row.id < cursor.id),
        );
      }
      const page = rows.slice(0, filter.limit);
      const nextCursor =
        rows.length > filter.limit && page.length > 0
          ? encodeJobCursor(page[page.length - 1] as SearchJobRow)
          : null;
      return { items: page.map((row) => ({ ...row })), nextCursor };
    },

    async getJobSteps(
      requestedWorkspaceId: string,
      jobId: string,
    ): Promise<SearchJobStepRow[]> {
      checkWorkspace(requestedWorkspaceId);
      requireJob(jobId);
      return (stepsStore.get(jobId) ?? []).map((row) => ({ ...row }));
    },

    async getJobSummary(requestedWorkspaceId: string, jobId: string): Promise<JobSummary> {
      checkWorkspace(requestedWorkspaceId);
      requireJob(jobId);
      const candidates = candidatesStore.filter((row) => row.jobId === jobId);
      const facts = factCandidatesStore.filter((row) => row.jobId === jobId);
      return {
        candidates: candidates.length,
        acceptedCandidates: candidates.filter((row) => row.disposition === 'accepted').length,
        factCandidates: facts.length,
        mappedFacts: facts.filter((row) => row.status === 'mapped').length,
        unmappedFacts: facts.filter((row) => row.status === 'unmapped').length,
      };
    },

    async cancelJob(requestedWorkspaceId: string, jobId: string): Promise<SearchJobRow> {
      checkWorkspace(requestedWorkspaceId);
      const row = requireJob(jobId);
      if (
        row.status === 'completed' ||
        row.status === 'failed' ||
        row.status === 'cancelled' ||
        row.status === 'writing'
      ) {
        throw ApiError.revisionConflict(
          { status: row.status },
          {},
          'The job can no longer be cancelled.',
        );
      }
      row.status = 'cancelled';
      row.finishedAt = now();
      return { ...row };
    },

    async retryJob(requestedWorkspaceId: string, jobId: string): Promise<SearchJobRow> {
      checkWorkspace(requestedWorkspaceId);
      const row = requireJob(jobId);
      if (row.status !== 'failed') {
        throw ApiError.revisionConflict(
          { status: row.status },
          {},
          'Only a failed job can be retried.',
        );
      }
      row.status = 'queued';
      row.startedAt = null;
      row.finishedAt = null;
      row.errorCode = null;
      row.errorDetail = null;
      stepsStore.set(jobId, freshSteps(jobId));
      return { ...row };
    },

    async listCandidates(
      requestedWorkspaceId: string,
      jobId: string,
    ): Promise<SearchCandidateRow[]> {
      checkWorkspace(requestedWorkspaceId);
      requireJob(jobId);
      return candidatesStore
        .filter((row) => row.jobId === jobId)
        .map((row) => ({ ...row }));
    },

    async listFactCandidates(
      requestedWorkspaceId: string,
      jobId: string,
    ): Promise<SearchFactCandidateRow[]> {
      checkWorkspace(requestedWorkspaceId);
      requireJob(jobId);
      return factCandidatesStore
        .filter((row) => row.jobId === jobId)
        .map((row) => ({ ...row }));
    },

    async claimNextCollectorJob(): Promise<SearchJobRow | null> {
      const running = [...jobsStore.values()].some(
        (row) =>
          row.status === 'collecting' ||
          row.status === 'assessing' ||
          row.status === 'complementing' ||
          row.status === 'writing',
      );
      if (running) {
        return null;
      }
      const queued = [...jobsStore.values()]
        .filter((row) => row.status === 'queued')
        .sort((a, b) =>
          a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id.localeCompare(b.id),
        );
      for (const job of queued) {
        const steps = stepsStore.get(job.id) ?? [];
        const step = steps.find((row) => row.step === 'collector_pubmed');
        if (step === undefined || step.status !== 'pending') {
          continue;
        }
        job.status = 'collecting';
        job.startedAt = job.startedAt ?? now();
        step.status = 'running';
        step.startedAt = now();
        return { ...job };
      }
      return null;
    },

    async markStaleJobsFailed(): Promise<number> {
      let recovered = 0;
      for (const job of jobsStore.values()) {
        if (
          job.status === 'collecting' ||
          job.status === 'assessing' ||
          job.status === 'complementing' ||
          job.status === 'writing'
        ) {
          job.status = 'failed';
          job.errorCode = 'worker_restarted';
          job.errorDetail = 'The worker process restarted while this job was running.';
          job.finishedAt = now();
          recovered += 1;
          for (const step of stepsStore.get(job.id) ?? []) {
            if (step.status === 'running') {
              step.status = 'failed';
              step.finishedAt = now();
            }
          }
        }
      }
      return recovered;
    },

    async completeStep(
      jobId: string,
      stepKind: StepKind,
      detail: Record<string, unknown> | null,
    ): Promise<void> {
      requireJob(jobId);
      const step = (stepsStore.get(jobId) ?? []).find((row) => row.step === stepKind);
      if (step === undefined) {
        throw jobNotFound();
      }
      step.status = 'completed';
      step.detail = detail;
      step.finishedAt = now();
    },

    async failStep(
      jobId: string,
      stepKind: StepKind,
      detail: Record<string, unknown> | null,
    ): Promise<void> {
      requireJob(jobId);
      const step = (stepsStore.get(jobId) ?? []).find((row) => row.step === stepKind);
      if (step === undefined) {
        throw jobNotFound();
      }
      step.status = 'failed';
      step.detail = detail;
      step.finishedAt = now();
    },

    async insertCandidates(
      jobId: string,
      candidates: NewCandidate[],
    ): Promise<SearchCandidateRow[]> {
      requireJob(jobId);
      for (const candidate of candidates) {
        const exists = candidatesStore.some(
          (row) => row.jobId === jobId && row.externalId === candidate.externalId,
        );
        if (exists) continue;
        candidatesStore.push({
          ...candidate,
          id: nextId(),
          jobId,
          disposition: 'pending',
          rejectReason: null,
          recordMarkId: null,
          createdAt: now(),
        });
      }
      const wanted = new Set(candidates.map((candidate) => candidate.externalId));
      return candidatesStore
        .filter((row) => row.jobId === jobId && wanted.has(row.externalId))
        .map((row) => ({ ...row }));
    },

    async insertEvidence(jobId: string, evidence: NewEvidence[]): Promise<void> {
      requireJob(jobId);
      for (const item of evidence) {
        evidenceStore.push({ ...item, id: nextId(), jobId, retrievedAt: now() });
      }
    },

    async countCandidates(jobId: string): Promise<number> {
      requireJob(jobId);
      return candidatesStore.filter((row) => row.jobId === jobId).length;
    },

    async releaseJobToQueued(jobId: string): Promise<SearchJobRow> {
      const row = requireJob(jobId);
      row.status = 'queued';
      return { ...row };
    },

    async failJob(
      jobId: string,
      errorCode: string,
      errorDetail: string,
    ): Promise<SearchJobRow> {
      const row = requireJob(jobId);
      row.status = 'failed';
      row.errorCode = errorCode;
      row.errorDetail = errorDetail;
      row.finishedAt = now();
      return { ...row };
    },

    listEvidence(jobId: string): FakeEvidenceRow[] {
      return evidenceStore
        .filter((row) => row.jobId === jobId)
        .map((row) => ({ ...row }));
    },

    seedCandidate(row: Omit<SearchCandidateRow, 'id' | 'createdAt'>): SearchCandidateRow {
      const full: SearchCandidateRow = { ...row, id: nextId(), createdAt: now() };
      candidatesStore.push(full);
      return { ...full };
    },

    seedFactCandidate(
      row: Omit<SearchFactCandidateRow, 'id' | 'createdAt'>,
    ): SearchFactCandidateRow {
      const full: SearchFactCandidateRow = { ...row, id: nextId(), createdAt: now() };
      factCandidatesStore.push(full);
      return { ...full };
    },

    forceJobStatus(jobId: string, status: SearchJobRow['status']): void {
      const row = requireJob(jobId);
      row.status = status;
      if (status === 'failed') {
        row.errorCode = 'test_forced';
        row.errorDetail = 'Forced by spec.';
        row.finishedAt = now();
      }
    },
  };
}
