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
// Exa cost accumulation. G-F2-2d adds the Assessor and Complement
// claims plus fact candidate inserts and score updates. G-F2-2e
// adds the Writer surface: explicit writing approval (decision
// 8), the writer claim, job completion, and the candidate/fact
// write-back links. The Writer stage has no step row (the step
// CHECK predates it and no migration is needed): the job status
// writing -> completed plus per-item evidence rows are its
// record.
//
// Status rules (binding):
// - cancel: allowed before writing (queued, collecting, assessing,
//   complementing). A writing job answers 409 in this wave; the
//   executor wave defines cancelling later stages. Terminal jobs
//   (completed, failed, cancelled) answer 409.
// - retry: only from failed. The job returns to queued with steps
//   reset to pending and error fields cleared; candidates are kept
//   for dedupe. Any other status answers 409.
// - approve-writing (G-F2-2e, decision 8): sets the explicit
//   writing approval on a non-terminal job. Terminal or writing
//   jobs answer 409. Approving twice is a no-op success. The
//   first job of a project is claimed by the Writer only with
//   this approval; a later job of the same project is claimable
//   once an earlier job already wrote data.
// - There is no delete: a job is the search audit trail (decision 9).

import type {
  CandidateDisposition,
  EvidenceRow,
  FactCandidateStatus,
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
  // Fact candidate this trail row supports (G-F2-2d Assessor and
  // Complement evidence). Collector rows leave it unset; the
  // repositories store null for unset.
  factCandidateId?: string | null;
  queryText: string;
  sourceKind: SourceKind;
  httpStatus: number | null;
  note: string | null;
}

// Executor-facing fact shapes (G-F2-2d). A NewFactCandidate is
// one Assessor output before it has a row id; factId stays null
// until the writing stage of a later wave. A FactScoreUpdate
// re-scores one stored fact candidate after Complement.
export interface NewFactCandidate {
  text: string;
  score: number;
  status: FactCandidateStatus;
  assessorNote: string | null;
}

export interface FactScoreUpdate {
  id: string;
  score: number;
  status: FactCandidateStatus;
  assessorNote: string | null;
}

// Writer write-back shapes (G-F2-2e). A CandidateWrittenUpdate
// records what one candidate became in the writing stage:
// accepted with its new structured record, duplicate with the
// existing record it matched, or rejected with its reason (no
// record). recordMarkId stays null exactly when rejected.
export interface CandidateWrittenUpdate {
  disposition: CandidateDisposition;
  recordMarkId: number | null;
  rejectReason: string | null;
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
  // createdByUserId is the session user on the cookie path (null on
  // the agent path, which passes createdByTokenId instead; wave
  // G-F2-2f). Exactly one of the two is set by the route layer.
  createJob(
    workspaceId: string,
    createdByUserId: string | null,
    input: CreateJobInput,
    createdByTokenId?: string | null,
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

  // Executor surface (G-F2-2d). Claim the oldest queued job whose
  // collector_pubmed step completed, whose collector_exa step is
  // resolved (completed, skipped, or failed), and whose assessor
  // step is still pending, with no running job in its workspace.
  // The job moves to assessing and the step to running,
  // atomically. Returns null when nothing is claimable.
  claimNextAssessorJob(): Promise<SearchJobRow | null>;

  // Claim the oldest queued job whose assessor step completed
  // and whose complement step is still pending, with no running
  // job in its workspace. The job moves to complementing and the
  // step to running, atomically. Returns null when nothing is
  // claimable. Whether Complement actually collects is decided
  // by the worker from the stored fact scores, not by the claim,
  // so a job that must not collect still gets its step resolved
  // as skipped.
  claimNextComplementJob(): Promise<SearchJobRow | null>;

  // Insert Assessor fact candidates for a job. Returns the
  // stored rows in insertion order so the worker can link
  // evidence to fact candidate ids.
  insertFactCandidates(
    jobId: string,
    facts: NewFactCandidate[],
  ): Promise<SearchFactCandidateRow[]>;

  // Re-score stored fact candidates after Complement. Only the
  // listed rows change; unknown ids are ignored so a partial
  // update never fails the stage.
  updateFactCandidateScores(jobId: string, updates: FactScoreUpdate[]): Promise<void>;

  // Executor + approval surface (G-F2-2e, Writer).

  // Record the explicit human approval to write the results of
  // this job into F2-1 (decision 8). Sets input.writingApproved.
  // Terminal or writing jobs answer 409; unknown job 404.
  // Approving an already approved job is a no-op success.
  approveWriting(workspaceId: string, jobId: string): Promise<SearchJobRow>;

  // Claim the oldest queued job whose complement step is
  // resolved (completed, skipped, or failed) and whose writing
  // is allowed: explicitly approved, or an earlier job of the
  // same project in the same workspace already wrote data
  // (decision 8: only the first job per project stops for
  // approval). The job moves to writing, atomically. Returns
  // null when nothing is claimable. A first job without
  // approval simply stays queued; cancel remains available.
  claimNextWriterJob(): Promise<SearchJobRow | null>;

  // Terminal success: status completed, finishedAt stamped.
  completeJob(jobId: string): Promise<SearchJobRow>;

  // Record what one candidate became in the writing stage.
  setCandidateWritten(
    jobId: string,
    candidateId: string,
    update: CandidateWrittenUpdate,
  ): Promise<void>;

  // Link one fact candidate to the facts row it became.
  setFactWritten(jobId: string, factCandidateId: string, factId: string): Promise<void>;

  // Search-trail rows of a job in retrieval order. The Writer
  // reads the assessor evidence to learn which candidates
  // support which fact candidate.
  listJobEvidence(jobId: string): Promise<EvidenceRow[]>;
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
