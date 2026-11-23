// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Row shapes for the Deep Search service (F2-2, wave G-F2-2a).
// These mirror the M10 tables one to one; the repository port
// returns these shapes and the route layer maps them to wire
// representations. Timestamps are epoch milliseconds, following the
// citations service. Money stays a decimal string end to end so no
// float rounding ever touches a recorded cost.

export type JobStatus =
  | 'queued'
  | 'collecting'
  | 'assessing'
  | 'complementing'
  | 'writing'
  | 'completed'
  | 'failed'
  | 'cancelled';

// Money helpers (wave G-F2-2c). Budget and recorded cost travel as
// decimal strings with 4 places end to end (validation formats
// with toFixed(4)); all arithmetic happens in integer units of
// 0.0001 USD so no float rounding ever touches a recorded cost.
export const USD_UNIT_SCALE = 10_000;

export function parseUsdToUnits(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * USD_UNIT_SCALE);
}

export function formatUsdUnits(units: number): string {
  return (units / USD_UNIT_SCALE).toFixed(4);
}

export const JOB_STATUSES: readonly JobStatus[] = [
  'queued',
  'collecting',
  'assessing',
  'complementing',
  'writing',
  'completed',
  'failed',
  'cancelled',
];

export type StepKind = 'collector_pubmed' | 'collector_exa' | 'assessor' | 'complement';

// Stage order is the binding chain: Collector (PubMed first, Exa
// only for non-PubMed sources) -> Assessor -> Complement
// (conditional). Steps are created in this order at job creation.
export const STEP_KINDS: readonly StepKind[] = [
  'collector_pubmed',
  'collector_exa',
  'assessor',
  'complement',
];

export type StepStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

export type SourceKind = 'pubmed' | 'europepmc' | 'exa';

export type CandidateDisposition = 'pending' | 'accepted' | 'duplicate' | 'rejected';

export type FactCandidateStatus = 'pending' | 'mapped' | 'unmapped';

export type StageChoice = 'collector' | 'full';

// Non-secret job input, stored as jsonb on the job row. Thresholds
// default to the binding coordinator values (fact below 70 or
// average below 80 triggers Complement); a job may tighten them,
// never loosen them (decision 10).
export interface JobInput {
  maxCandidates: number;
  yearFrom: number | undefined;
  yearTo: number | undefined;
  language: string | undefined;
  stages: StageChoice;
  complementThresholdFact: number;
  complementThresholdAverage: number;
}

export interface SearchJobRow {
  id: string;
  workspaceId: string;
  projectKey: string;
  topic: string;
  status: JobStatus;
  input: JobInput;
  // Decimal string, or null when no Exa ceiling was approved (the
  // Exa stage must not run for such a job).
  budgetExaUsd: string | null;
  costExaUsd: string;
  createdByUserId: string | null;
  createdByTokenId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  errorCode: string | null;
  errorDetail: string | null;
}

export interface SearchJobStepRow {
  id: string;
  jobId: string;
  step: StepKind;
  status: StepStatus;
  detail: Record<string, unknown> | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface SearchCandidateRow {
  id: string;
  jobId: string;
  sourceKind: SourceKind;
  externalId: string;
  title: string | null;
  authors: string | null;
  journal: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  url: string | null;
  oaFlag: boolean | null;
  snippet: string | null;
  disposition: CandidateDisposition;
  rejectReason: string | null;
  recordMarkId: number | null;
  createdAt: number;
}

export interface SearchFactCandidateRow {
  id: string;
  jobId: string;
  text: string;
  score: number | null;
  status: FactCandidateStatus;
  factId: string | null;
  assessorNote: string | null;
  createdAt: number;
}

export interface JobSummary {
  candidates: number;
  acceptedCandidates: number;
  factCandidates: number;
  mappedFacts: number;
  unmappedFacts: number;
}

// Wire representations for the Deep Search routes (wave G-F2-2a).
// Field lists mirror the row shapes one to one; the route layer
// never invents fields the service does not hold.

export interface ApiJobInput {
  maxCandidates: number;
  yearFrom: number | null;
  yearTo: number | null;
  language: string | null;
  stages: StageChoice;
  complementThresholdFact: number;
  complementThresholdAverage: number;
}

export interface ApiJob {
  id: string;
  workspaceId: string;
  projectKey: string;
  topic: string;
  status: JobStatus;
  input: ApiJobInput;
  budgetExaUsd: string | null;
  costExaUsd: string;
  createdByUserId: string | null;
  createdByTokenId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  errorCode: string | null;
  errorDetail: string | null;
}

export function toApiJob(row: SearchJobRow): ApiJob {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectKey: row.projectKey,
    topic: row.topic,
    status: row.status,
    input: {
      maxCandidates: row.input.maxCandidates,
      yearFrom: row.input.yearFrom ?? null,
      yearTo: row.input.yearTo ?? null,
      language: row.input.language ?? null,
      stages: row.input.stages,
      complementThresholdFact: row.input.complementThresholdFact,
      complementThresholdAverage: row.input.complementThresholdAverage,
    },
    budgetExaUsd: row.budgetExaUsd,
    costExaUsd: row.costExaUsd,
    createdByUserId: row.createdByUserId,
    createdByTokenId: row.createdByTokenId,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
  };
}

export interface ApiJobStep {
  id: string;
  jobId: string;
  step: StepKind;
  status: StepStatus;
  detail: Record<string, unknown> | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export function toApiJobStep(row: SearchJobStepRow): ApiJobStep {
  return {
    id: row.id,
    jobId: row.jobId,
    step: row.step,
    status: row.status,
    detail: row.detail,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export interface ApiCandidate {
  id: string;
  jobId: string;
  sourceKind: SourceKind;
  externalId: string;
  title: string | null;
  authors: string | null;
  journal: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  url: string | null;
  oaFlag: boolean | null;
  snippet: string | null;
  disposition: CandidateDisposition;
  rejectReason: string | null;
  recordMarkId: number | null;
  createdAt: number;
}

export function toApiCandidate(row: SearchCandidateRow): ApiCandidate {
  return {
    id: row.id,
    jobId: row.jobId,
    sourceKind: row.sourceKind,
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
    disposition: row.disposition,
    rejectReason: row.rejectReason,
    recordMarkId: row.recordMarkId,
    createdAt: row.createdAt,
  };
}

export interface ApiFactCandidate {
  id: string;
  jobId: string;
  text: string;
  score: number | null;
  status: FactCandidateStatus;
  factId: string | null;
  assessorNote: string | null;
  createdAt: number;
}

export function toApiFactCandidate(row: SearchFactCandidateRow): ApiFactCandidate {
  return {
    id: row.id,
    jobId: row.jobId,
    text: row.text,
    score: row.score,
    status: row.status,
    factId: row.factId,
    assessorNote: row.assessorNote,
    createdAt: row.createdAt,
  };
}
