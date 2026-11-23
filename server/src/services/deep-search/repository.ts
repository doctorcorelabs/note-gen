// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Repository port for the Deep Search service (F2-2, wave G-F2-2a).
// Coarse like the citations port: each method owns one operation's
// transaction. Two implementations: Drizzle over Postgres, and an
// in-memory fake for specs. HTTP concerns belong to the route layer.
//
// This wave is schema + job API only. The executor stages
// (Collector, Assessor, Complement, Writer) land in G-F2-2b..e, so
// jobs created here stay queued; cancel and retry already enforce
// the full status machine so later waves only add transitions.
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
} from './represent.js';
import type { CreateJobInput } from './validation.js';

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
