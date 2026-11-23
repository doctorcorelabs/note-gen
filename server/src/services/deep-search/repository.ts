// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Repository port for the Deep Search service (F2-2, waves G-F2-2a
// and G-F2-2b). Coarse like the citations port: each method owns one
// operation's transaction. Two implementations: Drizzle over
// Postgres, and an in-memory fake for specs. HTTP concerns belong
// to the route layer.
//
// G-F2-2a shipped schema + job API. G-F2-2b adds the executor
// surface for the first stage (Collector PubMed): claiming queued
// jobs, stage transitions, candidate and evidence inserts, and
// stale-job recovery. G-F2-2c adds the Collector Exa claim, the
// explicit stage skip (a stage that must not run is recorded
// skipped with its reason, never silently pending), and recorded
// Exa cost accumulation. Later waves (Assessor, Complement,
// Writer) extend the same port.
//
// Status rules (binding):
// - cancel: allowed before writing (queued, collecting, assessing,
//   complementing). A writing job answers 409 in this wave; the
//   executor wave defines cancelling later stages. Terminal jobs
//   (completed, failed, cancelled) answer 409.
// - retry: only from failed. The job returns to queued with steps
//   reset to pending and error fields cleared; candidates are kept
//   for dedupe. Any other status answers 409.
// - There is no delete: a job is the search audit trail (decision 9).

import type {
  JobStatus,
  JobSummary,
  SearchCandidateRow,
  SearchFactCandidateRow,
  SearchJobRow,
  SearchJobStepRow,
  SourceKind,
  StepKind,
} from './represent.js';
import type { CreateJobInput } from './validation.js';

// Executor-facing insert shapes (G-F2-2b). A NewCandidate is a
// normalized external source before it has a row id; disposition
// starts pending and recordMarkId stays null until the writing
// stage of a later wave. NewEvidence is one search-trail row:
// query-level rows carry candidateId null, candidate rows link to
// the candidate they produced. No credential ever rides in either
// shape.
export interface NewCandidate {
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
}

export interface NewEvidence {
  candidateId: string | null;
  queryText: string;
  sourceKind: SourceKind;
  httpStatus: number | null;
  note: string | null;
}

export interface ListJobsFilter {
  projectKey?: string | undefined;
  status?: JobStatus | undefined;
  limit: number;
  // Opaque cursor from a previous page (base64url of
  // "<createdAtMs>:<id>"). Invalid cursors answer 400.
  cursor?: string | undefined;
}

export interface ListJobsResult {
  items: SearchJobRow[];
  nextCursor: string | null;
}

export interface DeepSearchRepository {
  // Create a job in queued status with its four stage rows pending.
  // createdByUserId is the session user (null on the agent path of a
  // later wave, which passes a token id instead).
  createJob(
    workspaceId: string,
    createdByUserId: string | null,
    input: CreateJobInput,
  ): Promise<SearchJobRow>;

  // A single job. Unknown id answers 404.
  getJob(workspaceId: string, jobId: string): Promise<SearchJobRow>;

  // Jobs of the workspace, newest first, cursor paginated.
  listJobs(workspaceId: string, filter: ListJobsFilter): Promise<ListJobsResult>;

  // Stage rows of a job in binding chain order. Unknown job 404.
  getJobSteps(workspaceId: string, jobId: string): Promise<SearchJobStepRow[]>;

  // Candidate/fact counts for the detail view. Unknown job 404.
  getJobSummary(workspaceId: string, jobId: string): Promise<JobSummary>;

  // Cancel a job before writing. Terminal or writing jobs 409.
  cancelJob(workspaceId: string, jobId: string): Promise<SearchJobRow>;

  // Retry a failed job: back to queued, steps reset, candidates
  // kept. Any other status 409.
  retryJob(workspaceId: string, jobId: string): Promise<SearchJobRow>;

  // Candidates of a job, creation order. Unknown job 404.
  listCandidates(workspaceId: string, jobId: string): Promise<SearchCandidateRow[]>;

