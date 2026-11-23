// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Collector Exa stage (F2-2, wave G-F2-2c).
//
// Queries the Exa search API for one job topic and normalizes the
// hits into candidate + evidence shapes for the repository port.
// Exa is the non-PubMed collector of the binding chain (design
// 2.2): guidelines, official pages, and sources absent from
// PubMed. This stage never writes F2-1 data: candidates stay
// pending until the writing stage of a later wave.
//
// Binding rules (design 2.2, 3.2, 3.4 and decisions 1, 2, 6, 7):
// - Budget-bound: the job must carry a caller-approved Exa ceiling
//   (budget_exa_usd). Without it this collector refuses before any
//   call (error code exa_budget_missing); the worker records the
//   stage skipped instead of running it (decision 1).
// - The Exa API key comes from server configuration only (decision
//   2: env server muse-2, installed by Daivan through the existing
//   secret path). Without a configured key the collector fails
//   closed before any call (error code exa_key_missing) and the
//   worker records the stage skipped as explicitly unavailable.
// - Cost is recorded per run: a call costs the API-reported
//   costDollars.total when the response carries one, otherwise the
//   configured per-call estimate. The next call is never issued
//   when its estimate would push the run over the job ceiling,
//   and at most MAX_EXA_CALLS_PER_JOB calls run per job. Money
//   math is integer units of 0.0001 USD end to end, never floats.
// - Highlights over full text: the request asks for highlights
//   only, small numResults, never page bodies. The snippet is the
//   joined highlights, truncated like the PubMed stage.
// - HTTP 429 stops the source immediately; there is no retry and
//   no workaround route. Any other source failure also stops the
//   stage; the outcome is recorded in evidence and step detail.
// - No credential value is ever logged or stored in evidence.
//   Evidence holds query text, source kind, HTTP status, and
//   short notes only.
//
// Specs run against recorded-shape fixtures through the injected
// fetch; this module makes no network call of its own in tests.

import type { SearchJobRow } from './represent.js';
import { formatUsdUnits, parseUsdToUnits } from './represent.js';
import type { NewCandidate, NewEvidence } from './repository.js';
import { CollectorError } from './collector-pubmed.js';

export interface ExaCollectorDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  throttleMs?: number;
  requestTimeoutMs?: number;
  exaBaseUrl?: string;
  // Per-call cost estimate in USD units of 0.0001, used for the
  // pre-call budget guard and when the API reports no cost.
  estimatedCostPerCallUnits?: number;
  maxCallsPerJob?: number;
}

export interface ExaSourceOutcome {
  ok: boolean;
  httpStatus: number | null;
  resultCount: number;
  // Stable machine code when ok is false: rate_limited,
  // http_error, network_error, request_timeout, bad_response.
  errorCode: string | null;
}

// Evidence tied to a candidate by external id; the worker resolves
// external ids to stored candidate rows after insert.
export interface ExaCandidateEvidence {
  externalId: string;
  queryText: string;
  sourceKind: 'exa';
  httpStatus: number | null;
  note: string | null;
}

export interface ExaCollectorResult {
  candidates: NewCandidate[];
  candidateEvidence: ExaCandidateEvidence[];
  // Query-level trail rows (candidateId null), one per executed
  // external call, including failed ones.
  queryEvidence: NewEvidence[];
  outcome: ExaSourceOutcome;
  // Recorded run cost as a decimal string (4 places), ready for
  // the numeric cost_exa_usd column.
  costUsd: string;
  calls: number;
  queries: string[];
}

export interface ExaCollector {
  collect(job: SearchJobRow, limit: number): Promise<ExaCollectorResult>;
}

// Server-side call ceiling per job (decision 1 pairs the USD
// ceiling with a call-count ceiling; the count is enforced here
// because the job input carries no call-count field).
export const MAX_EXA_CALLS_PER_JOB = 10;
// Default per-call estimate: 0.0050 USD in units of 0.0001.
export const DEFAULT_EXA_COST_PER_CALL_UNITS = 50;

const DEFAULT_THROTTLE_MS = 400;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_EXA_BASE = 'https://api.exa.ai';
const MAX_SNIPPET_CHARS = 500;
const HIGHLIGHT_SENTENCES = 3;
const HIGHLIGHTS_PER_URL = 2;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function asYear(value: unknown): number | null {
  const raw = asString(value);
  if (raw === null) return null;
  const match = raw.match(/\d{4}/);
  if (match === null) return null;
  const year = Number(match[0]);
  return Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : null;
}

