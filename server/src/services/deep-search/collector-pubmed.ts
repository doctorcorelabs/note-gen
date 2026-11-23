// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Collector PubMed stage (F2-2, wave G-F2-2b).
//
// Queries Europe PMC and PubMed E-utilities for one job topic and
// normalizes the hits into candidate + evidence shapes for the
// repository port. This stage never writes F2-1 data: candidates
// stay pending until the writing stage of a later wave.
//
// Binding rules (design 2.2, 3.2, 3.4 and decisions 3, 6, 7):
// - PubMed first: Europe PMC + E-utilities only. Exa is G-F2-2c.
// - Throttle: at most one external request per 0.4 seconds per
//   process, across both sources.
// - HTTP 429 stops that source immediately; there is no retry and
//   no workaround route. The outcome is recorded, never hidden.
// - Fail-closed per source: a failed source invents no results
//   for the other. The worker decides the job outcome from the
//   per-source outcomes (PubMed failure fails the job, decision
//   7; a Europe PMC failure with PubMed success completes the
//   stage as partial with the failure recorded in step detail).
// - OA-only for full text: this stage fetches metadata and
//   abstract snippets only, never full text or PDFs. The OA flag
//   is recorded per candidate for later waves.
// - The E-utilities identity (tool + contact email) comes from
//   server configuration, never from job input. Without a
//   configured email the collector fails closed before any
//   external call (error code eutils_identity_missing).
// - No credential value is ever logged or stored in evidence.
//   Evidence holds query text, source kind, HTTP status, and
//   short notes only.
//
// Specs run against recorded-shape fixtures through the injected
// fetch; this module makes no network call of its own in tests.

import type { SearchJobRow } from './represent.js';
import type { NewCandidate, NewEvidence } from './repository.js';

export interface EutilsIdentity {
  tool: string;
  email: string | undefined;
}

export interface PubmedCollectorDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  throttleMs?: number;
  requestTimeoutMs?: number;
  europePmcBaseUrl?: string;
  eutilsBaseUrl?: string;
}

export interface SourceOutcome {
  ok: boolean;
  httpStatus: number | null;
  resultCount: number;
  // Stable machine code when ok is false: rate_limited,
  // http_error, network_error, request_timeout, bad_response.
  errorCode: string | null;
}

// Evidence tied to a candidate by external id; the worker resolves
// external ids to stored candidate rows after insert.
export interface CandidateEvidence {
  externalId: string;
  queryText: string;
  sourceKind: 'pubmed' | 'europepmc';
  httpStatus: number | null;
  note: string | null;
}

export interface CollectorResult {
  candidates: NewCandidate[];
  candidateEvidence: CandidateEvidence[];
  // Query-level trail rows (candidateId null), one per executed
  // external query, including failed ones.
  queryEvidence: NewEvidence[];
  sources: { europepmc: SourceOutcome; pubmed: SourceOutcome };
  queries: string[];
}

export class CollectorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PubmedCollector {
  collect(job: SearchJobRow, limit: number): Promise<CollectorResult>;
}

const DEFAULT_THROTTLE_MS = 400;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_EUROPEPMC_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const DEFAULT_EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const MAX_SNIPPET_CHARS = 500;

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

// Normalized external identity, most stable first: PMID, then
// PMCID, then DOI, then URL. The unique (job_id, external_id)
// pair dedupes on this value, so both sources must agree on it
// for the same article.
function externalIdOf(parts: {
  pmid: string | null;
  pmcid: string | null;
  doi: string | null;
  url: string | null;
}): string | null {
  if (parts.pmid !== null) return `pmid:${parts.pmid}`;
  if (parts.pmcid !== null) return `pmcid:${parts.pmcid}`;
  if (parts.doi !== null) return `doi:${parts.doi.toLowerCase()}`;
  return parts.url;
}

function candidateUrl(parts: {
  pmid: string | null;
  pmcid: string | null;
  doi: string | null;
}): string | null {
  if (parts.pmid !== null) return `https://pubmed.ncbi.nlm.nih.gov/${parts.pmid}/`;
  if (parts.doi !== null) return `https://doi.org/${parts.doi}`;
  if (parts.pmcid !== null) return `https://pmc.ncbi.nlm.nih.gov/articles/${parts.pmcid}/`;
  return null;
}

