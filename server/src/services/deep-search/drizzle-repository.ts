// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Drizzle/Postgres implementation of the Deep Search repository
// (F2-2, waves G-F2-2a and G-F2-2b). Every method runs in one
// transaction via db.transaction(). Semantics mirror the fake:
// queued creation with pending steps, cancel/retry status machine,
// cursor pagination, and since G-F2-2b the executor claim, stage
// transitions, candidate/evidence inserts, and stale recovery.

import { and, asc, count, desc, eq, inArray, isNotNull, lt, ne, or } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import {
  searchCandidates,
  searchEvidence,
  searchFactCandidates,
  searchJobs,
  searchJobSteps,
  type Database,
} from '../../db/index.js';
import {
  STEP_KINDS,
  formatUsdUnits,
  parseUsdToUnits,
  type EvidenceRow,
  type JobInput,
  type JobStatus,
  type JobSummary,
  type SearchCandidateRow,
  type SearchFactCandidateRow,
  type SearchJobRow,
  type SearchJobStepRow,
  type StageChoice,
  type StepKind,
  type StepStatus,
  type CandidateDisposition,
  type FactCandidateStatus,
  type SourceKind,
} from './represent.js';
import {
  decodeJobCursor,
  encodeJobCursor,
  type CandidateWrittenUpdate,
  type DeepSearchRepository,
  type FactScoreUpdate,
  type ListJobsFilter,
  type ListJobsResult,
  type NewCandidate,
  type NewEvidence,
  type NewFactCandidate,
} from './repository.js';
import type { CreateJobInput } from './validation.js';

type DbJobRow = typeof searchJobs.$inferSelect;
type DbStepRow = typeof searchJobSteps.$inferSelect;
type DbCandidateRow = typeof searchCandidates.$inferSelect;
type DbFactCandidateRow = typeof searchFactCandidates.$inferSelect;
type DbEvidenceRow = typeof searchEvidence.$inferSelect;

function jobNotFound(): ApiError {
  return ApiError.notFound('The search job was not found in this workspace.');
}

function normalizeJobInput(raw: unknown): JobInput {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const stages: StageChoice = record['stages'] === 'collector' ? 'collector' : 'full';
  return {
    maxCandidates:
      typeof record['maxCandidates'] === 'number' ? record['maxCandidates'] : 100,
    yearFrom: typeof record['yearFrom'] === 'number' ? record['yearFrom'] : undefined,
    yearTo: typeof record['yearTo'] === 'number' ? record['yearTo'] : undefined,
    language: typeof record['language'] === 'string' ? record['language'] : undefined,
    stages,
    complementThresholdFact:
      typeof record['complementThresholdFact'] === 'number'
        ? record['complementThresholdFact']
        : 70,
    complementThresholdAverage:
      typeof record['complementThresholdAverage'] === 'number'
        ? record['complementThresholdAverage']
        : 80,
    ...(record['writingApproved'] === true ? { writingApproved: true } : {}),
  };
}

function toJobRow(row: DbJobRow): SearchJobRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectKey: row.projectKey,
    topic: row.topic,
    status: row.status as JobStatus,
    input: normalizeJobInput(row.input),
    budgetExaUsd: row.budgetExaUsd,
    costExaUsd: row.costExaUsd,
    createdByUserId: row.createdByUserId,
    createdByTokenId: row.createdByTokenId,
    createdAt: row.createdAt.getTime(),
    startedAt: row.startedAt === null ? null : row.startedAt.getTime(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.getTime(),
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
  };
}

