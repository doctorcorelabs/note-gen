// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Drizzle/Postgres implementation of the Deep Search repository
// (F2-2, wave G-F2-2a). Every method runs in one transaction via
// db.transaction(). Semantics mirror the fake: queued creation with
// pending steps, cancel/retry status machine, cursor pagination.
// The executor stages land in G-F2-2b..e; this implementation only
// reads and writes job state.

import { and, asc, count, desc, eq, lt, or } from 'drizzle-orm';
import { ApiError } from '../../plugins/envelope.js';
import {
  searchCandidates,
  searchFactCandidates,
  searchJobs,
  searchJobSteps,
  type Database,
} from '../../db/index.js';
import {
  STEP_KINDS,
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
  type DeepSearchRepository,
  type ListJobsFilter,
  type ListJobsResult,
} from './repository.js';
import type { CreateJobInput } from './validation.js';

type DbJobRow = typeof searchJobs.$inferSelect;
type DbStepRow = typeof searchJobSteps.$inferSelect;
type DbCandidateRow = typeof searchCandidates.$inferSelect;
type DbFactCandidateRow = typeof searchFactCandidates.$inferSelect;

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
  };
}