  // Fact candidates of a job, creation order. Unknown job 404.
  listFactCandidates(workspaceId: string, jobId: string): Promise<SearchFactCandidateRow[]>;

  // Executor surface (G-F2-2b). These methods are worker-internal:
  // they take no workspace argument because the worker claims work
  // across workspaces, oldest first, and the claim itself is the
  // authorization boundary (one running job per workspace,
  // decision 6).

  // Claim the oldest queued job whose collector_pubmed step is
  // still pending and whose workspace has no running job. The job
  // moves to collecting (startedAt set on first claim) and the
  // step to running, atomically. Returns null when nothing is
  // claimable. A queued job whose collector_pubmed step already
  // completed is left for the later waves' executor.
  claimNextCollectorJob(): Promise<SearchJobRow | null>;

  // Startup recovery: jobs left in a running status by a previous
  // process are marked failed with error_code worker_restarted,
  // and their running steps failed. Returns how many jobs were
  // recovered. Never resumes work silently (design 3.2).
  markStaleJobsFailed(): Promise<number>;

  // Stage transitions. completeStep/failStep stamp finishedAt and
  // store the non-secret detail (query counts, per-source
  // outcomes, skip or failure reasons).
  completeStep(
    jobId: string,
    step: StepKind,
    detail: Record<string, unknown> | null,
  ): Promise<void>;
  failStep(jobId: string, step: StepKind, detail: Record<string, unknown> | null): Promise<void>;

  // Insert collector candidates, deduplicated on the unique
  // (job_id, external_id) pair so a stage retry never duplicates
  // a candidate. Returns the stored rows for the given external
  // ids (newly inserted and pre-existing alike) so the worker can
  // link evidence to candidate ids.
  insertCandidates(jobId: string, candidates: NewCandidate[]): Promise<SearchCandidateRow[]>;

  // Append search-trail rows for a job.
  insertEvidence(jobId: string, evidence: NewEvidence[]): Promise<void>;

  // How many candidates a job already holds (cap enforcement
  // across stage retries).
  countCandidates(jobId: string): Promise<number>;

  // Hand a job back to queued after a stage completed: the chain
  // continues when a later wave's executor claims the next
  // pending step. startedAt is kept (the job did start).
  releaseJobToQueued(jobId: string): Promise<SearchJobRow>;

  // Terminal failure: status failed, finishedAt stamped, stable
  // error code plus a short non-secret detail.
  failJob(jobId: string, errorCode: string, errorDetail: string): Promise<SearchJobRow>;

  // Executor surface (G-F2-2c). Claim the oldest queued job whose
  // collector_pubmed step completed and whose collector_exa step
  // is still pending, with no running job in its workspace. The
  // job moves to collecting and the step to running, atomically.
  // Returns null when nothing is claimable. Budget and key checks
  // belong to the worker/collector, not the claim, so a job that
  // must not run Exa still gets its step resolved as skipped.
  claimNextExaJob(): Promise<SearchJobRow | null>;

  // Record a stage as skipped with its non-secret reason (no
  // approved Exa budget, Exa key not configured, Complement not
  // triggered). A skipped stage is a recorded outcome, never a
  // silently pending one.
  skipStep(jobId: string, step: StepKind, detail: Record<string, unknown> | null): Promise<void>;

  // Add a recorded Exa run cost (decimal string, 4 places) to the
  // job's cost_exa_usd. Integer-unit arithmetic; the ceiling was
  // enforced by the collector before spending.
  addJobCost(jobId: string, costUsd: string): Promise<SearchJobRow>;
}

// Cursor helpers shared by both implementations so the wire format
// cannot drift between them.

export function encodeJobCursor(row: SearchJobRow): string {
  return Buffer.from(`${row.createdAt}:${row.id}`, 'utf8').toString('base64url');
}

export function decodeJobCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep <= 0) return null;
    const createdAt = Number(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (!Number.isFinite(createdAt) || id === '') return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