function buildEuropePmcQuery(job: SearchJobRow): string {
  const parts = [job.topic];
  const { yearFrom, yearTo, language } = job.input;
  if (yearFrom !== undefined || yearTo !== undefined) {
    parts.push(`(PUB_YEAR:[${yearFrom ?? '*'} TO ${yearTo ?? '*'}])`);
  }
  if (language !== undefined) {
    parts.push(`(LANG:"${language}")`);
  }
  return parts.join(' AND ');
}

function buildEutilsTerm(job: SearchJobRow): string {
  const parts = [job.topic];
  const { yearFrom, yearTo, language } = job.input;
  if (yearFrom !== undefined || yearTo !== undefined) {
    parts.push(`${yearFrom ?? 1000}:${yearTo ?? 3000}[dp]`);
  }
  if (language !== undefined) {
    parts.push(`${language}[la]`);
  }
  return parts.join(' AND ');
}

interface FetchOutcome {
  ok: boolean;
  httpStatus: number | null;
  errorCode: string | null;
  body: unknown;
}

export function createPubmedCollector(
  identity: EutilsIdentity,
  deps: PubmedCollectorDeps = {},
): PubmedCollector {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const throttleMs = deps.throttleMs ?? DEFAULT_THROTTLE_MS;
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const europePmcBase = deps.europePmcBaseUrl ?? DEFAULT_EUROPEPMC_BASE;
  const eutilsBase = deps.eutilsBaseUrl ?? DEFAULT_EUTILS_BASE;

  // Process-wide throttle: the timestamp of the last external
  // request issued by this collector instance. The worker owns
  // one instance per process, so this is the per-process gate.
  let lastRequestAt = 0;

  async function throttledFetch(url: string): Promise<FetchOutcome> {
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
      const response = await fetchFn(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status === 429) {
        return { ok: false, httpStatus: 429, errorCode: 'rate_limited', body: null };
      }
      if (!response.ok) {
        return { ok: false, httpStatus: response.status, errorCode: 'http_error', body: null };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, httpStatus: response.status, errorCode: 'bad_response', body: null };
      }
      return { ok: true, httpStatus: response.status, errorCode: null, body };
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

  function identityParams(): string {
    const params = new URLSearchParams({ tool: identity.tool });
    if (identity.email !== undefined) {
      params.set('email', identity.email);
    }
    return params.toString();
  }

  function parseEuropePmc(body: unknown): NewCandidate[] | null {
    const root = asRecord(body);
    const list = asRecord(root?.['resultList']);
    const results = list?.['result'];
    if (!Array.isArray(results)) return null;
    const candidates: NewCandidate[] = [];
    for (const entry of results) {
      const row = asRecord(entry);
      if (row === null) continue;
      const pmid = asString(row['pmid']);
      const pmcid = asString(row['pmcid']);
      const doi = asString(row['doi']);
      const url = candidateUrl({ pmid, pmcid, doi });
      const externalId = externalIdOf({ pmid, pmcid, doi, url });
      if (externalId === null) continue;
      const journalInfo = asRecord(row['journalInfo']);
      const journal = asRecord(journalInfo?.['journal']);
      const oaRaw = asString(row['isOpenAccess']);
      candidates.push({
        sourceKind: 'europepmc',
        externalId,
        title: asString(row['title']),
        authors: asString(row['authorString']),
        journal: asString(journal?.['title']) ?? asString(row['journalTitle']),
        year: asYear(row['pubYear']) ?? asYear(journalInfo?.['yearOfPublication']),
        doi,
        pmid,
        pmcid,
        url,
        oaFlag: oaRaw === 'Y' ? true : oaRaw === 'N' ? false : null,
        snippet: truncateSnippet(asString(row['abstractText'])),
      });
    }
    return candidates;
  }

  function parseEsearchIds(body: unknown): string[] | null {
    const root = asRecord(body);
    const result = asRecord(root?.['esearchresult']);
    const idlist = result?.['idlist'];
    if (!Array.isArray(idlist)) return null;
    return idlist.filter((id): id is string => typeof id === 'string' && id !== '');
  }

  function parseEsummary(body: unknown, ids: string[]): NewCandidate[] | null {
    const root = asRecord(body);
    const result = asRecord(root?.['result']);
    if (result === null) return null;
    const candidates: NewCandidate[] = [];
    for (const id of ids) {
      const row = asRecord(result[id]);
      if (row === null) continue;
      const pmid = asString(row['uid']) ?? id;
      let doi: string | null = null;
      let pmcid: string | null = null;
      const articleIds = row['articleids'];
      if (Array.isArray(articleIds)) {
        for (const item of articleIds) {
          const pair = asRecord(item);
          const idType = asString(pair?.['idtype']);
          const value = asString(pair?.['value']);
          if (value === null) continue;
          if (idType === 'doi') doi = value;
          if (idType === 'pmc') pmcid = value;
        }
      }
      const authorsRaw = row['authors'];
      const authors = Array.isArray(authorsRaw)
        ? authorsRaw
            .map((item) => asString(asRecord(item)?.['name']))
            .filter((name): name is string => name !== null)
            .join(', ')
        : null;
      const url = candidateUrl({ pmid, pmcid, doi });
      const externalId = externalIdOf({ pmid, pmcid, doi, url });
      if (externalId === null) continue;
      candidates.push({
        sourceKind: 'pubmed',
        externalId,
        title: asString(row['title']),
        authors: authors === '' ? null : authors,
        journal: asString(row['fulljournalname']) ?? asString(row['source']),
        year: asYear(row['pubdate']) ?? asYear(row['sortpubdate']),
        doi,
        pmid,
        pmcid,
        url,
        oaFlag: null,
        snippet: null,
      });
    }
    return candidates;
  }

  // Merge the two sources by external id: Europe PMC rows come
  // first (richer metadata), PubMed rows fill gaps on shared
  // articles and append the rest. First non-null field wins.
  function mergeCandidates(
    primary: NewCandidate[],
    secondary: NewCandidate[],
  ): NewCandidate[] {
    const byExternalId = new Map<string, NewCandidate>();
    for (const candidate of primary) {
      if (!byExternalId.has(candidate.externalId)) {
        byExternalId.set(candidate.externalId, candidate);
      }
    }
    for (const candidate of secondary) {
      const existing = byExternalId.get(candidate.externalId);
      if (existing === undefined) {
        byExternalId.set(candidate.externalId, candidate);
      } else {
        byExternalId.set(candidate.externalId, {
          ...existing,
          title: existing.title ?? candidate.title,
          authors: existing.authors ?? candidate.authors,
          journal: existing.journal ?? candidate.journal,
          year: existing.year ?? candidate.year,
          doi: existing.doi ?? candidate.doi,
          pmid: existing.pmid ?? candidate.pmid,
          pmcid: existing.pmcid ?? candidate.pmcid,
          url: existing.url ?? candidate.url,
          oaFlag: existing.oaFlag ?? candidate.oaFlag,
          snippet: existing.snippet ?? candidate.snippet,
        });
      }
    }
    return [...byExternalId.values()];
  }

  async function collect(job: SearchJobRow, limit: number): Promise<CollectorResult> {
    if (identity.email === undefined || identity.email.trim() === '') {
      throw new CollectorError(
        'eutils_identity_missing',
        'The E-utilities contact email is not configured on the server.',
      );
    }
    const cap = Math.max(0, limit);
    const queries: string[] = [];
    const queryEvidence: NewEvidence[] = [];
    const candidateEvidence: CandidateEvidence[] = [];

    // Europe PMC first.
    const europeQuery = buildEuropePmcQuery(job);
    queries.push(europeQuery);
    const europeUrl =
      `${europePmcBase}/search?query=${encodeURIComponent(europeQuery)}` +
      `&format=json&pageSize=${cap}&resultType=core`;
    const europeFetch = await throttledFetch(europeUrl);
    let europeCandidates: NewCandidate[] = [];
    let europeOutcome: SourceOutcome;
    if (!europeFetch.ok) {
      europeOutcome = {
        ok: false,
        httpStatus: europeFetch.httpStatus,
        resultCount: 0,
        errorCode: europeFetch.errorCode,
      };
    } else {
      const parsed = parseEuropePmc(europeFetch.body);
      if (parsed === null) {
        europeOutcome = {
          ok: false,
          httpStatus: europeFetch.httpStatus,
          resultCount: 0,
          errorCode: 'bad_response',
        };
      } else {
        europeCandidates = parsed;
        europeOutcome = {
          ok: true,
          httpStatus: europeFetch.httpStatus,
          resultCount: parsed.length,
          errorCode: null,
        };
      }
    }
    queryEvidence.push({
      candidateId: null,
      queryText: europeQuery,
      sourceKind: 'europepmc',
      httpStatus: europeOutcome.httpStatus,
      note: europeOutcome.ok
        ? `results=${europeOutcome.resultCount}`
        : `failed=${europeOutcome.errorCode ?? 'unknown'}`,
    });

    // PubMed E-utilities: esearch then esummary.
    const eutilsTerm = buildEutilsTerm(job);
    queries.push(eutilsTerm);
    const esearchUrl =
      `${eutilsBase}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(eutilsTerm)}` +
      `&retmax=${cap}&retmode=json&sort=relevance&${identityParams()}`;
    const esearchFetch = await throttledFetch(esearchUrl);
    let pubmedCandidates: NewCandidate[] = [];
    let pubmedOutcome: SourceOutcome;
    if (!esearchFetch.ok) {
      pubmedOutcome = {
        ok: false,
        httpStatus: esearchFetch.httpStatus,
        resultCount: 0,
        errorCode: esearchFetch.errorCode,
      };
    } else {
      const ids = parseEsearchIds(esearchFetch.body);
      if (ids === null) {
        pubmedOutcome = {
          ok: false,
          httpStatus: esearchFetch.httpStatus,
          resultCount: 0,
          errorCode: 'bad_response',
        };
      } else if (ids.length === 0) {
        pubmedOutcome = {
          ok: true,
          httpStatus: esearchFetch.httpStatus,
          resultCount: 0,
          errorCode: null,
        };
      } else {
        const esummaryUrl =
          `${eutilsBase}/esummary.fcgi?db=pubmed&id=${ids.join(',')}` +
          `&retmode=json&${identityParams()}`;
        const esummaryFetch = await throttledFetch(esummaryUrl);
        if (!esummaryFetch.ok) {
          pubmedOutcome = {
            ok: false,
            httpStatus: esummaryFetch.httpStatus,
            resultCount: 0,
            errorCode: esummaryFetch.errorCode,
          };
        } else {
          const parsed = parseEsummary(esummaryFetch.body, ids);
          if (parsed === null) {
            pubmedOutcome = {
              ok: false,
              httpStatus: esummaryFetch.httpStatus,
              resultCount: 0,
              errorCode: 'bad_response',
            };
          } else {
            pubmedCandidates = parsed;
            pubmedOutcome = {
              ok: true,
              httpStatus: esummaryFetch.httpStatus,
              resultCount: parsed.length,
              errorCode: null,
            };
          }
        }
      }
    }
    queryEvidence.push({
      candidateId: null,
      queryText: eutilsTerm,
      sourceKind: 'pubmed',
      httpStatus: pubmedOutcome.httpStatus,
      note: pubmedOutcome.ok
        ? `results=${pubmedOutcome.resultCount}`
        : `failed=${pubmedOutcome.errorCode ?? 'unknown'}`,
    });

    const merged = mergeCandidates(europeCandidates, pubmedCandidates).slice(0, cap);
    for (const candidate of merged) {
      // This collector only ever produces europepmc/pubmed rows;
      // narrow explicitly so the evidence type stays honest.
      const kind: 'pubmed' | 'europepmc' =
        candidate.sourceKind === 'europepmc' ? 'europepmc' : 'pubmed';
      candidateEvidence.push({
        externalId: candidate.externalId,
        queryText: kind === 'europepmc' ? europeQuery : eutilsTerm,
        sourceKind: kind,
        httpStatus: kind === 'europepmc' ? europeOutcome.httpStatus : pubmedOutcome.httpStatus,
        note: null,
      });
    }

    return {
      candidates: merged,
      candidateEvidence,
      queryEvidence,
      sources: { europepmc: europeOutcome, pubmed: pubmedOutcome },
      queries,
    };
  }

  return { collect };
}