function truncateSnippet(text: string | null): string | null {
  if (text === null) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > MAX_SNIPPET_CHARS ? flat.slice(0, MAX_SNIPPET_CHARS) : flat;
}

// A DOI inside a doi.org URL is the same external identity the
// PubMed stage produces (doi:<lowercased>), so the unique
// (job_id, external_id) pair dedupes the same article across
// stages. Otherwise the normalized URL is the identity.
function doiFromUrl(url: string): string | null {
  const match = url.match(/doi\.org\/(10\.\d{4,9}\/[^\s?#]+)/i);
  if (match === null || match[1] === undefined) return null;
  return decodeURIComponent(match[1]).replace(/[.)]+$/, '');
}

function parseExaResults(body: unknown): NewCandidate[] | null {
  const root = asRecord(body);
  const results = root?.['results'];
  if (!Array.isArray(results)) return null;
  const candidates: NewCandidate[] = [];
  for (const entry of results) {
    const row = asRecord(entry);
    if (row === null) continue;
    const url = asString(row['url']);
    if (url === null) continue;
    const doi = doiFromUrl(url);
    const externalId = doi !== null ? `doi:${doi.toLowerCase()}` : url;
    const highlightsRaw = row['highlights'];
    const highlights = Array.isArray(highlightsRaw)
      ? highlightsRaw
          .map((item) => asString(item))
          .filter((item): item is string => item !== null)
          .join(' ')
      : null;
    candidates.push({
      sourceKind: 'exa',
      externalId,
      title: asString(row['title']),
      authors: asString(row['author']),
      journal: null,
      year: asYear(row['publishedDate']),
      doi,
      pmid: null,
      pmcid: null,
      url,
      oaFlag: null,
      snippet: truncateSnippet(highlights),
    });
  }
  return candidates;
}

function reportedCostUnits(body: unknown): number | null {
  const root = asRecord(body);
  const cost = asRecord(root?.['costDollars']);
  const total = cost?.['total'];
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null;
  return Math.round(total * 10_000);
}

interface FetchOutcome {
  ok: boolean;
  httpStatus: number | null;
  errorCode: string | null;
  body: unknown;
}

export function createExaCollector(
  apiKey: string | undefined,
  deps: ExaCollectorDeps = {},
): ExaCollector {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const throttleMs = deps.throttleMs ?? DEFAULT_THROTTLE_MS;
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const exaBase = deps.exaBaseUrl ?? DEFAULT_EXA_BASE;
  const estimatedCostPerCallUnits =
    deps.estimatedCostPerCallUnits ?? DEFAULT_EXA_COST_PER_CALL_UNITS;
  const maxCallsPerJob = deps.maxCallsPerJob ?? MAX_EXA_CALLS_PER_JOB;

  // Process-wide throttle, same discipline as the PubMed stage:
  // the worker owns one instance per process.
  let lastRequestAt = 0;

  async function throttledSearch(body: Record<string, unknown>): Promise<FetchOutcome> {
    const waitMs = lastRequestAt + throttleMs - now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastRequestAt = now();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);
    try {
      const response = await fetchFn(`${exaBase}/search`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': apiKey as string,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status === 429) {
        return { ok: false, httpStatus: 429, errorCode: 'rate_limited', body: null };
      }
      if (!response.ok) {
        return { ok: false, httpStatus: response.status, errorCode: 'http_error', body: null };
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return { ok: false, httpStatus: response.status, errorCode: 'bad_response', body: null };
      }
      return { ok: true, httpStatus: response.status, errorCode: null, body: parsed };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        httpStatus: null,
        errorCode: aborted ? 'request_timeout' : 'network_error',
        body: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function collect(job: SearchJobRow, limit: number): Promise<ExaCollectorResult> {
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new CollectorError(
        'exa_key_missing',
        'The Exa API key is not configured on the server.',
      );
    }
    if (job.budgetExaUsd === null) {
      throw new CollectorError(
        'exa_budget_missing',
        'The job carries no approved Exa budget ceiling.',
      );
    }
    const budgetUnits = parseUsdToUnits(job.budgetExaUsd);
    const cap = Math.max(0, limit);
    const queries: string[] = [];
    const queryEvidence: NewEvidence[] = [];
    const candidateEvidence: ExaCandidateEvidence[] = [];
    const byExternalId = new Map<string, NewCandidate>();
    let spentUnits = 0;
    let calls = 0;
    let outcome: ExaSourceOutcome = { ok: true, httpStatus: null, resultCount: 0, errorCode: null };

    const query = job.topic;
    while (byExternalId.size < cap && calls < maxCallsPerJob) {
      // Budget guard before spending: the next call's estimate
      // must fit under the job ceiling, otherwise the stage stops
      // with what it has (recorded, never silent).
      if (spentUnits + estimatedCostPerCallUnits > budgetUnits) {
        queryEvidence.push({
          candidateId: null,
          queryText: query,
          sourceKind: 'exa',
          httpStatus: null,
          note: `budget_reached spent=${formatUsdUnits(spentUnits)}`,
        });
        break;
      }
      const requested = cap - byExternalId.size;
      const requestBody: Record<string, unknown> = {
        query,
        numResults: requested,
        contents: {
          highlights: {
            numSentences: HIGHLIGHT_SENTENCES,
            highlightsPerUrl: HIGHLIGHTS_PER_URL,
          },
        },
      };
      const { yearFrom, yearTo } = job.input;
      if (yearFrom !== undefined) {
        requestBody['startPublishedDate'] = `${yearFrom}-01-01T00:00:00.000Z`;
      }
      if (yearTo !== undefined) {
        requestBody['endPublishedDate'] = `${yearTo}-12-31T23:59:59.999Z`;
      }
      calls += 1;
      queries.push(query);
      const fetched = await throttledSearch(requestBody);
      if (!fetched.ok) {
        // 429 and every other source failure stop the stage. A
        // failed call records no cost.
        outcome = {
          ok: false,
          httpStatus: fetched.httpStatus,
          resultCount: byExternalId.size,
          errorCode: fetched.errorCode,
        };
        queryEvidence.push({
          candidateId: null,
          queryText: query,
          sourceKind: 'exa',
          httpStatus: fetched.httpStatus,
          note: `failed=${fetched.errorCode ?? 'unknown'}`,
        });
        break;
      }
      const parsed = parseExaResults(fetched.body);
      if (parsed === null) {
        outcome = {
          ok: false,
          httpStatus: fetched.httpStatus,
          resultCount: byExternalId.size,
          errorCode: 'bad_response',
        };
        queryEvidence.push({
          candidateId: null,
          queryText: query,
          sourceKind: 'exa',
          httpStatus: fetched.httpStatus,
          note: 'failed=bad_response',
        });
        break;
      }
      const callCostUnits = reportedCostUnits(fetched.body) ?? estimatedCostPerCallUnits;
      spentUnits += callCostUnits;
      let added = 0;
      for (const candidate of parsed) {
        if (byExternalId.size >= cap) break;
        if (!byExternalId.has(candidate.externalId)) {
          byExternalId.set(candidate.externalId, candidate);
          added += 1;
        }
      }
      outcome = {
        ok: true,
        httpStatus: fetched.httpStatus,
        resultCount: byExternalId.size,
        errorCode: null,
      };
      queryEvidence.push({
        candidateId: null,
        queryText: query,
        sourceKind: 'exa',
        httpStatus: fetched.httpStatus,
        note: `results=${added} cost=${formatUsdUnits(callCostUnits)}`,
      });
      // A call that adds nothing new ends the stage: repeating
      // the same query would only spend budget on duplicates. A
      // call that returns fewer usable results than requested
      // means the source is exhausted for this query; stop
      // instead of paying for a confirming duplicate call.
      if (added === 0 || parsed.length < requested) {
        break;
      }
    }

    const candidates = [...byExternalId.values()];
    for (const candidate of candidates) {
      candidateEvidence.push({
        externalId: candidate.externalId,
        queryText: query,
        sourceKind: 'exa',
        httpStatus: outcome.httpStatus,
        note: null,
      });
    }

    return {
      candidates,
      candidateEvidence,
      queryEvidence,
      outcome,
      costUsd: formatUsdUnits(spentUnits),
      calls,
      queries,
    };
  }

  return { collect };
}
