// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deep Search worker (F2-2, waves G-F2-2b and G-F2-2c): the
// executor.
//
// One background worker in the api process (design 3.2). It claims
// the oldest queued job whose next collector step is pending,
// at most one running job per workspace (decision 6), runs the
// stage with an explicit per-stage timeout (10 minutes, decision
// 6), stores candidates + evidence, and hands the job back to
// queued so later waves (Assessor, Complement, Writer) continue
// the chain from the next pending step. This wave never writes
// F2-1 data.
//
// G-F2-2b runs the PubMed collector stage. G-F2-2c adds the Exa
// collector stage, claimed only after the PubMed step completed
// and only when an Exa collector is wired in. Exa stage outcomes:
// - No approved budget on the job (decision 1) or no API key on
//   the server (decision 2): the step is recorded skipped with
//   its reason and the job returns to queued. The stage being
//   unavailable is an explicit recorded outcome, not a failure.
// - Source failure (429, HTTP, network, timeout, bad response):
//   the step is failed with its detail and the job returns to
//   queued as partial. Decision 7 allows partial completion only
//   when the PubMed stage completed, which the Exa claim already
//   guarantees; the PubMed candidates stay the job's trail.
// - Success: candidates + evidence stored, the recorded run cost
//   added to the job, step completed, job back to queued.
//
// PubMed failure semantics (decision 7): a PubMed (E-utilities)
// failure fails the stage and the job; a Europe PMC failure with
// PubMed success completes the stage as partial, with the failed
// source recorded in the step detail. HTTP 429 stops the source
// that returned it; nothing retries or routes around it. At
// startup, jobs a previous process left in a running status are
// marked failed with error_code worker_restarted, never resumed
// silently.
//
// runWorkerOnce is exported for specs: it claims and runs at most
// one job without timers.

import type { SearchJobRow } from './represent.js';
import type { DeepSearchRepository, NewEvidence } from './repository.js';
import {
  CollectorError,
  type CollectorResult,
  type PubmedCollector,
} from './collector-pubmed.js';
import type { ExaCollector, ExaCollectorResult } from './collector-exa.js';

export interface DeepSearchWorkerHandle {
  stop: () => void;
}

export interface DeepSearchWorkerOptions {
  repository: DeepSearchRepository;
  collector: PubmedCollector;
  // Exa stage wiring (G-F2-2c). When absent the worker never
  // claims the Exa step; production registration always wires a
  // collector (its key may still be unconfigured, which the
  // collector reports as exa_key_missing and the worker records
  // as a skipped step).
  exaCollector?: ExaCollector;
  pollIntervalMs?: number;
  stageTimeoutMs?: number;
  // Delay before the first tick (startup recovery + first claim).
  // Defaults to the poll interval. Short-lived app instances (the
  // spec suite boots many) then never issue a worker query, so
  // shutdown never waits on background database work; in
  // production the delay only postpones recovery by one interval.
  initialDelayMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60 * 1_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CollectorError('stage_timeout', 'The collector stage exceeded its time limit.'));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Collector failed.'));
      },
    );
  });
}

function sourceDetail(result: CollectorResult): Record<string, unknown> {
  return {
    queries: result.queries,
    sources: {
      europepmc: {
        ok: result.sources.europepmc.ok,
        httpStatus: result.sources.europepmc.httpStatus,
        resultCount: result.sources.europepmc.resultCount,
        errorCode: result.sources.europepmc.errorCode,
      },
      pubmed: {
        ok: result.sources.pubmed.ok,
        httpStatus: result.sources.pubmed.httpStatus,
        resultCount: result.sources.pubmed.resultCount,
        errorCode: result.sources.pubmed.errorCode,
      },
    },
    candidates: result.candidates.length,
  };
}

// Claim and run at most one job. Returns true when a job ran
// (successfully or not), false when nothing was claimable. The
// PubMed stage is claimed first (binding chain order); the Exa
// stage runs only when no PubMed job is claimable.
export async function runWorkerOnce(options: DeepSearchWorkerOptions): Promise<boolean> {
  const { repository, collector } = options;
  const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  const job = await repository.claimNextCollectorJob();
  if (job !== null) {
    await runCollectorStage(repository, collector, job, stageTimeoutMs);
    return true;
  }
  if (options.exaCollector !== undefined) {
    const exaJob = await repository.claimNextExaJob();
    if (exaJob !== null) {
      await runExaStage(repository, options.exaCollector, exaJob, stageTimeoutMs);
      return true;
    }
  }
  return false;
}