function toStepRow(row: DbStepRow): SearchJobStepRow {
  return {
    id: row.id,
    jobId: row.jobId,
    step: row.step as StepKind,
    status: row.status as StepStatus,
    detail:
      typeof row.detail === 'object' && row.detail !== null
        ? (row.detail as Record<string, unknown>)
        : null,
    startedAt: row.startedAt === null ? null : row.startedAt.getTime(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.getTime(),
  };
}

function toCandidateRow(row: DbCandidateRow): SearchCandidateRow {
  return {
    id: row.id,
    jobId: row.jobId,
    sourceKind: row.sourceKind as SourceKind,
    externalId: row.externalId,
    title: row.title,
    authors: row.authors,
    journal: row.journal,
    year: row.year,
    doi: row.doi,
    pmid: row.pmid,
    pmcid: row.pmcid,
    url: row.url,
    oaFlag: row.oaFlag,
    snippet: row.snippet,
    disposition: row.disposition as CandidateDisposition,
    rejectReason: row.rejectReason,
    recordMarkId: row.recordMarkId,
    createdAt: row.createdAt.getTime(),
  };
}

function toFactCandidateRow(row: DbFactCandidateRow): SearchFactCandidateRow {
  return {
    id: row.id,
    jobId: row.jobId,
    text: row.factText,
    score: row.score,
    status: row.status as FactCandidateStatus,
    factId: row.factId,
    assessorNote: row.assessorNote,
    createdAt: row.createdAt.getTime(),
  };
}

function toEvidenceRow(row: DbEvidenceRow): EvidenceRow {
  return {
    id: row.id,
    jobId: row.jobId,
    candidateId: row.candidateId,
    factCandidateId: row.factCandidateId,
    queryText: row.queryText,
    sourceKind: row.sourceKind as SourceKind,
    httpStatus: row.httpStatus,
    note: row.note,
    retrievedAt: row.retrievedAt.getTime(),
  };
}

export function createDrizzleDeepSearchRepository(db: Database): DeepSearchRepository {
  async function requireJob(
    tx: Database,
    workspaceId: string,
    jobId: string,
  ): Promise<DbJobRow> {
    const rows = await tx
      .select()
      .from(searchJobs)
      .where(and(eq(searchJobs.workspaceId, workspaceId), eq(searchJobs.id, jobId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw jobNotFound();
    }
    return row;
  }

  return {
    async createJob(
      workspaceId: string,
      createdByUserId: string | null,
      input: CreateJobInput,
    ): Promise<SearchJobRow> {
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(searchJobs)
          .values({
            workspaceId,
            projectKey: input.projectKey,
            topic: input.topic,
            status: 'queued',
            input: input.input,
            budgetExaUsd: input.budgetExaUsd ?? null,
            createdByUserId,
          })
          .returning();
        const row = inserted[0] as DbJobRow;
        await tx.insert(searchJobSteps).values(
          STEP_KINDS.map((step) => ({ jobId: row.id, step, status: 'pending' })),
        );
        return toJobRow(row);
      });
    },

    async getJob(workspaceId: string, jobId: string): Promise<SearchJobRow> {
      return db.transaction(async (tx) => toJobRow(await requireJob(tx, workspaceId, jobId)));
    },

    async listJobs(workspaceId: string, filter: ListJobsFilter): Promise<ListJobsResult> {
      return db.transaction(async (tx) => {
        const conditions = [eq(searchJobs.workspaceId, workspaceId)];
        if (filter.projectKey !== undefined) {
          conditions.push(eq(searchJobs.projectKey, filter.projectKey));
        }
        if (filter.status !== undefined) {
          conditions.push(eq(searchJobs.status, filter.status));
        }
        if (filter.cursor !== undefined) {
          const cursor = decodeJobCursor(filter.cursor);
          if (cursor === null) {
            throw ApiError.validation('The cursor is not valid.', { field: 'cursor' });
          }
          const cursorDate = new Date(cursor.createdAt);
          conditions.push(
            or(
              lt(searchJobs.createdAt, cursorDate),
              and(eq(searchJobs.createdAt, cursorDate), lt(searchJobs.id, cursor.id)),
            ) as never,
          );
        }
        const rows = await tx
          .select()
          .from(searchJobs)
          .where(and(...conditions))
          .orderBy(desc(searchJobs.createdAt), desc(searchJobs.id))
          .limit(filter.limit + 1);
        const page = rows.slice(0, filter.limit).map(toJobRow);
        const nextCursor =
          rows.length > filter.limit && page.length > 0
            ? encodeJobCursor(page[page.length - 1] as SearchJobRow)
            : null;
        return { items: page, nextCursor };
      });
    },

    async getJobSteps(workspaceId: string, jobId: string): Promise<SearchJobStepRow[]> {
      return db.transaction(async (tx) => {
        await requireJob(tx, workspaceId, jobId);
        const rows = await tx
          .select()
          .from(searchJobSteps)
          .where(eq(searchJobSteps.jobId, jobId));
        const byStep = new Map(rows.map((row) => [row.step, row]));
        return STEP_KINDS.flatMap((step) => {
          const row = byStep.get(step);
          return row === undefined ? [] : [toStepRow(row)];
        });
      });
    },

    async getJobSummary(workspaceId: string, jobId: string): Promise<JobSummary> {
      return db.transaction(async (tx) => {
        await requireJob(tx, workspaceId, jobId);
        const candidateCount = await tx
          .select({ value: count() })
          .from(searchCandidates)
          .where(eq(searchCandidates.jobId, jobId));
        const acceptedCount = await tx
          .select({ value: count() })
          .from(searchCandidates)
          .where(
            and(
              eq(searchCandidates.jobId, jobId),
              eq(searchCandidates.disposition, 'accepted'),
            ),
          );
        const factCount = await tx
          .select({ value: count() })
          .from(searchFactCandidates)
          .where(eq(searchFactCandidates.jobId, jobId));
        const mappedCount = await tx
          .select({ value: count() })
          .from(searchFactCandidates)
          .where(
            and(eq(searchFactCandidates.jobId, jobId), eq(searchFactCandidates.status, 'mapped')),
          );
        const unmappedCount = await tx
          .select({ value: count() })
          .from(searchFactCandidates)
          .where(
            and(
              eq(searchFactCandidates.jobId, jobId),
              eq(searchFactCandidates.status, 'unmapped'),
            ),
          );
        return {
          candidates: candidateCount[0]?.value ?? 0,
          acceptedCandidates: acceptedCount[0]?.value ?? 0,
          factCandidates: factCount[0]?.value ?? 0,
          mappedFacts: mappedCount[0]?.value ?? 0,
          unmappedFacts: unmappedCount[0]?.value ?? 0,
        };
      });
    },

    async cancelJob(workspaceId: string, jobId: string): Promise<SearchJobRow> {
      return db.transaction(async (tx) => {
        const row = await requireJob(tx, workspaceId, jobId);
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
        const updated = await tx
          .update(searchJobs)
          .set({ status: 'cancelled', finishedAt: new Date() })
          .where(eq(searchJobs.id, jobId))
          .returning();
        return toJobRow(updated[0] as DbJobRow);
      });
    },

    async retryJob(workspaceId: string, jobId: string): Promise<SearchJobRow> {
      return db.transaction(async (tx) => {
        const row = await requireJob(tx, workspaceId, jobId);
        if (row.status !== 'failed') {
          throw ApiError.revisionConflict(
            { status: row.status },
            {},
            'Only a failed job can be retried.',
          );
        }
        const updated = await tx
          .update(searchJobs)
          .set({
            status: 'queued',
            startedAt: null,
            finishedAt: null,
            errorCode: null,
            errorDetail: null,
          })
          .where(eq(searchJobs.id, jobId))
          .returning();
        await tx.delete(searchJobSteps).where(eq(searchJobSteps.jobId, jobId));
        await tx.insert(searchJobSteps).values(
          STEP_KINDS.map((step) => ({ jobId, step, status: 'pending' })),
        );
        return toJobRow(updated[0] as DbJobRow);
      });
    },

    async listCandidates(workspaceId: string, jobId: string): Promise<SearchCandidateRow[]> {
      return db.transaction(async (tx) => {
        await requireJob(tx, workspaceId, jobId);
        const rows = await tx
          .select()
          .from(searchCandidates)
          .where(eq(searchCandidates.jobId, jobId))
          .orderBy(asc(searchCandidates.createdAt), asc(searchCandidates.id));
        return rows.map(toCandidateRow);
      });
    },

    async listFactCandidates(
      workspaceId: string,
      jobId: string,
    ): Promise<SearchFactCandidateRow[]> {
      return db.transaction(async (tx) => {
        await requireJob(tx, workspaceId, jobId);
        const rows = await tx
          .select()
          .from(searchFactCandidates)
          .where(eq(searchFactCandidates.jobId, jobId))
          .orderBy(asc(searchFactCandidates.createdAt), asc(searchFactCandidates.id));
        return rows.map(toFactCandidateRow);
      });
    },

    async claimNextCollectorJob(): Promise<SearchJobRow | null> {
      return db.transaction(async (tx) => {
        const busyRows = await tx
          .select({ workspaceId: searchJobs.workspaceId })
          .from(searchJobs)
          .where(
            inArray(searchJobs.status, ['collecting', 'assessing', 'complementing', 'writing']),
          );
        const busyWorkspaces = new Set(busyRows.map((row) => row.workspaceId));
        const queued = await tx
          .select()
          .from(searchJobs)
          .where(eq(searchJobs.status, 'queued'))
          .orderBy(asc(searchJobs.createdAt), asc(searchJobs.id))
          .limit(50);
        for (const job of queued) {
          if (busyWorkspaces.has(job.workspaceId)) continue;
          const stepRows = await tx
            .select()
            .from(searchJobSteps)
            .where(
              and(eq(searchJobSteps.jobId, job.id), eq(searchJobSteps.step, 'collector_pubmed')),
            )
            .limit(1);
          const step = stepRows[0];
          if (step === undefined || step.status !== 'pending') continue;
          const updated = await tx
            .update(searchJobs)
            .set({ status: 'collecting', startedAt: job.startedAt ?? new Date() })
            .where(and(eq(searchJobs.id, job.id), eq(searchJobs.status, 'queued')))
            .returning();
          if (updated.length === 0) continue;
          await tx
            .update(searchJobSteps)
            .set({ status: 'running', startedAt: new Date() })
            .where(eq(searchJobSteps.id, step.id));
          return toJobRow(updated[0] as DbJobRow);
        }
        return null;
      });
    },

    async markStaleJobsFailed(): Promise<number> {
      return db.transaction(async (tx) => {
        const stale = await tx
          .select({ id: searchJobs.id })
          .from(searchJobs)
          .where(
            inArray(searchJobs.status, ['collecting', 'assessing', 'complementing', 'writing']),
          );
        if (stale.length === 0) return 0;
        const ids = stale.map((row) => row.id);
        await tx
          .update(searchJobs)
          .set({
            status: 'failed',
            errorCode: 'worker_restarted',
            errorDetail: 'The worker process restarted while this job was running.',
            finishedAt: new Date(),
          })
          .where(inArray(searchJobs.id, ids));
        await tx
          .update(searchJobSteps)
          .set({ status: 'failed', finishedAt: new Date() })
          .where(
            and(inArray(searchJobSteps.jobId, ids), eq(searchJobSteps.status, 'running')),
          );
        return ids.length;
      });
    },

    async completeStep(
      jobId: string,
      step: StepKind,
      detail: Record<string, unknown> | null,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(searchJobSteps)
          .set({ status: 'completed', detail, finishedAt: new Date() })
          .where(and(eq(searchJobSteps.jobId, jobId), eq(searchJobSteps.step, step)));
      });
    },

    async failStep(
      jobId: string,
      step: StepKind,
      detail: Record<string, unknown> | null,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(searchJobSteps)
          .set({ status: 'failed', detail, finishedAt: new Date() })
          .where(and(eq(searchJobSteps.jobId, jobId), eq(searchJobSteps.step, step)));
      });
    },

    async insertCandidates(
      jobId: string,
      candidates: NewCandidate[],
    ): Promise<SearchCandidateRow[]> {
      if (candidates.length === 0) return [];
      return db.transaction(async (tx) => {
        await tx
          .insert(searchCandidates)
          .values(candidates.map((candidate) => ({ jobId, ...candidate })))
          .onConflictDoNothing({
            target: [searchCandidates.jobId, searchCandidates.externalId],
          });
        const rows = await tx
          .select()
          .from(searchCandidates)
          .where(
            and(
              eq(searchCandidates.jobId, jobId),
              inArray(
                searchCandidates.externalId,
                candidates.map((candidate) => candidate.externalId),
              ),
            ),
          )
          .orderBy(asc(searchCandidates.createdAt), asc(searchCandidates.id));
        return rows.map(toCandidateRow);
      });
    },

    async insertEvidence(jobId: string, evidence: NewEvidence[]): Promise<void> {
      if (evidence.length === 0) return;
      await db.transaction(async (tx) => {
        await tx.insert(searchEvidence).values(
          evidence.map((item) => ({
            jobId,
            candidateId: item.candidateId,
            factCandidateId: item.factCandidateId ?? null,
            queryText: item.queryText,
            sourceKind: item.sourceKind,
            httpStatus: item.httpStatus,
            note: item.note,
          })),
        );
      });
    },

    async countCandidates(jobId: string): Promise<number> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ value: count() })
          .from(searchCandidates)
          .where(eq(searchCandidates.jobId, jobId));
        return rows[0]?.value ?? 0;
      });
    },

    async releaseJobToQueued(jobId: string): Promise<SearchJobRow> {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(searchJobs)
          .set({ status: 'queued' })
          .where(eq(searchJobs.id, jobId))
          .returning();
        const row = updated[0];
        if (row === undefined) {
          throw jobNotFound();
        }
        return toJobRow(row);
      });
    },

    async failJob(
      jobId: string,
      errorCode: string,
      errorDetail: string,
    ): Promise<SearchJobRow> {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(searchJobs)
          .set({ status: 'failed', errorCode, errorDetail, finishedAt: new Date() })
          .where(eq(searchJobs.id, jobId))
          .returning();
        const row = updated[0];
        if (row === undefined) {
          throw jobNotFound();
        }
        return toJobRow(row);
      });
    },

    async claimNextExaJob(): Promise<SearchJobRow | null> {
      return db.transaction(async (tx) => {
        const busyRows = await tx
          .select({ workspaceId: searchJobs.workspaceId })
          .from(searchJobs)
          .where(
            inArray(searchJobs.status, ['collecting', 'assessing', 'complementing', 'writing']),
          );
        const busyWorkspaces = new Set(busyRows.map((row) => row.workspaceId));
        const queued = await tx
          .select()
          .from(searchJobs)
          .where(eq(searchJobs.status, 'queued'))
          .orderBy(asc(searchJobs.createdAt), asc(searchJobs.id))
          .limit(50);
        for (const job of queued) {
          if (busyWorkspaces.has(job.workspaceId)) continue;
          const stepRows = await tx
            .select()
            .from(searchJobSteps)
            .where(
              and(
                eq(searchJobSteps.jobId, job.id),
                inArray(searchJobSteps.step, ['collector_pubmed', 'collector_exa']),
              ),
            );
          const pubmedStep = stepRows.find((row) => row.step === 'collector_pubmed');
          const exaStep = stepRows.find((row) => row.step === 'collector_exa');
          if (
            pubmedStep === undefined ||
            pubmedStep.status !== 'completed' ||
            exaStep === undefined ||
            exaStep.status !== 'pending'
          ) {
            continue;
          }
          const updated = await tx
            .update(searchJobs)
            .set({ status: 'collecting', startedAt: job.startedAt ?? new Date() })
            .where(and(eq(searchJobs.id, job.id), eq(searchJobs.status, 'queued')))
            .returning();
          if (updated.length === 0) continue;
          await tx
            .update(searchJobSteps)
            .set({ status: 'running', startedAt: new Date() })
            .where(eq(searchJobSteps.id, exaStep.id));
          return toJobRow(updated[0] as DbJobRow);
        }
        return null;
      });
    },

    async skipStep(
      jobId: string,
      step: StepKind,
      detail: Record<string, unknown> | null,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(searchJobSteps)
          .set({ status: 'skipped', detail, finishedAt: new Date() })
          .where(and(eq(searchJobSteps.jobId, jobId), eq(searchJobSteps.step, step)));
      });
    },

    async addJobCost(jobId: string, costUsd: string): Promise<SearchJobRow> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(searchJobs)
          .where(eq(searchJobs.id, jobId))
          .limit(1);
        const current = rows[0];
        if (current === undefined) {
          throw jobNotFound();
        }
        const next = formatUsdUnits(
          parseUsdToUnits(String(current.costExaUsd)) + parseUsdToUnits(costUsd),
        );
        const updated = await tx
          .update(searchJobs)
          .set({ costExaUsd: next })
          .where(eq(searchJobs.id, jobId))
          .returning();
        const row = updated[0];
        if (row === undefined) {
          throw jobNotFound();
        }
        return toJobRow(row);
      });
    },

    async claimNextAssessorJob(): Promise<SearchJobRow | null> {
      return db.transaction(async (tx) => {
        const busyRows = await tx
          .select({ workspaceId: searchJobs.workspaceId })
          .from(searchJobs)
          .where(
            inArray(searchJobs.status, ['collecting', 'assessing', 'complementing', 'writing']),
          );
        const busyWorkspaces = new Set(busyRows.map((row) => row.workspaceId));
        const queued = await tx
          .select()
          .from(searchJobs)
          .where(eq(searchJobs.status, 'queued'))
          .orderBy(asc(searchJobs.createdAt), asc(searchJobs.id))
          .limit(50);
        for (const job of queued) {
          if (busyWorkspaces.has(job.workspaceId)) continue;
          const stepRows = await tx
            .select()
            .from(searchJobSteps)
            .where(
              and(
                eq(searchJobSteps.jobId, job.id),
                inArray(searchJobSteps.step, ['collector_pubmed', 'collector_exa', 'assessor']),
              ),
            );
          const pubmedStep = stepRows.find((row) => row.step === 'collector_pubmed');
          const exaStep = stepRows.find((row) => row.step === 'collector_exa');
          const assessorStep = stepRows.find((row) => row.step === 'assessor');
          const exaResolved =
            exaStep !== undefined &&
            (exaStep.status === 'completed' ||
              exaStep.status === 'skipped' ||
              exaStep.status === 'failed');
          if (
            pubmedStep === undefined ||
            pubmedStep.status !== 'completed' ||
            !exaResolved ||
            assessorStep === undefined ||
            assessorStep.status !== 'pending'
          ) {
            continue;
          }
          const updated = await tx
            .update(searchJobs)
            .set({ status: 'assessing', startedAt: job.startedAt ?? new Date() })
            .where(and(eq(searchJobs.id, job.id), eq(searchJobs.status, 'queued')))
            .returning();
          if (updated.length === 0) continue;
          await tx
            .update(searchJobSteps)
            .set({ status: 'running', startedAt: new Date() })
            .where(eq(searchJobSteps.id, assessorStep.id));
          return toJobRow(updated[0] as DbJobRow);
        }
        return null;
      });
    },

    async claimNextComplementJob(): Promise<SearchJobRow | null> {
      return db.transaction(async (tx) => {
        const busyRows = await tx
          .select({ workspaceId: searchJobs.workspaceId })
          .from(searchJobs)
          .where(
            inArray(searchJobs.status, ['collecting', 'assessing', 'complementing', 'writing']),
          );
        const busyWorkspaces = new Set(busyRows.map((row) => row.workspaceId));
        const queued = await tx
          .select()
          .from(searchJobs)
          .where(eq(searchJobs.status, 'queued'))
          .orderBy(asc(searchJobs.createdAt), asc(searchJobs.id))
          .limit(50);
        for (const job of queued) {
          if (busyWorkspaces.has(job.workspaceId)) continue;
          const stepRows = await tx
            .select()
            .from(searchJobSteps)
            .where(
              and(
                eq(searchJobSteps.jobId, job.id),
                inArray(searchJobSteps.step, ['assessor', 'complement']),
              ),
            );
          const assessorStep = stepRows.find((row) => row.step === 'assessor');
          const complementStep = stepRows.find((row) => row.step === 'complement');
          if (
            assessorStep === undefined ||
            assessorStep.status !== 'completed' ||
            complementStep === undefined ||
            complementStep.status !== 'pending'
          ) {
            continue;
          }
          const updated = await tx
            .update(searchJobs)
            .set({ status: 'complementing', startedAt: job.startedAt ?? new Date() })
            .where(and(eq(searchJobs.id, job.id), eq(searchJobs.status, 'queued')))
            .returning();
          if (updated.length === 0) continue;
          await tx
            .update(searchJobSteps)
            .set({ status: 'running', startedAt: new Date() })
            .where(eq(searchJobSteps.id, complementStep.id));
          return toJobRow(updated[0] as DbJobRow);
        }
        return null;
      });
    },

    async insertFactCandidates(
      jobId: string,
      facts: NewFactCandidate[],
    ): Promise<SearchFactCandidateRow[]> {
      if (facts.length === 0) return [];
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(searchFactCandidates)
          .values(
            facts.map((fact) => ({
              jobId,
              factText: fact.text,
              score: fact.score,
              status: fact.status,
              assessorNote: fact.assessorNote,
            })),
          )
          .returning();
        return inserted.map(toFactCandidateRow);
      });
    },

    async updateFactCandidateScores(
      jobId: string,
      updates: FactScoreUpdate[],
    ): Promise<void> {
      if (updates.length === 0) return;
      await db.transaction(async (tx) => {
        for (const update of updates) {
          await tx
            .update(searchFactCandidates)
            .set({
              score: update.score,
              status: update.status,
              assessorNote: update.assessorNote,
            })
            .where(
              and(
                eq(searchFactCandidates.jobId, jobId),
                eq(searchFactCandidates.id, update.id),
              ),
            );
        }
      });
    },

    async approveWriting(workspaceId: string, jobId: string): Promise<SearchJobRow> {
      return db.transaction(async (tx) => {
        const row = await requireJob(tx, workspaceId, jobId);
        if (
          row.status === 'completed' ||
          row.status === 'failed' ||
          row.status === 'cancelled' ||
          row.status === 'writing'
        ) {
          throw ApiError.revisionConflict(
            { status: row.status },
            {},
            'The job can no longer be approved for writing.',
          );
        }
        const rawInput =
          typeof row.input === 'object' && row.input !== null
            ? (row.input as Record<string, unknown>)
            : {};
        const updated = await tx
          .update(searchJobs)
          .set({ input: { ...rawInput, writingApproved: true } })
          .where(eq(searchJobs.id, jobId))
          .returning();
        const updatedRow = updated[0];
        if (updatedRow === undefined) {
          throw jobNotFound();
        }
        return toJobRow(updatedRow);
      });
    },

    async claimNextWriterJob(): Promise<SearchJobRow | null> {
      return db.transaction(async (tx) => {
        const busyRows = await tx
          .select({ workspaceId: searchJobs.workspaceId })
          .from(searchJobs)
          .where(
            inArray(searchJobs.status, ['collecting', 'assessing', 'complementing', 'writing']),
          );
        const busyWorkspaces = new Set(busyRows.map((row) => row.workspaceId));
        const queued = await tx
          .select()
          .from(searchJobs)
          .where(eq(searchJobs.status, 'queued'))
          .orderBy(asc(searchJobs.createdAt), asc(searchJobs.id))
          .limit(50);
        for (const job of queued) {
          if (busyWorkspaces.has(job.workspaceId)) continue;
          const stepRows = await tx
            .select()
            .from(searchJobSteps)
            .where(
              and(eq(searchJobSteps.jobId, job.id), eq(searchJobSteps.step, 'complement')),
            )
            .limit(1);
          const complementStep = stepRows[0];
          const complementResolved =
            complementStep !== undefined &&
            (complementStep.status === 'completed' ||
              complementStep.status === 'skipped' ||
              complementStep.status === 'failed');
          if (!complementResolved) {
            continue;
          }
          const approved = normalizeJobInput(job.input).writingApproved === true;
          if (!approved) {
            const writtenRows = await tx
              .select({ id: searchCandidates.id })
              .from(searchCandidates)
              .innerJoin(searchJobs, eq(searchCandidates.jobId, searchJobs.id))
              .where(
                and(
                  eq(searchJobs.workspaceId, job.workspaceId),
                  eq(searchJobs.projectKey, job.projectKey),
                  ne(searchJobs.id, job.id),
                  isNotNull(searchCandidates.recordMarkId),
                ),
              )
              .limit(1);
            if (writtenRows.length === 0) {
              continue;
            }
          }
          const updated = await tx
            .update(searchJobs)
            .set({ status: 'writing', startedAt: job.startedAt ?? new Date() })
            .where(and(eq(searchJobs.id, job.id), eq(searchJobs.status, 'queued')))
            .returning();
          if (updated.length === 0) continue;
          return toJobRow(updated[0] as DbJobRow);
        }
        return null;
      });
    },

    async completeJob(jobId: string): Promise<SearchJobRow> {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(searchJobs)
          .set({ status: 'completed', finishedAt: new Date() })
          .where(eq(searchJobs.id, jobId))
          .returning();
        const row = updated[0];
        if (row === undefined) {
          throw jobNotFound();
        }
        return toJobRow(row);
      });
    },

    async setCandidateWritten(
      jobId: string,
      candidateId: string,
      update: CandidateWrittenUpdate,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(searchCandidates)
          .set({
            disposition: update.disposition,
            recordMarkId: update.recordMarkId,
            rejectReason: update.rejectReason,
          })
          .where(
            and(eq(searchCandidates.jobId, jobId), eq(searchCandidates.id, candidateId)),
          );
      });
    },

    async setFactWritten(
      jobId: string,
      factCandidateId: string,
      factId: string,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(searchFactCandidates)
          .set({ factId })
          .where(
            and(
              eq(searchFactCandidates.jobId, jobId),
              eq(searchFactCandidates.id, factCandidateId),
            ),
          );
      });
    },

    async listJobEvidence(jobId: string): Promise<EvidenceRow[]> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(searchEvidence)
          .where(eq(searchEvidence.jobId, jobId))
          .orderBy(asc(searchEvidence.retrievedAt), asc(searchEvidence.id));
        return rows.map(toEvidenceRow);
      });
    },
  };
}