async function runCollectorStage(
  repository: DeepSearchRepository,
  collector: PubmedCollector,
  job: SearchJobRow,
  stageTimeoutMs: number,
): Promise<void> {
  try {
    const existing = await repository.countCandidates(job.id);
    const limit = Math.max(0, job.input.maxCandidates - existing);
    if (limit === 0) {
      // A retry after a partial run can find the candidate cap
      // already reached (decision 6). The stage completes without
      // any external call; the reason is recorded, not silent.
      await repository.completeStep(job.id, 'collector_pubmed', {
        skipped: 'candidate_cap_reached',
        candidates: existing,
      });
      await repository.releaseJobToQueued(job.id);
      return;
    }
    const result = await withTimeout(collector.collect(job, limit), stageTimeoutMs);

    const stored = await repository.insertCandidates(job.id, result.candidates);
    const idByExternalId = new Map(stored.map((row) => [row.externalId, row.id]));
    const evidence: NewEvidence[] = [...result.queryEvidence];
    for (const item of result.candidateEvidence) {
      evidence.push({
        candidateId: idByExternalId.get(item.externalId) ?? null,
        queryText: item.queryText,
        sourceKind: item.sourceKind,
        httpStatus: item.httpStatus,
        note: item.note,
      });
    }
    await repository.insertEvidence(job.id, evidence);

    if (!result.sources.pubmed.ok) {
      // Decision 7: PubMed failure fails the job. Candidates from
      // Europe PMC stay stored as the partial trail, but the job
      // is failed and an explicit retry is the only way forward.
      const code = result.sources.pubmed.errorCode ?? 'unknown';
      await repository.failStep(job.id, 'collector_pubmed', sourceDetail(result));
      await repository.failJob(
        job.id,
        'collector_pubmed_failed',
        `The PubMed collector source failed (${code}).`,
      );
      return;
    }

    await repository.completeStep(job.id, 'collector_pubmed', sourceDetail(result));
    await repository.releaseJobToQueued(job.id);
  } catch (error) {
    const code = error instanceof CollectorError ? error.code : 'collector_error';
    const detail =
      error instanceof CollectorError
        ? error.message
        : 'The PubMed collector stage failed unexpectedly.';
    try {
      await repository.failStep(job.id, 'collector_pubmed', { errorCode: code });
      await repository.failJob(job.id, code, detail);
    } catch {
      // The repository itself is unreachable; the job stays in
      // collecting and startup recovery will mark it failed with
      // worker_restarted. Nothing else can be recorded honestly.
    }
  }
}

function exaDetail(result: ExaCollectorResult): Record<string, unknown> {
  return {
    queries: result.queries,
    calls: result.calls,
    costUsd: result.costUsd,
    sources: {
      exa: {
        ok: result.outcome.ok,
        httpStatus: result.outcome.httpStatus,
        resultCount: result.outcome.resultCount,
        errorCode: result.outcome.errorCode,
      },
    },
    candidates: result.candidates.length,
  };
}

async function runExaStage(
  repository: DeepSearchRepository,
  collector: ExaCollector,
  job: SearchJobRow,
  stageTimeoutMs: number,
): Promise<void> {
  try {
    if (job.budgetExaUsd === null) {
      // Decision 1: without a caller-approved ceiling the Exa
      // stage must not run. The skip is recorded with its reason.
      await repository.skipStep(job.id, 'collector_exa', {
        skipped: 'no_exa_budget',
      });
      await repository.releaseJobToQueued(job.id);
      return;
    }
    const existing = await repository.countCandidates(job.id);
    const limit = Math.max(0, job.input.maxCandidates - existing);
    if (limit === 0) {
      await repository.completeStep(job.id, 'collector_exa', {
        skipped: 'candidate_cap_reached',
        candidates: existing,
      });
      await repository.releaseJobToQueued(job.id);
      return;
    }
    const result = await withTimeout(collector.collect(job, limit), stageTimeoutMs);

    const stored = await repository.insertCandidates(job.id, result.candidates);
    const idByExternalId = new Map(stored.map((row) => [row.externalId, row.id]));
    const evidence: NewEvidence[] = [...result.queryEvidence];
    for (const item of result.candidateEvidence) {
      evidence.push({
        candidateId: idByExternalId.get(item.externalId) ?? null,
        queryText: item.queryText,
        sourceKind: item.sourceKind,
        httpStatus: item.httpStatus,
        note: item.note,
      });
    }
    await repository.insertEvidence(job.id, evidence);
    if (result.costUsd !== '0.0000') {
      await repository.addJobCost(job.id, result.costUsd);
    }

    if (!result.outcome.ok) {
      // Decision 7 partial: the PubMed stage already completed
      // (the claim required it), so an Exa source failure fails
      // the step but not the job. Stored candidates and recorded
      // cost stay as the partial trail.
      await repository.failStep(job.id, 'collector_exa', exaDetail(result));
      await repository.releaseJobToQueued(job.id);
      return;
    }

    await repository.completeStep(job.id, 'collector_exa', exaDetail(result));
    await repository.releaseJobToQueued(job.id);
  } catch (error) {
    const code = error instanceof CollectorError ? error.code : 'collector_error';
    try {
      if (code === 'exa_key_missing' || code === 'exa_budget_missing') {
        // The stage is explicitly unavailable (decision 2: no key
        // installed yet). Recorded skipped, never a job failure.
        await repository.skipStep(job.id, 'collector_exa', { skipped: code });
      } else {
        await repository.failStep(job.id, 'collector_exa', { errorCode: code });
      }
      await repository.releaseJobToQueued(job.id);
    } catch {
      // The repository itself is unreachable; the job stays in
      // collecting and startup recovery will mark it failed with
      // worker_restarted. Nothing else can be recorded honestly.
    }
  }
}

export function startDeepSearchWorker(options: DeepSearchWorkerOptions): DeepSearchWorkerHandle {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? pollIntervalMs;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function loop(): Promise<void> {
    if (initialDelayMs > 0) {
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, initialDelayMs);
      });
    }
    if (stopped) return;
    try {
      await options.repository.markStaleJobsFailed();
    } catch {
      // Startup recovery is best effort here; the next process
      // start retries it. The poll loop still runs.
    }
    while (!stopped) {
      let ran = false;
      try {
        ran = await runWorkerOnce(options);
      } catch {
        // A repository failure while claiming must not kill the
        // worker; wait one poll interval and try again.
        ran = false;
      }
      if (stopped) break;
      if (!ran) {
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, pollIntervalMs);
        });
      }
    }
  }

  void loop();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}
